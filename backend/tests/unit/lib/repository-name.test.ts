// tests/unit/lib/repository-name.test.ts
//
// Pure-helper unit tests for the ONE writer-side resolver of
// `repositories.name`. No DB, no fetch.
//
// ⭐ WHAT EACH GROUP IS ABLE TO FAIL — stated because a derivation test is easy
// to write so it cannot:
//
//   · `deriveRepositoryNameFromUrl` group — RED if the first-two-segments rule
//     is replaced by last-two (the `/tree/main` case), if the `.git` strip is
//     dropped (the `.git` cases), if the scp branch is removed (the `git@` case),
//     or if the trailing-slash filter goes (the `repo/` case).
//   · `returns null` group — RED if an underivable url is ever given a
//     placeholder instead. That is the assertion that forbids an invented name,
//     which is the failure mode worse than a blank: it looks like data.
//   · `resolveRepositoryName` group — RED if `?? null` is restored anywhere
//     (the throw arm), if a caller-supplied name stops winning, or if a
//     whitespace-only supplied name stops falling through to the derivation.

import { test, expect, describe } from 'bun:test';
import {
  deriveRepositoryNameFromUrl,
  resolveRepositoryName,
} from '../../../src/lib/repository-name';
import { AppError } from '../../../src/utils/errors';

describe('deriveRepositoryNameFromUrl', () => {
  // The four shapes the operator named, each as its own arm so a regression
  // names the shape it broke.
  test('https url → owner/repo', () => {
    expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo')).toBe('owner/repo');
  });

  test('https url with a trailing .git → owner/repo', () => {
    expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('https url with a trailing slash → owner/repo', () => {
    expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo/')).toBe('owner/repo');
  });

  test('scp-style git@host:owner/repo.git → owner/repo', () => {
    expect(deriveRepositoryNameFromUrl('git@github.com:owner/repo.git')).toBe('owner/repo');
  });

  // ── the discriminating arms ────────────────────────────────────────────────
  test('deeper path takes the FIRST two segments, not the last two', () => {
    // Last-two would yield 'tree/main' — a plausible-looking wrong answer, which
    // is exactly why this arm exists.
    expect(deriveRepositoryNameFromUrl('https://github.com/owner/repo/tree/main')).toBe(
      'owner/repo',
    );
  });

  test('non-github hosts are NOT rejected (services/repo-access.ts would)', () => {
    expect(deriveRepositoryNameFromUrl('https://gitlab.com/group/thing.git')).toBe('group/thing');
    expect(deriveRepositoryNameFromUrl('https://git.example.com:8443/team/svc')).toBe('team/svc');
  });

  test('ssh:// form', () => {
    expect(deriveRepositoryNameFromUrl('ssh://git@github.com/owner/repo.git')).toBe('owner/repo');
  });

  test('schemeless host/owner/repo', () => {
    expect(deriveRepositoryNameFromUrl('github.com/owner/repo')).toBe('owner/repo');
  });

  test('surrounding whitespace is trimmed before parsing', () => {
    expect(deriveRepositoryNameFromUrl('  https://github.com/owner/repo.git  ')).toBe('owner/repo');
  });

  describe('returns null rather than inventing a name', () => {
    test.each([
      ['not a url at all', 'not a url at all'],
      ['empty string', ''],
      ['whitespace only', '   '],
      ['owner-only path', 'https://github.com/owner'],
      ['host with no path', 'https://github.com'],
      ['the CP sentinel', 'https://example.invalid/REPLACE-IN-FR'],
      ['dot-segments', 'https://github.com/./..'],
      ['bare owner/repo with no host', 'owner-only'],
      ['a name that is only .git', 'https://github.com/owner/.git'],
    ])('%s → null', (_label, url) => {
      expect(deriveRepositoryNameFromUrl(url)).toBeNull();
    });

    test('null / undefined / non-string → null', () => {
      expect(deriveRepositoryNameFromUrl(null)).toBeNull();
      expect(deriveRepositoryNameFromUrl(undefined)).toBeNull();
      expect(deriveRepositoryNameFromUrl(42 as unknown as string)).toBeNull();
    });
  });
});

describe('resolveRepositoryName', () => {
  test('a caller-supplied name wins over the derivation', () => {
    expect(resolveRepositoryName('My Backend', 'https://github.com/owner/repo')).toBe('My Backend');
  });

  test('a supplied name is trimmed', () => {
    expect(resolveRepositoryName('  My Backend  ', 'https://github.com/owner/repo')).toBe(
      'My Backend',
    );
  });

  test('a whitespace-only supplied name falls through to the derivation', () => {
    // This is the blank that `.min(1)` without `.trim()` used to let through.
    expect(resolveRepositoryName('   ', 'https://github.com/owner/repo')).toBe('owner/repo');
  });

  test('an absent name is derived from the url', () => {
    expect(resolveRepositoryName(undefined, 'git@github.com:owner/repo.git')).toBe('owner/repo');
    expect(resolveRepositoryName(null, 'https://github.com/owner/repo/')).toBe('owner/repo');
  });

  test('an unparseable url with no name is a 400 naming the field', () => {
    let thrown: unknown = null;
    try {
      resolveRepositoryName(undefined, 'not a url');
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    const err = thrown as AppError;
    // 4xx, not a 500 and not a stored null.
    expect(err.statusCode).toBe(400);
    expect(err.code).toBe('repository_name_underivable');
    expect(err.details).toEqual({ field: 'name', url: 'not a url' });
    expect(err.message).toContain('name is required');
  });

  test('the error names the CALLER\'s field, not always "name"', () => {
    try {
      resolveRepositoryName(undefined, '', 'repo.additional[].name');
      throw new Error('expected resolveRepositoryName to throw');
    } catch (err) {
      expect((err as AppError).details).toEqual({
        field: 'repo.additional[].name',
        url: '',
      });
    }
  });

  test('NEVER returns a blank or a placeholder', () => {
    // Exhaustive over the derivable cases above: whatever comes back is
    // non-blank. The underivable cases throw, asserted separately.
    for (const url of [
      'https://github.com/owner/repo',
      'https://github.com/owner/repo.git',
      'https://github.com/owner/repo/',
      'git@github.com:owner/repo.git',
    ]) {
      const name = resolveRepositoryName(undefined, url);
      expect(name.trim().length).toBeGreaterThan(0);
      expect(name).toBe('owner/repo');
    }
  });
});
