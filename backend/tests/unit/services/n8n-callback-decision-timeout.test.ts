// tests/unit/services/n8n-callback-decision-timeout.test.ts
//
// A TIMEOUT IS NOT A FAILURE, AND THE TWO DEADLINES ARE NOT ONE NUMBER.
//
// WHY THIS EXISTS — the defect it pins
// ------------------------------------
// `reportDecisionCallback` (routes/approvals.ts) passed ONE value as BOTH the
// outer request deadline and the send bound, and that value defaulted to 5000.
// The receiver is an n8n webhook with `responseMode: lastNode`, so fr waits for
// the WHOLE workflow — a Planka card move included. Measured latency across all
// three receivers (worker4 db `n8n`, `execution_data`, 2026-09-08..11, n=2,352):
// p50 9,472ms, mean 22,844ms. A 5,000ms bound does not sample a slow tail; it
// expires before the TYPICAL send completes.
//
// MEASURED on the live fr DB 2026-09-13: 66 approvals in three days carry
// `decision callback abandoned after 5000ms (no response)` — while n8n recorded
// ZERO errored executions in the same window. The work had very likely
// COMPLETED; only fr had stopped listening. fr then told the decider the
// callback FAILED.
//
// ⛔ ONE KNOB COULD NOT FIX IT, which is the point of the split asserted below.
// The send bound must EXCEED the receiver's typical latency or fr abandons calls
// that were about to succeed. The request deadline must sit UNDER it or a human
// waits on a spinner after clicking Approve. Raising the single shared value
// would have moved the cost from the card onto the decider.
//
// DB-free: the stub `database` dispatches on table identity, no connection.
// Mirrors n8n-callback-expiry-timeout.test.ts, which pins the sibling ceiling.

import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_DECISION_CALLBACK_TIMEOUT_MS,
  DEFAULT_DECISION_REQUEST_DEADLINE_MS,
  decisionCallbackTimeoutMs,
  decisionOutcomeIsSettled,
  decisionRequestDeadlineMs,
} from '../../../src/services/n8n-callback';
import { approvalCallbackTimeoutMs } from '../../../src/services/n8n';

const SEND_ENV = 'APPROVAL_DECISION_CALLBACK_TIMEOUT_MS';
const REQ_ENV = 'APPROVAL_DECISION_REQUEST_DEADLINE_MS';

/**
 * The receiver's measured p50, in ms. The SEND bound must clear it or the
 * typical decision is abandoned; the REQUEST deadline should not, or every
 * decider waits for the slow half before being told anything.
 */
const MEASURED_RECEIVER_P50_MS = 9_472;

/**
 * RE-MEASURED 2026-09-14, live on worker4 db `n8n`, `execution_entity` joined to
 * `workflow_entity`, 14-day window, grouped by receiver so the decide path is not
 * pooled with the signoff rail:
 *
 *   AA Pattern - Approval Callback   n=675   mean 7,857  p50 6,914  p75 10,420
 *                                            p90 12,928  p99 29,746
 *
 * Both readings are kept, and the deadline must be right under BOTH — a value
 * tuned to only the newer population is a correction that expires.
 */
const MEASURED_RECEIVER_P90_MS = 12_928;


afterEach(() => {
  delete process.env[SEND_ENV];
  delete process.env[REQ_ENV];
});

describe('the send bound and the decider request deadline are separate numbers', () => {
  test('the SEND bound clears the receiver measured p50', () => {
    // ⛔ THE ASSERTION THAT FAILS AT 5000. Not "the number changed" — "the
    // number covers the distribution that produced the 66 abandonments".
    expect(decisionCallbackTimeoutMs()).toBeGreaterThan(MEASURED_RECEIVER_P50_MS);
  });

  // ── #B1 — THE DEADLINE WAS ON THE WRONG SIDE OF THE MEDIAN ─────────────────
  // The split shipped 2026-09-13 was right; the value was not. 8,000 ms sat just
  // UNDER the receiver's p50, and a deadline under the MEDIAN resolves strictly
  // FEWER THAN HALF of all sends inside the request. So `pending` — rendered to
  // the operator as "unknown, still reconciling" — was the MAJORITY outcome of a
  // perfectly healthy approval, and the product owner read it as "Approve seemed
  // to fail". The comment on the constant even claimed the opposite ("most
  // decisions will still resolve inside the request"), which is arithmetically
  // impossible for a sub-median bound.
  test('the REQUEST deadline EXCEEDS the receiver p50, so the TYPICAL approval resolves in-request', () => {
    // ⛔ THE ASSERTION THAT FAILS AT 8_000, under the OLDER and more conservative
    // of the two measured populations.
    expect(decisionRequestDeadlineMs()).toBeGreaterThan(MEASURED_RECEIVER_P50_MS);
  });

  test('...and clears the live p90, so it is a majority and not a coin flip', () => {
    // ⭐ THE DISCRIMINATOR AGAINST "just nudge it over the median". A value of,
    // say, 9,500 passes the p50 arm above while still leaving ~half the traffic
    // unresolved on today's distribution. Clearing p90 is what makes the claim
    // "the common case resolves inside the deadline" true rather than marginal.
    expect(decisionRequestDeadlineMs()).toBeGreaterThan(MEASURED_RECEIVER_P90_MS);
  });

  test('the REQUEST deadline is STRICTLY SHORTER than the send bound', () => {
    // ⭐ THE MUTATION THIS KILLS: re-collapsing the two back into one knob.
    // Either direction of that collapse passes some other assertion in this
    // file — a shared 30s passes the p50 arm, a shared 5s passes nothing but
    // used to be the shipped state — and only the INEQUALITY catches both.
    expect(decisionRequestDeadlineMs()).toBeLessThan(decisionCallbackTimeoutMs());
  });

  test('the send bound is not INERT — the client aborts its own fetch above it', () => {
    // A value above `N8nClient`'s own AbortSignal would never be the thing that
    // fires, so the knob would look raised and change nothing.
    expect(decisionCallbackTimeoutMs()).toBeLessThanOrEqual(approvalCallbackTimeoutMs());
  });

  test('the human wait stays BOUNDED — at most half the send bound', () => {
    // ⛔ THE OTHER DIRECTION OF THE B1 FIX, AND THE ONE AN OVER-CORRECTION BREAKS.
    // "Clear the p90" alone is satisfied by 29,999 ms, which is the 30s spinner the
    // 2026-09-13 split existed to prevent. The deadline must clear the receiver's
    // typical latency AND leave the tail to the redelivery worker rather than making
    // the human wait for it.
    expect(decisionRequestDeadlineMs()).toBeLessThanOrEqual(decisionCallbackTimeoutMs() / 2);
  });

  test('the exported defaults and the resolved defaults agree', () => {
    expect(decisionCallbackTimeoutMs()).toBe(DEFAULT_DECISION_CALLBACK_TIMEOUT_MS);
    expect(decisionRequestDeadlineMs()).toBe(DEFAULT_DECISION_REQUEST_DEADLINE_MS);
  });

  test('both stay knobs — an operator override still wins on each, independently', () => {
    process.env[SEND_ENV] = '45000';
    process.env[REQ_ENV] = '1500';
    expect(decisionCallbackTimeoutMs()).toBe(45_000);
    expect(decisionRequestDeadlineMs()).toBe(1_500);
  });

  test('a typo cannot install a 0ms bound that aborts every send instantly', () => {
    process.env[SEND_ENV] = 'not-a-number';
    process.env[REQ_ENV] = '0';
    expect(decisionCallbackTimeoutMs()).toBe(DEFAULT_DECISION_CALLBACK_TIMEOUT_MS);
    expect(decisionRequestDeadlineMs()).toBe(DEFAULT_DECISION_REQUEST_DEADLINE_MS);
  });
});

// ── #B2 — "THE DECISION WAS RECORDED" AND "fr KNOWS WHAT HAPPENED NEXT" ────────
// `PUT /api/approvals/:id` answered HTTP 200 for EVERY completing decision, so a
// caller that branches on the status code — the AA conveyor, the approval
// scripts, curl: every non-browser caller on this route — could not tell "handed
// to the receiver" from "fr has no idea". This predicate is the one expression
// both the status code and the response body are derived from.
describe('decisionOutcomeIsSettled — fr KNOWS, which is not the same as the card moved', () => {
  test('a send the receiver accepted is settled', () => {
    expect(decisionOutcomeIsSettled('sent')).toBe(true);
  });

  test('a row that owed no send at all is settled — there is nothing left to learn', () => {
    expect(decisionOutcomeIsSettled('skipped-no-callback-path')).toBe(true);
  });

  test.each([
    ['pending'],
    ['timeout-unknown'],
    ['failed'],
    ['not-attempted'],
    // ⛔ THE TWO `skipped-*` THAT ARE NOT SETTLED. A send WAS owed on these rows
    // and deliberately not made. Widening the predicate to "not failed" would
    // sweep them in and rebuild the exact lie `services/n8n-callback.ts` exists
    // to remove — the same warning `lib/chat-seat-decision.ts :: isDelivered`
    // carries verbatim.
    ['skipped-not-found'],
    ['skipped-unsupported-receiver'],
  ])('%s is NOT settled', (outcome) => {
    expect(decisionOutcomeIsSettled(outcome)).toBe(false);
  });

  test('CONTROL: an outcome string this build has never heard of is NOT settled', () => {
    // Fails closed. A predicate that defaulted to `true` would silently promote
    // every future outcome to a 200.
    expect(decisionOutcomeIsSettled('some-future-outcome')).toBe(false);
  });
});
