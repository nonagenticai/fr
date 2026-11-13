// E-7: Inbound channel dispatch.
//
// Defines the frozen `ChannelInbound` and `InboundMessage` interfaces (per
// architecture-enablers §E-7) and a module-global `channelDispatcher` that
// routes a webhook Request through the channel's `parseWebhook`, then hands
// off any non-null `InboundMessage` to a thin `dispatchInbound` seam.
//
// Wave 1 scope (per spec 2026-04-25-e7-inbound-channel-dispatch.md):
//   - Gated by env `CHANNEL_DISPATCH_ENABLED` (default false). When false, the
//     dispatcher is a pure pass-through: `handleWebhook` returns null without
//     touching the body, so legacy route handlers run unchanged.
//   - When enabled, the dispatcher builds a §E-3 RequestContext from the
//     parsed message (initiator='agent', channel=msg.channel, correlationId
//     from msg) and wraps `dispatchInbound` in `emitSpan('channels.dispatch')`.
//   - `dispatchInbound` itself is a structured-log + 200 ack stub. The actual
//     `agentCore.resolveIntent` + `invokeAction` integration is out of scope
//     here; it lands with the agent-core spec.
//   - When `parseWebhook` returns null, the dispatcher returns null so the
//     legacy route handler can fall through unchanged.
//
// Frozen interfaces are quoted from architecture-enablers §E-7 — DO NOT
// REDEFINE with extra fields here.

import { jsonResponse } from '../utils/response';
import type { ChannelMessage } from '../domain/engagement/notifications';
import {
  withRequestContext,
  type RequestContext,
} from '../integrations/_lib/context';
import { emitSpan } from '../telemetry/spans';
import { agentCore } from '../agent-core';
import type { IdentityResolution } from '../agent-core/types';
import { getAction, invokeAction, markChannelDispatched } from '../agui/registry';
import type { ActionContext, PendingAction } from '../agui/types';
import {
  channelTenantRefusalText,
  isChannelWorkspaceMember,
  resolveChannelTenant,
  type ChannelTenant,
  type ChannelTenantResolution,
} from '../capabilities/principal';
import { findLinkedTenant } from '../domain/engagement/channel-prefs';
import { actionPendingReply } from '../domain/engagement/approval-menu';
import { findAgentMemberByAddress, isAgentMemberId } from '../domain/engagement/agent-members';
import { keycloak } from '../services/keycloak';
import { userHomedIn } from '../services/user-home-tenant';
import type { DecisionVia } from '../db/schema';
import { isIntegrationError, reportSwallowedFailure } from '../integrations/_lib/errors';
import { AppError, pgErrorCode } from '../utils/errors';

export interface InboundMessage {
  channel: string;
  userId: string;
  address: string;
  text: string;
  correlationId: string;
  threadId?: string; // for chat threading
  raw: unknown;
  /**
   * mcp only (nonagenticai_mcp_server #64): the human an agent member acts for (a Keycloak
   * sub) and the agent job id, top-level siblings of `address`. Honoured only for an agent
   * member's address (fr #1683); ignored for every other sender.
   */
  onBehalfOf?: string;
  jobId?: string;
  /**
   * The sender's own new words when `text` carries more than that (email prepends the
   * subject). The reply→decision flow reads THIS; the agent dispatcher reads `text`.
   */
  replyText?: string;
  /** What the message replies to, when the transport carries it (email: the subject line,
   * which keeps the notification's `[ApprovalId:…]` tag). */
  quotedText?: string;
}

export interface ChannelInbound {
  name: string;
  parseWebhook(req: Request): Promise<InboundMessage | null>;
  postReply(threadId: string | undefined, message: ChannelMessage): Promise<void>;
}

export class DuplicateChannelError extends Error {
  constructor(name: string) {
    super(`Channel already registered: ${name}`);
    this.name = 'DuplicateChannelError';
  }
}

const registry = new Map<string, ChannelInbound>();

const dispatchEnabled = process.env.CHANNEL_DISPATCH_ENABLED === 'true';

export function registerChannel(c: ChannelInbound): void {
  if (registry.has(c.name)) {
    throw new DuplicateChannelError(c.name);
  }
  registry.set(c.name, c);
}

export function getChannel(name: string): ChannelInbound | undefined {
  return registry.get(name);
}

export function listChannels(): ChannelInbound[] {
  return Array.from(registry.values());
}

/**
 * fr's OWN web chat-box channels. Their tenant is the WEB SESSION's (the
 * authenticated request's active workspace, `X-Active-Tenant` rules), never a
 * channel-membership pick, so the §6.5 rule-2 refusal does not apply to them:
 *   - `inapp` (`POST /api/inapp/messages`) passes the session's active tenant
 *     to `handleWebhook` as `sessionTenant`;
 *   - `web` (the N8N_WEBHOOK_SECRET thread injection) has no session, so it
 *     takes the external channels' membership rule (P1-TEAM-a: the
 *     `getUserTenant` LIMIT-1 fallback it used to keep is no longer authority).
 *   A web channel WITHOUT a server-set session tenant is never a web session.
 */
export const WEB_SESSION_CHANNELS: ReadonlySet<string> = new Set(['web', 'inapp']);

/**
 * Channel commands that need no tenant at all: answered for ANY linked sender,
 * whatever their workspace count.
 */
export const TENANT_FREE_CHANNEL_ACTIONS: ReadonlySet<string> = new Set(['help.list_commands']);

/**
 * Per-workspace READS of the sender's own data. A multi-workspace sender gets the
 * answer for EACH of their workspaces (never one arbitrary pick); a zero-workspace
 * sender gets the empty answer (there is nothing of theirs to list).
 */
export const PER_WORKSPACE_CHANNEL_READS: ReadonlySet<string> = new Set(['status.summary']);

/** A server-set tenant for the dispatch (the web session's active workspace). */
export interface DispatchOptions {
  sessionTenant?: { id: string; name?: string | null };
  /**
   * The route already ran this message through the reply→decision flow (`runChannelTurn`)
   * with a richer envelope of its own (Telegram: chat, topic, quoted Reply) and is offering
   * the unclaimed text to the agent. Never set by any other route.
   */
  replyTurnDone?: boolean;
}

/**
 * Bounded in-process retry budget for the tenant lookup.
 *
 * A DB blip is normally sub-second, so retrying IN the request is what actually
 * saves the message: the delivery is processed and nothing has to be re-sent.
 * The budget is small on purpose — 125 ms of added latency in the fault case
 * only, which a webhook sender's timeout tolerates. It is not a substitute for
 * the refusal below; it is what makes that refusal rare.
 *
 * ⛔ Deliberately NOT a DB-backed dead-letter row: the dependency that just
 * faulted IS Postgres, so a "durable" park written there fails in exactly the
 * incident it exists for. Past this budget the retry belongs to the SENDER, and
 * the refusal below is what asks for it.
 */
const TENANT_LOOKUP_ATTEMPTS = 3;
const TENANT_LOOKUP_BACKOFF_MS: readonly number[] = [25, 100];

/**
 * The retriable refusal for a DEPENDENCY FAULT on the inbound-channel path.
 *
 * Shared by BOTH non-2xx branches: the identity fault at step 1 (fr#1292,
 * Keycloak) and the tenant-lookup fault at step 2b (fr#1243, Postgres). Named
 * for the CLASS and not for either dependency — these were named for the tenant
 * lookup while step 2b was the only refusal in this file, and reusing that name
 * for a Keycloak fault would have made the status read as tenant-specific when
 * the rule is deliberately ONE rule for every dependency and every channel.
 *
 * ⛔ 503, not 200 and not the 500 that falls out of an uncaught throw. The full
 * reasoning lives at the branches that use these; the short version is that a
 * machine sender branches on the STATUS and never on our body, so a 2xx here
 * would be the only thing in this path capable of losing the message.
 *
 * `Retry-After` is a few seconds because the fault is a dependency blip — at
 * step 2b, one the in-request budget above already failed to ride out — and not
 * a capacity limit. It is advisory; nothing in fr enforces it.
 */
const DEPENDENCY_UNAVAILABLE_STATUS = 503;
const DEPENDENCY_UNAVAILABLE_RETRY_AFTER_S = 5;

// ───────────────────────────────────────────────────────────────────────────
// THE TRANSIENT-vs-fr DISCRIMINATOR (fr#1295)
//
// Steps 1 and 2b tell a fault from an answer STRUCTURALLY: their resolvers have
// a documented zero-throw contract (`services/user-tenant.ts` contains ZERO
// `throw` sites), so a THROW *is* a dependency fault and no error inspection is
// needed. Steps 2 and 3 do NOT have that luxury — their catch blocks see both
// classes of error arrive on one line:
//
//   * step 2 (`resolveIntent`). The production chain is
//     CommandGrammar → LLM → Heuristic (`server.ts:1089`). The LLM leg catches
//     its own transport failure and falls back (`llm-resolver.ts:147`), and the
//     Heuristic leg is pure regex + registry reads. (The grammar's former
//     `findLastPendingApproval` Postgres read, reached by a bare `yes`/`no`, is
//     gone — a bare yes/no is answered by the shared reply flow before intent.) A
//     transient fault here can still come from an injected resolver; anything
//     else arriving here is an fr-side bug.
//   * step 3 (`invokeAction`). A handler's upstream call (kanban, kag,
//     worker_management, …) arrives as an `IntegrationError` from
//     `integrations/_lib/http-client.ts`. An `UnknownActionError`, an
//     `ActionInputValidationError`, an `ActionOutputValidationError`, an
//     `RbacDeniedError` or a plain `TypeError` is fr's own fault or the
//     caller's, and a re-delivery would fail identically.
//
// ⛔ SO THIS PREDICATE DEMANDS POSITIVE EVIDENCE AND DEFAULTS TO fr-SIDE. That
// is the OPPOSITE default from `routes/agui.ts classifyError`, which answers
// `retriable: true` for any unrecognised error and calls that "the safe
// direction to be wrong in" — true for ITS reader, which is an agent retrying a
// bounded number of times. OUR reader is telegram / Mailgun, which re-delivers
// on a 5xx on its own schedule and with no human in the loop:
// over-claiming "transient" there turns every fr bug into an unbounded
// re-delivery loop into a broken fr. The 200 ack on an fr-side fault is
// therefore NOT a leftover to be cleaned up — it is the correct answer, and it
// is what this predicate must keep returning for everything it cannot PROVE
// transient. ⛔ Do not widen it to a default-true.
// ───────────────────────────────────────────────────────────────────────────

/** `IntegrationError` codes that mean the dependency did not answer at all. */
const TRANSIENT_INTEGRATION_CODES: ReadonlySet<string> = new Set([
  'UPSTREAM_UNREACHABLE', // `fetch` itself failed; nothing was ever delivered
  'UPSTREAM_TIMEOUT', // the call was abandoned, not refused
]);

/**
 * Upstream statuses that mean "come back later". Both halves are RESTATED from
 * their owners and named so the restatement stays checkable, rather than
 * invented here as a third set:
 *   * {502,503,504} is `RETRYABLE_STATUS` (`integrations/_lib/http-client.ts:274`
 *     — module-private, so it cannot be imported). fr's OWN client retries
 *     exactly these, so admitting them makes this leg agree with that one.
 *   * {408,425,429} is the exported `TRANSIENT_4XX_STATUSES`
 *     (`connectors/dispatcher.ts:67`).
 * ⛔ Every OTHER 4xx is the upstream saying the REQUEST is wrong, which
 * re-delivering the same message cannot fix.
 */
const TRANSIENT_UPSTREAM_STATUS: ReadonlySet<number> = new Set([502, 503, 504, 408, 425, 429]);

/**
 * SQLSTATEs that mean the database could not SERVE, as opposed to refusing the
 * statement. Class `08` is "connection exception" in full; `57P01`/`57P02`/
 * `57P03` are admin_shutdown / crash_shutdown / cannot_connect_now; `53300`
 * too_many_connections and `53200` out_of_memory are capacity; `40001`
 * serialization_failure and `40P01` deadlock_detected are the two the standard
 * itself defines as "retry and it may succeed".
 *
 * ⛔ Deliberately ABSENT: `22P02` (invalid input syntax — the malformed-uuid 500
 * `utils/errors.ts` documents at length), the `23*` integrity violations, and
 * the `42*` syntax / undefined-relation family. Those are fr's own bug or the
 * caller's input, and they are byte-identical on every re-delivery.
 */
const TRANSIENT_SQLSTATES: ReadonlySet<string> = new Set([
  '57P01',
  '57P02',
  '57P03',
  '53300',
  '53200',
  '40001',
  '40P01',
]);

/**
 * Non-SQLSTATE `code` values a connection failure carries. postgres.js raises
 * its own (`db/client.ts:166` records a real boot failure reading
 * `CONNECT_TIMEOUT pgbouncer.example.com:6432`); the rest are
 * node socket / DNS codes.
 *
 * ⚠️ THIS SET IS WHY `pgErrorCode` ALONE IS NOT ENOUGH. That helper only
 * returns SQLSTATE-SHAPED codes (`/^[0-9A-Z]{5}$/`), and `CONNECT_TIMEOUT` and
 * `ECONNREFUSED` are not that shape — a predicate built on it alone would be
 * blind to the single most likely fault on both of these legs, i.e. a gate that
 * cannot fire on the thing it exists for.
 */
const TRANSIENT_DRIVER_CODES: ReadonlySet<string> = new Set([
  // postgres.js
  'CONNECT_TIMEOUT',
  'CONNECTION_REFUSED',
  'CONNECTION_CLOSED',
  'CONNECTION_DESTROYED',
  'CONNECTION_ENDED',
  // node socket / DNS
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
]);

/**
 * How far to follow `.cause`. Same depth and same cycle guard as `pgErrorCode`
 * (`utils/errors.ts`), for the measured reason recorded there: drizzle wraps
 * every driver error in a `DrizzleQueryError` that carries `.cause` and NO
 * `.code`, so reading the top level alone sees nothing at all.
 */
const TRANSIENT_CAUSE_MAX_DEPTH = 3;

/**
 * `err`, or something within 3 `.cause` levels of it, carries a
 * `TRANSIENT_DRIVER_CODES` member.
 *
 * ⚠️ No `severity`/`routine` corroboration is required here, unlike
 * `pgErrorCode`'s deeper levels. That requirement exists because an unrelated
 * error with a five-uppercase `code` could be MISREAD as a SQLSTATE; this set
 * is closed and every member already means "the socket did not work", so there
 * is nothing to be confused with.
 */
function hasTransientDriverCode(err: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = err;
  for (let depth = 0; depth <= TRANSIENT_CAUSE_MAX_DEPTH; depth += 1) {
    if (typeof current !== 'object' || current === null) return false;
    if (seen.has(current)) return false;
    seen.add(current);
    const candidate = current as { code?: unknown; cause?: unknown };
    if (typeof candidate.code === 'string' && TRANSIENT_DRIVER_CODES.has(candidate.code)) {
      return true;
    }
    current = candidate.cause;
  }
  return false;
}

/** A SQLSTATE that means "could not serve", per {@link TRANSIENT_SQLSTATES}. */
function isTransientSqlstate(code: string): boolean {
  // Class 08 in full — `08000`, `08001`, `08003`, `08004`, `08006`, `08007`,
  // `08P01` are all "connection exception" and none of them is about the
  // statement's content.
  if (code.startsWith('08')) return true;
  return TRANSIENT_SQLSTATES.has(code);
}

/**
 * Is this fault a TRANSIENT fault of a DEPENDENCY — the kind a sender's
 * re-delivery can actually fix — rather than a fault in fr itself?
 *
 * Read the block above {@link TRANSIENT_INTEGRATION_CODES} first: the answer
 * decides between a `503` that asks the sender to re-deliver and a `200` that
 * deliberately retires the message, and the two mistakes are not symmetric.
 *
 * Exported for the same reason `initiatorFor` is: a predicate this load-bearing
 * that can only be reached through a webhook dispatch is a predicate nobody can
 * mutate, and an un-mutatable predicate is not defended by anything.
 *
 * ⚠️ WHERE IT IS DELIBERATELY SILENT, stated rather than implied:
 *   * `SERVICE_AUTH_FAILED` and `UPSTREAM_UNAUTHORIZED` are NOT transient. Both
 *     mean a credential was refused — a rotated secret, a wrong realm — and no
 *     re-delivery fixes either. A Keycloak that is merely DOWN raises
 *     `UPSTREAM_UNREACHABLE` instead (`serviceAuthIntegrationError`: no status
 *     ⇒ unreachable), which IS admitted, so the ridable case is still covered.
 *   * `UPSTREAM_BAD_BODY` is not transient: an upstream that answers with
 *     nonsense answers with the same nonsense next time.
 *   * `coding_slice_not_landed` maps to a 503 in `httpStatusFor` but is a
 *     DOMAIN state ("not landed yet"), not a dependency fault, so it is not
 *     admitted here. This is the one exclusion I am least certain of — if a
 *     channel-reachable action ever returns it, re-delivery may genuinely be
 *     the right answer and it should move.
 */
export function isTransientDependencyFault(err: unknown): boolean {
  if (isIntegrationError(err)) {
    if (TRANSIENT_INTEGRATION_CODES.has(err.code)) return true;
    if (err.code === 'UPSTREAM_BAD_STATUS') {
      // The upstream ANSWERED. Only its own "unavailable"/"too many" family is
      // worth re-delivering for; a 404 or a 422 is permanent.
      return (
        typeof err.upstreamStatus === 'number' && TRANSIENT_UPSTREAM_STATUS.has(err.upstreamStatus)
      );
    }
    // Every remaining code is fr's own invariant, fr's own credential, or the
    // caller's input. See the exclusions in this function's doc comment.
    return false;
  }
  // Not an `IntegrationError`, so nothing has NAMED a dependency — the only
  // remaining positive evidence is a driver-level one. Both arms below are
  // Postgres/socket-shaped, which is exactly the population this leg's one
  // unguarded non-`fetch` dependency produces.
  const sqlstate = pgErrorCode(err);
  if (sqlstate !== undefined && isTransientSqlstate(sqlstate)) return true;
  return hasTransientDriverCode(err);
}

/**
 * The dependency a transient fault is credited to, for the TELEMETRY only.
 *
 * An `IntegrationError` names its own service, and `reportSwallowedFailure`
 * prefers that over whatever is passed here. Everything else
 * `isTransientDependencyFault` admits is a Postgres-driver or socket code, and
 * the one unguarded non-`fetch` dependency reachable from either of these two
 * legs is Postgres — so `'postgres'` is a reading of the predicate rather than
 * a guess at the incident. `'unknown'` for an `IntegrationError` that named no
 * service: a wrong attribution in the failure ranking is worse than an absent
 * one, which is the whole lesson of the `fr-streams` mis-attribution recorded
 * in `integrations/_lib/errors.ts`.
 */
function transientFaultService(err: unknown): string {
  if (isIntegrationError(err)) return err.service ?? 'unknown';
  return 'postgres';
}

function sleep(ms: number): Promise<void> {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function truncatedJson(value: unknown, max = 500): string {
  let s: string;
  try {
    s = JSON.stringify(value);
  } catch {
    s = String(value);
  }
  if (s === undefined) s = String(value);
  return s.length > max ? s.slice(0, max - 3) + '...' : s;
}

async function postReplySafely(
  channelName: string,
  threadId: string | undefined,
  message: ChannelMessage,
): Promise<void> {
  const ch = registry.get(channelName);
  if (!ch) {
    console.warn(`[channels] postReply skipped: channel not registered: ${channelName}`);
    return;
  }
  try {
    await ch.postReply(threadId, message);
  } catch (err) {
    console.error(
      `[channels] postReply failed channel=${channelName} cid=${message.correlationId}:`,
      err instanceof Error ? err.message : err,
    );
  }
}

/**
 * The retriable refusal, for the two legs (steps 2 and 3) whose catch block
 * sees transient AND fr-side faults on one line and must therefore ask
 * {@link isTransientDependencyFault} first.
 *
 * SAME three records and SAME wire shape as the hand-written refusals at step 1
 * and step 2b, deliberately — one rule for every dependency and every channel:
 *   (a) `spanAttrs.degraded` names the leg (NOT `outcome`: `emitSpan` strips a
 *       caller-supplied `outcome`, so that key would be silently discarded);
 *   (b) a `channel_inbound_unprocessed` stdout line an operator greps by
 *       correlation id, agreeing with the wire on `http_status` and `acked`;
 *   (c) `reportSwallowedFailure`, so the degrade stays in the standing
 *       `integration_error` ranking instead of living only in this file.
 * The body is `{error, retryable, correlationId}` with NO `status` key — the
 * 2xx-with-a-status-word shape is pinned NEGATIVELY by the sibling tests
 * precisely so it cannot creep back in alongside a 503.
 *
 * ⚠️ THE TWO OLDER LEGS ARE NOT FOLDED IN HERE, and that is a scope decision
 * rather than an oversight: step 2b's record carries an `attempts` field this
 * signature has no business inventing for legs that have no retry budget, and
 * the inline prose at both of them IS the fr#1292 / fr#1243 decision record.
 * Converging all four is a readable follow-up.
 *
 * ⚠️ It inherits the SAME ACKNOWLEDGED RESIDUAL as both of them:
 * `reportSwallowedFailure` hardcodes `http_status: null`, which is literally
 * inaccurate once a 503 IS served. It is still the ONLY exported route onto the
 * ranking, and absent-from-the-ranking is worse than present-with-one-wrong-
 * field, so `degradedTo` names the served status in text.
 */
function refuseTransiently(
  msg: InboundMessage,
  err: unknown,
  opts: {
    /** Span + log `reason`, e.g. `intent-unavailable`. */
    reason: string;
    /** The wire `error` code, e.g. `intent_unavailable`. */
    errorCode: string;
    /** The action reached, or `null` when intent never resolved. */
    action: string | null;
    /** Whether `invokeAction` had already been ENTERED. See step 3. */
    actionInvoked: boolean;
    spanAttrs?: { action: string; degraded?: string };
  },
): Response {
  if (opts.spanAttrs) {
    opts.spanAttrs.degraded = opts.reason;
  }
  try {
    console.error(
      JSON.stringify({
        telemetry: 'channel_inbound_unprocessed',
        reason: opts.reason,
        channel: msg.channel,
        address: msg.address,
        action: opts.action,
        http_status: DEPENDENCY_UNAVAILABLE_STATUS,
        acked: false,
        action_invoked: opts.actionInvoked,
        correlation_id: msg.correlationId,
        message: err instanceof Error ? err.message : String(err),
      }),
    );
  } catch {
    // Recording must never itself become the failure — (c) below still fires.
  }
  reportSwallowedFailure(err, {
    service: transientFaultService(err),
    degradedTo:
      `channel ${msg.channel} inbound -> ${opts.reason}: refused http ` +
      `${DEPENDENCY_UNAVAILABLE_STATUS} (retriable), action ${opts.action ?? 'null'} ` +
      `${opts.actionInvoked ? 'INVOKED and failed' : 'NOT invoked'}`,
  });
  return jsonResponse(
    {
      error: opts.errorCode,
      // A restatement of the 503, not a substitute for it. See step 2b.
      retryable: true,
      correlationId: msg.correlationId,
    },
    DEPENDENCY_UNAVAILABLE_STATUS,
    { 'Retry-After': String(DEPENDENCY_UNAVAILABLE_RETRY_AFTER_S) },
  );
}

/**
 * Dispatcher pipeline (spec §"Dispatcher flow"):
 *   1. resolveIdentity → `null` is an ANSWER (a stranger): friendly
 *      "unknown sender" reply + 200 ack. A THROW is a FAULT (an outage is not a
 *      stranger): REFUSED with a retriable `503 identity_unavailable`, no reply
 *      and no action — recorded on the span, in `channel_inbound_unprocessed`
 *      and in the swallowed-failure ranking (fr#1292).
 *   2. resolveIntent → if no-action, optional reply text. A THROW is SPLIT by
 *      `isTransientDependencyFault` (fr#1295): a transient dependency fault —
 *      (historically `findLastPendingApproval`'s Postgres read, removed with
 *      the grammar's bare yes/no binding) — is REFUSED with a retriable
 *      `503 intent_unavailable` and no reply, while an fr-side fault keeps the
 *      200 ack + the action-error reply.
 *   2b. tenant lookup (`resolveChannelTenant`, SPEC §6.5 rule 2) → `none` or
 *      `ambiguous` is an ANSWER: refused with the rule-2 reply, nothing entered;
 *      a THROW is a FAULT, retried in-request and then
 *      REFUSED with a retriable `503 tenant_unavailable` WITHOUT invoking the
 *      action — recorded on the span, in `channel_inbound_unprocessed` and in
 *      the swallowed-failure ranking (fr#1243).
 *   3. invokeAction → branch on PendingAction vs sync result vs error. An
 *      exception is SPLIT the same way step 2 is (fr#1295): a transient
 *      dependency fault inside the action — a handler's upstream call arriving
 *      as a retriable `IntegrationError` — is REFUSED with a retriable
 *      `503 action_dependency_unavailable`, while an fr-side fault keeps the
 *      200 ack + the action-error reply.
 *
 * ⭐ THE ASYMMETRY IS THE WHOLE DESIGN, AND IT IS ABOUT WHO FAILED, NOT WHICH
 * STEP IT WAS. A transient DEPENDENCY fault is refused retriably at every one
 * of the four legs, because the sender's re-delivery is the recovery. A fault
 * in fr ITSELF keeps the 2xx at steps 2 and 3, because re-delivery would fail
 * identically and a 5xx would make a machine sender loop into a broken fr —
 * which is why `isTransientDependencyFault` demands positive evidence and
 * defaults to fr-side. Steps 1 and 2b need no such predicate: their resolvers
 * have a zero-throw contract, so a throw there is NECESSARILY a fault.
 *
 * Exported only so unit tests can spy on it; production callers go through
 * `channelDispatcher.handleWebhook` which wraps this in withRequestContext +
 * emitSpan('channels.dispatch').
 */
/**
 * A `PER_WORKSPACE_CHANNEL_READS` command for a sender whose tenant is not ONE
 * workspace: run it once in each of the sender's own workspaces (an empty list ⇒
 * one run with no tenant, which the read answers fail-closed as "nothing") and
 * combine the answers. Every run gets its own dispatcher-marked context.
 */
async function runPerWorkspace(
  tenants: ChannelTenant[],
  base: ActionContext,
  runIn: (ctx: ActionContext) => Promise<unknown>,
): Promise<unknown> {
  if (tenants.length === 0) {
    return runIn(markChannelDispatched({ ...base, tenantId: undefined, tenantName: undefined }));
  }
  const workspaces: Array<Record<string, unknown>> = [];
  const texts: string[] = [];
  for (const t of tenants) {
    const label = t.name?.trim() || t.id;
    const ctx = markChannelDispatched({ ...base, tenantId: t.id, tenantName: t.name?.trim() || undefined });
    const one = await runIn(ctx);
    const rec = one && typeof one === 'object' ? (one as Record<string, unknown>) : { value: one };
    workspaces.push({ workspace: label, workspace_id: t.id, ...rec });
    texts.push(`[${label}]\n${typeof rec.text === 'string' ? rec.text : truncatedJson(one)}`);
  }
  // `text` first: the channel reply is a truncated JSON of this object.
  return { text: texts.join('\n\n'), workspaces };
}

/** fr's own code → the mcp wire code where the names differ (fr #1683). */
const MCP_CODE_ALIASES: Readonly<Record<string, string>> = {
  channel_sender_not_tenant_member: 'not_a_member',
};

/**
 * fr #1683: the machine-readable reason an mcp caller gets in `code` — the agent escalates
 * by it, so it is fr's specific cause (AppError.withCode), snake_case `[a-z_]`, at most 64
 * characters; `forbidden` / `error` only when fr names none. Other channels keep the class
 * name their callers already read.
 */
export function mcpRefusalCode(err: unknown): string {
  if (err instanceof AppError && err.code) {
    const raw = MCP_CODE_ALIASES[err.code] ?? err.code;
    const wire = raw.toLowerCase().replace(/[^a-z_]+/g, '_').replace(/_+/g, '_').replace(/^_|_$/g, '').slice(0, 64);
    if (wire) return wire;
  }
  return err instanceof AppError && err.statusCode === 403 ? 'forbidden' : 'error';
}

/**
 * Who is credited as the INITIATOR of a channel-dispatched action.
 *
 * Exported and pure so the security decision can be exhaustively exercised —
 * it was inlined at the call site and, measured 2026-09-04, BOTH mutants
 * survived: forcing the heuristic resolver to claim determinism, and dropping
 * the identity requirement entirely, each left 560 tests passing. An
 * un-mutatable authorisation predicate is not defended by anything.
 *
 * Both conditions are required and neither is sufficient:
 *   (a) `matchedDeterministically` — fr's own grammar matched the raw inbound
 *       text (a fixed verb, or a typed `<tool>.<verb> {json}` on a sender-verified
 *       channel); no model chose the action. The LLM resolver, the heuristic
 *       fallback and an email/Teams `{json}` report false, so they still park.
 *       ⚠️ The flag is set per-resolver and never derived from "a regex matched".
 *   (b) a resolved Keycloak identity.
 *
 * ⚠️ Neither proves personhood — see the call site's RESIDUAL RISK note.
 */
export function initiatorFor(
  resolved: { matchedDeterministically?: boolean },
  userId: string | null | undefined,
): ActionContext['initiator'] {
  return resolved.matchedDeterministically === true && Boolean(userId)
    ? 'human'
    : 'agent';
}

export async function dispatchInbound(
  msg: InboundMessage,
  spanAttrs?: { action: string; degraded?: string },
  opts?: DispatchOptions,
): Promise<Response> {
  const baseMeta: Record<string, unknown> = { address: msg.address };

  // 1. Identity.
  //
  // ⚠️ Two DIFFERENT things used to land here as one: the directory answering
  // "nobody has this address", and the directory not answering at all. Both
  // produced `identity = null` and therefore the same reply — which told a
  // sender during a Keycloak outage to go and link an address they had already
  // linked. A user is not going to fix an outage by re-linking, so an
  // instruction they cannot act on is worse than no answer. THAT HALF STANDS:
  // `null` and a THROW are still told apart here, and the genuine miss below
  // still gets the linking hint.
  //
  // ⛔ fr#1292 — WHAT THAT FIX GOT WRONG WAS THE STATUS, AND IT WAS THE HALF
  // THAT LOST THE MESSAGE. Its own closing line was `Keep the 200 ack (webhook
  // contract) and keep the reply friendly, but say the true thing`, and it did
  // exactly that. But the "webhook contract" it preserved is written down
  // nowhere as requiring 2xx on a DEPENDENCY FAULT — the 2xx in this file only
  // ever covered step 3, where fr ITSELF is what failed and a re-delivery would
  // fail identically. A Keycloak fault is the opposite case, and there a 2xx is
  // not neutral: telegram, Mailgun and every other machine sender branches on
  // the STATUS LINE and never on our body, so `{status:'identity-unavailable'}`
  // under a 200 said "delivered, do not send it again" during the one outage in
  // which the sender's re-delivery was the only surviving recovery path. The
  // body was honest and the status was not, and only one of the two is read by a
  // machine. Same class, same shape and same one-rule-for-every-channel
  // reasoning as the tenant refusal at step 2b — read that branch for the full
  // argument, including why 503 rather than the 500 a bare throw produces, why
  // `retryable: true` restates the status instead of substituting for it, and
  // why there is deliberately no durable park.
  //
  // ⛔ AND THE REPLY IS GONE, for the reason step 2b gives: `postReplySafely`
  // (:140) catches and LOGS its own failure, and for `inapp` the reply leg runs
  // on infrastructure that can be inside this very outage — so the courtesy
  // message is the part most likely to evaporate exactly when it would matter.
  // The 503 + `Retry-After` carries the same request ("nothing was done, send it
  // again") to the only reader that acts on it without a human.
  //
  // ⚠️ NOT DONE HERE, AND STATED RATHER THAN IMPLIED: there is no in-request
  // retry budget on this leg, unlike the tenant lookup at step 2b. A Keycloak
  // blip is as ridable as a Postgres one, so a budget here would make this
  // refusal rarer — but it is a behaviour change with its own latency and its
  // own tests, and fr#1292 is the status. Adding one belongs in its own unit.
  let identity: IdentityResolution | null = null;
  let identityUnavailable: unknown = null;
  try {
    identity = await agentCore.resolveIdentity(msg);
  } catch (err) {
    identityUnavailable = err;
  }
  if (identityUnavailable) {
    // REFUSE the delivery, retriably. Nothing is acked, nothing is parked, and
    // no action ran — intent was never even resolved, which is the ONE
    // structural difference from step 2b's record: there is no action to name,
    // so the field is explicitly `null` rather than omitted.
    if (spanAttrs) {
      spanAttrs.degraded = 'identity-unavailable';
    }
    try {
      console.error(
        JSON.stringify({
          telemetry: 'channel_inbound_unprocessed',
          reason: 'identity-unavailable',
          channel: msg.channel,
          address: msg.address,
          action: null,
          http_status: DEPENDENCY_UNAVAILABLE_STATUS,
          acked: false,
          action_invoked: false,
          correlation_id: msg.correlationId,
          message:
            identityUnavailable instanceof Error
              ? identityUnavailable.message
              : String(identityUnavailable),
        }),
      );
    } catch {
      // Recording must never itself become the failure — the ranking below still fires.
    }
    // ⚠️ THE SAME ACKNOWLEDGED RESIDUAL as step 2b, kept for the same reason:
    // this helper hardcodes `swallowed: true, http_status: null`, and that null
    // is now literally inaccurate here because a 503 IS served. It stays because
    // it is the ONLY exported route onto the standing `integration_error`
    // ranking, and being absent from that ranking is worse than being present
    // with one wrong field; `degradedTo` names the 503 explicitly so no reader
    // is misled. Proper fix — export `reportServedFailure(err, ctx, httpStatus)`
    // from `integrations/_lib/errors.ts` — is tracked separately and is
    // deliberately NOT done here.
    reportSwallowedFailure(identityUnavailable, {
      service: 'keycloak',
      degradedTo:
        `channel ${msg.channel} inbound -> identity-unavailable: refused http ` +
        `${DEPENDENCY_UNAVAILABLE_STATUS} (retriable), no intent resolved and no ` +
        `action invoked`,
    });
    return jsonResponse(
      {
        error: 'identity_unavailable',
        // A restatement of the 503, not a substitute for it. See step 2b.
        retryable: true,
        correlationId: msg.correlationId,
      },
      DEPENDENCY_UNAVAILABLE_STATUS,
      { 'Retry-After': String(DEPENDENCY_UNAVAILABLE_RETRY_AFTER_S) },
    );
  }
  if (!identity) {
    await postReplySafely(msg.channel, msg.threadId, {
      kind: 'text',
      correlationId: msg.correlationId,
      text:
        "I couldn't identify your account. Please link your channel address to your account first.",
      meta: baseMeta,
    });
    return jsonResponse({
      status: 'unknown-sender',
      correlationId: msg.correlationId,
    });
  }

  // 2. Intent.
  let resolved;
  try {
    // fr-agui SPEC §6.5 rule 1-2: intent is resolved for the RESOLVED identity.
    // A channel parser carries the sender's ADDRESS in `userId` (an email
    // address, a phone number), and the command grammar's `start` derives the sender's
    // tenant from membership of this id — so it must be the Keycloak user id,
    // never an address the sender controls.
    resolved = await agentCore.resolveIntent({ ...msg, userId: identity.userId });
  } catch (err) {
    // ⛔ fr#1295 — TWO CLASSES OF ERROR LAND HERE AND ONLY ONE OF THEM IS OURS.
    // Until this branch existed, every one of them fell through to the 200 ack
    // below, so a Postgres blip inside `findLastPendingApproval` — then reached
    // by a bare `yes` or `no` (since removed: a bare yes/no is answered by the
    // shared reply flow before intent) — answered telegram / Mailgun
    // "delivered, do not send it again" during the one outage in which their
    // re-delivery was the only surviving recovery path. That is the identical
    // shape fr#1292 fixed at step 1 and fr#1243 at step 2b, one step over:
    // an honest body (`{status:'error', code:'PostgresError'}`) under a lying
    // status, and only the status is machine-read.
    //
    // Same 503, same `Retry-After`, same no-reply, same three records.
    //
    // ⛔ AND THE 200 BELOW IS DELIBERATELY KEPT FOR AN fr-SIDE FAULT. A bug in
    // our own resolver chain fails identically on every re-delivery, so a 5xx
    // there buys nothing and costs an unbounded sender loop into a broken fr.
    // `isTransientDependencyFault` is therefore written to demand positive
    // evidence and default to fr-side — read its doc comment before widening
    // it, because widening it is what reintroduces that loop.
    if (isTransientDependencyFault(err)) {
      // ⛔ No reply, for the reason step 2b gives: `postReplySafely` catches and
      // LOGS its own failure, and for `inapp` it runs on the very Postgres that
      // just faulted. An `Error: PostgresError: …` courtesy reply is also the
      // worst shape in this family — a confident sentence about a fault the
      // reader cannot act on, which is exactly what fr#1292 removed.
      return refuseTransiently(msg, err, {
        reason: 'intent-unavailable',
        errorCode: 'intent_unavailable',
        // Intent never resolved, so there is no action to name — explicitly
        // `null` rather than omitted, matching step 1's record.
        action: null,
        actionInvoked: false,
        spanAttrs,
      });
    }
    console.error(
      `[channels] resolveIntent threw channel=${msg.channel} cid=${msg.correlationId}:`,
      err instanceof Error ? err.message : err,
    );
    await postReplySafely(msg.channel, msg.threadId, {
      kind: 'action-error',
      correlationId: msg.correlationId,
      text: `Error: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`,
      meta: { ...baseMeta, actionId: 'unresolved' },
    });
    return jsonResponse({
      status: 'error',
      code: msg.channel === 'mcp' ? mcpRefusalCode(err) : err instanceof Error ? err.name : 'Error',
      correlationId: msg.correlationId,
    });
  }

  if (spanAttrs && resolved.kind === 'action') {
    spanAttrs.action = resolved.actionName;
  }

  if (resolved.kind === 'no-action') {
    if (resolved.replyText && resolved.replyText.length > 0) {
      await postReplySafely(msg.channel, msg.threadId, {
        kind: 'text',
        correlationId: msg.correlationId,
        text: resolved.replyText,
        meta: baseMeta,
      });
    }
    return jsonResponse({
      status: 'no-action',
      // The refusal's reason for an mcp caller (fr #1683); help and chat replies carry none.
      ...(msg.channel === 'mcp' && resolved.code ? { code: resolved.code } : {}),
      correlationId: msg.correlationId,
    });
  }

  // 3. Action invocation.
  // Resolve the caller's tenant from membership (`resolveChannelTenant`, SPEC
  // §6.5 rule 2). `resolveIdentity` yields only userId + tenantRoles, so
  // without this lookup every action reached from Telegram ran with
  // `ctx.tenantId === undefined`: tenant-scoped handlers saw no tenant to
  // filter or attribute by, and writes that persist an approvals row (which
  // requires a tenant_id) could not be recorded at all.
  // A user with no membership, or with more than one, is REFUSED below — never
  // a fabricated or arbitrarily picked id.
  // ⚠️ fr#1243 — A FAULT HERE IS NOT AN ANSWER. `resolveChannelTenant` returns
  // `none` / `ambiguous` from the rows it read (an ANSWER — refused just below
  // the fault branch). It THROWS when the
  // database is unreachable or the query fails (a FAULT). This call sat OUTSIDE
  // every `try`, so the two were one thing.
  //
  // ⭐ AND fr#1243 AS FILED WAS WRONG ABOUT THE CONSEQUENCE — MEASURED, NOT
  // ASSUMED. The issue says the webhook "REJECTS instead of ACKING" and asked
  // for an ack. Trace what the throw actually produced: out of `dispatchInbound`
  // → out of `emitSpan` (`telemetry/spans.ts` catch block ends `throw err`) →
  // out of `channelDispatcher.handleWebhook` → past the route (every webhook
  // route does a bare `const dispatched = await …handleWebhook(); if
  // (dispatched) return dispatched;`) → into `server.ts`'s request catch, which
  // calls `handleError` → `statusForError`. A drizzle/postgres connection error
  // is not an `AppError`, not a `ZodError`, carries no `ERR_JWT_*`, is not an
  // `AuthenticationError`/`IntegrationError`/`PlankaError`, and its SQLSTATE is
  // not `22P02` — so it falls through to `return 500`. The pre-fix answer was a
  // **500**, i.e. ALREADY a 5xx, i.e. ALREADY the thing that makes a sender
  // re-deliver. The premise "a rejection loses the message" was false.
  //
  // ⛔ SO AN ACK WOULD HAVE BEEN THE REGRESSION, AND THAT IS WHY THIS BRANCH
  // REFUSES. `retryable: true` on a 2xx is decorative: telegram, Mailgun and
  // every other machine sender branch on the STATUS, never on our body, so a 200
  // stops re-delivery permanently. Acking here would have converted a
  // sender-retriable fault into silent loss — strictly worse than the 500 it
  // replaced. What WAS wrong with the 500 is only that it was unlabelled: a
  // transient dependency outage was indistinguishable from an fr bug, carried no
  // `Retry-After`, and produced no record naming the channel delivery. This
  // branch fixes exactly that and nothing more.
  //
  // THROW vs ANSWER is the transient/legitimate discriminator, and it is the
  // resolver's own documented contract rather than a guess at an error string:
  // `resolveChannelTenant` contains ZERO `throw` sites of its own, `none` means
  // `!userId` or no row, a malformed id cannot raise 22P02 because
  // `user_roles.user_id` is `text`, and revocation is a row delete rather than a
  // flag. The other legitimate refusals never reach this line at all: a
  // malformed payload or a bad signature is refused in the channel's
  // `parseWebhook` (which returns null and makes `handleWebhook` fall through),
  // and an unknown sender is refused by the `unknown-sender` branch above.
  //
  // Retry in-request FIRST. A blip is normally sub-second, so a message saved
  // here is fully processed and the sender never has to re-send — which is what
  // makes the refusal below rare rather than routine.
  // ⛔ P1-TEAM-a: a web chat-box channel is a WEB SESSION only when the server
  // handed it the session's tenant. Without one (the `web` N8N_WEBHOOK_SECRET
  // thread injection) it used to fall back to `getUserTenant` — a `LIMIT 1` with
  // no `ORDER BY`, an ARBITRARY pick for a multi-workspace sender — and that pick
  // is now an access decision (every tenant member acts on every project of the
  // tenant). So it takes the external channels' rule instead: membership only,
  // exactly one workspace, else the refusal below. Fail closed, never a pick.
  const session = opts?.sessionTenant;
  const webSession = WEB_SESSION_CHANNELS.has(msg.channel) && Boolean(session?.id);
  const senderId = identity.userId;
  let linkedTenantId: string | null = null;
  const lookupTenant = async (): Promise<ChannelTenantResolution> => {
    if (webSession && session?.id) {
      return { kind: 'ok', tenant: { id: session.id, name: session.name ?? null } };
    }
    linkedTenantId = await findLinkedTenant(msg.channel, msg.address, senderId);
    return resolveChannelTenant(senderId, linkedTenantId);
  };
  let tenantResolution: ChannelTenantResolution | null = null;
  let tenantFault: unknown = null;
  let tenantAttempts = 0;
  for (let i = 0; i < TENANT_LOOKUP_ATTEMPTS; i += 1) {
    tenantAttempts = i + 1;
    try {
      tenantResolution = await lookupTenant();
      tenantFault = null;
      break;
    } catch (err) {
      // Held, never dropped: the branch below is what reports it. This is not a
      // silent catch — if the budget is exhausted `tenantFault` is still set and
      // every record below fires.
      tenantFault = err;
      if (i < TENANT_LOOKUP_ATTEMPTS - 1) {
        await sleep(TENANT_LOOKUP_BACKOFF_MS[i] ?? 0);
      }
    }
  }

  if (tenantFault) {
    // REFUSE the delivery, retriably. Nothing is acked and nothing is parked:
    // the sender still owns this message, and the status is what tells it so.
    //
    // ⛔ WHY 503 AND NOT 200, AND WHY NOT THE PRE-FIX 500.
    //   * 200 is wrong because it ENDS re-delivery. See the block above: the
    //     senders branch on the status line, so an ack would have been the only
    //     thing in this whole path capable of losing the message.
    //   * 500 (what fell out before) is retriable but says "fr is broken",
    //     conflating a momentary Postgres outage with a code defect, and carries
    //     no `Retry-After`.
    //   * 503 is the repo's own idiom for "this service cannot serve right now,
    //     come back" — `lib/readiness.ts` ("so 503 — 'do not send me traffic' —
    //     is honest"), `routes/internal-projects-tenant-map.ts`,
    //     `routes/projects.ts:1196`, and 10 more sites all spell it
    //     `jsonResponse({ error: '<snake_code>' }, 503)`. It is also in
    //     `integrations/_lib/http-client.ts`'s `RETRYABLE_STATUS`
    //     ({502,503,504}), so fr's OWN client would retry it — the body's
    //     `retryable: true` therefore RESTATES the status rather than
    //     substituting for it, which is the whole difference from the 2xx
    //     version of this field.
    //
    // ⚠️ ONE RULE FOR EVERY CHANNEL, DELIBERATELY. The registered adapters are
    // email, inapp, mcp, teams, telegram, voice (a stub whose `parseWebhook`
    // always returns null, so it never reaches here) and web. Their senders'
    // re-delivery policies are NOT uniformly knowable from this repo — the
    // Teams relay in particular is configured outside it — so
    // per-channel behaviour is not split here. An asymmetry nobody can state is
    // worse than one rule, and 503 is the one rule that is safe under BOTH
    // possibilities: a sender that retries re-delivers, and a sender that does
    // not at least surfaces an error to a human instead of a false success.
    //
    // ⚠️ WHAT THIS DOES NOT DO, STATED RATHER THAN IMPLIED: there is no durable
    // park, and there is deliberately no channel reply. A dead-letter row would
    // have to be written to the database that just faulted. And a reply goes
    // through `postReplySafely`, which catches and LOGS its own failure (:140) —
    // and for `inapp` the reply leg is the notification service on the SAME
    // Postgres that just faulted, so in the very outage this branch exists for
    // the reply is the thing most likely to vanish. A retriable status the
    // sender must handle is strictly more reliable than a courtesy message that
    // can silently evaporate, and it already asks for the same thing.
    //
    // The refusal is recorded three independent ways, each for a different
    // reader:
    //   (a) `channel_inbound_unprocessed` — the joinable stdout line an operator
    //       greps by correlation id. It names the action that did NOT run and
    //       says `http_status: 503, acked: false, action_invoked: false`;
    //   (b) `reportSwallowedFailure` → the standing `integration_error` ranking,
    //       so this degrade is counted alongside every other one instead of
    //       living only in this file;
    //   (c) `spanAttrs.degraded` — the `channels.dispatch` span carries the
    //       reason. Kept even though `emitSpan` now also records
    //       `http.status_code: 503` and `outcome: 'error'` from the returned
    //       Response: the status says something failed, `degraded` says WHICH
    //       dependency, and only the second one is greppable by reason.
    if (spanAttrs) {
      spanAttrs.degraded = 'tenant-unavailable';
    }
    try {
      console.error(
        JSON.stringify({
          telemetry: 'channel_inbound_unprocessed',
          reason: 'tenant-unavailable',
          channel: msg.channel,
          address: msg.address,
          action: resolved.actionName,
          attempts: tenantAttempts,
          http_status: DEPENDENCY_UNAVAILABLE_STATUS,
          acked: false,
          action_invoked: false,
          correlation_id: msg.correlationId,
          message: tenantFault instanceof Error ? tenantFault.message : String(tenantFault),
        }),
      );
    } catch {
      // Recording must never itself become the failure — (b) below still fires.
    }
    // ⚠️ ACKNOWLEDGED RESIDUAL, because the alternative is worse. This helper
    // hardcodes `swallowed: true, http_status: null`, and its own doc says the
    // null "is what distinguishes a swallowed failure from a served one" — which
    // is now literally inaccurate here, since a 503 IS served. It is kept
    // because it is the ONLY exported route onto the standing `integration_error`
    // ranking (`logIntegrationFailure`, which takes the real status, is
    // module-private, and `integrationErrorResponse` would force a 502 and a
    // wrapper `IntegrationError`), and being absent from that ranking is a worse
    // failure than being present with one wrong field. `degradedTo` therefore
    // names the 503 explicitly so no reader is misled by the null. Proper fix —
    // export a `reportServedFailure(err, ctx, httpStatus)` — belongs in
    // `integrations/_lib/errors.ts`, which is outside this change's scope.
    reportSwallowedFailure(tenantFault, {
      service: 'postgres',
      degradedTo:
        `channel ${msg.channel} inbound -> tenant-unavailable: refused http ` +
        `${DEPENDENCY_UNAVAILABLE_STATUS} (retriable), action ${resolved.actionName} ` +
        `NOT invoked after ${tenantAttempts} tenant-lookup attempts`,
    });
    return jsonResponse(
      {
        error: 'tenant_unavailable',
        // A restatement of the 503, not a substitute for it. See the block above.
        retryable: true,
        correlationId: msg.correlationId,
      },
      DEPENDENCY_UNAVAILABLE_STATUS,
      { 'Retry-After': String(DEPENDENCY_UNAVAILABLE_RETRY_AFTER_S) },
    );
  }

  // fr-agui SPEC §6.5 rule 2 (layer 1), scoped to the commands that need a
  // tenant. The pre-P0a lookup (`getUserTenant`, `LIMIT 1` with no ORDER BY)
  // picked an ARBITRARY workspace for a multi-workspace sender — a cross-tenant
  // risk for every write. So on an EXTERNAL channel:
  //   - a tenant-free command (`help`) is answered for any linked sender;
  //   - a per-workspace read (`status`) is answered in EACH of the sender's
  //     workspaces, or empty for a zero-workspace sender;
  //   - every other command (start / approve / reject / card / comment / a direct
  //     `<tool>.<verb>` invocation) is REFUSED for a zero- or multi-workspace
  //     sender, before the action is entered: nothing parks, nothing is created.
  // fr's own web chat-box channels take the web session's tenant instead
  // (`WEB_SESSION_CHANNELS`) and are never refused here.
  // A refusal is an ANSWER, not a fault: 200, nothing for the sender to re-deliver.
  let tenant: ChannelTenant | null = null;
  let fanOutTenants: ChannelTenant[] | null = null;
  if (tenantResolution?.kind === 'ok') {
    tenant = tenantResolution.tenant;
  } else if (!webSession && !TENANT_FREE_CHANNEL_ACTIONS.has(resolved.actionName)) {
    const unresolved: Exclude<ChannelTenantResolution, { kind: 'ok' }> = tenantResolution ?? { kind: 'none' };
    if (unresolved.kind === 'none' && PER_WORKSPACE_CHANNEL_READS.has(resolved.actionName)) {
      fanOutTenants = [];
    } else if (unresolved.kind === 'ambiguous' && unresolved.tenants && PER_WORKSPACE_CHANNEL_READS.has(resolved.actionName)) {
      fanOutTenants = unresolved.tenants;
    } else {
      await postReplySafely(msg.channel, msg.threadId, {
        kind: 'text',
        correlationId: msg.correlationId,
        text: channelTenantRefusalText(unresolved),
        meta: baseMeta,
      });
      return jsonResponse({
        status: 'no-action',
        // The reason, for an mcp caller (fr #1683): no membership, several, or a stale home.
        ...(msg.channel === 'mcp'
          ? { code: unresolved.kind === 'none' ? 'not_a_member' : unresolved.kind === 'mismatch' ? 'tenant_mismatch' : 'tenant_ambiguous' }
          : {}),
        correlationId: msg.correlationId,
      });
    }
  }

  // Initiator provenance. `autoApproveForInitiator` exists so that a person
  // doing their own self-service write is not made to approve themselves,
  // while an agent proposing the same write still parks for review. Before
  // this, `initiator` was hardcoded 'agent' here, so `shouldSelfApprove` was
  // unreachable from every channel and the flag was dead on this path.
  //
  // Two INDEPENDENT conditions, both required:
  //   (a) `matchedDeterministically` — fr's own grammar matched the raw inbound
  //       text (`card X: title`, `comment <id>: text`, `start …`, or a typed
  //       `<tool>.<verb> {json}` on Telegram/mcp). No model chose this
  //       action. The LLM resolver, the heuristic fallback and an email/Teams
  //       `{json}` report false and so still park.
  //   (b) a resolved Keycloak identity — `resolveIdentity` mapped the sender's
  //       channel address to a real account. An unlinked sender never reaches
  //       here at all.
  //
  // ⚠️ RESIDUAL RISK, stated plainly: neither condition proves personhood.
  // `resolveIdentity` returns a userId, not evidence that a human typed the
  // message — a bot or an n8n workflow posting into a Telegram thread
  // linked to a registered user resolves to that user and, if it emits exactly
  // the grammar's literal shape, self-approves. The condition is kept as
  // narrow as the evidence supports: the grammar is server-side and fixed (the
  // caller cannot assert its own initiator, unlike a request body field). Its
  // verbs and a typed `<action> {json}` count (George 2026-10-30: a channel is
  // one more interface to operate fr as the person); an LLM's pick never does. Widening either
  // condition — inferring `matchedDeterministically` from "a regex matched",
  // or accepting a caller-supplied initiator — reopens the hole this closes.
  // fr #1683 (owner rulings 2026-10-31): the agent platform is fr's autonomous user over
  // mcp. An agent member is a normal member within its admin-assigned role — the same
  // grammar rule for `human` initiator as anyone's own Telegram, so it runs writes and
  // decides approvals itself; agent decisions are allowed and recorded as
  // decided_by_kind='agent' (decidedByKindFor), with `via` naming the agent member and job.
  // Option A: a message that names `on_behalf_of` — a member of the agent's tenant (a
  // direct staff click relayed by the agent) — runs AS THAT PERSON, exactly as their own
  // Telegram message would (decide rights, APPROVER_IS_REQUESTER and
  // membership as usual), recorded 'human' + via. An unresolvable on_behalf_of is refused.
  let actor = { userId: identity.userId, tenantRoles: identity.tenantRoles, homed: !identity.agentMember };
  let decisionVia: DecisionVia | undefined;
  if (identity.agentMember && msg.onBehalfOf !== undefined) {
    let staff: { userId: string; tenantRoles: string[]; homed: boolean } | null = null;
    try {
      const sub = msg.onBehalfOf;
      if (tenant && !isAgentMemberId(sub) && (await isChannelWorkspaceMember(sub, tenant.id))) {
        const roles = await keycloak.getUserRealmRolesIfUserExists(sub);
        if (roles !== null) staff = { userId: sub, tenantRoles: roles, homed: await userHomedIn(sub, tenant.id) };
      }
    } catch (err) {
      return refuseTransiently(msg, err, {
        reason: 'on-behalf-of-unavailable',
        errorCode: 'identity_unavailable',
        action: resolved.actionName,
        actionInvoked: false,
        spanAttrs,
      });
    }
    if (!staff) {
      await postReplySafely(msg.channel, msg.threadId, {
        kind: 'text',
        correlationId: msg.correlationId,
        text: 'Nothing was done: on_behalf_of is not a member of this workspace.',
        meta: baseMeta,
      });
      return jsonResponse({ status: 'no-action', code: 'not_a_member', correlationId: msg.correlationId });
    }
    actor = staff;
  }
  if (identity.agentMember) {
    decisionVia = {
      channel: msg.channel,
      agent_member_id: identity.userId,
      product: identity.agentMember.product,
      ...(msg.jobId ? { job_id: msg.jobId } : {}),
    };
  }
  const initiator = initiatorFor(resolved, actor.userId);

  const actionCtx: ActionContext = {
    userId: actor.userId,
    projectId: null,
    correlationId: msg.correlationId,
    initiator,
    channel: msg.channel,
    tenantRoles: actor.tenantRoles,
    tenantId: tenant?.id ?? undefined,
    tenantName: tenant?.name?.trim() || undefined,
    // An `ok` channel tenant is the sender's Keycloak home (resolveChannelTenant checks
    // userHomedIn), so it is the raw claim a web token carries: the realm `tenant_admin`
    // arm applies on a channel as on the web. Never for a web session (its own token
    // decides), a fan-out read, or the `sub` fallback.
    // Through the agent member the tenant is the agent's pin, so it is the staff member's raw
    // claim only when Keycloak homes them there.
    ...(tenant && !webSession && actor.homed && tenant.id !== actor.userId ? { tenantClaim: tenant.id } : {}),
    ...(decisionVia ? { decisionVia } : {}),
    ...(identity.linkedAccountIds && identity.linkedAccountIds.length > 1
      ? { channelLinkedAccountIds: identity.linkedAccountIds }
      : {}),
    ...(webSession ? { channelWebSession: true } : {}),
    ...(linkedTenantId ? { channelLinkedTenantId: linkedTenantId } : {}),
  };
  // Server-side provenance: THIS context was built by the dispatcher, so a
  // confirm-card write may park for `approve <id>` (registry, SPEC §5.2 P).
  markChannelDispatched(actionCtx);

  try {
    // Re-enter the ALS frame with the identity we just resolved.
    //
    // `handleWebhook` opens the frame (see below in this file) BEFORE
    // `resolveIdentity` has run, so it can only carry
    // `{correlationId, initiator, channel}` — and `http-client.buildHeaders`
    // reads `getTenantId()` off THAT frame, not off `ActionContext`. Setting
    // `actionCtx.tenantId` above is therefore necessary but NOT sufficient:
    // without this nested frame the Telegram path still sends no
    // `X-Tenant-Id`, and tenant-scoped upstreams fall back to their own
    // DEFAULT_TENANT_ID — the same cross-tenant read measured on the agui path.
    //
    // Worse, it would look fixed: `ctx.tenantId` is correct here, so any
    // assertion made at the handler level passes while the wire is still wrong.
    // The header is the thing to assert on.
    //
    // `withRequestContext` is `requestContext.run`, which REPLACES the frame for
    // its callback rather than merging, so every field the outer frame set must
    // be restated here. `bearerToken` stays absent deliberately — a channel
    // caller has no Keycloak JWT to forward.
    //
    // `initiator` is restated from `actionCtx` for the same reason as
    // `tenantId`: this frame REPLACES the outer one, so a hardcoded 'agent'
    // here would leave the ALS frame (and every span / outbound header derived
    // from it) disagreeing with the context the action actually ran under.
    const runIn = (ctx: ActionContext): Promise<unknown> =>
      withRequestContext(
        {
          correlationId: msg.correlationId,
          initiator: ctx.initiator,
          channel: msg.channel,
          tenantId: ctx.tenantId,
          userId: actor.userId,
          subjectId: actor.userId,
        },
        () => invokeAction(resolved.actionName, resolved.input, ctx),
      );
    const out = fanOutTenants
      ? await runPerWorkspace(fanOutTenants, actionCtx, runIn)
      : await runIn(actionCtx);
    if (
      out !== null &&
      typeof out === 'object' &&
      (out as PendingAction).status === 'pending' &&
      typeof (out as PendingAction).actionId === 'string'
    ) {
      const pending = out as PendingAction;
      // fr-agui SPEC §5.2 (P): the reply names the APPROVAL id — the id
      // `approve <id>` / `reject <id>` and `PUT /api/approvals/:approvalId` take.
      // (A PendingAction cached before P0a carries only the action id.)
      const approvalId = pending.approvalId ?? pending.actionId;
      const pendingText = getAction(resolved.actionName)?.channelPendingText;
      await postReplySafely(msg.channel, msg.threadId, {
        kind: 'approval-request',
        correlationId: msg.correlationId,
        // Never offers a typed `approve <id>` where it is refused (approval-menu.ts).
        text: actionPendingReply({
          channel: msg.channel,
          webSession,
          actionName: resolved.actionName,
          approvalId,
          ...(pendingText ? { pendingText: pendingText(resolved.input, actionCtx, approvalId) } : {}),
        }),
        meta: { ...baseMeta, approvalId, actionId: pending.actionId },
      });
      return jsonResponse({
        status: 'pending-approval',
        actionId: pending.actionId,
        ...(msg.channel === 'mcp' ? { approvalId } : {}),
        correlationId: msg.correlationId,
      });
    }
    await postReplySafely(msg.channel, msg.threadId, {
      kind: 'action-result',
      correlationId: msg.correlationId,
      text: `Done. Result: ${truncatedJson(out)}`,
      meta: { ...baseMeta, actionId: resolved.actionName },
    });
    // `result` serves the mcp channel's synchronous caller (the reply above is a
    // truncated rendering). ONLY mcp: every other receiver returns this Response to
    // its relay (Telegram's servers, the email relay), which must not see the output.
    return jsonResponse({
      status: 'result',
      correlationId: msg.correlationId,
      ...(msg.channel === 'mcp' ? { result: out ?? null } : {}),
    });
  } catch (err) {
    // ⛔ fr#1295 — SAME SPLIT AS STEP 2, SAME REASON, DIFFERENT POPULATION.
    // Every exception out of `invokeAction` used to produce the 200 ack below,
    // under the heading "webhook contract". But the 2xx in this file only ever
    // justified itself for a fault in fr ITSELF — and `invokeAction` is the leg
    // that most readily carries the other kind, because a handler's upstream
    // call (kanban, kag, worker_management) arrives here as an
    // `IntegrationError` from `integrations/_lib/http-client.ts`. A kanban
    // outage while creating a card therefore created nothing AND answered 200,
    // so the message was retired permanently with no record of the delivery.
    //
    // ⚠️ THE ACTION WAS INVOKED HERE, UNLIKE EVERY OTHER REFUSAL IN THIS FILE,
    // AND THE RECORD SAYS SO (`action_invoked: true`). That matters: steps 1,
    // 2 and 2b refuse BEFORE anything ran, so a re-delivery is a clean retry.
    // Here the action had already been entered, so a re-delivery re-enters it.
    //   * What makes that safe for the normal case: `invokeAction`
    //     idempotency-wraps both paths (`runIdempotent(ctx.userId, idemKey…)`
    //     for reads, `write:${idemKey}` for approval parking), so a re-delivery
    //     inside the TTL with the same input returns the SAME value / the SAME
    //     PendingAction rather than duplicating a row.
    //   * ⚠️ THE RESIDUAL, STATED RATHER THAN IMPLIED: that wrap lives in
    //     Postgres (`action_idempotency`). If the transient fault IS Postgres,
    //     the idempotency record may never have been written, so a multi-step
    //     action that half-applied before faulting CAN re-run its earlier
    //     steps. A 503 is still the better answer — the alternative is losing
    //     the message every time — but this is not a double-apply-proof path
    //     and must not be described as one.
    //
    // ⛔ The 200 below is kept for an fr-side fault for the same reason as at
    // step 2: an `UnknownActionError`, an `ActionInputValidationError`, an
    // `ActionOutputValidationError`, an `RbacDeniedError` or a plain
    // `TypeError` in a handler fails identically on every re-delivery.
    if (isTransientDependencyFault(err)) {
      // No reply: see step 2b. The 503 + `Retry-After` carries the same request
      // to the only reader that acts on it without a human, and cannot silently
      // evaporate the way `postReplySafely` can.
      return refuseTransiently(msg, err, {
        reason: 'action-dependency-unavailable',
        errorCode: 'action_dependency_unavailable',
        action: resolved.actionName,
        actionInvoked: true,
        spanAttrs,
      });
    }
    const name = err instanceof Error ? err.name : 'Error';
    const message = err instanceof Error ? err.message : String(err);
    await postReplySafely(msg.channel, msg.threadId, {
      kind: 'action-error',
      correlationId: msg.correlationId,
      text: `Error: ${name}: ${message}`,
      meta: { ...baseMeta, actionId: resolved.actionName, actionName: resolved.actionName },
    });
    return jsonResponse({
      status: 'error',
      code: msg.channel === 'mcp' ? mcpRefusalCode(err) : name,
      correlationId: msg.correlationId,
    });
  }
}

/**
 * The reply→decision turn for a parsed inbound message. Returns the Response to send when
 * the turn handled the message (or the agent dispatcher took the unclaimed text), else null
 * when nothing applied to it and nothing was said (falls through to the dispatcher).
 *
 * The transport facts every non-Telegram channel shares: the conversation is 1:1 with the
 * sender's address (deliveries recorded that address), there is no topic, and the inbound time
 * is fr's receive time.
 */
async function runReplyTurn(inbound: InboundMessage, opts?: DispatchOptions): Promise<Response | null> {
  const { runChannelTurn } = await import('../domain/engagement/channel-reply');
  const receivedAtMs = Date.now();
  // mcp: an agent member relaying a staff member's click decides AS that person (fr #1683),
  // with `via` naming the agent member; the shared decide path checks their membership.
  const agent = inbound.channel === 'mcp' ? await findAgentMemberByAddress(inbound.address) : null;
  const via: DecisionVia | undefined = agent
    ? {
      channel: inbound.channel,
      agent_member_id: agent.user_id,
      product: agent.product,
      ...(inbound.jobId ? { job_id: inbound.jobId } : {}),
    }
    : undefined;
  // ⛔ `on_behalf_of` is resolved EXACTLY as the dispatcher resolves it (step 3): a live member
  // of the AGENT's own workspace, else refused `not_a_member` with nothing done. The turn then
  // decides only approvals of that workspace (`processDecision` actAs).
  let actAs: { userId: string; tenantId: string } | undefined;
  if (agent && inbound.onBehalfOf !== undefined) {
    const sub = inbound.onBehalfOf;
    let member = false;
    try {
      member = !isAgentMemberId(sub) &&
        (await isChannelWorkspaceMember(sub, agent.tenant_id)) &&
        (await keycloak.getUserRealmRolesIfUserExists(sub)) !== null;
    } catch (err) {
      // A fault is not an answer: refused RETRIABLY, exactly as the dispatcher refuses an
      // unreadable on_behalf_of (503 identity_unavailable + Retry-After, nothing done). Falling
      // through would hand reply grammar (`1 [ApprovalId:…]`) to the command grammar, whose
      // 200 `unknown_command` tells the mcp server not to send it again.
      return refuseTransiently(inbound, err, {
        reason: 'on-behalf-of-unavailable',
        errorCode: 'identity_unavailable',
        action: null,
        actionInvoked: false,
      });
    }
    if (!member) {
      await postReplySafely(inbound.channel, inbound.threadId, {
        kind: 'text',
        correlationId: inbound.correlationId,
        text: 'Nothing was done: on_behalf_of is not a member of this workspace.',
        meta: { address: inbound.address },
      });
      return jsonResponse({ status: 'no-action', code: 'not_a_member', correlationId: inbound.correlationId });
    }
    actAs = { userId: sub, tenantId: agent.tenant_id };
  }
  let dispatched: Response | null = null;
  const result = await runChannelTurn({
    channel: inbound.channel,
    senderAddress: inbound.address,
    chatKey: inbound.address,
    threadKey: '',
    isDirectChat: true,
    isReplyToOther: false,
    isEdited: false,
    messageDate: Math.floor(receivedAtMs / 1000),
    receivedAtMs,
    text: inbound.replyText ?? inbound.text,
    ...(inbound.quotedText !== undefined ? { quotedText: inbound.quotedText } : {}),
    ...(actAs ? { actAs } : {}),
    // The in-app chat box is a web SESSION when the route handed it the session's tenant — the
    // same evidence the dispatcher gives `approvals.decide` (`channelWebSession`).
    ...(WEB_SESSION_CHANNELS.has(inbound.channel) && Boolean(opts?.sessionTenant?.id)
      ? { evidence: { keycloakSession: true } }
      : {}),
    ...(via ? { via } : {}),
    say: (text) => postReplySafely(inbound.channel, inbound.threadId, {
      kind: 'text',
      correlationId: inbound.correlationId,
      text,
      meta: { address: inbound.address },
    }),
    dispatch: async () => {
      dispatched = await dispatchParsed(inbound, opts);
      return true;
    },
  });
  if (dispatched !== null) return dispatched;
  if (!result.handled) return null;
  return jsonResponse({
    status: 'handled',
    ...(result.approvalId !== null ? { approvalId: result.approvalId, decided: result.decided === true } : {}),
    correlationId: inbound.correlationId,
  });
}

/** Dispatch an already-parsed message to the agent pipeline (identity → intent → action). */
function dispatchParsed(inbound: InboundMessage, opts?: DispatchOptions): Promise<Response> {
  const ctx: RequestContext = {
    correlationId: inbound.correlationId,
    initiator: 'agent',
    channel: inbound.channel,
    bearerToken: undefined,
  };
  // `degraded` is declared here, not assigned: `dispatchInbound` sets it when
  // it acks a delivery it did not process (fr#1243), so the span itself
  // carries the distinction. ⛔ NOT `outcome` — `emitSpan` STRIPS a
  // caller-supplied `outcome` (spans.ts `strip`) and sets it authoritatively,
  // so writing that key would have been silently discarded.
  const spanAttrs: { channel: string; action: string; degraded?: string } = {
    channel: inbound.channel,
    action: 'none',
  };
  return withRequestContext(ctx, () =>
    emitSpan('channels.dispatch', spanAttrs, () =>
      dispatchInbound(inbound, spanAttrs, opts),
    ),
  );
}

/**
 * channelDispatcher.handleWebhook(channelName, req)
 *
 * Returns:
 *   - `Response`  when the channel parsed an InboundMessage and the dispatch
 *                 seam handled it. The route should return this verbatim.
 *   - `null`      when the feature flag is off, `parseWebhook` returned null
 *                 (e.g. legacy approval-callback shape that the channel
 *                 doesn't claim), or the channel is unknown. The route MUST
 *                 fall through to its existing handler.
 *
 * The route is responsible for cloning the request before passing it in if
 * it also needs to read the body afterwards (Request bodies are single-use).
 */
export const channelDispatcher = {
  async handleWebhook(channelName: string, req: Request, opts?: DispatchOptions): Promise<Response | null> {
    if (!dispatchEnabled) {
      // Pure pass-through: do not touch the body. Legacy route handles it.
      return null;
    }

    const channel = registry.get(channelName);
    if (!channel) {
      console.warn(`[channels] handleWebhook called for unknown channel: ${channelName}`);
      return null;
    }

    let msg: InboundMessage | null;
    try {
      msg = await channel.parseWebhook(req);
    } catch (err) {
      console.error(
        `[channels] parseWebhook threw for channel=${channelName}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }

    if (msg === null) {
      return null;
    }
    const inbound: InboundMessage = msg;

    if (!opts?.replyTurnDone) {
      // ⭐ ONE REPLY→DECISION FLOW ON EVERY CHANNEL (owner ruling 2026-10-31): `1`, `approve`,
      // `2 <reason>`, `approve: <answer>`, `#<short id>`, an `[ApprovalId:…]` tag and laya's
      // free-text read mean on mcp, email, teams and inapp exactly what they mean on
      // Telegram — the same `runChannelTurn`, before the agent sees the text. What it does not
      // claim is offered to the agent dispatcher below, as on Telegram.
      const turned = await runReplyTurn(inbound, opts);
      if (turned !== null) return turned;
    }
    return dispatchParsed(inbound, opts);
  },
};
