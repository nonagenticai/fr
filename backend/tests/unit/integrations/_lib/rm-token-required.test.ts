// tests/unit/integrations/_lib/rm-token-required.test.ts
//
// R351 (7): every requirements_management caller presents fr's RM token. With
// REQUIREMENTS_SERVICE_TOKEN unset or blank, an RM call is REFUSED before it is
// sent (`SERVICE_NOT_CONFIGURED`, naming the env var) — never the plain-uuid
// `X-Tenant-Id` request it used to fall back to.
//
// No test double: the refusal happens before any network I/O. The CONTROL sets
// the token and shows the same call IS sent (it fails reaching the unroutable
// test host, `requirements.test`), so the refusal is the token's doing.
import { afterEach, describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { isIntegrationError } from '../../../../src/integrations/_lib/errors';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from '../../../../src/integrations/_lib/service-credential';
import { listDecisions } from '../../../../src/integrations/decisions';
import { listProjectsByOrigin } from '../../../../src/integrations/pm';
import { withRequestContext } from '../../../../src/integrations/_lib/context';

const TENANT = '11111111-1111-4111-8111-111111111111';
const FR_PROJECT = '22222222-2222-4222-8222-222222222222';
const saved = process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
  else process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = saved;
});

async function codeOf(p: Promise<unknown>): Promise<{ code: string; message: string }> {
  try {
    await p;
  } catch (err) {
    if (isIntegrationError(err)) return { code: err.code, message: err.message };
    return { code: `non-integration: ${String(err)}`, message: String(err) };
  }
  return { code: 'resolved', message: '' };
}

describe('an RM call without fr RM token is refused before it is sent', () => {
  test('unset token: pm.listProjectsByOrigin refuses with SERVICE_NOT_CONFIGURED naming the env var', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    const out = await codeOf(listProjectsByOrigin(FR_PROJECT, TENANT));
    expect(out.code).toBe('SERVICE_NOT_CONFIGURED');
    expect(out.message).toContain(REQUIREMENTS_SERVICE_TOKEN_ENV);
  });

  test('a blank token is unset (a SOPS newline-only value presents nothing)', async () => {
    process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = '  \n';
    expect((await codeOf(listProjectsByOrigin(FR_PROJECT, TENANT))).code).toBe('SERVICE_NOT_CONFIGURED');
  });

  test('another RM client (decisions) refuses the same way, inside a request frame', async () => {
    delete process.env[REQUIREMENTS_SERVICE_TOKEN_ENV];
    const out = await withRequestContext(
      { correlationId: 'rm-token-test', initiator: 'human', channel: 'web', tenantId: TENANT },
      () => codeOf(listDecisions()),
    );
    expect(out.code).toBe('SERVICE_NOT_CONFIGURED');
  });

  test('CONTROL: with the token set the same call IS sent (it fails reaching the unroutable test host)', async () => {
    process.env[REQUIREMENTS_SERVICE_TOKEN_ENV] = 'test-requirements-service-token';
    const out = await codeOf(listProjectsByOrigin(FR_PROJECT, TENANT));
    expect(out.code).not.toBe('SERVICE_NOT_CONFIGURED');
    expect(out.code).toMatch(/^UPSTREAM_/);
  });
});

describe('every RM client is built fail-closed', () => {
  // The behaviour above holds for a client only if it opts in; this pins that EVERY client that
  // presents the RM token also requires it (a new RM client without the flag fails here).
  const dir = join(import.meta.dir, '../../../../src/integrations');
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts'));
  const rmClients = files.filter((f) => readFileSync(join(dir, f), 'utf8').includes('tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV'));

  test('the scan finds the RM clients (scope is not empty)', () => {
    expect(rmClients.length).toBeGreaterThanOrEqual(9);
  });

  test.each(rmClients)('%s sets tenantBearerRequired: true', (f) => {
    const src = readFileSync(join(dir, f), 'utf8');
    expect(src).toMatch(/tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,\s*\n\s*tenantBearerRequired: true,/);
  });
});
