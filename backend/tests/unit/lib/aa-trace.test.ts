import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';

import {
  AA_TRACE_HEADER,
  UUID_V7_RE,
  isTraceId,
  resolveTraceId,
  traceIdOrMint,
} from '../../../src/lib/aa-trace';

const V7 = '0192a0b1-2c3d-7e4f-8a5b-6c7d8e9f0a1b';
const V4 = '0b6f3c1e-8d2a-4f5b-9c7d-1e2f3a4b5c6d';

describe('isTraceId / UUID_V7_RE', () => {
  test('accepts a UUIDv7 in either case', () => {
    expect(isTraceId(V7)).toBe(true);
    expect(isTraceId(V7.toUpperCase())).toBe(true);
    expect(UUID_V7_RE.test(V7)).toBe(true);
  });
  test('refuses v4, a wrong variant, garbage and non-strings', () => {
    expect(isTraceId(V4)).toBe(false);
    expect(isTraceId('0192a0b1-0000-7000-c000-000000000000')).toBe(false);
    expect(isTraceId('not-a-uuid')).toBe(false);
    expect(isTraceId(undefined)).toBe(false);
    expect(isTraceId(42)).toBe(false);
  });
});

describe('resolveTraceId(header, body) — the write-side contract (U2)', () => {
  test('neither → null (an orphan write, never refused)', () => {
    expect(resolveTraceId(null, null)).toBeNull();
    expect(resolveTraceId(undefined, undefined)).toBeNull();
    expect(resolveTraceId('   ', null)).toBeNull();
  });
  test('header only / body only → that id, lowercased', () => {
    expect(resolveTraceId(V7.toUpperCase(), null)).toBe(V7);
    expect(resolveTraceId(null, V7.toUpperCase())).toBe(V7);
  });
  test('both, equal ignoring case → the id', () => {
    expect(resolveTraceId(V7, V7.toUpperCase())).toBe(V7);
  });
  test('malformed header or body → 422 trace_id_malformed', () => {
    for (const [h, b] of [[V4, null], [null, 'abc']] as const) {
      let err: any;
      try { resolveTraceId(h, b); } catch (e) { err = e; }
      expect(err?.code).toBe('trace_id_malformed');
      expect(err?.statusCode).toBe(422);
    }
  });
  test('both valid but differing → 400 trace_id_conflict', () => {
    const other = '0192a0b1-2c3d-7e4f-8a5b-6c7d8e9f0a1c';
    let err: any;
    try { resolveTraceId(V7, other); } catch (e) { err = e; }
    expect(err?.code).toBe('trace_id_conflict');
    expect(err?.statusCode).toBe(400);
  });
});

describe('traceIdOrMint(headers) — fr-originated actions adopt or mint, never throw', () => {
  let warn: ReturnType<typeof spyOn>;
  let info: ReturnType<typeof spyOn>;
  beforeEach(() => {
    warn = spyOn(console, 'warn').mockImplementation(() => {});
    info = spyOn(console, 'info').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
    info.mockRestore();
  });

  test('a valid UUIDv7 header is adopted, lowercased, nothing logged', () => {
    expect(traceIdOrMint(new Headers({ [AA_TRACE_HEADER]: V7.toUpperCase() }))).toBe(V7);
    expect(traceIdOrMint(new Headers({ 'x-aa-trace-id': ` ${V7} ` }))).toBe(V7);
    expect(warn).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  test('absent → a fresh UUIDv7 carrying the timestamp, logged at info', () => {
    const before = Date.now();
    const id = traceIdOrMint(new Headers());
    const after = Date.now();
    expect(isTraceId(id)).toBe(true);
    expect(id).toBe(id.toLowerCase());
    const stamped = parseInt(id.replace(/-/g, '').slice(0, 12), 16);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(after);
    expect(info).toHaveBeenCalledTimes(1);
  });

  test('malformed (v4, garbage) → minted, not adopted, logged as a warning, never throws', () => {
    for (const bad of [V4, 'abc']) {
      const id = traceIdOrMint(new Headers({ [AA_TRACE_HEADER]: bad }));
      expect(isTraceId(id)).toBe(true);
      expect(id).not.toBe(bad);
    }
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test('two mints differ', () => {
    expect(traceIdOrMint(new Headers())).not.toBe(traceIdOrMint(new Headers()));
  });
});
