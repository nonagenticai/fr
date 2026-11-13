// tests/unit/workers/analytics-rollup-bucket-math.test.ts
//
// The rollup's bucket labelling. `rate(x[5m])` evaluated at instant T covers
// (T-5m, T], i.e. the bucket that ENDS at T. The worker used to evaluate at the
// start of the CURRENT (still open) bucket and label the value with that same
// start — every row one bucket late. Now it rolls up the previous closed bucket
// B = bucketStart(now) - size, evaluated at B + size, and back-fills missed
// buckets (bounded) from analytics_rollup_meta.last_success.
import { describe, expect, test } from 'bun:test';
import * as rollup from '../../../src/workers/analytics-rollup';

const FIVE_MIN = 300;
// 2026-10-12T10:07:30Z — 2.5 min into the 10:05 bucket.
const NOW_MS = Date.UTC(2026, 9, 12, 10, 7, 30);
const B_1005 = Date.UTC(2026, 9, 12, 10, 5, 0) / 1000;
const B_1000 = B_1005 - FIVE_MIN;

describe('bucket math helpers', () => {
  test('closedBucketTs = bucketStart(now) - size; bucketEvalTs = start + size', () => {
    expect(rollup.closedBucketTs(NOW_MS, FIVE_MIN)).toBe(B_1000);
    expect(rollup.bucketEvalTs(B_1000, FIVE_MIN)).toBe(B_1005);
    // Exactly on a boundary: the bucket that just closed.
    expect(rollup.closedBucketTs(B_1005 * 1000, FIVE_MIN)).toBe(B_1000);
  });

  test('never succeeded → only the current closed bucket', () => {
    expect(rollup.bucketsToRoll(NOW_MS, FIVE_MIN, null)).toEqual([B_1000]);
  });

  test('last success one tick ago → no catch-up, just the current closed bucket', () => {
    // A tick at 10:02:30 rolled up 09:55; the next missed bucket is 10:00 = current.
    const last = NOW_MS - FIVE_MIN * 1000;
    expect(rollup.bucketsToRoll(NOW_MS, FIVE_MIN, last)).toEqual([B_1000]);
  });

  test('missed ticks → back-fills every missed bucket oldest first, ending at current', () => {
    // Last success at 09:47:30 covered 09:40; missed 09:45, 09:50, 09:55, then 10:00.
    const last = NOW_MS - 20 * 60 * 1000;
    expect(rollup.bucketsToRoll(NOW_MS, FIVE_MIN, last)).toEqual([
      B_1000 - 3 * FIVE_MIN,
      B_1000 - 2 * FIVE_MIN,
      B_1000 - FIVE_MIN,
      B_1000,
    ]);
  });

  test('a long outage is bounded to MAX_CATCH_UP_BUCKETS (newest kept)', () => {
    const last = NOW_MS - 24 * 3600 * 1000;
    const out = rollup.bucketsToRoll(NOW_MS, FIVE_MIN, last);
    expect(out.length).toBe(rollup.MAX_CATCH_UP_BUCKETS);
    expect(out[out.length - 1]).toBe(B_1000);
    expect(out[0]).toBe(B_1000 - (rollup.MAX_CATCH_UP_BUCKETS - 1) * FIVE_MIN);
  });

  test('a last success in the current bucket (clock skew / same-cycle) still rolls current', () => {
    expect(rollup.bucketsToRoll(NOW_MS, FIVE_MIN, NOW_MS)).toEqual([B_1000]);
  });
});
