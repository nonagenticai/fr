// fr-agui P1-TEAM-a (George 2026-10-15): the PRODUCTION project-membership
// provider (agui/tenant-member-provider.ts) answers EXACTLY what the route gate
// (lib/project-access.ts findTenantScopedProject — the write gate every project
// sub-resource uses) answers, for every persona:
//   - the owner and a NON-owner member of the project's tenant — both ADMITTED;
//   - a member of ANOTHER tenant — both REFUSED;
//   - an UNTAGGED project — both REFUSED;
//   - a super-admin SWITCHED (X-Active-Tenant) into the project's tenant —
//     both ADMITTED there for READS, both REFUSED for the home tenant's project;
//     for WRITES both keep the pre-P1-TEAM owner pin: REFUSED on a project it
//     does not own (the provider answers a read-only `viewer`), ADMITTED on one
//     it owns (`projectWritableByCaller` on the route side);
//   - a LICENCE caller of the tenant — both ADMITTED, other tenant REFUSED;
//   - the CONVEYOR priority identity (no tenant claim) — both REFUSED: its own
//     lane is `loadProjectForConveyor`, unchanged and not this one;
//   - no resolvable tenant — the provider answers null (fail closed).
// The provider is read through `assertRbac` (its real seam), with the tenant
// resolved by rbac.ts from the request frame exactly as the routes do.
//
// DB-backed (assertion-armed by scripts/ci-test.sh): fixture rows use per-file fixed
// uuids and cleanup is scoped to those ids, in the throwaway CI database.

import { afterAll, beforeAll, describe, expect } from 'bun:test';
import { z } from 'zod';

import {
  assertRbac,
  RbacDeniedError,
  setProjectMembershipProvider,
} from '../../../src/agui/rbac';
import { tenantMemberProjectMembershipProvider } from '../../../src/agui/tenant-member-provider';
import type { ActionContext, AgentCallableAction } from '../../../src/agui/types';
import { db, queryClient, projects } from '../../../src/db/client';
import { findTenantScopedProject, findProjectForRead, projectWritableByCaller } from '../../../src/lib/project-access';
import { withRequestContext } from '../../../src/middleware/request-context';
import type { User } from '../../../src/types/api';
import { CONVEYOR_AZP, CONVEYOR_ROLE, CONVEYOR_USERNAME } from '../../../src/lib/conveyor-identity';

import { createDbSuite } from '../../integration/helpers/db-suite';

const sql = queryClient;

const TENANT_A = 'f7000000-0000-4000-8000-00000000000a';
const TENANT_B = 'f7000000-0000-4000-8000-00000000000b';
const OWNER = 'f7100000-0000-4000-8000-000000000001';
const MEMBER = 'f7100000-0000-4000-8000-000000000002'; // same tenant, not the owner
const OUTSIDER = 'f7100000-0000-4000-8000-000000000003'; // tenant B
const SUPER = 'f7100000-0000-4000-8000-000000000004'; // super-admin homed in B
const LICENCE = 'f7100000-0000-4000-8000-000000000005';
const CONVEYOR = 'f7100000-0000-4000-8000-000000000006';
const P_A = 'f7200000-0000-4000-8000-0000000000a1'; // tagged A, owned by OWNER
const P_B = 'f7200000-0000-4000-8000-0000000000b1'; // tagged B, owned by OUTSIDER
const P_UNTAGGED = 'f7200000-0000-4000-8000-0000000000a2'; // owned by OWNER, no tag
const P_A_SUPER = 'f7200000-0000-4000-8000-0000000000a3'; // tagged A, owned by SUPER (homed in B)
const ALL = [P_A, P_B, P_UNTAGGED, P_A_SUPER];

const user = (id: string, tenantId: string, extra: Partial<User> = {}): User =>
  ({ id, email: `${id}@t`, name: id, roles: ['user'], tenantId, ...extra }) as User;

interface Persona {
  label: string;
  subject: User;
  /** The frame the request-context middleware would have built. */
  frameTenant: string;
  source: 'jwt' | 'header';
}

const PERSONAS: Persona[] = [
  { label: 'owner', subject: user(OWNER, TENANT_A), frameTenant: TENANT_A, source: 'jwt' },
  { label: 'non-owner tenant member', subject: user(MEMBER, TENANT_A), frameTenant: TENANT_A, source: 'jwt' },
  { label: 'member of another tenant', subject: user(OUTSIDER, TENANT_B), frameTenant: TENANT_B, source: 'jwt' },
  {
    label: 'super-admin switched into A',
    subject: user(SUPER, TENANT_B, { roles: ['user', 'super_admin'] }),
    frameTenant: TENANT_A,
    source: 'header',
  },
  {
    label: 'licence caller of A',
    subject: user(LICENCE, TENANT_A, { roles: [], authKind: 'licence' } as Partial<User>),
    frameTenant: TENANT_A,
    source: 'jwt',
  },
  {
    // The measured live conveyor token carries NO tenant_id claim, so its
    // `tenantId` is its own sub — a member of no tenant.
    label: 'conveyor priority identity',
    subject: user(CONVEYOR, CONVEYOR, {
      roles: [CONVEYOR_ROLE],
      azp: CONVEYOR_AZP,
      username: CONVEYOR_USERNAME,
    } as Partial<User>),
    frameTenant: CONVEYOR,
    source: 'jwt',
  },
];

/** What the persona is expected to reach — the ruling, written down once. */
const EXPECTED: Record<string, Record<string, boolean>> = {
  owner: { [P_A]: true, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: true },
  'non-owner tenant member': { [P_A]: true, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: true },
  'member of another tenant': { [P_A]: false, [P_B]: true, [P_UNTAGGED]: false, [P_A_SUPER]: false },
  'super-admin switched into A': { [P_A]: true, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: true },
  'licence caller of A': { [P_A]: true, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: true },
  'conveyor priority identity': { [P_A]: false, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: false },
};

/**
 * WRITES: the same, except a caller acting OUTSIDE its own tenant (the switched
 * super-admin) keeps the pre-P1-TEAM owner pin — only its own project.
 */
const EXPECTED_WRITE: Record<string, Record<string, boolean>> = {
  ...EXPECTED,
  'super-admin switched into A': { [P_A]: false, [P_B]: false, [P_UNTAGGED]: false, [P_A_SUPER]: true },
};

function inFrame<T>(p: Persona, fn: () => Promise<T>): Promise<T> {
  return withRequestContext(
    {
      correlationId: 'p1team-parity',
      initiator: 'human',
      channel: 'web',
      tenantId: p.frameTenant,
      userId: p.subject.id,
      activeTenantSource: p.source,
    },
    fn,
  );
}

const memberAction: AgentCallableAction<{ x: number }, { y: number }> = {
  name: 'demo.p1team_member_read',
  kind: 'read',
  description: 'parity probe',
  input: z.object({ x: z.number() }),
  output: z.object({ y: z.number() }),
  approval: { type: 'auto' },
  idempotencyKey: () => 'p1team-parity',
  cronSafe: true,
  rbac: { type: 'project-member' },
  handler: async () => ({ y: 1 }),
};

const memberWriteAction: AgentCallableAction<{ x: number }, { y: number }> = {
  ...memberAction,
  name: 'demo.p1team_member_write',
  kind: 'write',
};

function actionCtx(p: Persona, projectId: string): ActionContext {
  // ActionContext.tenantId is the JWT tenant; the frame carries the resolved one.
  return {
    userId: p.subject.id,
    projectId,
    correlationId: 'p1team-parity',
    initiator: 'agent',
    channel: 'agent',
    tenantId: p.subject.tenantId,
  };
}

async function providerAdmits(p: Persona, projectId: string, action = memberAction): Promise<boolean> {
  try {
    await inFrame(p, () => assertRbac(action, actionCtx(p, projectId), { x: 1 }));
    return true;
  } catch (e) {
    if (
      e instanceof RbacDeniedError &&
      (e.code === 'rbac_not_project_member' || e.code === 'rbac_insufficient_project_role')
    ) {
      return false;
    }
    throw e;
  }
}

async function routeAdmits(p: Persona, projectId: string): Promise<boolean> {
  return Boolean(await inFrame(p, () => findTenantScopedProject(db, p.subject, projectId)));
}

/** The route WRITE rule: the seam, then the switched-view owner pin. */
async function routeWriteAdmits(p: Persona, projectId: string): Promise<boolean> {
  return inFrame(p, async () => {
    const project = await findTenantScopedProject(db, p.subject, projectId);
    return Boolean(project) && projectWritableByCaller(p.subject, project!);
  });
}

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn('[tenant-member-provider-parity] DB not reachable, skipping. — ' + String(err));
  }
  setProjectMembershipProvider(tenantMemberProjectMembershipProvider);
  if (!reachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
  await db.insert(projects).values([
    { id: P_A, owner_id: OWNER, name: 'p1team-parity-a', repository_url: 'https://example.com/a', project_data: { keycloak_tenant_id: TENANT_A } },
    { id: P_B, owner_id: OUTSIDER, name: 'p1team-parity-b', repository_url: 'https://example.com/b', project_data: { keycloak_tenant_id: TENANT_B } },
    { id: P_UNTAGGED, owner_id: OWNER, name: 'p1team-parity-untagged', repository_url: 'https://example.com/u' },
    { id: P_A_SUPER, owner_id: SUPER, name: 'p1team-parity-a-super', repository_url: 'https://example.com/as', project_data: { keycloak_tenant_id: TENANT_A } },
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
});

const { itDb } = createDbSuite('tenant-member-provider-parity');

describe('P1-TEAM-a: production membership provider == route gate', () => {
  for (const p of PERSONAS) {
    for (const projectId of ALL) {
      const expected = EXPECTED[p.label]![projectId]!;
      itDb(`${p.label} × ${projectId.slice(-2)}: provider and route both ${expected ? 'ADMIT' : 'REFUSE'}`, async () => {
        const [provider, route] = [await providerAdmits(p, projectId), await routeAdmits(p, projectId)];
        expect({ provider, route }).toEqual({ provider: expected, route: expected });
      });
      const expectedWrite = EXPECTED_WRITE[p.label]![projectId]!;
      itDb(`${p.label} × ${projectId.slice(-2)}: WRITE — provider and route both ${expectedWrite ? 'ADMIT' : 'REFUSE'}`, async () => {
        const [provider, route] = [
          await providerAdmits(p, projectId, memberWriteAction),
          await routeWriteAdmits(p, projectId),
        ];
        expect({ provider, route }).toEqual({ provider: expectedWrite, route: expectedWrite });
      });
    }
  }

  itDb('the provider answers `editor` (never owner) for a member, null for an outsider', async () => {
    expect(await tenantMemberProjectMembershipProvider.getRole(P_A, MEMBER, TENANT_A)).toBe('editor');
    expect(await tenantMemberProjectMembershipProvider.getRole(P_A, OWNER, TENANT_A)).toBe('editor');
    expect(await tenantMemberProjectMembershipProvider.getRole(P_A, OUTSIDER, TENANT_B)).toBeNull();
  });

  // MUTATION: drop the switched-view branch in tenant-member-provider.ts and the
  // first assertion is red ('editor'); drop the header check and the last is red.
  itDb('a switched super-admin: `viewer` on a project it does not own, `editor` on its own, null without an accepted header switch', async () => {
    const sa = PERSONAS.find((p) => p.label === 'super-admin switched into A')!;
    expect(await inFrame(sa, () => tenantMemberProjectMembershipProvider.getRole(P_A, SUPER, TENANT_A, TENANT_B))).toBe('viewer');
    expect(await inFrame(sa, () => tenantMemberProjectMembershipProvider.getRole(P_A_SUPER, SUPER, TENANT_A, TENANT_B))).toBe('editor');
    const unswitched: Persona = { ...sa, source: 'jwt' };
    expect(await inFrame(unswitched, () => tenantMemberProjectMembershipProvider.getRole(P_A, SUPER, TENANT_A, TENANT_B))).toBeNull();
  });

  itDb('no resolvable tenant ⇒ null (an unresolvable tenant never becomes membership)', async () => {
    expect(await tenantMemberProjectMembershipProvider.getRole(P_A, MEMBER, undefined)).toBeNull();
    expect(await tenantMemberProjectMembershipProvider.getRole(P_A, MEMBER, '  ')).toBeNull();
    expect(await tenantMemberProjectMembershipProvider.getRole('not-a-uuid', MEMBER, TENANT_A)).toBeNull();
  });

  itDb('the frame tenant wins over ActionContext.tenantId (the switched super-admin is a member of A, not B)', async () => {
    const sa = PERSONAS.find((p) => p.label === 'super-admin switched into A')!;
    // ActionContext.tenantId is B (the JWT home); the frame says A.
    expect(await providerAdmits(sa, P_A)).toBe(true);
    expect(await providerAdmits(sa, P_B)).toBe(false);
  });

  // ⛔ INVARIANT: the super-admin HOME-view read relaxation never reaches the
  // write gate (`resolveProject` with crossTenantRead=false) — nor the provider.
  itDb('a super-admin in HOME view: the READ lane reaches its home-tagged project, the write gate and the provider do not reach another tenant', async () => {
    const home: Persona = {
      label: 'super-admin home',
      subject: user(SUPER, TENANT_B, { roles: ['user', 'super_admin'] }),
      frameTenant: TENANT_B,
      source: 'jwt',
    };
    expect(Boolean(await inFrame(home, () => findProjectForRead(db, home.subject, P_B)))).toBe(true);
    expect(Boolean(await inFrame(home, () => findProjectForRead(db, home.subject, P_A)))).toBe(false);
    expect(await routeAdmits(home, P_A)).toBe(false);
    expect(await providerAdmits(home, P_A)).toBe(false);
  });
});
