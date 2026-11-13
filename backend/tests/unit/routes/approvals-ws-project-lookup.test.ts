// tests/unit/routes/approvals-ws-project-lookup.test.ts
//
// fr row 14d-0b (approvals half) — the REAL project lookup behind the
// `approvals:project:<id>` subscribe gate, against Postgres.
//
// approvals-ws-tenant-gate.test.ts proves the gate with an in-memory lookup;
// this file proves the lookup server.ts actually injects
// (`lib/approvals-ws-project-tenant.ts`) feeds the gate the row's
// `project_data.keycloak_tenant_id`, so a tag match admits and a foreign or
// untagged row refuses. DB-dependent: runs in the ARMED unit line
// (FR_TEST_REQUIRE_DB=1) as well as the plain unit lane.

import { afterAll, beforeAll, expect } from 'bun:test';
import { db, queryClient, projects } from '../../../src/db/client';
import { WebSocketManager } from '../../../src/domain/engagement/adapters/websocket';
import { lookupApprovalsWsProject } from '../../../src/lib/approvals-ws-project-tenant';
import { createDbSuite } from '../../integration/helpers/db-suite';

const sql = queryClient;
const { itDb, dbReachable } = createDbSuite('approvals-ws-project-lookup');

const TENANT_A = 'f14d0b00-0000-4000-8000-00000000000a';
const TENANT_B = 'f14d0b00-0000-4000-8000-00000000000b';
const OWNER = 'f14d0b10-0000-4000-8000-000000000001';
const P_A = 'f14d0b20-0000-4000-8000-0000000000a1'; // tagged A
const P_B = 'f14d0b20-0000-4000-8000-0000000000b1'; // tagged B
const P_NULL = 'f14d0b20-0000-4000-8000-0000000000c1'; // untagged
const P_GONE = 'f14d0b20-0000-4000-8000-0000000000d1'; // never inserted
const ALL = [P_A, P_B, P_NULL];

beforeAll(async () => {
  if (!dbReachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
  await db.insert(projects).values([
    { id: P_A, owner_id: OWNER, name: '14d0b-a', repository_url: 'x', project_data: { keycloak_tenant_id: TENANT_A } },
    { id: P_B, owner_id: OWNER, name: '14d0b-b', repository_url: 'x', project_data: { keycloak_tenant_id: TENANT_B } },
    { id: P_NULL, owner_id: OWNER, name: '14d0b-null', repository_url: 'x', project_data: { other: 1 } },
  ]);
});

afterAll(async () => {
  if (!dbReachable) return;
  await sql`DELETE FROM projects WHERE id = ANY(${ALL}::uuid[])`;
});

/** Drive one `{type:'subscribe', projectId}` through a manager wired to the REAL lookup. */
async function subscribe(projectId: string, tenantId: string) {
  const m = new WebSocketManager();
  m.setProjectLookup(lookupApprovalsWsProject);
  const sent: Array<Record<string, unknown>> = [];
  const subscribed: string[] = [];
  const ws = {
    data: { kind: 'approval', userId: 'u', tenantId },
    readyState: 1,
    send: (s: string) => sent.push(JSON.parse(s)),
    subscribe: (t: string) => subscribed.push(t),
    unsubscribe: () => {},
  };
  m.handleMessage(ws as never, JSON.stringify({ type: 'subscribe', projectId }));
  for (let i = 0; i < 100 && sent.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
  return { sent, subscribed };
}

itDb('lookup returns the row with its project_data tag', async () => {
  const row = await lookupApprovalsWsProject(P_A);
  expect(row?.id).toBe(P_A);
  expect((row?.project_data as { keycloak_tenant_id?: string }).keycloak_tenant_id).toBe(TENANT_A);
  expect(await lookupApprovalsWsProject(P_GONE)).toBeNull();
});

itDb('own-tenant project → subscribed', async () => {
  const { sent, subscribed } = await subscribe(P_A, TENANT_A);
  expect(subscribed).toEqual([`approvals:project:${P_A}`]);
  expect(sent).toEqual([{ type: 'subscribed', projectId: P_A }]);
});

itDb('another tenant\'s project → refused project_tenant_mismatch', async () => {
  const { sent, subscribed } = await subscribe(P_B, TENANT_A);
  expect(subscribed).toEqual([]);
  expect(sent).toEqual([{ type: 'subscribe_refused', projectId: P_B, reason: 'project_tenant_mismatch' }]);
});

itDb('untagged project → refused project_untagged (fail-closed)', async () => {
  const { sent, subscribed } = await subscribe(P_NULL, TENANT_A);
  expect(subscribed).toEqual([]);
  expect(sent).toEqual([{ type: 'subscribe_refused', projectId: P_NULL, reason: 'project_untagged' }]);
});

itDb('missing project → refused project_not_found', async () => {
  const { sent, subscribed } = await subscribe(P_GONE, TENANT_A);
  expect(subscribed).toEqual([]);
  expect(sent).toEqual([{ type: 'subscribe_refused', projectId: P_GONE, reason: 'project_not_found' }]);
});
