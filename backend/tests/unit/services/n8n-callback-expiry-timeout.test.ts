// tests/unit/services/n8n-callback-expiry-timeout.test.ts
//
// The expiry re-queue ceiling has to fit the receiver that actually answers it.
//
// WHY THIS EXISTS — the defect it pins
// ------------------------------------
// `expiryCallbackTimeoutMs()` defaulted to 2000 on the strength of an unmeasured
// sentence ("a receiver that cannot answer in 2s is down"). It is not down: all
// three receivers in EXPIRY_CALLBACK_PATHS are n8n webhooks with
// `responseMode: lastNode`, so fr waits for the WHOLE workflow — a Planka card
// move included. Measured on worker4 db `n8n` 2026-09-11, real `expired`
// notices run p50 732ms, p95 17,462ms, p99 18,874ms, max 19,227ms. 59 of 61
// recorded failures on this path read `abandoned after 2000ms`: the ceiling was
// not catching dead receivers, it WAS the failure.
//
// ⚠️ The sizing is bounded from BOTH sides and both bounds are asserted here.
// Too low and the measured tail keeps failing. Too high and the value is INERT,
// because `N8nClient.sendApprovalDecision` aborts its own fetch at
// `approvalCallbackTimeoutMs()` (30s) and the whole notice phase stops at
// `notifyDeadlineMs()` (60s) — a race timeout above either is simply never the
// thing that fires.
//
import { afterEach, describe, expect, test } from 'bun:test';

import {
  DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS,
  expiryCallbackTimeoutMs,
} from '../../../src/services/n8n-callback';
import { approvalCallbackTimeoutMs } from '../../../src/services/n8n';

const ENV = 'APPROVAL_EXPIRY_CALLBACK_TIMEOUT_MS';

/**
 * The receiver's measured p95, in ms (worker4 db `n8n`, `execution_entity`,
 * 2026-09-08..11, real `expired` notices only). The ceiling must clear this or
 * the whole tail keeps being abandoned.
 *
 * ⚠️ p95 and not p99 on purpose: n = 18, which makes a p99 an interpolation
 * between the top two samples rather than a measurement. This test asserts on
 * the number the sample size can actually carry.
 */
const MEASURED_RECEIVER_P95_MS = 17_462;

afterEach(() => {
  delete process.env[ENV];
});

describe('expiryCallbackTimeoutMs is sized off the receiver, not off a guess', () => {
  test('the default clears the receiver measured p95', () => {
    delete process.env[ENV];
    // ⛔ THE ASSERTION THAT FAILS AT 2000. It is not "the number changed" — it
    // is "the number covers the distribution that produced 59 of 61 failures".
    expect(expiryCallbackTimeoutMs()).toBeGreaterThan(MEASURED_RECEIVER_P95_MS);
  });

  test('the default is not INERT — it stays inside the two budgets above it', () => {
    delete process.env[ENV];
    const ceiling = expiryCallbackTimeoutMs();
    // `N8nClient` aborts its own fetch first if this is bigger, so a larger
    // value would never be the thing that fires.
    expect(ceiling).toBeLessThanOrEqual(approvalCallbackTimeoutMs());
    // And the phase deadline in workers/approval-expiry.ts is 60s; a per-send
    // ceiling at or above it means one row can consume the entire phase.
    expect(ceiling).toBeLessThan(60_000);
  });

  test('the exported default and the resolved default agree', () => {
    delete process.env[ENV];
    expect(expiryCallbackTimeoutMs()).toBe(DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS);
  });

  // The knob stays a knob. A change that hard-coded the new value would pass
  // every assertion above and take the operator's override away.
  test('an operator override still wins', () => {
    process.env[ENV] = '45000';
    expect(expiryCallbackTimeoutMs()).toBe(45_000);
  });

  test('a typo cannot install a 0ms ceiling that aborts every send instantly', () => {
    process.env[ENV] = 'not-a-number';
    expect(expiryCallbackTimeoutMs()).toBe(DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS);
    process.env[ENV] = '0';
    expect(expiryCallbackTimeoutMs()).toBe(DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS);
  });
});
