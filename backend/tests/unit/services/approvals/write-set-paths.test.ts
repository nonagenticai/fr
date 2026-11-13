// tests/unit/services/approvals/write-set-paths.test.ts — U4 write-set PATH FORMAT
// (U4-diff-scope-recon.md § WRITE_SET PATH FORMAT, amended + frozen 2026-10-02). PURE.
// Exact string match, never glob-expanded: brackets, braces, parens, '+', '~', '@', '#', '%'
// and space are LITERAL; '*', '?', '..', leading/trailing '/', empty segments, control
// chars and backslash are refused.
import { describe, expect, test } from 'bun:test';

import {
  WRITE_SET_MAX,
  WriteSetPathsError,
  assertWriteSetPaths,
  isValidWriteSetPath,
} from '../../../../src/services/approvals/write-set-paths';

function codeOf(paths: readonly string[]): string | null {
  try {
    assertWriteSetPaths(paths);
    return null;
  } catch (err) {
    return err instanceof WriteSetPathsError ? err.pathsCode : `threw ${String(err)}`;
  }
}

describe('isValidWriteSetPath', () => {
  test('ACCEPTS literal [ ] { } ( ) + ~ @ # % and space — real SvelteKit / Next.js paths', () => {
    for (const ok of [
      'src/routes/projects/[id]/+page.svelte',
      'pages/[id].tsx',
      'frontend/src/routes/(admin)/admin/(platform)/tenants/[nameOrId]/+page.svelte',
      'src/[...slug]/{a,b}.ts',
      'a~b/@scope/#x/100%/with space.md',
      'a',
      'src/a.py',
      '.github/workflows/ci.yml',
      'a/./b',
    ]) {
      expect([ok, isValidWriteSetPath(ok)]).toEqual([ok, true]);
    }
  });

  test('REFUSES * ? .. leading/trailing / empty segments, control chars, backslash', () => {
    for (const bad of [
      'src/*.ts',
      'x/*.ts',
      'a/?.ts',
      '../x',
      'a/../b',
      '..',
      '/abs',
      'dir/',
      'a//b',
      '',
      'a\u0000b',
      'a\nb',
      'a\u007fb',
      'a\\b',
    ]) {
      expect([bad, isValidWriteSetPath(bad)]).toEqual([bad, false]);
    }
  });

  test('non-strings are refused at runtime (untyped JSON from approvals.metadata)', () => {
    for (const bad of [7, null, undefined, {}, ['a']]) expect(isValidWriteSetPath(bad as unknown as string)).toBe(false);
  });
});

describe('assertWriteSetPaths', () => {
  test('a valid, unique, byte-sorted set with brackets passes', () => {
    expect(codeOf(['pages/[id].tsx', 'src/routes/projects/[id]/+page.svelte'])).toBeNull();
  });

  test('empty / non-array / duplicate / unsorted / bad path → write_set_invalid; > 40 → write_set_too_broad', () => {
    expect(codeOf([])).toBe('write_set_invalid');
    expect(codeOf('src/a' as unknown as string[])).toBe('write_set_invalid');
    expect(codeOf(['a', 'a'])).toBe('write_set_invalid');
    expect(codeOf(['b', 'a'])).toBe('write_set_invalid');
    expect(codeOf(['a', '../b'])).toBe('write_set_invalid');
    expect(codeOf(['a', 'src/*.ts'])).toBe('write_set_invalid');
    const forty = Array.from({ length: WRITE_SET_MAX }, (_, i) => `f${String(i).padStart(2, '0')}`);
    expect(codeOf(forty)).toBeNull();
    expect(codeOf([...forty, 'f99'])).toBe('write_set_too_broad');
  });

  test('byte order: uppercase before lowercase, "[" (0x5B) after "Z" and before "a"', () => {
    expect(codeOf(['src/B', 'src/[id].ts', 'src/b'])).toBeNull();
    expect(codeOf(['src/b', 'src/[id].ts'])).toBe('write_set_invalid');
  });
});
