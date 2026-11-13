// tests/unit/services/repository-pins.test.ts
//
// A repository PIN (George 2026-11-07): a full commit SHA or a GitHub PR, resolved
// to the 40-hex commit RM stores. Only the paths that need NO GitHub read are
// covered here — a 40-hex pin, a malformed pin and the sha/pin conflict all decide
// before any network call. The PR round-trip is verified live (no test doubles,
// owner ruling 2026-10-29).
//
// Hermetic: pure functions, no DB, no fetch.

import { describe, expect, test } from 'bun:test';

import { parseRepoPin, resolveRepositoryPins } from '../../../src/services/repository-pins';

const SHA = '0123456789abcdef0123456789abcdef01234567';

describe('parseRepoPin', () => {
  test('a full 40-hex sha is the commit itself, lowercased', () => {
    expect(parseRepoPin('AB'.repeat(20))).toEqual({ kind: 'sha', sha: 'ab'.repeat(20) });
    expect(parseRepoPin(SHA)).toEqual({ kind: 'sha', sha: SHA });
  });

  test('a PR number is a pr with no repository of its own', () => {
    expect(parseRepoPin('42')).toEqual({ kind: 'pr', number: 42, owner: null, repo: null });
    expect(parseRepoPin(' #42 ')).toEqual({ kind: 'pr', number: 42, owner: null, repo: null });
  });

  test('a PR URL names its repository', () => {
    expect(parseRepoPin('https://github.com/o/r/pull/7')).toEqual({
      kind: 'pr',
      number: 7,
      owner: 'o',
      repo: 'r',
    });
    expect(parseRepoPin('https://github.com/o/r/pull/7/files')).toBeNull();
  });

  test('anything else is not a pin', () => {
    for (const bad of ['', 'main', 'abc1234', 'g'.repeat(40), '#', 'v1.2.3']) {
      expect(parseRepoPin(bad)).toBeNull();
    }
  });
});

describe('resolveRepositoryPins — decisions that need no GitHub read', () => {
  test('a sha pin replaces the pin with the lowercase sha', async () => {
    const out = await resolveRepositoryPins(
      { primary: { url: 'https://github.com/o/a', pin: 'AB'.repeat(20) } },
      { tenantId: 'tenant' },
    );
    expect(out?.primary).toEqual({ url: 'https://github.com/o/a', sha: 'ab'.repeat(20) });
  });

  test('no pin leaves the rows (and the absent pin) untouched', async () => {
    const repo = { primary: { url: 'https://github.com/o/a', branch: 'main' } };
    const out = await resolveRepositoryPins(repo, { tenantId: 'tenant' });
    expect(out).toEqual(repo);
    expect('pin' in (out?.primary ?? {})).toBe(false);
  });

  test('a row carrying BOTH sha and pin is refused 422 repository_pin_conflict', async () => {
    await expect(
      resolveRepositoryPins(
        { primary: { url: 'https://github.com/o/a', sha: SHA, pin: '#1' } },
        { tenantId: 'tenant' },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'repository_pin_conflict' });
  });

  test('a malformed pin is refused 422 before any network call', async () => {
    await expect(
      resolveRepositoryPins(
        { primary: { url: 'https://github.com/o/a', pin: 'main' } },
        { tenantId: 'tenant' },
      ),
    ).rejects.toMatchObject({ statusCode: 422, code: 'repository_pin_invalid' });
  });
});
