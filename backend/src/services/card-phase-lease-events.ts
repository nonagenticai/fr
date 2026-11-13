// src/services/card-phase-lease-events.ts
//
// `lease.released` — fr tells n8n that a card's phase lease is no longer held, so
// the QA re-pull can be event-driven instead of waiting for its next poll.
//
// TRANSPORT IS REUSED, NOT INVENTED: `n8nClient.callWebhook` (services/n8n.ts) —
// N8N_WEBHOOK_URL base, `X-Webhook-Secret`, attribution headers, its fixed 10s
// AbortSignal timeout. The path is `config.services.n8n.leaseReleasedWebhook`
// (env AA_LEASE_RELEASED_WEBHOOK).
//
// ⛔ DEFAULT OFF. The env is UNSET by default ⇒ this emitter is a no-op: no POST,
// no failure-counter increment, one debug line per process. The consumer
// workflow (`aa-qa-repull`) does not exist in n8n yet; a default path would make
// every production lease release POST to a missing webhook (404 noise + the
// failure counter climbing). ARMING = setting AA_LEASE_RELEASED_WEBHOOK in gitops
// TOGETHER with shipping the consumer. Same shape as `aaEvaluateLensesWebhook`
// (config.ts: `process.env.AA_EVALUATE_LENSES_WEBHOOK || ''`).
//
// ⛔ THE CONTRACT THE CALLER (routes/webhooks/card-phase-lease.ts) RELIES ON:
//   * Call this ONLY after the lease write has COMMITTED. Every lease statement is
//     one autocommit statement on `queryClient` (no `begin()`), so "after the
//     awaited statement returned" IS "after commit", and no row lock is held while
//     the POST is in flight (the fr#1314 class: no HTTP inside a transaction or
//     under a lock).
//   * It never throws and is never awaited: it returns `void` synchronously and
//     the POST runs detached. A failed, non-2xx or slow (timed-out) POST is logged
//     and counted (`fr_card_phase_lease_release_emit_failures_total`) — it can
//     never fail, delay or roll back the lease response.
//   * At-least-once is acceptable (consumers are idempotent on lease_id); fr does
//     no dedupe.

import { trackDetached } from '../lib/detached-work';
import { config } from '../config';
import {
  recordLeaseReleaseEmitFailure,
  type LeaseReleaseReason,
} from '../lib/card-phase-lease-emit-metrics';
import { n8nClient } from './n8n';

interface LeaseReleasedEvent {
  event: 'lease.released';
  reason: LeaseReleaseReason;
  tenant_id: string;
  /** The lease key: the card the lease was on. */
  lease_key: string;
  /** The lease that ENDED (for a supersede/preempt: the previous holder's). */
  lease_id: string;
  holder: string;
  /** ISO-8601 UTC, rendered by Postgres. */
  released_at: string;
}

let loggedDisabled = false;

/**
 * Fire-and-forget `lease.released`. Synchronous `void`; never throws; never
 * awaited by the caller. See the header for the after-commit contract.
 */
export function emitLeaseReleased(event: Omit<LeaseReleasedEvent, 'event'>): void {
  const path = config.services.n8n.leaseReleasedWebhook;
  if (!path) {
    // Unarmed (the default): nothing to POST to. Not a failure — no counter.
    if (!loggedDisabled) {
      loggedDisabled = true;
      console.debug(
        '[card-phase-lease] lease.released emit disabled (AA_LEASE_RELEASED_WEBHOOK unset)',
      );
    }
    return;
  }
  const payload: LeaseReleasedEvent = { event: 'lease.released', ...event };
  const fail = (err: unknown) => {
    recordLeaseReleaseEmitFailure(payload.reason);
    console.error(
      `[card-phase-lease] lease.released emit failed (reason=${payload.reason} ` +
        `lease_id=${payload.lease_id}):`,
      err instanceof Error ? err.message : err,
    );
  };
  try {
    // Detached on purpose: `void` + `.catch` — the caller's response never waits
    // on this POST (up to callWebhook's 10s timeout).
    // `projectId: null` — present-but-empty: this event is about a card lease, and
    // must not borrow whatever project the request context happens to carry.
    void trackDetached(
      n8nClient
        .callWebhook(path, payload as unknown as Record<string, unknown>, { projectId: null })
        .catch(fail),
    );
  } catch (err) {
    // A synchronous throw from the transport must not escape into the route.
    fail(err);
  }
}
