// tests/unit/services/improvement/config-hash.test.ts
//
// canonicalJson: recursively key-sorted, array order preserved. Pure.

import { describe, expect, test } from 'bun:test';
import { canonicalJson } from '../../../../src/services/improvement/config-hash';

describe('canonicalJson', () => {
  test('sorts object keys recursively but preserves array order', () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
    expect(canonicalJson([3, 1, 2])).toBe('[3,1,2]');
  });
});
