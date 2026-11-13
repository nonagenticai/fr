// src/connectors/dispatcher.ts
// Dispatcher: takes an IntakeEnvelope and routes it to the operator's handler.
//
// Two implementations:
//   WebhookDispatcher — POST JSON to webhook_url, retry once on 5xx. A non-2xx
//     throws DispatchHttpError, which carries the status AND whether it is
//     PERMANENT (see isPermanentDispatchStatus / TRANSIENT_4XX_STATUSES).
//   DirectDispatcher  — delivers nothing; reports direct_dispatcher_noop.
//
// selectDispatcher(env) — returns DirectDispatcher if
//   SCHEDULED_TRIGGER_DISPATCHER === 'direct', else WebhookDispatcher.
//
// Spec 2 Plan 2-B Track A.

import type { IntakeEnvelope } from '../types/intake-envelope';
import { assertPublicUrl, safeFetch } from '../utils/ssrf-guard';

export interface DispatchTarget {
  kind: string;
  webhook_url?: string;
}

/**
 * Outcome of a dispatch attempt.
 *
 * `delivered` is the ONLY thing a caller may count as "a record was handed
 * to the operator". A dispatch that is skipped (no target configured, no
 * in-process handler installed) is NOT a delivery — the previous `Promise<void>`
 * signature made the two indistinguishable, and the tick worker counted the
 * skip as a processed record (status='ok', records_processed=N, nothing
 * delivered anywhere).
 *
 * A hard delivery failure (non-2xx after the retry) still THROWS — the caller
 * needs to distinguish "nothing to do" from "the operator's endpoint is down".
 */
export interface DispatchResult {
  delivered: boolean;
  /** Machine-readable reason when `delivered` is false. */
  reason?: string;
}

/**
 * 4xx statuses that are NOT permanent.
 *
 * Everything else in 4xx says "this request will never succeed as sent" —
 * a wrong/deleted URL (404), bad credentials (401/403), a payload the peer
 * rejects (400/422). Re-POSTing those on the next cron slot forever is what
 * let a single trigger pointed at a DELETED n8n workflow emit 100% of the
 * n8n service's production error log: 2,160 dead POSTs/day, indefinitely.
 *
 * The three exceptions are retry-later signals by specification:
 *   408 Request Timeout   — RFC 9110 §15.5.9: the client may repeat the request.
 *   425 Too Early         — RFC 8470 §5.2: the server declines to risk a replay
 *                           of TLS early-data; the client "can retry the request
 *                           when the handshake completes". It is definitionally
 *                           a try-again status, and it can only arise when the
 *                           client sends 0-RTT early data (Bun's fetch does not),
 *                           so including it costs nothing and mis-classifying it
 *                           would permanently disable a working trigger.
 *   429 Too Many Requests — RFC 6585 §4: explicit back-pressure, not a defect.
 *
 * The risk here is asymmetric, and that asymmetry is the whole argument for
 * keeping this set conservative: calling a TRANSIENT status permanent disables
 * a healthy trigger and silently stops ingesting real records, while calling a
 * PERMANENT status transient only costs one more cron slot of log noise.
 */
export const TRANSIENT_4XX_STATUSES: ReadonlySet<number> = new Set([408, 425, 429]);

/**
 * Is this HTTP status a PERMANENT client error — one that re-sending the exact
 * same request can never fix?
 *
 * 5xx is explicitly NOT permanent: that is the peer being broken, not us, and
 * it is already covered by the retry-once path below.
 */
export function isPermanentDispatchStatus(status: number): boolean {
  return status >= 400 && status < 500 && !TRANSIENT_4XX_STATUSES.has(status);
}

/**
 * A dispatch that failed with a real HTTP status.
 *
 * Exists because the caller has to make a RETRY-OR-GIVE-UP decision and the
 * old `new Error('... returned HTTP 404')` only carried the status inside a
 * human-readable string. Re-parsing a status out of a message with a regex is
 * how a classifier silently starts matching nothing; the status is structured
 * data and it travels as structured data.
 *
 * The `message` format is byte-identical to the string the plain Error used to
 * carry, so existing log greps and the existing `rejects.toThrow(/500/)` test
 * keep working.
 */
export class DispatchHttpError extends Error {
  override readonly name = 'DispatchHttpError';
  readonly status: number;
  readonly url: string;
  /** True when re-sending this request can never succeed. */
  readonly permanent: boolean;

  constructor(url: string, status: number) {
    super(`WebhookDispatcher: ${url} returned HTTP ${status}`);
    this.url = url;
    this.status = status;
    this.permanent = isPermanentDispatchStatus(status);
  }
}

/**
 * Narrow an unknown caught value to a PERMANENT dispatch failure.
 *
 * Deliberately duck-typed rather than `instanceof`: the tick worker catches
 * `unknown` from a call that crosses a module boundary, and `instanceof` across
 * two copies of a module (Bun's loader, a re-export chain) silently returns
 * false — which would degrade this guard to "nothing is ever permanent", the
 * exact defect it exists to fix, with no test able to see it.
 */
export function isPermanentDispatchError(
  err: unknown,
): err is DispatchHttpError {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { name?: unknown }).name === 'DispatchHttpError' &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (err as { permanent?: unknown }).permanent === true
  );
}

export interface Dispatcher {
  dispatch(envelope: IntakeEnvelope, target: DispatchTarget): Promise<DispatchResult>;
  /**
   * Can this target EVER be delivered to, independent of any record?
   *
   * Lets a caller distinguish a permanent misconfiguration from a transient
   * delivery failure BEFORE it starts consuming records. Without it, a trigger
   * with no destination re-claims and re-releases an idempotency row for every
   * record on every tick, forever — real measured load, and unbounded audit
   * rows — when the honest answer is "this trigger is misconfigured, skip it".
   */
  canDeliver(target: DispatchTarget): DispatchResult;
}

// ----- WebhookDispatcher ----------------------------------------------------

export class WebhookDispatcher implements Dispatcher {
  canDeliver(target: DispatchTarget): DispatchResult {
    return target.webhook_url
      ? { delivered: true }
      : { delivered: false, reason: 'no_webhook_url' };
  }

  async dispatch(
    envelope: IntakeEnvelope,
    target: DispatchTarget,
  ): Promise<DispatchResult> {
    if (!target.webhook_url) {
      // Nothing to POST to. This is NOT a delivery.
      //
      // (The old comment here claimed this branch covered the "n8n_webhook
      // passive connector". That was factually wrong: N8nWebhookConnectorConfig
      // is the ONLY config variant that even has a `webhook_url` field, and it
      // is required — while `n8nWebhookConnector.fetch()` yields nothing during
      // a cron tick, so this branch is unreachable for that kind. The kinds
      // that actually land here are file/rss/github_query/s3, which have no
      // webhook_url at all: perfectly valid triggers whose records were being
      // silently dropped and then reported as processed.)
      return { delivered: false, reason: 'no_webhook_url' };
    }

    // SSRF guard. This is the recurring cron-tick counterpart of the
    // test-connection preflight, and it is worse: it POSTs the tenant's ACTUAL
    // record data rather than just probing, so an internal target would receive
    // real payloads on every tick. Validated per dispatch — the stored config
    // can be edited between ticks, so checking once at save time would not hold.
    await assertPublicUrl(target.webhook_url);

    const body = JSON.stringify(envelope);
    const headers = { 'Content-Type': 'application/json' };

    // H3: safeFetch re-checks every redirect hop (a plain fetch followed a
    // public 3xx to an internal host with the tenant's record data).
    let response = await safeFetch(target.webhook_url, {
      method: 'POST',
      headers,
      body,
    });

    if (response.status >= 500) {
      // Retry once on server error
      response = await safeFetch(target.webhook_url, {
        method: 'POST',
        headers,
        body,
      });
    }

    if (!response.ok) {
      // Typed so the caller can tell "the operator's endpoint is down" (retry
      // next slot) from "this URL is gone / rejects us" (stop dispatching).
      throw new DispatchHttpError(target.webhook_url, response.status);
    }

    return { delivered: true };
  }
}

// ----- DirectDispatcher -----------------------------------------------------

// No in-process handler exists: `direct` delivers nothing, and says so rather
// than reporting a delivery. A mis-set SCHEDULED_TRIGGER_DISPATCHER=direct in a
// real environment must not burn idempotency keys and record green runs for
// work that was never done.
export class DirectDispatcher implements Dispatcher {
  canDeliver(_target: DispatchTarget): DispatchResult {
    return { delivered: false, reason: 'direct_dispatcher_noop' };
  }

  async dispatch(_envelope: IntakeEnvelope, _target: DispatchTarget): Promise<DispatchResult> {
    return { delivered: false, reason: 'direct_dispatcher_noop' };
  }
}

// ----- Factory --------------------------------------------------------------

export function selectDispatcher(env: NodeJS.ProcessEnv): Dispatcher {
  if (env['SCHEDULED_TRIGGER_DISPATCHER'] === 'direct') {
    return new DirectDispatcher();
  }
  return new WebhookDispatcher();
}
