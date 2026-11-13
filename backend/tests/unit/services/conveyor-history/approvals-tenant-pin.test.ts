// tests/unit/services/conveyor-history/approvals-tenant-pin.test.ts
//
// The project page's conveyor conversation reads approvals pinned to the ACTIVE tenant (fr row 14d),
// like the cockpit's approvals block: another tenant's approval on the SAME project_id must never be
// returned. DB-backed (assertion-armed lane). Mutation that must red this: drop
// `eq(approvals.tenant_id, tenantId)` from listConveyorApprovalsFromDb (checked 2026-10-25).

import { afterAll, beforeAll, expect } from 'bun:test';
import { db, queryClient, projects, workspaces } from '../../../../src/db/client';
import { listConveyorApprovalsFromDb } from '../../../../src/services/conveyor-history/history';
import { createDbSuite } from '../../../integration/helpers/db-suite';

const sql = queryClient;
const { itDb } = createDbSuite('conveyor-history-approvals-tenant-pin');

const T_OWN = 'c4e10000-0000-4000-8000-00000000000a';
const T_OTHER = 'c4e10000-0000-4000-8000-00000000000b';
const OWNER = 'c4e11000-0000-4000-8000-000000000001';
const P = 'c4e12000-0000-4000-8000-000000000001';
const A_OWN = 'c4e13000-0000-4000-8000-0000000000a1'; // T_OWN, n8n — must show
const A_OTHER = 'c4e13000-0000-4000-8000-0000000000a2'; // T_OTHER, n8n, same project — must never show
const A_WEB = 'c4e13000-0000-4000-8000-0000000000a3'; // T_OWN, web — not a conveyor ask
const APPROVALS = [A_OWN, A_OTHER, A_WEB];

async function cleanup(): Promise<void> {
  await sql`DELETE FROM approval_decisions WHERE approval_id = ANY(${APPROVALS}::uuid[])`;
  await sql`DELETE FROM approvals WHERE id = ANY(${APPROVALS}::uuid[])`;
  await sql`DELETE FROM projects WHERE id = ${P}::uuid`;
  await sql`DELETE FROM workspaces WHERE id IN (${T_OWN}, ${T_OTHER})`;
}

beforeAll(async () => {
  await cleanup();
  await db.insert(workspaces).values([
    { id: T_OWN, name: 'conveyor-history-own' },
    { id: T_OTHER, name: 'conveyor-history-other-secret' },
  ]);
  await db.insert(projects).values({
    id: P,
    owner_id: OWNER,
    name: 'conveyor-history-tenant-pin',
    repository_url: 'https://example.com/repo',
    project_data: { keycloak_tenant_id: T_OWN, rm_pm_project_id: 'rm-pin' },
  });
  const ap = (id: string, tenant: string, source: string, desc: string) =>
    sql`INSERT INTO approvals (id, tenant_id, project_id, requester_id, description, status, source)
        VALUES (${id}::uuid, ${tenant}::uuid, ${P}::uuid, ${OWNER}::uuid, ${desc}, 'approved', ${source})`;
  await ap(A_OWN, T_OWN, 'n8n', 'OWN-TENANT-ASK');
  await ap(A_OTHER, T_OTHER, 'n8n', 'OTHER-TENANT-SECRET-ASK');
  await ap(A_WEB, T_OWN, 'web', 'OWN-TENANT-WEB-ROW');
  for (const a of [A_OWN, A_OTHER]) {
    await sql`INSERT INTO approval_decisions (approval_id, approver_id, decision, comment)
              VALUES (${a}::uuid, ${OWNER}::uuid, 'approved', ${'decision on ' + a.slice(-2)})`;
  }
});

afterAll(cleanup);

itDb("another tenant's approval on the same project_id is never returned, nor its decision", async () => {
  const own = await listConveyorApprovalsFromDb(P, T_OWN);
  expect(own.rows.map((r) => r.id)).toEqual([A_OWN]);
  expect(own.decisions.map((d) => d.approval_id)).toEqual([A_OWN]);
  expect(JSON.stringify(own)).not.toContain('OTHER-TENANT-SECRET');
});

itDb('positive control: the other tenant reads its own row on that project, and only it', async () => {
  const other = await listConveyorApprovalsFromDb(P, T_OTHER);
  expect(other.rows.map((r) => r.id)).toEqual([A_OTHER]);
  expect(other.decisions.map((d) => d.approval_id)).toEqual([A_OTHER]);
});
