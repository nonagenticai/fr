/**
 * E-2: AG-UI action registry.
 *
 * Module-global registry of agent-callable actions. A slice registers its
 * actions at module import time; the HTTP layer (and later the agent core)
 * invoke them by name through `invokeAction`. Invocations are:
 *   - input-validated via zod,
 *   - wrapped in an emitSpan (E-1) for telemetry join with the action catalog,
 *   - for reads: run the handler directly; only a read that sets an explicit
 *     idempotencyTtlSeconds is run through runIdempotent (E-4),
 *   - every cache key is scoped `${tenantId}:${projectId}:` (D2),
 *   - for writes: delegated to a pluggable ApprovalBackend (E-5 plugs in at
 *     import time via setApprovalBackend), never run synchronously.
 *
 * Error types are exported so route handlers can map to HTTP status codes
 * without sniffing error messages.
 */

import type { ZodError } from 'zod';

import * as spansModule from '../telemetry/spans';
import { runIdempotent } from '../domain/engagement/idempotency';
import { assertRbac } from './rbac';
import { AppError } from '../utils/errors';
import { shapeProposal, type AgentProposal } from './proposal-shape';
import { bindProjectInput } from '../agent/project-binding';
import { assertAssetInBoundProject } from '../agent/project-asset-guard';
import { isChannelDispatched, isConfirmedCard } from './context-provenance';
import { isRetiredFromAgent, PROJECT_BINDING } from './agent-surface';
import { auditSuperAdminAgentAction } from '../lib/super-admin-tenant-audit';
import { tryGetRequestContext } from '../integrations/_lib/context';

import type {
  AgentCallableAction,
  ActionContext,
  PendingAction,
  ApprovalPolicy,
} from './types';

const NAME_RE = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60; // 24h

// ---------- Errors ----------
//
// ⚠️ WHICH OF THESE EXTEND AppError, AND WHY ONLY SOME.
//
// `handleError` (utils/errors.ts) maps `AppError` by `statusCode`; anything
// else falls to a bare 500 `{"error":"Internal server error"}`. The REST tool
// routes wrap handlers in `withIntegrationCatch` (routes/_lib/request.ts),
// which deliberately RETHROWS anything that is not an IntegrationError so a
// bug is never laundered into a tidy response -- correct, and also what let
// these reach the boundary unmapped. The module docstring above has claimed
// since E-2 that these types exist so routes "can map to HTTP status codes";
// nothing at the boundary ever did.
//
// MEASURED: five of the classes below are reachable on /api/tools/{analytics,
// kag,coding}/* and assets/artifacts, where they rendered as 500. A denial or
// a bad input arriving as 500 is not cosmetic: 20 n8n node modules retry on
// `statusCode >= 500`, so a request that can NEVER succeed was retried forever
// (the same blast radius as the UPSTREAM_BAD_BODY -> 502 defect in #908).
// Those five now extend AppError and need no change to `handleError` at all.
//
// The four REGISTRATION validators (AlreadyRegistered / InvalidActionName /
// InvalidActionApproval / InvalidActionSchema) and NotCronSafeError stay bare
// `Error` ON PURPOSE. They are unreachable over HTTP -- the validators throw at
// module import (a boot crash, not a request) and NotCronSafe needs
// `initiator === 'cron'`, which no HTTP route sets. Converting them would buy
// nothing measured and would touch the `err.name` swallow described below.
//
// ⛔ EVERY class here MUST re-set `this.name` AFTER `super()`. AppError's
// constructor sets `this.name = 'AppError'`, and `safeRegister` swallows
// ActionAlreadyRegisteredError BY NAME (routes/assets/artifacts.ts,
// analytics.ts, coding.ts, kag.ts, kanban.ts). Losing a name turns a swallowed
// double-registration into a crash at import time. Asserted in
// tests/unit/agui/registry-error-status.test.ts.

export class ActionAlreadyRegisteredError extends Error {
  constructor(name: string) {
    super(`Action already registered: ${name}`);
    this.name = 'ActionAlreadyRegisteredError';
  }
}

export class InvalidActionNameError extends Error {
  constructor(name: string) {
    super(
      `Invalid action name: ${JSON.stringify(name)}. Must match /^[a-z][a-z0-9_]*\\.[a-z][a-z0-9_]*$/ (two lowercase dotted segments).`,
    );
    this.name = 'InvalidActionNameError';
  }
}

export class InvalidActionApprovalError extends Error {
  constructor(name: string) {
    super(
      `Action ${name} is kind:'write' with approval.type:'auto'. Writes MUST require approval (minimum: single-approver with approver:'initiator').`,
    );
    this.name = 'InvalidActionApprovalError';
  }
}

export class UnknownActionError extends AppError {
  constructor(name: string) {
    super(404, `Unknown action: ${name}`);
    this.name = 'UnknownActionError';
  }
}

export class ActionInputValidationError extends AppError {
  readonly issues?: ZodError['issues'];
  constructor(actionName: string, cause: unknown) {
    const issues = (cause as ZodError | undefined)?.issues;
    super(
      422,
      `Input validation failed for action ${actionName}` +
        (issues ? `: ${JSON.stringify(issues)}` : ''),
      issues,
    );
    this.name = 'ActionInputValidationError';
    this.issues = issues;
    this.code = 'ACTION_INPUT_VALIDATION_FAILED';
  }
}

export class ActionOutputValidationError extends AppError {
  readonly issues?: ZodError['issues'];
  constructor(actionName: string, cause: unknown) {
    const issues = (cause as ZodError | undefined)?.issues;
    super(
      500,
      `Output validation failed for action ${actionName}` +
        (issues ? `: ${JSON.stringify(issues)}` : ''),
      issues,
    );
    this.name = 'ActionOutputValidationError';
    this.issues = issues;
    this.code = 'ACTION_OUTPUT_VALIDATION_FAILED';
  }
}

export class InvalidIdempotencyKeyError extends AppError {
  constructor(actionName: string) {
    super(
      400,
      `Action ${actionName} produced an empty idempotencyKey for the given input. Keys must be deterministic non-empty strings derived from input.`,
    );
    this.name = 'InvalidIdempotencyKeyError';
  }
}

export class NoApprovalBackendError extends AppError {
  constructor(actionName: string) {
    super(
      503,
      `Action ${actionName} requires approval but no ApprovalBackend is registered. Enable E-5 (see backend/src/domain/engagement/action-approvals.ts) and call setApprovalBackend() at server boot.`,
    );
    this.name = 'NoApprovalBackendError';
  }
}

export class NotCronSafeError extends Error {
  constructor(actionName: string) {
    super(
      `Action ${actionName} is not cronSafe and cannot be invoked with initiator:'cron'.`,
    );
    this.name = 'NotCronSafeError';
  }
}

export class InvalidActionSchemaError extends Error {
  constructor(actionName: string, field: 'input' | 'output') {
    super(
      `Action ${actionName} has an invalid ${field} schema: schema is missing or its .parse is not a function. ` +
        `Both input and output must be zod-compatible schemas exposing a .parse(value) method at registration time.`,
    );
    this.name = 'InvalidActionSchemaError';
  }
}

/**
 * fr-agui SPEC §5.2: `parking:'never'` is allowed for exactly ONE action. Any
 * other action that sets it is refused at registration (a boot crash, like the
 * other registration validators), so a second never-parking write cannot slip in.
 */
export const NEVER_PARKING_ALLOWLIST: ReadonlySet<string> = new Set(['approvals.decide']);

export class InvalidActionParkingError extends Error {
  constructor(name: string) {
    super(
      `Action ${name} sets parking:'never', which is allowed only for ${[...NEVER_PARKING_ALLOWLIST].join(', ')}.`,
    );
    this.name = 'InvalidActionParkingError';
  }
}

/**
 * A never-parking action (approvals.decide) invoked by anything but a HUMAN on a
 * CHANNEL — a context the channel dispatcher marked (`markChannelDispatched`),
 * never one that merely names a channel. The agent token can never decide, and on
 * the web the decision is the human's own `PUT /api/approvals/:approvalId` (the
 * confirm card), not a registry call.
 */
export class NeverParkingActionRefusedError extends AppError {
  constructor(name: string) {
    super(
      403,
      `Action ${name} is a human decision: it runs only from a person's own channel command ` +
        '(e.g. "approve <id>" on Telegram) or from the decision card in fr, never from an agent.',
    );
    this.name = 'NeverParkingActionRefusedError';
    this.code = 'decision_requires_human';
  }
}

export class ConfirmCardRequiredError extends AppError {
  constructor(name: string) {
    super(
      403,
      `Action ${name} runs on the web only from its confirm card, under the user's own session.`,
    );
    this.name = 'ConfirmCardRequiredError';
    this.code = 'confirm_card_required';
  }
}

// fr-agui SPEC §5.2 / §6.5 — server-side context provenance (channel dispatcher,
// agent token, confirmed card) lives in ./context-provenance (rbac.ts reads it
// too and cannot import this module). Re-exported so existing importers of
// `markChannelDispatched` / `isChannelDispatched` from here are unchanged.
export { markChannelDispatched, isChannelDispatched } from './context-provenance';

// ---------- Approval backend plug-in point ----------

export interface ApprovalBackend {
  requestApproval(
    action: AgentCallableAction,
    input: unknown,
    ctx: ActionContext,
  ): Promise<PendingAction>;
  /**
   * Decide (WITHOUT creating an approval row) whether this write should be
   * executed inline instead of parked for approval — the documented
   * `single-approver:initiator` "immediate self-approve" semantic. The backend
   * owns the full policy; {@link invokeAction} only branches on the boolean.
   * Today this is true only in the KAG single-user product for a human-initiated
   * write whose sole required approver is the requester. Optional: a backend
   * that does not implement it (or returns false) parks every write exactly as
   * before — fr is unchanged.
   */
  shouldSelfApprove?(
    action: AgentCallableAction,
    ctx: ActionContext,
  ): Promise<boolean>;
}

let approvalBackend: ApprovalBackend | null = null;

export function setApprovalBackend(b: ApprovalBackend | null): void {
  approvalBackend = b;
}

// ---------- Registry ----------

const actions = new Map<string, AgentCallableAction<any, any>>();

function policyRequiresApproval(policy: ApprovalPolicy): boolean {
  return policy.type !== 'auto';
}

function hasParseFn(schema: unknown): boolean {
  return (
    schema !== null &&
    schema !== undefined &&
    typeof (schema as { parse?: unknown }).parse === 'function'
  );
}

/**
 * Sentinel-parse probe to distinguish real zod schemas from foreign objects
 * that merely happen to expose a `.parse()` method (e.g. JSON.parse-style or
 * a class whose .parse always throws with a non-zod error). A zod schema
 * called with `undefined` either:
 *   - returns a parsed value (e.g. when the schema has a default/optional/is
 *     z.unknown()/z.any()), OR
 *   - throws a ZodError (recognizable by `name === 'ZodError'`).
 * Anything else (TypeError, plain Error, string, etc.) means "not a zod
 * schema" and the registration is rejected with InvalidActionSchemaError.
 */
function isZodLike(schema: unknown): boolean {
  if (!hasParseFn(schema)) {
    return false;
  }
  try {
    (schema as { parse: (v: unknown) => unknown }).parse(undefined);
    return true;
  } catch (err) {
    if (
      err !== null &&
      typeof err === 'object' &&
      (err as { name?: unknown }).name === 'ZodError'
    ) {
      return true;
    }
    return false;
  }
}

export function registerAction<I, O>(a: AgentCallableAction<I, O>): void {
  if (!NAME_RE.test(a.name)) {
    throw new InvalidActionNameError(a.name);
  }
  if (actions.has(a.name)) {
    throw new ActionAlreadyRegisteredError(a.name);
  }
  if (a.kind === 'write' && !policyRequiresApproval(a.approval)) {
    throw new InvalidActionApprovalError(a.name);
  }
  if (a.parking === 'never' && !NEVER_PARKING_ALLOWLIST.has(a.name)) {
    throw new InvalidActionParkingError(a.name);
  }
  if (!isZodLike(a.input)) {
    throw new InvalidActionSchemaError(a.name, 'input');
  }
  if (!isZodLike(a.output)) {
    throw new InvalidActionSchemaError(a.name, 'output');
  }
  // fr-agui SPEC §13 P1c (OQ-17 = c): the ONE retirement list stamps
  // `catalog:'none'`, and a hand-written re-homed action gets the project key
  // its project-agent binding injects (agui/agent-surface.ts). Stamped on the
  // registered object itself so `getAction(name)` and every catalog see it.
  if (isRetiredFromAgent(a.name)) a.catalog = 'none';
  const binding = PROJECT_BINDING.get(a.name);
  if (binding?.projectParam !== undefined && a.projectParam === undefined) a.projectParam = binding.projectParam;
  actions.set(a.name, a as AgentCallableAction<unknown, unknown>);
}

export function listActions(): AgentCallableAction[] {
  return Array.from(actions.values()) as AgentCallableAction[];
}

/**
 * Look up a registered action by name. Returns `undefined` when no action
 * with that name has been registered. Used by E-5 to resolve a pending
 * approval row back to its action handler at decision time.
 */
export function getAction(name: string): AgentCallableAction | undefined {
  return actions.get(name) as AgentCallableAction | undefined;
}

// Parse a zod schema against a value. types.ts declares schemas as `unknown` to
// avoid coupling to a specific zod generic shape; `registerAction` guarantees
// that `schema.parse` exists by the time this runs (see InvalidActionSchemaError),
// so callers pass `action.input` / `action.output` (both `unknown`) and we
// duck-type the call defensively here without an `as`-cast on the schema itself.
interface ParseLike<T> {
  parse: (v: unknown) => T;
}
function zodParse<T>(schema: unknown, value: unknown): T {
  if (!schema || typeof (schema as { parse?: unknown }).parse !== 'function') {
    // Should be unreachable: registerAction enforces this. Defensive throw so a
    // future code path that bypasses registerAction still fails loudly.
    throw new Error('zodParse called with a schema that has no .parse function');
  }
  return (schema as ParseLike<T>).parse(value);
}

export async function invokeAction<I, O>(
  name: string,
  input: I,
  ctx: ActionContext,
): Promise<O | PendingAction | AgentProposal> {
  const action = actions.get(name) as AgentCallableAction<I, O> | undefined;
  if (!action) {
    throw new UnknownActionError(name);
  }
  // George 2026-10-27: every WRITE action a switched super_admin (or their
  // switched Copilot session) runs is audited HERE, one row per action with its
  // name and outcome — a chat turn runs its no-confirm-card writes in-process,
  // so the HTTP-level row alone would hide which writes ran
  // (lib/super-admin-tenant-audit.ts). Reads, and every other frame, run as-is.
  if (action.kind === 'write') {
    return auditSuperAdminAgentAction(tryGetRequestContext(), name, () => invokeResolvedAction(action, name, input, ctx));
  }
  return invokeResolvedAction(action, name, input, ctx);
}

async function invokeResolvedAction<I, O>(
  action: AgentCallableAction<I, O>,
  name: string,
  input: I,
  ctx: ActionContext,
): Promise<O | PendingAction | AgentProposal> {

  if (!action.cronSafe && ctx.initiator === 'cron') {
    throw new NotCronSafeError(name);
  }

  // fr-agui SPEC §5.7 rule 3: in a project-bound context the project comes from
  // `ctx.projectId`, never the input — injected, and any other id refused 403
  // `project_mismatch` before validation, RBAC, idempotency or any handler.
  // A no-op without a bound project (agent/project-binding.ts).
  const boundInput = bindProjectInput(action as AgentCallableAction, input, ctx);

  // Input validation.
  let parsedInput: I;
  try {
    parsedInput = zodParse<I>(action.input, boundInput);
  } catch (err) {
    throw new ActionInputValidationError(name, err);
  }

  // Idempotency key — derived from the parsed input, not the raw input, so
  // action authors can rely on zod's coercions (.default(), .transform(), etc.)
  // being applied before their key function sees the data.
  // T7a — `idempotencyKey` may be sync or async (see types.ts). The async
  // form is used by actions that fold runtime state into the key (e.g.
  // `coding.trigger_analysis` looking up the repo HEAD sha).
  const idemKey = await action.idempotencyKey(parsedInput);
  if (!idemKey) {
    throw new InvalidIdempotencyKeyError(name);
  }

  const spanAttrs = {
    kind: action.kind,
    initiator: ctx.initiator,
    channel: ctx.channel,
    projectId: ctx.projectId ?? undefined,
    userId: ctx.userId,
    correlationId: ctx.correlationId,
  };

  return spansModule.emitSpan<O | PendingAction | AgentProposal>(action.name, spanAttrs, async () => {
    // E-12 — Per-action RBAC. Runs AFTER input validation and BEFORE the
    // idempotency lookup / approval dispatch so denials never poison the
    // idempotency cache and never create approval rows. See
    // docs/superpowers/specs/completed/2026-04-25-e12-per-action-rbac.md §"Enforcement
    // order".
    await assertRbac(action as AgentCallableAction, ctx, parsedInput);
    // fr-agui SPEC §13 P2: in a project-bound context an asset addressed by id
    // must belong to the bound project (agent/project-asset-guard.ts), refused
    // 403 project_mismatch before idempotency, approvals or any handler.
    await assertAssetInBoundProject(action as AgentCallableAction, parsedInput, ctx);

    const ttl = action.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;

    // D2 — the store keys on (user_id, key) only. Without a tenant/project
    // dimension, a super-admin switching X-Active-Tenant (same userId) was
    // replayed the OTHER tenant's cached result for 24h. Every key the
    // registry hands to runIdempotent is therefore scoped by tenant AND
    // project. `-` stands in for an absent value (never an empty segment).
    const scopedKey = `${ctx.tenantId || '-'}:${ctx.projectId ?? '-'}:${idemKey}`;

    // Write actions with non-auto policy -> either self-approve inline (sole
    // initiator) or delegate to the approval backend for parking.
    // (write+auto was already rejected at registration.)
    // fr-agui SPEC §5.2 (W): on the web a confirm-card write runs ONLY as the
    // human's own request to its UI route (the card). A registry invocation
    // with channel 'web' (the agent token's /api/agui/invoke) would park an
    // approval for a handler the web never executes, so it is refused here.
    //
    // fr-agui SPEC §5.2 (W) + §6.5: a confirm-card write PARKS only when it
    // arrived through the channel DISPATCHER (Telegram/Teams/…), which marks its
    // context server-side (`markChannelDispatched`). Every other invocation —
    // above all the agent token's /api/agui/invoke, whose `channel` is a
    // caller-supplied body field — is untrusted for this decision: an agent
    // gets a PROPOSAL (no approval row, no handler), anyone else is refused.
    // Before this, `/api/agui/invoke` with no channel (default 'agent'), or with
    // a body channel like 'teams', parked a projects.create that `approve <id>`
    // then executed: an agent-token write with no confirm card.
    // fr-agui P1c: a HUMAN's own click on the confirm card of an agent-native
    // write (`POST /api/capabilities/:id/invoke`, routes/capability-invoke.ts,
    // context marked server-side) IS that card: it proceeds to the action's
    // declared approval policy below, exactly like a UI write.
    const confirmedByHuman = isConfirmedCard(ctx) && ctx.initiator === 'human';
    if (action.kind === 'write' && action.confirm && action.parking !== 'never' && !confirmedByHuman) {
      if (!isChannelDispatched(ctx)) {
        if (ctx.initiator === 'agent') return shapeProposal(action as AgentCallableAction, parsedInput);
        throw new ConfirmCardRequiredError(name);
      }
      if (ctx.channel === 'web') {
        throw new ConfirmCardRequiredError(name);
      }
      // A web-only write (no server-side handler) never parks: an `approve <id>`
      // has nothing to run — the web confirms it through its card's route.
      if (action.webOnly) {
        throw new ConfirmCardRequiredError(name);
      }
    }

    if (action.kind === 'write' && action.parking === 'never') {
      // fr-agui SPEC §5.2: the decision IS the human's confirmation, so parking it
      // would mint an approval for an approval. Runs ONLY for a human on a
      // channel (initiatorFor: deterministic grammar + resolved identity); never
      // cached (a second `approve <id>` must reach the decision guards, which
      // answer "already decided"), and creates no approval row.
      //
      // "On a channel" is the server-side dispatcher mark, exactly as for the
      // confirm-card park above — never the `channel` string, which on
      // /api/agui/invoke is a caller-supplied body field. A context the
      // dispatcher did not build is refused whatever channel it names.
      if (ctx.initiator !== 'human' || !isChannelDispatched(ctx) || ctx.channel === 'web') {
        throw new NeverParkingActionRefusedError(name);
      }
      const directRaw = await action.handler(parsedInput, ctx);
      try {
        return zodParse<O>(action.output, directRaw);
      } catch (err) {
        throw new ActionOutputValidationError(name, err);
      }
    }

    if (action.kind === 'write') {
      if (!approvalBackend) {
        throw new NoApprovalBackendError(name);
      }

      // Sole-initiator self-approve (KAG single-user product). When the backend
      // says this human-initiated write's only required approver is the
      // requester themselves, there is no one else to gate on — parking a
      // pending approval only the requester can grant is friction with zero
      // governance value. Execute inline, exactly like the read path (same
      // user-scoped idempotency wrap + output validation), and create NO
      // approval row. Everything else parks below (fr is unchanged).
      if (
        await approvalBackend.shouldSelfApprove?.(action as AgentCallableAction, ctx)
      ) {
        const { value: selfRaw } = await runIdempotent<unknown>(
          ctx.userId,
          scopedKey,
          ttl,
          async () => action.handler(parsedInput, ctx),
        );
        try {
          return zodParse<O>(action.output, selfRaw);
        } catch (err) {
          throw new ActionOutputValidationError(name, err);
        }
      }

      // Writes are idempotency-wrapped: a retry within the TTL with the same
      // input must return the SAME PendingAction (same approvalId) instead of
      // creating a duplicate approvals row. Cache key namespaced with `write:`
      // to avoid collision with read-path entries that share the action's
      // idempotencyKey shape.
      const { value: pending } = await runIdempotent<PendingAction>(
        ctx.userId,
        `write:${scopedKey}`,
        ttl,
        async () =>
          approvalBackend!.requestApproval(
            action as AgentCallableAction,
            parsedInput,
            ctx,
          ),
      );
      return pending;
    }

    // Read path. D2 — a read is NOT cached unless the action opts in with an
    // explicit `idempotencyTtlSeconds`. The old 24h default turned every read
    // into a day-stale snapshot (a list/get re-run an hour later returned the
    // first answer). Reads have no side effect to dedupe, so the default is to
    // run the handler. Opted-in reads are cached user + tenant + project
    // scoped (see `scopedKey`).
    const raw: unknown =
      action.idempotencyTtlSeconds === undefined
        ? await action.handler(parsedInput, ctx)
        : (
            await runIdempotent<unknown>(ctx.userId, scopedKey, ttl, async () => {
              return action.handler(parsedInput, ctx);
            })
          ).value;

    // Output validation on the handler return (or cached value — validating
    // the cached value is cheap and protects against a schema tightening
    // that would make previously-cached values invalid).
    try {
      return zodParse<O>(action.output, raw);
    } catch (err) {
      throw new ActionOutputValidationError(name, err);
    }
  });
}

// ---------- Startup summary ----------

export function logRegistrySummary(): void {
  const all = listActions();
  const tools = new Set<string>();
  for (const a of all) {
    const firstSegment = a.name.split('.', 1)[0] ?? '';
    if (firstSegment) tools.add(firstSegment);
  }
  console.log(`[agui] registered ${all.length} actions across ${tools.size} tools`);
}
