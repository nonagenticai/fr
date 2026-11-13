// tests/unit/lib/write-set.test.ts — U4 write-set contract, PURE (src/lib/write-set.ts).
import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';

import { evaluateWriteSetFence, isTestPath, writeSetSeal } from '../../../src/lib/write-set';
// Path rules: tests/unit/services/approvals/write-set-paths.test.ts (the ONE predicate module).

describe('writeSetSeal', () => {
  test('is sha256 over the RFC 8785 form {"v":1,"write_set":[...]} written out by hand', () => {
    const body = '{"v":1,"write_set":["src/a.py","tests/test_a.py"]}';
    expect(writeSetSeal(['src/a.py', 'tests/test_a.py'])).toBe(createHash('sha256').update(body, 'utf8').digest('hex'));
  });
  test('order is part of the seal (the stored sorted array is what is sealed)', () => {
    expect(writeSetSeal(['a', 'b'])).not.toBe(writeSetSeal(['b', 'a']));
  });
});

describe('fence', () => {
  test('isTestPath: tests/**, **/*.test.*, **/*_test.*', () => {
    for (const t of ['tests/test_a.py', 'tests/x/y.py', 'src/a.test.ts', 'pkg/a_test.go']) expect(isTestPath(t)).toBe(true);
    for (const n of ['src/a.py', 'src/tests/a.py', 'testsx/a.py', 'src/latest.py', 'src/test.ts']) expect(isTestPath(n)).toBe(false);
  });
  test('in_set / write_set_test_path_mismatch / diff_outside_write_set', () => {
    const ws = ['src/a.py', 'tests/test_a.py'];
    expect(evaluateWriteSetFence(ws, ['src/a.py'])).toEqual({ outcome: 'in_set', offending: [] });
    expect(evaluateWriteSetFence(ws, ['src/a.py', 'tests/test_b.py'])).toEqual({
      outcome: 'write_set_test_path_mismatch',
      offending: ['tests/test_b.py'],
    });
    expect(evaluateWriteSetFence(ws, ['tests/test_b.py', 'src/b.py'])).toEqual({
      outcome: 'diff_outside_write_set',
      offending: ['src/b.py', 'tests/test_b.py'],
    });
  });
  test('EXACT match: `src/[id].ts` in the set does NOT cover `src/i.ts` (no glob expansion)', () => {
    expect(evaluateWriteSetFence(['src/[id].ts'], ['src/[id].ts'])).toEqual({ outcome: 'in_set', offending: [] });
    expect(evaluateWriteSetFence(['src/[id].ts'], ['src/i.ts', 'src/d.ts'])).toEqual({
      outcome: 'diff_outside_write_set',
      offending: ['src/d.ts', 'src/i.ts'],
    });
  });
});
