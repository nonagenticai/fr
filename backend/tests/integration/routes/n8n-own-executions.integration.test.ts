// tests/integration/routes/n8n-own-executions.integration.test.ts
//
// fr#1322 item 1 — the customer executions list reads the caller's OWN rows
// from n8n_execution_mapping through `dbOwnExecutionStore(db).readPage(...)`.
// The unit test injects a fake store, so it cannot notice the REAL query
// losing its user_id / tenant_id / project_id filter, its ordering, or its
// paging. This file runs the real query against real Postgres.
//
// Fixture: 5 rows, every id carries a random suffix so parallel files and
// re-runs never collide; cleanup deletes only rows owned by this file's two
// synthetic users.
//
//   execution        user  tenant  project  triggered_at
//   A-t1-P           A     t1      P        base+3s
//   A-t1-Q           A     t1      Q        base+2s
//   A-t2-P           A     t2      P        base+4s
//   B-t1-P           B     t1      P        base+5s
//   A-null-P         A     NULL    P        base+6s
//
// Every assertion is chosen so that removing the filter named in its comment
// changes the result (the "removed" rows are all NEWER than the expected ones,
// so they cannot hide behind a limit).

import { afterAll, beforeEach, expect } from 'bun:test';

import { db, queryClient } from '../../../src/db/client';
import { dbOwnExecutionStore } from '../../../src/routes/tools/n8n';
import { createDbSuite } from '../helpers/db-suite';

const sql = queryClient;
const { itDb, dbReachable } = createDbSuite('n8n-own-executions');

const SUFFIX = crypto.randomUUID().slice(0, 8);
const USER_A = `own-exec-user-a-${SUFFIX}`;
const USER_B = `own-exec-user-b-${SUFFIX}`;
const TENANT_1 = `own-exec-tenant-1-${SUFFIX}`;
const TENANT_2 = `own-exec-tenant-2-${SUFFIX}`;
const PROJ_P = `own-exec-proj-p-${SUFFIX}`;
const PROJ_Q = `own-exec-proj-q-${SUFFIX}`;

const A_T1_P = `own-exec-a-t1-p-${SUFFIX}`;
const A_T1_Q = `own-exec-a-t1-q-${SUFFIX}`;
const A_T2_P = `own-exec-a-t2-p-${SUFFIX}`;
const B_T1_P = `own-exec-b-t1-p-${SUFFIX}`;
const A_NULL_P = `own-exec-a-null-p-${SUFFIX}`;
const ALL_IDS = [A_T1_P, A_T1_Q, A_T2_P, B_T1_P, A_NULL_P];

const BASE_MS = Date.parse('2026-01-01T00:00:00Z');

const SEED: Array<{
  id: string;
  user: string;
  tenant: string | null;
  project: string;
  t: number;
}> = [
  { id: A_T1_P, user: USER_A, tenant: TENANT_1, project: PROJ_P, t: 3 },
  { id: A_T1_Q, user: USER_A, tenant: TENANT_1, project: PROJ_Q, t: 2 },
  { id: A_T2_P, user: USER_A, tenant: TENANT_2, project: PROJ_P, t: 4 },
  { id: B_T1_P, user: USER_B, tenant: TENANT_1, project: PROJ_P, t: 5 },
  { id: A_NULL_P, user: USER_A, tenant: null, project: PROJ_P, t: 6 },
];

async function cleanup(): Promise<void> {
  await sql`DELETE FROM n8n_execution_mapping WHERE user_id IN ${sql([USER_A, USER_B])}`;
}

beforeEach(async () => {
  if (!dbReachable) return;
  await cleanup();
  for (const r of SEED) {
    await sql`
      INSERT INTO n8n_execution_mapping
        (execution_id, workflow_id, project_id, user_id, tenant_id,
         correlation_id, initiated_via, triggered_at, counted_terminal)
      VALUES
        (${r.id}, ${'own-exec-wf-' + SUFFIX}, ${r.project}, ${r.user}, ${r.tenant},
         ${'corr-' + r.id}, ${'api'}, ${new Date(BASE_MS + r.t * 1000).toISOString()}::timestamptz, false)
    `;
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

const ids = (rows: Array<{ execution_id: string }>): string[] => rows.map((r) => r.execution_id);

itDb('readPage returns only the caller\'s rows in the caller\'s tenant, newest first', async () => {
  const store = dbOwnExecutionStore(db);
  const rows = await store.readPage({ userId: USER_A, tenantId: TENANT_1, offset: 0, limit: 10 });
  // Guards user_id filter (B-t1-P), tenant_id filter (A-t2-P, A-null-P: NULL
  // tenant must be excluded, not treated as a wildcard) and DESC ordering.
  expect(ids(rows)).toEqual([A_T1_P, A_T1_Q]);
});

itDb('readPage with projectId narrows to that project', async () => {
  const store = dbOwnExecutionStore(db);
  const rows = await store.readPage({
    userId: USER_A,
    tenantId: TENANT_1,
    projectId: PROJ_P,
    offset: 0,
    limit: 10,
  });
  // Guards the optional project_id filter (would also return A-t1-Q).
  expect(ids(rows)).toEqual([A_T1_P]);
});

itDb('readPage honours limit and offset', async () => {
  const store = dbOwnExecutionStore(db);
  const second = await store.readPage({ userId: USER_A, tenantId: TENANT_1, offset: 1, limit: 1 });
  // Guards OFFSET (without it the first row, A-t1-P, comes back).
  expect(ids(second)).toEqual([A_T1_Q]);
  const first = await store.readPage({ userId: USER_A, tenantId: TENANT_1, offset: 0, limit: 1 });
  // Guards LIMIT (without it both A-t1-P and A-t1-Q come back).
  expect(ids(first)).toEqual([A_T1_P]);
});

itDb('readPage for a user with no rows in that tenant returns nothing', async () => {
  const store = dbOwnExecutionStore(db);
  const rows = await store.readPage({ userId: USER_B, tenantId: TENANT_2, offset: 0, limit: 10 });
  // Guards BOTH filters together: dropping user_id leaks A-t2-P, dropping tenant_id leaks B-t1-P.
  expect(ids(rows)).toEqual([]);
});

itDb('markCounted flips counted_terminal on the named row only', async () => {
  const store = dbOwnExecutionStore(db);
  await store.markCounted([A_T1_P]);
  const rows = await sql<Array<{ execution_id: string; counted_terminal: boolean }>>`
    SELECT execution_id, counted_terminal
      FROM n8n_execution_mapping
     WHERE execution_id IN ${sql(ALL_IDS)}
     ORDER BY execution_id
  `;
  const counted = Object.fromEntries(rows.map((r) => [r.execution_id, r.counted_terminal]));
  // Guards the execution_id IN (...) filter: every other seeded row must stay false.
  expect(counted).toEqual({
    [A_T1_P]: true,
    [A_T1_Q]: false,
    [A_T2_P]: false,
    [B_T1_P]: false,
    [A_NULL_P]: false,
  });
});
