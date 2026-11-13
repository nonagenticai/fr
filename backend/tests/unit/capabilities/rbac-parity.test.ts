// tests/unit/capabilities/rbac-parity.test.ts
//
// fr-agui SPEC §10.3 (P1c): the RBAC PARITY test over the PROJECT personas
// (P1-TEAM, George 2026-10-15 — every tenant member is a member of every
// project of the tenant):
//   - the project owner,
//   - a tenant member who is NOT the owner,
//   - a member of ANOTHER tenant (negative control),
//   - plus a super-admin SWITCHED into the tenant (reads yes, writes keep the
//     owner pin) — the one persona where read and write gates differ.
//
// For EVERY action of the project agent (the `project-core` pack, over the
// production registry), the AGENT's answer — `assertRbac` on a bound RAIL
// context, the seam both the catalog dry-run and `invokeAction` use — must equal
// the PROJECT ROUTE's answer for the same person: the read gate
// (`findProjectForRead`, what `GET /api/projects/:id/*` and the per-turn thread
// check use) for a read, the write gate (`findTenantScopedProject` +
// `projectWritableByCaller`) for a write. A disagreement fails CI; the fix is to
// correct the agent's rule, never to widen the route.
//
// The core READS go one step further (parity by construction): they execute the
// UI route itself with the human's own token (its suite, project-core-reads,
// was deleted 2026-10-29 under the no-test-doubles ruling).
//
// DB-backed (assertion-armed by scripts/ci-test.sh): per-file fixed uuids, cleanup scoped
// to them, in the throwaway CI database.
//
// MUTATION (run, red, reverted — see the P1c report): drop the implicit
// `project-member` rule for the project agent in agui/rbac.ts assertRbac → the
// "member of another tenant" rows for every `public`-rule action go red (the
// agent admits, the route refuses).

import { afterAll, beforeAll, describe, expect } from 'bun:test';

import { assertRbac, RbacDeniedError, setProjectMembershipProvider } from '../../../src/agui/rbac';
import { tenantMemberProjectMembershipProvider } from '../../../src/agui/tenant-member-provider';
import { getAction, listActions } from '../../../src/agui/registry';
import { registerAllActions } from '../../../src/agui/register-all-actions';
import { PROJECT_AGENT_ACTIONS } from '../../../src/agui/agent-surface';
import { markAgentTokenContext } from '../../../src/agui/context-provenance';
import type { ActionContext } from '../../../src/agui/types';
import { db, queryClient, projects } from '../../../src/db/client';
import { findProjectForRead, findTenantScopedProject, projectWritableByCaller } from '../../../src/lib/project-access';
import { withRequestContext } from '../../../src/middleware/request-context';
import type { User } from '../../../src/types/api';

import { createDbSuite } from '../../integration/helpers/db-suite';


const sql = queryClient;

const TENANT_A = 'f8000000-0000-4000-8000-00000000000a';
const TENANT_B = 'f8000000-0000-4000-8000-00000000000b';
const OWNER = 'f8100000-0000-4000-8000-000000000001';
const MEMBER = 'f8100000-0000-4000-8000-000000000002';
const OUTSIDER = 'f8100000-0000-4000-8000-000000000003';
const SUPER = 'f8100000-0000-4000-8000-000000000004';
const P_A = 'f8200000-0000-4000-8000-0000000000a1';
const ALL = [P_A];

const user = (id: string, tenantId: string, extra: Partial<User> = {}): User =>
  ({ id, email: `${id}@t`, name: id, roles: ['user'], tenantId, ...extra }) as User;

interface Persona {
  label: string;
  subject: User;
  frameTenant: string;
  source: 'jwt' | 'header';
  read: boolean;
  write: boolean;
}

const PERSONAS: Persona[] = [
  { label: 'project owner', subject: user(OWNER, TENANT_A), frameTenant: TENANT_A, source: 'jwt', read: true, write: true },
  { label: 'tenant member (not the owner)', subject: user(MEMBER, TENANT_A), frameTenant: TENANT_A, source: 'jwt', read: true, write: true },
  { label: 'member of another tenant', subject: user(OUTSIDER, TENANT_B), frameTenant: TENANT_B, source: 'jwt', read: false, write: false },
  {
    label: 'super-admin switched into the tenant',
    subject: user(SUPER, TENANT_B, { roles: ['user', 'super_admin'] }),
    frameTenant: TENANT_A,
    source: 'header',
    read: true,
    write: false,
  },
];

function inFrame<T>(p: Persona, fn: () => Promise<T>): Promise<T> {
  return withRequestContext(
    { correlationId: 'p1c-parity', initiator: 'agent', channel: 'web', tenantId: p.frameTenant, userId: p.subject.id, activeTenantSource: p.source },
    fn,
  );
}

function railCtx(p: Persona): ActionContext {
  return markAgentTokenContext({
    userId: p.subject.id,
    projectId: P_A,
    correlationId: 'p1c-parity',
    initiator: 'agent',
    channel: 'web',
    tenantRoles: p.subject.roles,
    tenantId: p.subject.tenantId,
  });
}

async function agentAdmits(p: Persona, name: string): Promise<boolean> {
  try {
    await inFrame(p, () => assertRbac(getAction(name)!, railCtx(p), {}));
    return true;
  } catch (e) {
    if (e instanceof RbacDeniedError) return false;
    throw e;
  }
}

async function routeAdmits(p: Persona, kind: 'read' | 'write'): Promise<boolean> {
  return inFrame(p, async () => {
    if (kind === 'read') return Boolean(await findProjectForRead(db, p.subject, P_A));
    const project = await findTenantScopedProject(db, p.subject, P_A);
    return Boolean(project) && projectWritableByCaller(p.subject, project!);
  });
}

let reachable = false;

beforeAll(async () => {
  await registerAllActions();
  try {
    await sql`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn('[rbac-parity] DB not reachable, skipping. — ' + String(err));
  }
  setProjectMembershipProvider(tenantMemberProjectMembershipProvider);
  if (!reachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
  await db.insert(projects).values([
    { id: P_A, owner_id: OWNER, name: 'p1c-parity-a', repository_url: 'https://example.com/a', project_data: { keycloak_tenant_id: TENANT_A } },
  ]);
});

afterAll(async () => {
  if (!reachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
});

const { itDb } = createDbSuite('p1c-rbac-parity');

describe('P1c §10.3: the project agent answers exactly what the project route answers', () => {
  itDb('the parity set is the whole project agent (not vacuous)', async () => {
    const registered = new Set(listActions().map((a) => a.name));
    expect([...PROJECT_AGENT_ACTIONS].every((n) => registered.has(n))).toBe(true);
    // Non-vacuity for the per-persona loops below: the set (read AND write) must
    // be populated. No counts — they move with every project-agent action.
    expect(PROJECT_AGENT_ACTIONS.size).toBeGreaterThan(0);
    expect([...PROJECT_AGENT_ACTIONS].filter((n) => getAction(n)!.kind === 'write').length).toBeGreaterThan(0);
  });

  for (const p of PERSONAS) {
    itDb(`${p.label}: agent == route for EVERY project-agent action (read ${p.read ? 'ADMIT' : 'REFUSE'}, write ${p.write ? 'ADMIT' : 'REFUSE'})`, async () => {
      expect(await routeAdmits(p, 'read')).toBe(p.read);
      expect(await routeAdmits(p, 'write')).toBe(p.write);
      const disagreements: string[] = [];
      for (const name of PROJECT_AGENT_ACTIONS) {
        const kind = getAction(name)!.kind;
        const [agent, route] = [await agentAdmits(p, name), kind === 'read' ? p.read : p.write];
        if (agent !== route) disagreements.push(`${name} (${kind}): agent ${agent ? 'ADMITS' : 'REFUSES'}, route ${route ? 'ADMITS' : 'REFUSES'}`);
      }
      expect(disagreements).toEqual([]);
    });
  }
});
