// tests/unit/integrations/coding-github-client.test.ts
//
// Wire contract for fr -> coding-github `POST /api/internal/github/clone-token`
// (coding-github src/routers/github_internal.py): the not-configured refusals,
// which fire before any request is made.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
  requestCloneToken,
  CodingGithubNotConfiguredError,
  CODING_GITHUB_URL_ENV,
  CODING_GITHUB_TOKEN_ENV,
} from '../../../src/integrations/coding-github/client';

const SECRET = 'fr-internal-secret-DO-NOT-LEAK';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.url = process.env[CODING_GITHUB_URL_ENV];
  saved.tok = process.env[CODING_GITHUB_TOKEN_ENV];
  saved.lic = process.env.CODING_SERVICE_TOKEN;
  process.env[CODING_GITHUB_URL_ENV] = 'http://coding-github.test:9000/';
  process.env[CODING_GITHUB_TOKEN_ENV] = `${SECRET}\n`;
  process.env.CODING_SERVICE_TOKEN = LICENCE;
});
afterEach(() => {
  for (const [k, v] of [
    [CODING_GITHUB_URL_ENV, saved.url],
    [CODING_GITHUB_TOKEN_ENV, saved.tok],
    ['CODING_SERVICE_TOKEN', saved.lic],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const REPO = 'https://github.com/nonagenticai/fr';
const LICENCE = 'fr-coding-licence-DO-NOT-LEAK';

describe('requestCloneToken — not configured', () => {
  test('licence unset -> NotConfigured (coding-github would 401)', async () => {
    delete process.env.CODING_SERVICE_TOKEN;
    const err = await requestCloneToken(REPO).catch((e) => e);
    expect(err).toBeInstanceOf(CodingGithubNotConfiguredError);
  });

  for (const [missingUrl, missingTok] of [
    [true, false],
    [false, true],
    [true, true],
  ] as const) {
    test(`not configured (url unset=${missingUrl}, token unset=${missingTok}) -> NotConfigured`, async () => {
      if (missingUrl) delete process.env[CODING_GITHUB_URL_ENV];
      if (missingTok) process.env[CODING_GITHUB_TOKEN_ENV] = '   ';
      const err = await requestCloneToken(REPO).catch((e) => e);
      expect(err).toBeInstanceOf(CodingGithubNotConfiguredError);
    });
  }
});
