import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * THE SENDER MUST STAY ARMED.
 *
 * The receiver-side idempotence guard in
 * `n8n_custom_nodes/workflows/patterns/approval-callback.json :: Resolve Target List`
 * only fires when the callback body carries `redelivery: true`. It shipped in #1285
 * deliberately INERT, its own header saying it "must land BEFORE any sender may
 * re-deliver" — and then nothing ever armed it. Measured 2026-09-10: the string
 * `redelivery` appeared NOWHERE in this repo, so `isRedelivery` was always false and a
 * re-send moved the card unconditionally. That is a two-repo contract with no single
 * place that fails when one half goes missing, which is why it went missing.
 *
 * ⚠️ THIS IS A SOURCE-LEVEL INVARIANT, NOT A BEHAVIOURAL PROOF, and it is labelled as
 * one deliberately. The behavioural proof that the flag reaches the wire lives in
 * `tests/unit/services/n8n-callback.test.ts`. What this adds is the thing that test
 * cannot see: that the estate's ONLY re-sender still asks for it. A typo here does not
 * fail typecheck — `{ db }` is a perfectly valid argument — so without this the guard
 * silently disarms again and every symptom is in another repo.
 */
describe('the deblock redelivery worker arms the receiver guard', () => {
  const src = readFileSync(
    join(import.meta.dir, '../../../src/workers/deblock-callback-redelivery.ts'),
    'utf8',
  );

  test('every deliverDecisionCallback call in the re-sender passes redelivery: true', () => {
    const calls = src.match(/deliverDecisionCallback\([^)]*\)/g) ?? [];
    // Non-vacuity: if the call disappears or is renamed, this must fail rather than
    // pass over an empty list.
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call).toContain('redelivery: true');
    }
  });

  test('the flag is a literal true, never a variable that could resolve false', () => {
    // The receiver accepts `=== true` and nothing else, so a truthy-but-not-true value
    // would leave the guard inert while reading as armed at this call site.
    expect(src).not.toMatch(/redelivery:\s*(?!true\b)[A-Za-z_$]/);
  });
});
