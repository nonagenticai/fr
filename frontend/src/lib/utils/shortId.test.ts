// shortId.test.ts
//
// ⚠️ THIS FILE IS NOT A GATE ON ANY CALL SITE. It pins the primitive only. A
// component that goes back to `id.slice(0, 8)` inline still passes every
// assertion here — the 25 hand-rolled sites of fr#1205 are swept separately,
// and `EntityRef.test.ts` is what pins the one component already wired up.
//
// What it DOES pin:
//   1. the load-bearing one — two ids sharing a LONG leading prefix produce
//      DIFFERENT stubs. This is the fr#1203 lesson made executable: it is RED
//      under `slice(0, 8)`, which is the algorithm the app is being
//      consolidated AWAY from;
//   2. which end the stub comes from, so "make them differ" cannot be
//      satisfied by hashing or by widening a leading slice;
//   3. the blank/short shapes (null, undefined, '', ≤ 8 chars);
//   4. byte-identity with the derivation `EntityRef.svelte` used before it
//      imported this function, so the two can never drift apart.

import { describe, it, expect } from 'vitest';
import { shortId, SHORT_LEN } from './shortId';

// Shaped like the real ids: UUIDv7, i.e. a monotonic timestamp prefix followed
// by random bytes. `06954722` is the literal prefix 13 different apps rendered
// identically in production (fr#1203).
//
// ⚠️ THESE TWO FIXTURES MUST SHARE THEIR FIRST 12 CHARACTERS. Do not "simplify"
// them into two freshly generated random uuids — that version of this test
// PASSES under the leading-slice bug it exists to catch, and is worthless.
const BATCH_SIBLING_A = '0695472200007000800000000000000a';
const BATCH_SIBLING_B = '0695472200007000800000000000000b';
const SHARED_PREFIX_LEN = 12;

const UUID = '3f2b1c4d-5e6f-4a7b-8c9d-0e1f2a3b4c5d';

describe('shortId — the stub discriminates within a provisioning batch (fr#1203)', () => {
  it('POSITIVE CONTROL — the two fixtures really do share a 12-character prefix', () => {
    // Without this, a future edit could weaken the fixtures and the killing
    // test below would pass vacuously while still looking like a gate.
    expect(BATCH_SIBLING_A.slice(0, SHARED_PREFIX_LEN)).toBe(
      BATCH_SIBLING_B.slice(0, SHARED_PREFIX_LEN),
    );
    expect(SHARED_PREFIX_LEN).toBeGreaterThan(SHORT_LEN);
    expect(BATCH_SIBLING_A).not.toBe(BATCH_SIBLING_B);
  });

  it('⭐ two ids sharing a 12-character prefix produce DIFFERENT stubs', () => {
    // RED under `slice(0, 8)`: both sides would be `06954722`.
    expect(shortId(BATCH_SIBLING_A)).not.toBe(shortId(BATCH_SIBLING_B));
  });

  it('takes the stub from the TAIL, with a leading ellipsis', () => {
    // Pins WHICH end, so "make them differ" cannot be satisfied by hashing,
    // widening the leading slice, or any scheme that drops the tail.
    expect(shortId(BATCH_SIBLING_A)).toBe('…0000000a');
    expect(shortId(BATCH_SIBLING_B)).toBe('…0000000b');
  });

  it('never contains the leading characters of the id', () => {
    expect(shortId(UUID)).toBe('…2a3b4c5d');
    expect(shortId(UUID)).not.toContain('3f2b1c4d');
  });
});

describe('shortId — blank and already-short inputs', () => {
  it('null → empty string', () => {
    expect(shortId(null)).toBe('');
  });

  it('undefined → empty string', () => {
    expect(shortId(undefined)).toBe('');
  });

  it('empty string → empty string', () => {
    expect(shortId('')).toBe('');
  });

  it('an id of 8 characters or fewer passes through unchanged, with NO ellipsis', () => {
    // A stub shorter than the whole value would be a lie: the full value is
    // already on screen.
    expect(shortId('abc123')).toBe('abc123');
    expect(shortId('a')).toBe('a');
    expect(shortId('12345678')).toBe('12345678');
  });

  it('9 characters is the first length that truncates', () => {
    // The boundary is `> SHORT_LEN`, byte-identical to EntityRef's historic
    // derivation. An off-by-one here changes rendered output estate-wide.
    expect(shortId('123456789')).toBe('…23456789');
  });
});

describe('shortId agrees with the derivation EntityRef.svelte used before importing it', () => {
  // The literal expression from `EntityRef.svelte` at fr#1205, reproduced here
  // so that changing the implementation without changing this reference fails
  // rather than silently altering every rendered stub in the app.
  const entityRefDerivation = (id: string | null | undefined): string => {
    const fullId = id ?? '';
    return fullId.length > 8 ? `…${fullId.slice(-8)}` : fullId;
  };

  const CASES: Array<string | null | undefined> = [
    null,
    undefined,
    '',
    'a',
    'abc123',
    '12345678',
    '123456789',
    UUID,
    BATCH_SIBLING_A,
    BATCH_SIBLING_B,
    '  spaced  id  ',
  ];

  for (const value of CASES) {
    it(`same stub for ${JSON.stringify(value)}`, () => {
      expect(shortId(value)).toBe(entityRefDerivation(value));
    });
  }
});
