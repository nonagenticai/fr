// src/lib/decision-rate-limit.ts
//
// ── NO HUMAN DECIDES AT MACHINE SPEED (#901), NOW SHARED BY EVERY DECIDE PATH ──
//
// MEASURED 2026-08-31 (the founding incident, on the HTTP seat — `routes/approvals.ts`):
// one shared super-admin account decided 184 approvals in a 38s window, every one with an
// EMPTY comment. The true shape is two-phase: 9 decisions paced over 34s (~3.8s apart,
// plausibly a human), then 175 in 1.14 SECONDS, ~153 per second, ~6.5ms apart. A minimum
// interval is the honest discriminator: 3.8s apart passes with a 3.8x margin, 6.5ms apart
// fails by 150x. It does not guess intent or model a session; it asserts the one thing that
// is physically true — reading a proposition and deciding it takes longer than a second.
//
// ⛔ WHY THIS MOVED OUT OF `routes/approvals.ts`. The gate is enforced against
// `approval_decisions.decided_at` for the SAME `approver_id`, keyed on the DECIDER's
// identity, not on the request path — so a burst spread across the HTTP seat and a chat
// seat (or across the three chat seats) is exactly the shape #901 measured, and a limiter
// that only watched the HTTP seat would let the same unread-burst pattern through the
// moment one PUT in the sequence was a Telegram reply instead. Enforced against the DB
// rather than in memory so it holds across pods, restarts and channels alike — an
// in-process limiter would reset exactly when a crash loop (or a channel switch) made
// bursts most likely.
//
// Refusal is per-decision and immediately retryable, so a human clearing a queue is slowed,
// never blocked. The alternative on offer is another 175 unread approvals.

import { db, approvalDecisions } from '../db/client';
import { eq, desc } from 'drizzle-orm';

/**
 * The floor on the gap between two decisions by the SAME approver, across every seat.
 *
 * 1000ms is not a round number chosen for comfort — it sits between the two measured
 * phases of the 2026-08-31 event (3.8s apart human-paced, 6.5ms apart machine-paced) with a
 * wide margin on both sides. Override only with evidence.
 */
export const MIN_DECISION_INTERVAL_MS = Number(
  process.env.APPROVAL_MIN_DECISION_INTERVAL_MS ?? 1000,
);

/** The decider's most recent `decided_at`, or `null` if they have never decided. */
async function lastDecidedAt(approverId: string): Promise<Date | null> {
  const [row] = await db
    .select({ decided_at: approvalDecisions.decided_at })
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approver_id, approverId))
    .orderBy(desc(approvalDecisions.decided_at))
    .limit(1);
  return row?.decided_at ?? null;
}

/**
 * Milliseconds since this approver's most recent decision, or `null` if they have none
 * on record (never refused — there is nothing to compare against).
 */
export async function decisionGapMs(
  approverId: string,
): Promise<number | null> {
  const last = await lastDecidedAt(approverId);
  if (!last) return null;
  return Date.now() - new Date(last).getTime();
}

/**
 * True when `gapMs` falls inside the refused burst window.
 *
 * `gapMs < 0` is NOT refused — a negative gap means clock skew or a decision recorded by a
 * concurrent writer after `now` was captured, and treating clock skew as a burst would
 * refuse a caller for a clock it does not control. This mirrors the `gapMs >= 0` guard
 * `routes/approvals.ts` has enforced since #901.
 */
export function isWithinBurstWindow(gapMs: number | null): boolean {
  return gapMs !== null && gapMs >= 0 && gapMs < MIN_DECISION_INTERVAL_MS;
}

/**
 * The refusal text. One definition so the HTTP seat and the three chat seats describe the
 * same rule identically instead of drifting into four different explanations of one number.
 */
export function decisionRateLimitMessage(gapMs: number): string {
  return (
    `Decisions are arriving faster than anyone can read them: ${gapMs}ms since your ` +
    `previous decision, minimum ${MIN_DECISION_INTERVAL_MS}ms. On 2026-08-31 a burst at ` +
    'this rate approved 175 approvals in 1.14s, 115 of which the approval gate had ' +
    'explicitly marked do_not_decide. Retry in a moment; if you are trying to clear a ' +
    'queue in bulk, that is the thing this refuses.'
  );
}
