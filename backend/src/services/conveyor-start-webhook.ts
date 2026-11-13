// src/services/conveyor-start-webhook.ts
//
// THE CONVEYOR START WEBHOOK — fr's proposal, recorded by the conveyor design
// session: fr is a facilitator, and a project starts by fr telling n8n it exists.
// After a project is created AND its RM pm_project and Planka board exist
// (routes/projects.ts createSingleProject, the success path, after the commit),
// fr fires ONCE:
//
//   POST ${CONVEYOR_START_WEBHOOK_URL}
//   Content-Type:    application/json
//   X-FR-Signature:  sha256=<hex HMAC-SHA256 of the RAW body, key CONVEYOR_START_WEBHOOK_SECRET>
//   X-Conveyor-Token: <CONVEYOR_START_WEBHOOK_SECRET>  (same secret, verbatim — n8n's Webhook
//                    node Header Auth checks it; the HMAC stays for receivers that verify
//                    the body. Both are sent on every attempt. NEVER logged.)
//   Idempotency-Key: <fr_project_id>              (the first start)
//                    <fr_project_id>:retry-<n>    (retry n, R311 §2.5 — services/conveyor-failures.ts)
//                    <fr_project_id>:restart-<n>  (a member's restart, George 2026-10-31)
//   body EXACTLY     {"event":"project.created","rm_project_id":…,"tenant_id":…,"fr_project_id":…}
//   or, for a RESTART (George 2026-10-31: "Start again" restarts the whole project or its
//   current phase — every card in scope runs again, DONE ones included), those four keys plus
//                    "restart":{"scope":"project"} | {"scope":"phase","phase":"<current RM phase name>"}
//   Without `restart` the body is byte-identical to the start-card retry it always was.
//
// ⛔ INERT when CONVEYOR_START_WEBHOOK_URL is unset (config.ts
// validateConveyorStartWebhookConfig logs that once at boot; this module then
// sends nothing). A set URL without the secret refuses to boot there.
//
// ⛔ URL GUARD DECISION: plain `fetch` with `redirect: 'manual'`, NOT
// utils/ssrf-guard.ts `safeFetch`. safeFetch exists for USER-supplied URLs and is
// deny-by-default to globally-routable addresses only, so it would refuse exactly
// the destination this webhook is for — n8n, which may be cluster-internal
// (a cluster DNS name, a tailnet 100.x host). This URL is OPERATOR config
// (an env var set in gitops, the same trust class as N8N_WEBHOOK_URL, which
// services/n8n.ts also fetches unguarded); no request field can influence it.
// `redirect: 'manual'` keeps a 3xx from bouncing the signed body to a host the
// operator did not name: a redirect is NOT followed and counts as a failure.
// The boot validator refuses a non-http(s) URL.
//
// DELIVERY: detached (lib/detached-work.ts `trackDetached`, the repo idiom — the
// caller never awaits it, so it runs after the create has answered). Up to 3
// attempts with backoff, retrying ONLY on a network error (incl. the per-attempt
// timeout) or a 5xx; a 3xx/4xx is final. A final failure is logged through
// reportSwallowedFailure and NEVER fails, delays or rolls back the create. The
// receiver dedupes on Idempotency-Key, so at-least-once is fine.
//
// THE ANSWER (U1.1 response contract, program/v4-alignment/U1-brief.md):
//   200 {accepted:true}                  → delivered (a fresh start)
//   200 {accepted:true,duplicate:true}   → delivered (the key was already seen)
//   200 {accepted:true,resumed:true}     → delivered (an unpulled start card re-pulled)
//   200 {accepted:true,restarted:true}   → delivered (R320: a stalled start card restarted)
//   200 {accepted:true,running:true}     → delivered (R320: the start card's flow is still
//                                          running, so nothing was restarted)
//   (Until the conveyor ships R320 it answers a stalled restart `duplicate` or
//   409 psra_exists; services/conveyor-failures.ts shows "could not restart" for both.)
//   409 {code}                           → REFUSED: code ∈ CONVEYOR_START_REFUSAL_CODES.
//                                          The conveyor will never accept this start, so
//                                          a retry is pointless (outcome 'refused').
//   400                                  → failed, `HTTP 400…`: fr sent a malformed start
//                                          (wrong event / no Idempotency-Key) — a
//                                          PROGRAMMING ERROR, logged loudly, never retried.
//   503 / other 5xx / network            → retried here, then failed (unchanged).
//
// PER-ATTEMPT TIMEOUT: config `conveyorStartWebhookTimeoutMs`
// (CONVEYOR_START_WEBHOOK_TIMEOUT_MS, default 30 s). It was a fixed 10 s until
// 2026-10-21, when an R320 restart (project ff8bb1f0) took 13.8 s at n8n and the
// guard's `running` answers to the two retries ~10 s each: all three attempts
// timed out and the attempt row said `failed` for a restart that happened.
//
// ONE KEY PER CHAIN: every attempt of one delivery sends the SAME headers, so the
// same Idempotency-Key — the conveyor's restart lease is keyed by it, which is what
// makes a retry after a timeout safe. Hence the rule: ANY 2xx in the chain is the
// outcome, whatever timed out before it. A `running` answer after an earlier
// attempt timed out (or hit a network error) is the conveyor reporting the
// restart that THIS chain's earlier attempt started, so it is additionally
// flagged `restart_in_progress` (never `failed`).

import { createHmac } from 'node:crypto';

import { config, CONVEYOR_START_WEBHOOK_TIMEOUT_DEFAULT_MS } from '../config';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { trackDetached } from '../lib/detached-work';

export interface ConveyorStartEvent {
  rm_project_id: string;
  tenant_id: string;
  fr_project_id: string;
  /**
   * The `Idempotency-Key` header (never in the body). Absent ⇒ the bare
   * `fr_project_id` (the first start). A retry sends `<fr id>:retry-<n>`
   * (kanban-coach-errors.md §2.5): n8n's Dedupe store has no per-value delete, so
   * a fresh key is what lets a retried start through.
   */
  idempotency_key?: string;
  /**
   * George 2026-10-31: a member's project or phase RESTART (every card in scope runs
   * again). Absent ⇒ the first start / the start-card retry, body unchanged.
   */
  restart?: ConveyorRestart;
}

/**
 * The restart a member asked for (R349, George 2026-11-04): the whole project, or one RM phase at
 * or before the current one — with the member's optional comment to steer that run.
 */
export type ConveyorRestart = ({ scope: 'project' } | { scope: 'phase'; phase: string }) & { comment?: string };

/**
 * The exact wire body — four keys in this order, plus `restart` last for a restart only:
 * `restart: {scope, phase (scope phase only), comment (only when given)}`.
 */
export function conveyorStartBody(e: ConveyorStartEvent): string {
  const r = e.restart;
  return JSON.stringify({
    event: 'project.created',
    rm_project_id: e.rm_project_id,
    tenant_id: e.tenant_id,
    fr_project_id: e.fr_project_id,
    ...(r
      ? {
          restart: {
            scope: r.scope,
            ...(r.scope === 'phase' ? { phase: r.phase } : {}),
            ...(r.comment ? { comment: r.comment } : {}),
          },
        }
      : {}),
  });
}

/** The exact request fr sends (body + headers), built once per delivery chain. Pure. */
export function conveyorStartRequest(e: ConveyorStartEvent, secret: string): { body: string; headers: Record<string, string> } {
  const body = conveyorStartBody(e);
  return {
    body,
    headers: {
      'Content-Type': 'application/json',
      'X-FR-Signature': signConveyorStartBody(body, secret),
      'X-Conveyor-Token': secret,
      'Idempotency-Key': e.idempotency_key || e.fr_project_id,
    },
  };
}

/** `sha256=<hex HMAC-SHA256(rawBody, secret)>`. */
export function signConveyorStartBody(rawBody: string, secret: string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex')}`;
}

const CONVEYOR_START_MAX_ATTEMPTS = 3;
/** Wait before attempt 2 and attempt 3. */
const CONVEYOR_START_BACKOFF_MS: readonly number[] = Object.freeze([500, 2_000]);
/** Used only if the configured timeout is not a positive finite number (the boot validator refuses that). */
const FALLBACK_ATTEMPT_TIMEOUT_MS = CONVEYOR_START_WEBHOOK_TIMEOUT_DEFAULT_MS;

/** The per-attempt timeout this delivery uses, ms. Exported for tests. */
function conveyorStartAttemptTimeoutMs(): number {
  const t = config.services.n8n.conveyorStartWebhookTimeoutMs;
  return typeof t === 'number' && Number.isFinite(t) && t > 0 ? t : FALLBACK_ATTEMPT_TIMEOUT_MS;
}

/** The four `409 {code}` refusals of the conveyor start (U1.1). */
export const CONVEYOR_START_REFUSAL_CODES = ['project_mismatch', 'tenant_mismatch', 'phase_not_setup', 'psra_exists'] as const;
type ConveyorStartRefusalCode = (typeof CONVEYOR_START_REFUSAL_CODES)[number];
/** A 409 whose body carries no known code — still a refusal (the conveyor only 409s to refuse). */
const UNRECOGNISED_REFUSAL_CODE = 'unrecognised' as const;

/**
 * The `reason` prefix of a 400 answer. services/conveyor-failures.ts reads it off
 * `outcome_detail` to offer no retry: a 400 is fr's own malformed start.
 */
const CONVEYOR_START_BAD_REQUEST_PREFIX = 'HTTP 400';

/** True for an `outcome_detail` this module wrote for a 400 answer (`HTTP 400`, then end, space or colon). */
export function isBadRequestDetail(detail: string | null | undefined): boolean {
  return typeof detail === 'string' && /^HTTP 400(?:$|[ :])/.test(detail);
}

export type ConveyorStartOutcome =
  | { kind: 'inert' }
  | {
      kind: 'delivered';
      attempts: number;
      status: number;
      duplicate?: true;
      resumed?: true;
      restarted?: true;
      running?: true;
      /** `running`, after an earlier attempt of this chain (same Idempotency-Key) timed out or hit a network error. */
      restart_in_progress?: true;
    }
  | {
      kind: 'refused';
      attempts: number;
      status: 409;
      code: ConveyorStartRefusalCode | typeof UNRECOGNISED_REFUSAL_CODE;
      reason: string;
    }
  | { kind: 'failed'; attempts: number; status: number | null; reason: string };

/** Read a small JSON answer body; anything unreadable is `null` (never throws). */
async function readJsonBody(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const text = (await res.text()).slice(0, 4096);
    const parsed: unknown = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A short token from the body (`code`, else `error`) for a log/detail line; never free text. */
function bodyToken(body: Record<string, unknown> | null): string | null {
  for (const k of ['code', 'error'] as const) {
    const v = body?.[k];
    if (typeof v === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(v)) return v;
  }
  return null;
}

/** The refusal code of a 409 body. */
function refusalCodeOf(body: Record<string, unknown> | null): ConveyorStartRefusalCode | typeof UNRECOGNISED_REFUSAL_CODE {
  const code = body?.code;
  return typeof code === 'string' && (CONVEYOR_START_REFUSAL_CODES as readonly string[]).includes(code)
    ? (code as ConveyorStartRefusalCode)
    : UNRECOGNISED_REFUSAL_CODE;
}

/** One delivery with retries. Never throws. Exported for tests; callers use {@link emitConveyorStart}. */
async function deliverConveyorStart(e: ConveyorStartEvent): Promise<ConveyorStartOutcome> {
  const url = config.services.n8n.conveyorStartWebhookUrl;
  if (!url) return { kind: 'inert' };
  const secret = config.services.n8n.conveyorStartWebhookSecret;
  if (!secret) {
    // Unreachable after the boot validator; refuse to send an unsigned event.
    return { kind: 'failed', attempts: 0, status: null, reason: 'CONVEYOR_START_WEBHOOK_SECRET unset' };
  }
  const { body, headers } = conveyorStartRequest(e, secret);
  const timeoutMs = conveyorStartAttemptTimeoutMs();
  let last: { status: number | null; reason: string } = { status: null, reason: 'not attempted' };
  // An earlier attempt of THIS chain may have reached the conveyor (timeout / network error).
  let maybeSent = false;
  for (let attempt = 1; attempt <= CONVEYOR_START_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, CONVEYOR_START_BACKOFF_MS[attempt - 2] ?? 2_000));
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers,
        body,
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      // Network error or timeout: retryable (same headers ⇒ same Idempotency-Key).
      maybeSent = true;
      last = { status: null, reason: err instanceof Error ? err.message : String(err) };
      continue;
    }
    if (res.status >= 200 && res.status < 300) {
      const answer = await readJsonBody(res);
      return {
        kind: 'delivered',
        attempts: attempt,
        status: res.status,
        ...(answer?.duplicate === true ? { duplicate: true as const } : {}),
        ...(answer?.resumed === true ? { resumed: true as const } : {}),
        ...(answer?.restarted === true ? { restarted: true as const } : {}),
        ...(answer?.running === true ? { running: true as const } : {}),
        ...(answer?.running === true && maybeSent ? { restart_in_progress: true as const } : {}),
      };
    }
    if (res.status === 409) {
      const answer = await readJsonBody(res);
      const code = refusalCodeOf(answer);
      const raw = bodyToken(answer);
      const reason = code === UNRECOGNISED_REFUSAL_CODE ? `HTTP 409 ${raw ?? 'without a code'}` : `HTTP 409 ${code}`;
      return { kind: 'refused', attempts: attempt, status: 409, code, reason };
    }
    if (res.status === 400) {
      const raw = bodyToken(await readJsonBody(res));
      return {
        kind: 'failed',
        attempts: attempt,
        status: 400,
        reason: `${CONVEYOR_START_BAD_REQUEST_PREFIX}${raw ? ` ${raw}` : ''}: the conveyor rejected the start request as malformed`,
      };
    }
    last = { status: res.status, reason: `HTTP ${res.status}` };
    if (res.status < 500) return { kind: 'failed', attempts: attempt, status: res.status, reason: last.reason };
  }
  return { kind: 'failed', attempts: CONVEYOR_START_MAX_ATTEMPTS, ...last };
}

/**
 * One delivery, AWAITED, with its final failure reported exactly as the
 * fire-and-forget path reports it. Never throws. For a caller that is itself
 * detached and records the outcome (services/rm-board-link.ts → the start
 * attempt row, R311 §2.5).
 */
export async function startConveyor(e: ConveyorStartEvent): Promise<ConveyorStartOutcome> {
  let outcome: ConveyorStartOutcome;
  try {
    outcome = await deliverConveyorStart(e);
  } catch (err) {
    outcome = { kind: 'failed', attempts: 0, status: null, reason: err instanceof Error ? err.message : String(err) };
  }
  logOutcome(e, outcome, 'without');
  return outcome;
}

/**
 * Report a final outcome that is not a delivery. A 400 is fr's OWN malformed
 * start (wrong event or no Idempotency-Key) — a programming error, so it is
 * logged at error level with that name before the usual swallowed-failure report.
 * A refusal is the conveyor's considered answer, not an outage: one warn line.
 */
function logOutcome(e: ConveyorStartEvent, outcome: ConveyorStartOutcome, prefix: 'without' | 'created without'): void {
  if (outcome.kind === 'refused') {
    console.warn(
      `[conveyor-start] project ${e.fr_project_id}: the conveyor REFUSED the start (${outcome.code}); a retry would be refused the same way`,
    );
    return;
  }
  if (outcome.kind !== 'failed') return;
  if (outcome.status === 400) {
    console.error(
      `[conveyor-start] PROGRAMMING ERROR: the conveyor answered 400 to fr's start for project ${e.fr_project_id} ` +
        `(${outcome.reason}). fr sent a malformed start (wrong event or no Idempotency-Key); a retry would be rejected the same way.`,
    );
  }
  reportSwallowedFailure(new Error(`conveyor start webhook failed: ${outcome.reason}`), {
    service: 'n8n-conveyor-start',
    method: 'POST',
    path: 'CONVEYOR_START_WEBHOOK_URL',
    degradedTo: `project ${e.fr_project_id} ${prefix} a delivered project.created event (attempts ${outcome.attempts})`,
  });
}

/**
 * Fire-and-forget `project.created`. Synchronous `void`; never throws; never awaited
 * by the caller. Call ONLY after the project row has committed and the RM pm_project
 * and the Planka board exist.
 */
export function emitConveyorStart(e: ConveyorStartEvent): void {
  if (!config.services.n8n.conveyorStartWebhookUrl) return; // inert — logged once at boot
  const work = deliverConveyorStart(e).then(
    (outcome) => logOutcome(e, outcome, 'created without'),
    (err: unknown) => {
      reportSwallowedFailure(err, {
        service: 'n8n-conveyor-start',
        method: 'POST',
        path: 'CONVEYOR_START_WEBHOOK_URL',
        degradedTo: `project ${e.fr_project_id} created without a delivered project.created event`,
      });
    },
  );
  void trackDetached(work);
}
