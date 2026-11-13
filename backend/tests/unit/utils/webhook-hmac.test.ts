// tests/unit/utils/webhook-hmac.test.ts
import { test, expect, describe } from 'bun:test';
import { createHmac } from 'node:crypto';
import { verifyMeteringSignature } from '../../../src/utils/webhook-hmac';

const SECRET = 'platform-budget-webhook-secret-abc123';
// Canonical body exactly as billing_service emits it (comma/colon separators,
// sorted keys) — the receiver hashes these bytes verbatim.
const BODY =
  '{"budget_id":"b-1","budget_tokens":1000,"consumed_tokens":830,"event":"budget.threshold_crossed",' +
  '"fired_at":"2026-07-19T00:00:00+00:00","period_start":"2026-07-01T00:00:00+00:00",' +
  '"tenant_id":"t-1","threshold_pct":80,"usage_pct":83.0}';

function sign(body: string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(body, 'utf8').digest('hex');
}

describe('verifyMeteringSignature', () => {
  test('accepts a correct signature over the raw body', () => {
    expect(verifyMeteringSignature(BODY, sign(BODY, SECRET), SECRET)).toBe(true);
  });

  test('rejects a tampered body (signature no longer matches)', () => {
    const good = sign(BODY, SECRET);
    const tampered = BODY.replace('"threshold_pct":80', '"threshold_pct":50');
    expect(verifyMeteringSignature(tampered, good, SECRET)).toBe(false);
  });

  test('rejects a signature made with the wrong secret', () => {
    expect(verifyMeteringSignature(BODY, sign(BODY, 'other-secret'), SECRET)).toBe(false);
  });

  test('rejects a missing header', () => {
    expect(verifyMeteringSignature(BODY, null, SECRET)).toBe(false);
  });

  test('rejects a header without the sha256= prefix', () => {
    const hexOnly = createHmac('sha256', SECRET).update(BODY, 'utf8').digest('hex');
    expect(verifyMeteringSignature(BODY, hexOnly, SECRET)).toBe(false);
  });

  test('rejects an empty/garbage header', () => {
    expect(verifyMeteringSignature(BODY, 'sha256=', SECRET)).toBe(false);
    expect(verifyMeteringSignature(BODY, 'garbage', SECRET)).toBe(false);
  });
});
