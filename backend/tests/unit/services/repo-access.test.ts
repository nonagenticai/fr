// tests/unit/services/repo-access.test.ts
//
// The pure platform-repo ownership gate. The clone-token -> verdict cases
// (assessRepoAccess) needed an injected fake fetch and were removed under the
// no-test-doubles ruling; that path is verified live.

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { deriveRepositoryNameFromUrl } from '../../../src/lib/repository-name';
import {
  internalOwnerByFirstSegment,
  internalOwnerOf,
  isRepoPlatformTenant,
  platformRepoRefusals,
  REPO_ACCESS_INTERNAL_OWNERS_ENV,
} from '../../../src/services/repo-access';
import { EXECUTION_TENANT_ID, INTERNAL_SYSTEM_TENANT_ID } from '../../../src/middleware/internal-tenant-only';
import {
  CODING_GITHUB_URL_ENV,
  CODING_GITHUB_TOKEN_ENV,
} from '../../../src/integrations/coding-github/client';
import { platformRepoRefusalResponse } from '../../../src/routes/project-request-repo-gate';

const SECRET = 'fr-internal-secret-DO-NOT-LEAK';

const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  saved.url = process.env[CODING_GITHUB_URL_ENV];
  saved.tok = process.env[CODING_GITHUB_TOKEN_ENV];
  saved.owners = process.env[REPO_ACCESS_INTERNAL_OWNERS_ENV];
  saved.licence = process.env.CODING_SERVICE_TOKEN;
  process.env.CODING_SERVICE_TOKEN = 'licence-test';
  delete process.env[REPO_ACCESS_INTERNAL_OWNERS_ENV];
  process.env[CODING_GITHUB_URL_ENV] = 'http://coding-github.test:9000';
  process.env[CODING_GITHUB_TOKEN_ENV] = SECRET;
});
afterEach(() => {
  for (const [k, v] of [
    [CODING_GITHUB_URL_ENV, saved.url],
    [CODING_GITHUB_TOKEN_ENV, saved.tok],
    [REPO_ACCESS_INTERNAL_OWNERS_ENV, saved.owners],
    ['CODING_SERVICE_TOKEN', saved.licence],
  ] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ⛔ PLATFORM-REPO OWNERSHIP GATE (owner ruling 2026-09-30). Pure: no fetch is
// injected because none may happen — a fetch here would be a bug.
describe('platformRepoRefusals: only platform tenants may use internal-owner repos', () => {
  const NETCARE = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const AA_CONVEYOR = '019de842-c92a-7e37-8fdd-eb0d8c5396f9';
  const DETAIL = (owner: string) =>
    `${owner} is a platform-owned organisation — this workspace is not permitted to use its repositories`;
  const refusedAs = (url: string, owner = 'nonagenticai') => [
    { url, access_state: 'platform_repo_forbidden' as const, detail: DETAIL(owner) },
  ];

  test('system and execution are platform; nothing else is (the three improvement tenants were deleted 2026-11-03)', () => {
    expect(isRepoPlatformTenant('0195f48b-d000-7000-8000-000000000001')).toBe(true);
    for (const i of [2, 4, 5]) {
      expect(isRepoPlatformTenant(`0195f48b-d000-7000-8000-00000000000${i}`)).toBe(false);
    }
    expect(isRepoPlatformTenant(EXECUTION_TENANT_ID)).toBe(true);
    expect(isRepoPlatformTenant(NETCARE)).toBe(false);
    expect(isRepoPlatformTenant(AA_CONVEYOR)).toBe(false);
    expect(isRepoPlatformTenant(null)).toBe(false);
    expect(isRepoPlatformTenant(undefined)).toBe(false);
    expect(isRepoPlatformTenant('')).toBe(false);
  });

  test('platform tenants …0001 and …0003 are allowed an internal-owner repo', () => {
    const url = 'https://github.com/nonagenticai/fr';
    expect(platformRepoRefusals([url], '0195f48b-d000-7000-8000-000000000001')).toEqual([]);
    expect(platformRepoRefusals([url], '0195f48b-d000-7000-8000-000000000003')).toEqual([]);
  });

  test('a customer tenant, a null tenant and the AA conveyor tenant are refused', () => {
    const url = 'https://github.com/nonagenticai/fr';
    expect(platformRepoRefusals([url], NETCARE)).toEqual(refusedAs(url));
    expect(platformRepoRefusals([url], null)).toEqual(refusedAs(url));
    expect(platformRepoRefusals([url], undefined)).toEqual(refusedAs(url));
    // In PLATFORM_TENANT_IDS (system-union.ts) but refused by coding-github.
    expect(platformRepoRefusals([url], AA_CONVEYOR)).toEqual(refusedAs(url));
  });

  const VARIANTS = [
    'https://github.com/nonagenticai/fr',
    'http://github.com/nonagenticai/fr',
    'https://www.github.com/nonagenticai/fr',
    'https://github.com/nonagenticai/fr.git',
    'https://github.com/nonagenticai/fr/',
    'https://github.com/nonagenticai/fr/tree/main',
    'git@github.com:NonAgenticAI/x.git',
    'ssh://git@github.com/nonagenticai/x',
    'github.com/nonagenticai/x',
    'https://github.com/nonagenticai',
    'https://GITHUB.COM/NONAGENTICAI/X',
    'https://github.com./nonagenticai/x',
    'https://github.com:443/nonagenticai/x',
    'https://github.com/%6Eonagenticai/x',
  ];
  for (const url of VARIANTS) {
    test(`non-platform refused: ${url}`, () => {
      expect(platformRepoRefusals([url], NETCARE)).toEqual(refusedAs(url));
    });
  }

  test('every variant is still allowed for a platform tenant (the gate is the tenant, not the url)', () => {
    expect(platformRepoRefusals(VARIANTS, INTERNAL_SYSTEM_TENANT_ID)).toEqual([]);
  });

  test('non-internal owners pass for a non-platform tenant', () => {
    expect(
      platformRepoRefusals(
        [
          'https://github.com/netcare/x',
          'https://github.com/nonagenticai-fake/x',
          'https://github.com/conveyor-coding/x',
          'https://gitlab.com/netcare/x',
        ],
        NETCARE,
      ),
    ).toEqual([]);
  });

  test('a mixed batch refuses exactly the internal-owner urls, in input order', () => {
    const a = 'https://github.com/nonagenticai/a';
    const b = 'git@github.com:nonagenticai/b.git';
    expect(
      platformRepoRefusals([a, 'https://github.com/netcare/x', b], NETCARE).map((i) => i.url),
    ).toEqual([a, b]);
  });

  test(`${REPO_ACCESS_INTERNAL_OWNERS_ENV} widens the refused owner set`, () => {
    process.env[REPO_ACCESS_INTERNAL_OWNERS_ENV] = 'nonagenticai, Specra.Labs';
    expect(platformRepoRefusals(['github.com/specra.labs/x'], NETCARE)).toEqual(
      refusedAs('github.com/specra.labs/x', 'specra.labs'),
    );
    // A regex metachar in an owner is literal, not a wildcard.
    expect(platformRepoRefusals(['github.com/specraXlabs/x'], NETCARE)).toEqual([]);
  });

  // Reviewer NO (2026-09-30): these walked past the first matcher.
  const GITHUB_FAMILY_VARIANTS = [
    'https://api.github.com/repos/nonagenticai/fr',
    'https://api.github.com/repos/NonAgenticAI/fr/contents/README.md',
    'https://raw.githubusercontent.com/nonagenticai/fr/main/README.md',
    'https://objects.githubusercontent.com/nonagenticai/x',
    'https://gist.github.com/nonagenticai/0123abcd',
    'https://codeload.github.com/nonagenticai/fr/zip/main',
    'HTTPS://API.GITHUB.COM/REPOS/NONAGENTICAI/FR',
    'https://RAW.GitHubUserContent.COM/nonagenticai/fr/main/x',
    'api.github.com/repos/nonagenticai/fr',
    '//raw.githubusercontent.com/nonagenticai/fr/main/x',
    'https://api.github.com./repos/nonagenticai/fr',
    'https://api.github.com/repos/%256Eonagenticai/fr',
    'https:\\github.com\\nonagenticai\\fr',
    'org-1@github.com:nonagenticai/fr.git',
  ];
  for (const url of GITHUB_FAMILY_VARIANTS) {
    test(`non-platform refused (github family): ${url}`, () => {
      expect(platformRepoRefusals([url], NETCARE)).toEqual(refusedAs(url));
    });
  }

  test('github-family variants are allowed for a platform tenant', () => {
    expect(platformRepoRefusals(GITHUB_FAMILY_VARIANTS, INTERNAL_SYSTEM_TENANT_ID)).toEqual([]);
  });

  test('github-family look-alike OWNERS still pass', () => {
    expect(
      platformRepoRefusals(
        [
          'https://api.github.com/repos/nonagenticai-fake/fr',
          'https://raw.githubusercontent.com/conveyor-coding/x/main/y',
          'https://gist.github.com/netcare/abc',
        ],
        NETCARE,
      ),
    ).toEqual([]);
  });

  // Reviewer NO #2 (2026-09-30): coding-github's `parse_repo_url` reads owner/repo
  // from the URL PATH ALONE and ignores the host, so every one of these resolves
  // to nonagenticai/<repo> downstream. The gate must be HOST-AGNOSTIC.
  const HOST_AGNOSTIC_VARIANTS = [
    'https://gitlab.com/nonagenticai/r',
    'https://xn--github-xyz.com/nonagenticai/r',
    'http://github.com.evil/nonagenticai/r',
    'https://github.com.evil.example/nonagenticai/x',
    'https://notgithub.com/nonagenticai/x',
    'https://api.gitlab.com/repos/nonagenticai/x',
    'nonagenticai/r',
    'nonagenticai/r.git',
    '/nonagenticai/r',
    ' NonAgenticAI/r ',
    'git@anyhost:nonagenticai/r',
    'git@bitbucket.org:nonagenticai/x.git',
    'deploy@anyhost:nonagenticai/r',
    'anyhost:nonagenticai/r',
    'anyhost:/nonagenticai/r',
    'gitlab.com/nonagenticai/r',
    'gitlab.com:8443/nonagenticai/r',
    'ssh://git@anyhost:2222/nonagenticai/r',
    'ssh://git@anyhost:nonagenticai/r',
    'https:///nonagenticai/r',
    'https://gitlab.com//nonagenticai/r',
    'https://gitlab.com/./nonagenticai/r',
    'https://gitlab.com/.//./nonagenticai/r',
    './nonagenticai/r',
    'https://gitlab.com/%6Eonagenticai/r',
    'https://gitlab.com/%256Eonagenticai/r',
    'https://gitlab.com%2Fnonagenticai%2Fr',
    'https:\\\\gitlab.com\\nonagenticai\\r',
    'nonagenticai\\r',
    'non\tagenticai/r',
    'nonagent\u200bicai/r',
    '\u0000nonagenticai/r',
    'https://gitlab.com/NONAGENTICAI./r',
    'https://anyhost/repos/nonagenticai/r',
  ];
  for (const url of HOST_AGNOSTIC_VARIANTS) {
    test(`non-platform refused (host-agnostic): ${JSON.stringify(url)}`, () => {
      expect(platformRepoRefusals([url], NETCARE)).toEqual(refusedAs(url));
      expect(internalOwnerByFirstSegment(url, new Set(['nonagenticai']))).toBe('nonagenticai');
    });
  }

  test('host-agnostic variants are allowed for a platform tenant', () => {
    expect(platformRepoRefusals(HOST_AGNOSTIC_VARIANTS, INTERNAL_SYSTEM_TENANT_ID)).toEqual([]);
  });

  test('host-agnostic negatives: look-alike owners, other owners, empty', () => {
    const NEG = [
      'nonagenticai-fake/x',
      'conveyor-coding/x',
      'netcare/x',
      'https://gitlab.com/netcare/x',
      'https://gitlab.com/nonagenticai-fake/x',
      'git@anyhost:netcare/x.git',
      'gitlab.com/netcare/x',
      'https://gitlab.com/netcare/nonagenticai-docs',
      '',
      '   ',
    ];
    expect(platformRepoRefusals(NEG, NETCARE)).toEqual([]);
    for (const u of NEG) expect(internalOwnerOf(u, new Set(['nonagenticai']))).toBeNull();
  });

  test('platformRepoRefusalResponse: 422 repo_access_denied with the refused items', async () => {
    const url = 'https://github.com/nonagenticai/fr';
    const res = platformRepoRefusalResponse([url, 'https://github.com/netcare/x'], NETCARE);
    expect(res?.status).toBe(422);
    const body = (await res!.json()) as { error: string; items: unknown[] };
    expect(body.error).toBe('repo_access_denied');
    expect(body.items).toEqual(refusedAs(url));
    expect(platformRepoRefusalResponse([url], EXECUTION_TENANT_ID)).toBeNull();
  });

  test('dot segments: WHATWG-resolved owner is refused (agrees with deriveRepositoryNameFromUrl)', () => {
    const owners = new Set(['nonagenticai']);
    for (const u of [
      'https://gitlab.com/acme/../nonagenticai/r',
      'https://gitlab.com/acme/%2e%2e/nonagenticai/r',
      'https://gitlab.com/acme/%2E%2e/%6eonagenticai/r',
      'gitlab.com/acme/../nonagenticai/r',
    ]) {
      expect(deriveRepositoryNameFromUrl(u)?.toLowerCase().replace('%6e', 'n')).toBe('nonagenticai/r');
      expect(internalOwnerOf(u, owners)).toBe('nonagenticai');
      expect(platformRepoRefusals([u], NETCARE)).toEqual(refusedAs(u));
    }
    // a dot segment that resolves to a CUSTOMER owner still passes
    expect(internalOwnerOf('https://gitlab.com/nonagenticai-x/../acme/r', owners)).toBeNull();
  });
});
