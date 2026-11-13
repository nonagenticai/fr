// tests/unit/routes/assets/page-cap.test.ts
//
// Measured 2026-09-06 in a real browser as `fr-test` (super_admin):
// /decisions, /principles and /requirements each rendered EXACTLY 100 rows with
// no total, no pager and no notice, while the system-workspace tenant holds
// 9,845 decisions. fr sent no `limit`, so the upstream applied its own default
// of 100 and fr presented that page as the whole set.

import { test, expect, describe } from 'bun:test';
import {
  ASSET_LIST_DEFAULT_LIMIT,
  ASSET_LIST_MAX_LIMIT,
  frameProbe,
  pageCapHeaders,
  resolveListLimit,
} from '../../../../src/routes/assets/_lib/page-cap';

const sp = (q: string) => new URLSearchParams(q);

describe('resolveListLimit', () => {
  test('an absent limit uses the default — never "no limit"', () => {
    // The whole defect was that no limit was sent, so the ceiling was somebody
    // else's default. There is no code path here that sends nothing.
    expect(resolveListLimit(sp(''))).toBe(ASSET_LIST_DEFAULT_LIMIT);
    expect(ASSET_LIST_DEFAULT_LIMIT).toBeGreaterThan(0);
  });

  test('an EMPTY or blank limit is "not specified", not zero', () => {
    // `Number('')` is 0 and `Number.isFinite(0)` is true — the same trap that
    // put a zero grace window into the redis supervisor earlier today.
    expect(resolveListLimit(sp('limit='))).toBe(ASSET_LIST_DEFAULT_LIMIT);
    expect(resolveListLimit(sp('limit=%20%20'))).toBe(ASSET_LIST_DEFAULT_LIMIT);
  });

  test('junk, zero and negatives fall back rather than capping at nothing', () => {
    expect(resolveListLimit(sp('limit=abc'))).toBe(ASSET_LIST_DEFAULT_LIMIT);
    expect(resolveListLimit(sp('limit=0'))).toBe(ASSET_LIST_DEFAULT_LIMIT);
    expect(resolveListLimit(sp('limit=-5'))).toBe(ASSET_LIST_DEFAULT_LIMIT);
  });

  test('an explicit in-range limit is honoured', () => {
    expect(resolveListLimit(sp('limit=250'))).toBe(250);
    expect(resolveListLimit(sp('limit=1'))).toBe(1);
  });

  test('an oversized limit is clamped to the upstream ceiling', () => {
    // Not clamping would compare the probe against a limit the upstream never
    // applied, and report a capped page as complete.
    expect(resolveListLimit(sp('limit=999999'))).toBe(ASSET_LIST_MAX_LIMIT);
  });
});

describe('frameProbe', () => {
  test('reports the FULLEST frame, not the last one', () => {
    // The union calls listFn once per tenant frame. A full tenant frame after
    // an empty system frame still means the user is seeing a capped page.
    const p = frameProbe();
    p.record(200);
    p.record(3);
    expect(p.max).toBe(200);
  });

  test('starts at zero so a route that never records is not "truncated"', () => {
    expect(frameProbe().max).toBe(0);
  });
});

describe('pageCapHeaders', () => {
  test('a FULL frame is reported as truncated', () => {
    const p = frameProbe();
    p.record(200);
    expect(pageCapHeaders(200, p)['X-Truncated']).toBe('true');
  });

  test('a short frame is reported as complete', () => {
    const p = frameProbe();
    p.record(42);
    expect(pageCapHeaders(200, p)['X-Truncated']).toBe('false');
  });

  test('the applied limit is stated, so the client is not guessing', () => {
    expect(pageCapHeaders(200, frameProbe())['X-Applied-Limit']).toBe('200');
  });

  test('the headers are EXPOSED, or the browser hides them from JS', () => {
    // Without this the header is on the wire and invisible to the page — the
    // same silence the change exists to remove.
    const h = pageCapHeaders(200, frameProbe());
    expect(h['Access-Control-Expose-Headers']).toContain('X-Truncated');
    expect(h['Access-Control-Expose-Headers']).toContain('X-Applied-Limit');
  });
});
