// tests/unit/lib/request-bits.test.ts — U-PS-S0 (fr half; PSD §6.3 step 2).

import { describe, expect, test } from 'bun:test';

import {
  PRESENCE_BITS,
  PresenceBitValueSchema,
  RequesterRequestBitsSchema,
  StoredRequestBitsSchema,
  mergeRequestBits,
  requestBitVector,
} from '../../../src/lib/request-bits';

describe('the closed bit set', () => {
  test("is exactly pm's REQUEST_BITS (procedure_management src/utils/template_predicates.py), in order", () => {
    // pm is a separate repo; this literal is the handshake. Adding a bit is a code change in BOTH.
    expect([...PRESENCE_BITS, 'repo_count']).toEqual(['has_feature_statement', 'has_interface_contract', 'has_bdd_ac', 'repo_count']);
  });
});

describe('a bit value', () => {
  test('unknown is representable: value null + bit_source unknown', () => {
    expect(PresenceBitValueSchema.safeParse({ value: null, bit_source: 'unknown' }).success).toBe(true);
  });
  test('form / extracted carry a boolean', () => {
    expect(PresenceBitValueSchema.safeParse({ value: false, bit_source: 'form' }).success).toBe(true);
    expect(PresenceBitValueSchema.safeParse({ value: true, bit_source: 'extracted' }).success).toBe(true);
  });
  test('MUST-FAIL: value null with a known source, or a value with source unknown', () => {
    expect(PresenceBitValueSchema.safeParse({ value: null, bit_source: 'form' }).success).toBe(false);
    expect(PresenceBitValueSchema.safeParse({ value: true, bit_source: 'unknown' }).success).toBe(false);
  });
  test('MUST-FAIL: a majority / free-text value is not a bit', () => {
    expect(PresenceBitValueSchema.safeParse({ value: 'yes, 2 of 3', bit_source: 'extracted' }).success).toBe(false);
    expect(PresenceBitValueSchema.safeParse({ value: true, bit_source: 'majority' }).success).toBe(false);
  });
});

describe('stored / requester shapes', () => {
  test('strict: an unknown bit name is refused (never stripped)', () => {
    expect(StoredRequestBitsSchema.safeParse({ has_tests: { value: true, bit_source: 'form' } }).success).toBe(false);
  });
  test('repo_count cannot be written — it is computed', () => {
    expect(StoredRequestBitsSchema.safeParse({ repo_count: { value: 3, bit_source: 'form' } }).success).toBe(false);
  });
  test("MUST-FAIL: a requester cannot claim 'extracted'", () => {
    expect(RequesterRequestBitsSchema.safeParse({ has_bdd_ac: { value: true, bit_source: 'extracted' } }).success).toBe(false);
    expect(RequesterRequestBitsSchema.safeParse({ has_bdd_ac: { value: true, bit_source: 'form' } }).success).toBe(true);
  });
});

describe('requestBitVector', () => {
  test('NULL stored (every request today) ⇒ every presence bit unknown, has_unknown', () => {
    const v = requestBitVector(null, []);
    expect(v.has_feature_statement).toEqual({ value: null, bit_source: 'unknown' });
    expect(v.has_unknown).toBe(true);
    expect(v.repo_count).toEqual({ value: 0, bit_source: 'form' });
  });
  test('all three known ⇒ has_unknown false; repo_count = distinct repo URLs', () => {
    const k = { value: true, bit_source: 'form' as const };
    const v = requestBitVector({ has_feature_statement: k, has_interface_contract: k, has_bdd_ac: { value: false, bit_source: 'extracted' } }, [
      'https://github.com/a/b',
      'https://github.com/a/b',
      'https://github.com/a/c',
    ]);
    expect(v.has_unknown).toBe(false);
    expect(v.repo_count.value).toBe(2);
  });
  test('a malformed stored row reads as unknown, never as "no"', () => {
    const v = requestBitVector({ has_feature_statement: { value: 'no', bit_source: 'form' } }, []);
    expect(v.has_feature_statement.value).toBeNull();
    expect(v.has_unknown).toBe(true);
  });
  test('merge keeps omitted bits', () => {
    const merged = mergeRequestBits(
      { has_bdd_ac: { value: true, bit_source: 'form' } },
      { has_feature_statement: { value: false, bit_source: 'form' } },
    );
    expect(Object.keys(merged).sort()).toEqual(['has_bdd_ac', 'has_feature_statement']);
  });
});
