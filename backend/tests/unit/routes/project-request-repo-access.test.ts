// tests/unit/routes/project-request-repo-access.test.ts
//
// Route surface only: URL parsing (re-exported from services/repo-access) and
// input validation. The classification itself — coding-github clone-token ->
// verdict — is pinned in tests/unit/services/repo-access.test.ts and the wire
// contract in tests/unit/integrations/coding-github-client.test.ts.
//
// ⚠️ SCOPE. Like tests/unit/routes/tenant/members.test.ts, the handler is not
// driven end-to-end: this suite runs with AUTH_BYPASS and no database.

import { describe, test, expect } from 'bun:test';
import {
  parseGithubRepo,
  VerifyRepoAccessBody,
} from '../../../src/routes/project-request-repo-access';

describe('parseGithubRepo', () => {
  const cases: Array<[string, { owner: string; repo: string } | null]> = [
    ['https://github.com/acme/widget', { owner: 'acme', repo: 'widget' }],
    ['https://github.com/acme/widget.git', { owner: 'acme', repo: 'widget' }],
    ['https://github.com/acme/widget/', { owner: 'acme', repo: 'widget' }],
    ['https://github.com/acme/widget.git/', { owner: 'acme', repo: 'widget' }],
    ['https://www.github.com/acme/widget', { owner: 'acme', repo: 'widget' }],
    ['https://github.com/acme/widget/tree/main/src', { owner: 'acme', repo: 'widget' }],
    ['  https://github.com/acme/my_repo.v2  ', { owner: 'acme', repo: 'my_repo.v2' }],
    ['git@github.com:acme/widget.git', { owner: 'acme', repo: 'widget' }],
    ['git@github.com:acme/widget', { owner: 'acme', repo: 'widget' }],
    ['https://gitlab.com/acme/widget', null],
    ['https://github.com/acme', null],
    ['https://github.com/', null],
    ['not a url', null],
    ['', null],
    ['ftp://github.com/acme/widget', null],
    ['https://github.com.evil.test/acme/widget', null],
    ['git@gitlab.com:acme/widget.git', null],
  ];
  for (const [input, expected] of cases) {
    test(`${JSON.stringify(input)} -> ${JSON.stringify(expected)}`, () => {
      expect(parseGithubRepo(input)).toEqual(expected);
    });
  }
});

describe('VerifyRepoAccessBody', () => {
  test('accepts 1..20 urls', () => {
    expect(VerifyRepoAccessBody.safeParse({ urls: ['a'] }).success).toBe(true);
    expect(
      VerifyRepoAccessBody.safeParse({ urls: Array.from({ length: 20 }, (_, i) => `u${i}`) })
        .success,
    ).toBe(true);
  });

  test('rejects empty, >20, unknown keys and non-strings', () => {
    expect(VerifyRepoAccessBody.safeParse({ urls: [] }).success).toBe(false);
    expect(
      VerifyRepoAccessBody.safeParse({ urls: Array.from({ length: 21 }, (_, i) => `u${i}`) })
        .success,
    ).toBe(false);
    expect(VerifyRepoAccessBody.safeParse({ urls: ['a'], extra: 1 }).success).toBe(false);
    expect(VerifyRepoAccessBody.safeParse({ urls: [1] }).success).toBe(false);
    expect(VerifyRepoAccessBody.safeParse({ urls: ['   '] }).success).toBe(false);
  });
});
