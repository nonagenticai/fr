// tests/unit/agui/actions/kanban-card-bound.test.ts
//
// fr-agui P1c (P1b audit MAJOR carry): `kanban.create_card` is re-homed into the
// project agent as BOUND-PROJECT-ONLY. In a project-bound context the handler
// targets the bound project BY ID — a `project_ref` naming another project of
// the same tenant is ignored by the handler (and refused `project_mismatch` one
// layer up, agent/project-binding.ts). The channel `card <project>: <title>`
// grammar (unbound) keeps its fuzzy name lookup.
//
// The handler stops at "no Planka board provisioned yet" for these fixture
// projects (none has a board), which names the project it chose — the
// observation, with no Planka call.
//
// DB-backed (assertion-armed by scripts/ci-test.sh); fixture rows scoped to fixed ids.
//
// MUTATION (run, red, reverted — see the P1c report): replace the
// `ctx.projectId ? eq(projects.id, …) : ilike(…)` target with the name match
// alone → the bound case picks project B and reds.

import { afterAll, beforeAll, describe, expect } from 'bun:test';

import { createCardAction } from '../../../../src/agui/actions/kanban-card';
import type { ActionContext } from '../../../../src/agui/types';
import { db, queryClient, projects } from '../../../../src/db/client';

import { createDbSuite } from '../../../integration/helpers/db-suite';

const TENANT = 'f9000000-0000-4000-8000-00000000000a';
const OWNER = 'f9100000-0000-4000-8000-000000000001';
const P_A = 'f9200000-0000-4000-8000-0000000000a1';
const P_B = 'f9200000-0000-4000-8000-0000000000b1';
const ALL = [P_A, P_B];

let reachable = false;
beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM projects LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn('[kanban-card-bound] DB not reachable, skipping. — ' + String(err));
  }
  if (!reachable) return;
  await queryClient`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
  await db.insert(projects).values([
    { id: P_A, owner_id: OWNER, name: 'p1c-card-alpha', repository_url: 'https://example.com/a', project_data: { keycloak_tenant_id: TENANT } },
    { id: P_B, owner_id: OWNER, name: 'p1c-card-bravo', repository_url: 'https://example.com/b', project_data: { keycloak_tenant_id: TENANT } },
  ]);
});
afterAll(async () => {
  if (!reachable) return;
  await queryClient`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
});

const { itDb } = createDbSuite('p1c-kanban-card-bound');

const ctx = (projectId: string | null): ActionContext => ({
  userId: OWNER,
  projectId,
  correlationId: 'cid-card',
  initiator: 'human',
  channel: 'web',
  tenantId: TENANT,
});

async function chosen(input: Record<string, unknown>, c: ActionContext): Promise<string> {
  try {
    await createCardAction.handler(input as never, c);
    return 'created?';
  } catch (err) {
    return (err as Error).message;
  }
}

describe('kanban.create_card targets the BOUND project by id', () => {
  itDb('bound to A: a project_ref naming B is ignored by the handler — the card goes to A', async () => {
    const msg = await chosen({ project_ref: 'p1c-card-bravo', title: 't' }, ctx(P_A));
    expect(msg).toContain('p1c-card-alpha');
    expect(msg).not.toContain('bravo');
  });

  itDb('bound, no project_ref at all (the project agent shape) → A', async () => {
    expect(await chosen({ title: 't' }, ctx(P_A))).toContain('p1c-card-alpha');
  });

  itDb('CONTROL: unbound (the channel grammar) keeps the name lookup; no ref is refused', async () => {
    expect(await chosen({ project_ref: 'p1c-card-bravo', title: 't' }, ctx(null))).toContain('p1c-card-bravo');
    expect(await chosen({ title: 't' }, ctx(null))).toContain('needs a project');
  });
});
