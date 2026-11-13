// The conveyor's Planka editor grant on a NEW board is decided by the board's
// OWNING tenant, never by the deciding user's active one (strict tenant
// separation, George 2026-09-30). A super-admin may decide a CUSTOMER project
// request cross-tenant from a platform workspace (approvals → onOutlineDecided
// → promoteProjectRequest, which passes `repoGateTenantId: row.tenant_id`); the
// customer board must NOT get the grant.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

import { conveyorGrantTenantId } from '../../../src/routes/projects';
import { isPlatformTenant } from '../../../src/routes/assets/_lib/system-union';

// Literal on purpose: not derived from the constants under test.
const EXEC = '0195f48b-d000-7000-8000-000000000003';
const CUSTOMER = '0195f48b-d000-7000-8000-000000000100';

const grants = (input: { repoGateTenantId?: string | null }, active: string) =>
  isPlatformTenant(conveyorGrantTenantId(input, active));

describe('conveyorGrantTenantId — owner, not decider', () => {
  test('(a) customer request decided from EXECUTION → customer tenant, NO grant', () => {
    expect(conveyorGrantTenantId({ repoGateTenantId: CUSTOMER }, EXEC)).toBe(CUSTOMER);
    expect(grants({ repoGateTenantId: CUSTOMER }, EXEC)).toBe(false);
  });

  test('(b) direct create (no repoGateTenantId) in a platform tenant → grant', () => {
    expect(conveyorGrantTenantId({}, EXEC)).toBe(EXEC);
    expect(grants({}, EXEC)).toBe(true);
  });

  test('(c) platform-owned request → grant, whatever the decider', () => {
    expect(conveyorGrantTenantId({ repoGateTenantId: EXEC }, CUSTOMER)).toBe(EXEC);
    expect(grants({ repoGateTenantId: EXEC }, CUSTOMER)).toBe(true);
  });

  test('owner unknown (null / empty) fails closed even from a platform decider', () => {
    expect(conveyorGrantTenantId({ repoGateTenantId: null }, EXEC)).toBeUndefined();
    expect(conveyorGrantTenantId({ repoGateTenantId: '' }, EXEC)).toBeUndefined();
    expect(conveyorGrantTenantId({ repoGateTenantId: undefined }, EXEC)).toBeUndefined();
    expect(grants({ repoGateTenantId: null }, EXEC)).toBe(false);
  });

  test('direct create in a customer tenant → no grant', () => {
    expect(grants({}, CUSTOMER)).toBe(false);
  });
});

describe('call sites wire the owner through', () => {
  const src = (rel: string) => readFileSync(join(import.meta.dir, '../../../src', rel), 'utf8');

  test('createSingleProject hands createProjectWithDefaultBoard the OWNER tenant', () => {
    const s = src('routes/projects.ts');
    const call = s.slice(s.indexOf('await createProjectWithDefaultBoard('));
    const args = call.slice(0, call.indexOf(');'));
    // The owner is resolved ONCE (`ownerTenantId = conveyorGrantTenantId(...)`,
    // refused when unknown) and that single value feeds every owner-scoped site.
    expect(s).toContain('const ownerTenantId = conveyorGrantTenantId(input, activeTenantId);');
    expect(args).toMatch(/^\s*ownerTenantId,?\s*$/m);
    // the bare decider tenant must not be the tenant argument
    expect(args).not.toMatch(/^\s*activeTenantId,?\s*$/m);
  });

  test('promoteProjectRequest passes the request row tenant as the owner', () => {
    expect(src('routes/project-requests.ts')).toContain('repoGateTenantId: row.tenant_id');
  });
});
