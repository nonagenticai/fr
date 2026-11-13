// src/lib/approval-callback-url.ts
//
// D17 (George-approved, agreed with the conveyor design session): an approval
// minted by n8n through the LICENCE door may carry `callback_url` — the n8n Wait
// node's `$execution.resumeUrl`, e.g.
//   https://n8n.example.com/webhook-waiting/<execId>?signature=…
// On a decision fr POSTs the EXISTING decision payload (services/n8n-callback.ts
// buildCallbackPayload) to that URL exactly as given, with
// `X-Approval-Callback-Secret`, and to nothing else.
//
// ⛔ THE URL IS A CAPABILITY. Its `signature` query parameter lets whoever holds it
// resume the waiting execution with ANY body. So:
//   * it is stored in a side table (migration 191), never on an `approvals` row;
//   * it is NEVER logged in full — `redactCallbackUrl` gives origin + path prefix;
//   * every error this module raises is built from the redacted form only.
//
// MINT-TIME VALIDATION (`assertCallbackUrlAllowed`, 422 `callback_url_not_allowed`):
//   * an absolute http(s) URL, no userinfo, at most 2048 chars;
//   * its origin (scheme + host + port) is in N8N_CALLBACK_ORIGINS (comma-separated;
//     default EMPTY ⇒ every callback_url is refused);
//   * https only, unless the allowlisted origin itself is http — enforced by the
//     origin match, because an origin INCLUDES its scheme;
//   * its (parser-normalised) path starts with `/webhook-waiting/` and names
//     something after it.
//
// DELIVERY (`postDecisionToCallbackUrl`): `redirect: 'manual'` — a 3xx is NOT
// followed and counts as a failure, so an allowlisted host cannot bounce the
// secret header elsewhere. An approval may carry SEVERAL URLs (a dedupe attaches
// its URL to the surviving gate); each row has its own claim / backoff / delivered
// state (`claimCallbackUrlSend` etc., workers/approval-redelivery.ts lane).

import { sql } from 'drizzle-orm';

import { config } from '../config';
import { db } from '../db/client';
import { parseCallbackOrigins } from './callback-origins';
import { ValidationError } from '../utils/errors';

export const CALLBACK_URL_NOT_ALLOWED_CODE = 'callback_url_not_allowed' as const;
export const CALLBACK_URL_PATH_PREFIX = '/webhook-waiting/' as const;
export const CALLBACK_URL_MAX_LENGTH = 2048;

/** Backoff base and ceiling: min(15min * 2^attempts, 24h) — migration 186's formula. */
export const REDELIVERY_BACKOFF_BASE_MINUTES = 15;
export const REDELIVERY_BACKOFF_MAX_HOURS = 24;
/**
 * A first send is in flight for at most the client ceiling (30s). Before sending,
 * the row is leased this far ahead, so a pod that dies mid-send leaves a row the
 * worker retries — and a live send is never raced by the worker.
 */
export const CALLBACK_URL_SEND_LEASE_MINUTES = 10;

// ---------------------------------------------------------------------------
// The allowlist
// ---------------------------------------------------------------------------

export { parseCallbackOrigins, type ParsedOrigins } from './callback-origins';

/** The live allowlist (config, read at call time so tests can set the env). */
export function configuredCallbackOrigins(): string[] {
  return parseCallbackOrigins(config.services.n8n.callbackOrigins).origins;
}

// ---------------------------------------------------------------------------
// Redaction
// ---------------------------------------------------------------------------

/**
 * The ONLY form of a callback URL that may be logged or put in an error:
 * `<origin>/webhook-waiting/…`. Never the execution id, never the signature.
 */
export function redactCallbackUrl(raw: string): string {
  try {
    const u = new URL(raw);
    const prefix = u.pathname.startsWith(CALLBACK_URL_PATH_PREFIX) ? CALLBACK_URL_PATH_PREFIX : '/';
    return `${u.protocol}//${u.host}${prefix}…`;
  } catch {
    return '<unparseable callback_url>';
  }
}

// ---------------------------------------------------------------------------
// Mint-time validation
// ---------------------------------------------------------------------------

function notAllowed(why: string): ValidationError {
  return new ValidationError(
    `callback_url is not allowed: ${why}. Nothing was written`,
  ).withCode(CALLBACK_URL_NOT_ALLOWED_CODE);
}

/**
 * Validate a mint's `callback_url`. Returns it UNCHANGED (fr posts exactly what
 * was given). Throws 422 `callback_url_not_allowed` otherwise. Messages name the
 * origin at most — never the path or query.
 */
export function assertCallbackUrlAllowed(
  raw: unknown,
  allowlist: readonly string[] = configuredCallbackOrigins(),
): string {
  if (typeof raw !== 'string' || raw.length === 0) throw notAllowed('it must be a non-empty string');
  if (raw.length > CALLBACK_URL_MAX_LENGTH) {
    throw notAllowed(`it exceeds ${CALLBACK_URL_MAX_LENGTH} characters`);
  }
  if (allowlist.length === 0) {
    throw notAllowed('N8N_CALLBACK_ORIGINS is empty, so no callback origin is allowed');
  }
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw notAllowed('it is not an absolute URL');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw notAllowed('it is not http(s)');
  if (u.username || u.password) throw notAllowed('it carries userinfo');
  if (!allowlist.includes(u.origin)) {
    // An http URL whose host IS allowlisted over https lands here too: the origin
    // includes the scheme, so http is accepted only when the http origin is listed.
    throw notAllowed(`origin ${u.origin} is not in N8N_CALLBACK_ORIGINS`);
  }
  if (!u.pathname.startsWith(CALLBACK_URL_PATH_PREFIX) || u.pathname.length <= CALLBACK_URL_PATH_PREFIX.length) {
    throw notAllowed(`its path must start with ${CALLBACK_URL_PATH_PREFIX} and name the waiting execution`);
  }
  return raw;
}

// ---------------------------------------------------------------------------
// Delivery
// ---------------------------------------------------------------------------

/**
 * A NON-2xx ANSWER FROM THE RECEIVER — with the status carried as a FIELD.
 *
 * ⭐ WHY THE FIELD EXISTS. `status` used to live only inside the message string
 * (`… failed (HTTP 409, non-2xx)`), so a caller that needed to know whether the
 * waiting execution was GONE had to parse an error message. It cannot: the
 * message is deliberately built from the redacted URL and is not a contract.
 *
 * ⚠️ 409/410 ARE NOT FAILURES OF THE SEND. n8n answers 409 from
 * `webhook-waiting/<executionId>` exactly when that execution is no longer
 * waiting (already resumed, cancelled or timed out) — the notice is MOOT, and
 * re-POSTing it cannot start working. The classifier for that lives in
 * `isCallbackUrlAlreadyTerminal`; this class only carries the fact.
 */
export class CallbackUrlHttpError extends Error {
  /** The receiver's HTTP status. Never 2xx — a 2xx never constructs this. */
  readonly status: number;
  /** True for a 3xx: redirects are never followed, so they arrive here too. */
  readonly redirect: boolean;

  constructor(status: number, message: string, redirect = false) {
    super(message);
    this.name = 'CallbackUrlHttpError';
    this.status = status;
    this.redirect = redirect;
  }
}

/**
 * True when the receiver's status says THE WAITING EXECUTION IS GONE, so the
 * notice is moot rather than failed:
 *
 *   * `409 Conflict` — n8n's `webhook-waiting/<executionId>` answer when the
 *     execution is no longer in a waiting state (already resumed, cancelled,
 *     expired). Confirmed live on `fr` 2026-11-03: an expiry notice replayed at
 *     the same execution kept getting 409.
 *   * `410 Gone` — the same fact stated explicitly by any receiver.
 *
 * ⛔ DELIBERATELY NARROW. Only these two. Every other non-2xx (a 5xx, a 404, a
 * 3xx that was not followed) is a failure and must keep its retry/record
 * behaviour: a 500 means the receiver broke, a 404 may mean fr has the wrong
 * path, and neither is evidence that the execution is gone.
 */
export function isCallbackUrlAlreadyTerminal(error: unknown): error is CallbackUrlHttpError {
  return error instanceof CallbackUrlHttpError && (error.status === 409 || error.status === 410);
}

/**
 * Build the error a non-2xx answer throws. One place owns the message text
 * (operators grep for it) and the `status` field, so the two can never drift.
 * The message names only the redacted URL.
 */
export function callbackUrlNon2xxError(status: number, callbackUrl: string): CallbackUrlHttpError {
  const where = redactCallbackUrl(callbackUrl);
  const redirect = status >= 300 && status < 400;
  const kind = redirect ? 'redirect not followed' : 'non-2xx';
  return new CallbackUrlHttpError(
    status,
    `approval callback_url POST to ${where} failed (HTTP ${status}, ${kind})`,
    redirect,
  );
}

/**
 * POST a decision payload to a stored callback URL, exactly as given.
 * Resolves with the receiver's JSON body (or `undefined` for a non-JSON 2xx).
 * Throws {@link CallbackUrlHttpError} whose message carries ONLY the redacted
 * URL on a non-2xx (a 3xx included: redirects are never followed), or a plain
 * Error on a transport error.
 */
export async function postDecisionToCallbackUrl(
  callbackUrl: string,
  payload: unknown,
  opts: { secret: string; timeoutMs: number },
): Promise<unknown> {
  const where = redactCallbackUrl(callbackUrl);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.secret) headers['X-Approval-Callback-Secret'] = opts.secret;
  let res: Response;
  try {
    res = await fetch(callbackUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'manual',
      signal: AbortSignal.timeout(opts.timeoutMs),
    });
  } catch (err) {
    // ⛔ Never the original message or object: a transport error can carry the
    // full URL (Bun puts it on `.path`; some messages quote it).
    const name = err instanceof Error ? err.name : 'Error';
    const code = (err as { code?: unknown } | null)?.code;
    throw new Error(
      `approval callback_url POST to ${where} failed (${name}${typeof code === 'string' ? ` ${code}` : ''})`,
    );
  }
  if (res.status < 200 || res.status >= 300) {
    // Drain without reading it into the message — the body is the receiver's and
    // may echo the request URL.
    await res.body?.cancel().catch(() => {});
    // The message text is unchanged (operators grep for it); the status is now
    // ALSO a field, so classification never parses this string.
    throw callbackUrlNon2xxError(res.status, callbackUrl);
  }
  const text = await res.text().catch(() => '');
  if (!text) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Per-callback delivery state (migration 191's columns, one row per URL)
// ---------------------------------------------------------------------------

type Exec = { execute: (q: ReturnType<typeof sql>) => Promise<unknown> };

const rowsOf = <T>(r: unknown): T[] => (Array.isArray(r) ? (r as T[]) : []);

/**
 * CLAIM one callback row for a send. Succeeds only when the row is undelivered
 * and not leased/backed-off (`next_attempt_at` NULL or due), so two senders — the
 * decision path, the expiry/void notice, the redelivery lane — never POST the
 * same row at once. The claim records the attempt BEFORE the send (`attempts`+1)
 * and leases the row {@link CALLBACK_URL_SEND_LEASE_MINUTES} ahead, so a crash
 * mid-send leaves it retryable. Returns the attempts made BEFORE this one (0 = a
 * first send), or `null` when the row was not claimable.
 */
export async function claimCallbackUrlSend(exec: Exec, callbackId: string): Promise<number | null> {
  const r = rowsOf<{ prior: number }>(
    await exec.execute(sql`
      UPDATE approval_callback_urls
         SET attempts = attempts + 1,
             next_attempt_at = now() + make_interval(mins => ${CALLBACK_URL_SEND_LEASE_MINUTES})
       WHERE id = ${callbackId}::uuid
         AND delivered_at IS NULL
         AND (next_attempt_at IS NULL OR next_attempt_at <= now())
      RETURNING attempts - 1 AS prior
    `),
  );
  return r.length > 0 ? Number(r[0]!.prior) : null;
}

/**
 * After a failed send: next = now() + min(15min * 2^(attempts-1), 24h) — the first
 * failure waits 15 min. `error` must already be redacted (it is stored).
 */
export async function scheduleCallbackUrlRetry(exec: Exec, callbackId: string, error: string): Promise<void> {
  await exec.execute(sql`
    UPDATE approval_callback_urls
       SET next_attempt_at = now() + least(
             make_interval(mins => ${REDELIVERY_BACKOFF_BASE_MINUTES}) * power(2, greatest(attempts - 1, 0)),
             make_interval(hours => ${REDELIVERY_BACKOFF_MAX_HOURS})
           ),
           last_error = ${error.slice(0, 300)}
     WHERE id = ${callbackId}::uuid
  `);
}

/** After a delivered send: this row is done; nothing left to retry. */
export async function markCallbackUrlDelivered(exec: Exec, callbackId: string): Promise<void> {
  await exec.execute(sql`
    UPDATE approval_callback_urls
       SET delivered_at = now(), next_attempt_at = NULL, last_error = NULL
     WHERE id = ${callbackId}::uuid
  `);
}

/**
 * The receiver answered 409/410: the waiting execution this URL would resume is
 * GONE, so the notice is moot. Retire the row exactly as a delivery would —
 * `delivered_at` is the ONLY column every sender's claim predicate and both
 * retry lanes read, so it is the terminal marker that stops the replay.
 *
 * ⛔ NO `last_error` AND NO RE-QUEUE. Nothing failed: writing an error would
 * make a moot row read as a broken one, and `scheduleCallbackUrlRetry` would
 * replay a notice at an execution that no longer exists — the live defect this
 * function is the repair for (fr re-POSTing 409s forever).
 *
 * ⚠️ "delivered" IS THE COLUMN'S NAME, NOT A CLAIM. It means this row has
 * nothing left to deliver; it is not an assertion that the receiver accepted
 * anything. The receiver having said GO AWAY is a terminal state.
 */
export async function markCallbackUrlAlreadyTerminal(exec: Exec, callbackId: string): Promise<void> {
  // ⚠️ ONE WRITER FOR "RETIRE THIS ROW". The SQL is `markCallbackUrlDelivered`'s
  // on purpose — `delivered_at`, `next_attempt_at` and `last_error` ARE the
  // retirement contract — so a future column added to it cannot be missed here.
  // The distinct NAME is what a reader (and the log line) needs: the receiver
  // did not accept a notice; it said there was nothing left to accept.
  await markCallbackUrlDelivered(exec, callbackId);
}

/**
 * Attach a callback URL to an approval (migration 191 side table). Called right
 * after a mint, AND when a create DEDUPES onto an existing pending gate — the
 * second n8n execution must be resumed too, so its URL rides the surviving gate.
 * Re-attaching the same URL to the same approval is a no-op (unique on
 * approval_id + md5(url), ON CONFLICT DO NOTHING). Returns whether a row was added.
 */
export async function attachApprovalCallbackUrl(
  approvalId: string,
  tenantId: string,
  callbackUrl: string,
  database: Exec = db,
): Promise<boolean> {
  const r = rowsOf<{ id: string }>(
    await database.execute(sql`
      INSERT INTO approval_callback_urls (approval_id, tenant_id, callback_url)
      VALUES (${approvalId}::uuid, ${tenantId}::uuid, ${callbackUrl})
      ON CONFLICT DO NOTHING
      RETURNING id
    `),
  );
  return r.length > 0;
}
