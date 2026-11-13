// tests/unit/routes/assets/artifact-preview-max-bytes.test.ts
//
// GET /api/assets/artifacts/:id/preview?max_bytes= — a byte budget that is not
// an integer is refused, and the DECLARED default is what an absent param gets.
//
// ⚠️ MEASURED 2026-09-08, before the fix. The guard was
// `Number.parseInt(maxBytesRaw, 10)` + `!Number.isFinite(n) || n <= 0`, and
// `parseInt` reads a PREFIX, so values that are not integers at all passed the
// positive-integer guard as tiny positive ones:
//
//     ?max_bytes=2.7    -> 2   (preview truncated to TWO bytes)
//     ?max_bytes=1e400  -> 1   (preview truncated to ONE byte)
//     ?max_bytes=1e9    -> 1   (the caller asked for ~1 GB and got one byte)
//
// Each answered 200 with `truncated: true` and a one- or two-byte body — which
// a client cannot tell apart from a genuinely tiny artifact.
//
// This file grades the parser directly rather than the whole handler:
// `handleArtifactPreview` reaches Postgres (`assertProjectAccess`) and the
// artifact service on the SUCCESS path, so a route-level negative control here
// would be an integration test. The parser is the entire decision — the handler
// calls it and does nothing else with `max_bytes` — and `bunx tsc --noEmit`
// pins that it is the one the route uses.
//
// The default is asserted against the imported `PREVIEW_MAX_BYTES` constant,
// never the literal 1048576.

import { describe, test, expect } from 'bun:test';
import {
  PREVIEW_MAX_BYTES,
  parsePreviewMaxBytes,
} from '../../../../src/routes/assets/artifacts';

// ---------------------------------------------------------------------------
// POSITIVE — absent yields the declared default; non-integers are refused
// ---------------------------------------------------------------------------

describe('absent ?max_bytes= yields the DECLARED default', () => {
  test('null → PREVIEW_MAX_BYTES', () => {
    expect(parsePreviewMaxBytes(null)).toBe(PREVIEW_MAX_BYTES);
  });
});

describe('a ?max_bytes= that is not a positive integer is refused', () => {
  const junk: Array<[string, string]> = [
    ['2.7', 'non-integer — used to truncate the preview to TWO bytes'],
    ['1e400', 'Infinity — used to truncate the preview to ONE byte'],
    ['5px', 'trailing junk — used to be read as 5'],
    ['abc', 'unparseable — refused before and still is'],
    ['0', 'zero — refused before and still is'],
    ['-1', 'negative — refused before and still is'],
    ['', 'blank — refused before (parseInt("") is NaN) and still is'],
  ];

  for (const [value, why] of junk) {
    test(`?max_bytes=${value || '<blank>'} → null, i.e. INVALID_MAX_BYTES (${why})`, () => {
      // `null` is exactly what makes the handler return its pre-existing
      // 400 { error: { code: 'INVALID_MAX_BYTES' } } body — the refusal shape
      // is unchanged, only the set of inputs reaching it grew.
      expect(parsePreviewMaxBytes(value)).toBeNull();
    });
  }
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROLS — real byte counts are unaffected
// ---------------------------------------------------------------------------

describe('NEGATIVE CONTROL — a caller sending a real byte count is unaffected', () => {
  // These FAIL against an always-refuse rule: each asserts the exact number
  // that must come back, not merely "not refused".
  test('a small real byte count passes through untouched', () => {
    expect(parsePreviewMaxBytes('1')).toBe(1);
    expect(parsePreviewMaxBytes('1024')).toBe(1024);
    expect(parsePreviewMaxBytes('65536')).toBe(65536);
  });

  test('the largest in-range value is honoured exactly, not clamped off by one', () => {
    expect(parsePreviewMaxBytes(String(PREVIEW_MAX_BYTES))).toBe(PREVIEW_MAX_BYTES);
    expect(parsePreviewMaxBytes(String(PREVIEW_MAX_BYTES - 1))).toBe(PREVIEW_MAX_BYTES - 1);
  });

  test('an over-large but WELL-FORMED value is still clamped, not refused', () => {
    // ⚠️ `1e9` is where the census and the code disagree, and the code is
    // right: `Number('1e9')` is exactly 1000000000 and IS an integer, so the
    // request is well formed — the caller asked for the biggest preview
    // available and now gets it. The bug was `parseInt('1e9', 10) === 1`
    // serving ONE byte for that request. Turning this into a 400 would be a new
    // defect (refusing a request this route has always honoured), and the
    // AG-UI twin bounds it the same way (`.max(PREVIEW_MAX_BYTES)`).
    expect(parsePreviewMaxBytes('1e9')).toBe(PREVIEW_MAX_BYTES);
    expect(parsePreviewMaxBytes('999999999')).toBe(PREVIEW_MAX_BYTES);
    expect(Number.parseInt('1e9', 10)).toBe(1); // the value the bug served
  });
});
