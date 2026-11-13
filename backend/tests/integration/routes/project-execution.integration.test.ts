// tests/integration/routes/project-execution.integration.test.ts
//
// fr-agui SPEC §7.4 / §13 P3 — the REAL SQL behind the execution-observability
// reads (routes/project-execution.ts `execution*` stores). A unit test cannot
// notice a query that narrows to the
// caller's own rows (the ruling is the opposite: every tenant member sees every
// project's runs) or that drops the tenant pin. Real Postgres here.
//
// Fixture (random suffixes; cleanup deletes only this file's rows):
//   n8n_execution_mapping   project  tenant  user  triggered_at
//     me-P                  P        T       me    base+1h
//     colleague-P           P        T       col   base+2h
//     old-P                 P        T       col   base-1d   (before `since`)
//     other-tenant-P        P        U       me    base+3h
//     null-tenant-P         P        NULL    me    base+4h
//     colleague-Q           Q        T       col   base+5h
//   capability_audit        P/T (col, me) · P/U · Q/T
//   approvals (pending)     card c-1 on P/T · card c-2 on P/T but APPROVED · card c-3 on Q/T
//
// Every excluded row is NEWER than the included ones, so a dropped filter cannot
// hide behind a limit.

import { afterAll, beforeAll, expect } from 'bun:test';

import { queryClient } from '../../../src/db/client';
import {
  executionAuditRows,
  executionMappingPage,
  executionOpenGates,
} from '../../../src/routes/project-execution';
import { createDbSuite } from '../helpers/db-suite';

const sql = queryClient;
const { itDb, dbReachable } = createDbSuite('project-execution');

const S = crypto.randomUUID().slice(0, 8);
const T = crypto.randomUUID();
const U = crypto.randomUUID();
const P = crypto.randomUUID();
const Q = crypto.randomUUID();
const OWNER = crypto.randomUUID();
const ME = `p3-me-${S}`;
const COL = `p3-col-${S}`;
const BASE = Date.parse('2026-10-16T00:00:00Z');
const at = (h: number) => new Date(BASE + h * 3_600_000).toISOString();

async function cleanup(): Promise<void> {
  await sql`DELETE FROM n8n_execution_mapping WHERE user_id IN ${sql([ME, COL])}`;
  await sql`DELETE FROM capability_audit WHERE user_id IN ${sql([ME, COL])}`;
  await sql`DELETE FROM approvals WHERE project_id IN ${sql([P, Q])}`;
  await sql`DELETE FROM projects WHERE id IN ${sql([P, Q])}`;
}

beforeAll(async () => {
  if (!dbReachable) return;
  await cleanup();
  for (const id of [P, Q]) {
    await sql`INSERT INTO projects (id, owner_id, name, repository_url, project_data)
              VALUES (${id}::uuid, ${OWNER}::uuid, ${'p3-exec-' + S}, ${'https://example.invalid/p3'}, ${JSON.stringify({ keycloak_tenant_id: T })}::jsonb)`;
  }
  const map = [
    ['me-P', P, T, ME, 1],
    ['colleague-P', P, T, COL, 2],
    ['old-P', P, T, COL, -24],
    ['other-tenant-P', P, U, ME, 3],
    ['null-tenant-P', P, null, ME, 4],
    ['colleague-Q', Q, T, COL, 5],
  ] as const;
  for (const [id, project, tenant, user, h] of map) {
    await sql`INSERT INTO n8n_execution_mapping (execution_id, workflow_id, project_id, user_id, tenant_id, correlation_id, initiated_via, triggered_at)
              VALUES (${`${id}-${S}`}, 'wf-p3', ${project}, ${user}, ${tenant}, ${'corr-' + id}, 'web', ${at(h)}::timestamptz)`;
  }
  const audit = [
    ['kanban.create_card', COL, P, T, 1],
    ['kanban.add_comment', ME, P, T, 2],
    ['kanban.create_card', ME, P, U, 3],
    ['kanban.create_card', COL, Q, T, 4],
  ] as const;
  for (const [cap, user, project, tenant, h] of audit) {
    await sql`INSERT INTO capability_audit (capability_id, proposal_id, user_id, tenant_id, project_id, initiator, input_hash, status, ts)
              VALUES (${cap}, ${'pp-' + S + h}, ${user}, ${tenant}::uuid, ${project}::uuid, 'agent', 'aaaa', 'proposed', ${at(h)}::timestamptz)`;
  }
  const gates = [
    [P, 'c-1', 'pending', 'gate on c-1'],
    [P, 'c-2', 'approved', 'decided gate on c-2'],
    [Q, 'c-3', 'pending', 'other project gate'],
  ] as const;
  for (const [project, card, status, description] of gates) {
    await sql`INSERT INTO approvals (tenant_id, project_id, status, kind, description, card_id)
              VALUES (${T}::uuid, ${project}::uuid, ${status}, 'generic'::approval_kind, ${description}, ${card})`;
  }
});

afterAll(async () => {
  if (!dbReachable) return;
  await cleanup();
});

const ids = (rows: Array<{ execution_id: string }>) => rows.map((r) => r.execution_id.replace(`-${S}`, ''));

itDb("executions: EVERY member's runs of the project, in the caller's active tenant only, newest first", async () => {
  const rows = await executionMappingPage({ projectId: P, tenantId: T, offset: 0, limit: 10 });
  // Guards: no user filter (colleague-P present), the tenant pin (other-tenant-P,
  // null-tenant-P absent — NULL is not a wildcard), the project filter (colleague-Q absent).
  expect(ids(rows)).toEqual(['colleague-P', 'me-P', 'old-P']);
});

itDb('executions: `since` keeps runs started at or after it; limit / offset page', async () => {
  expect(ids(await executionMappingPage({ projectId: P, tenantId: T, since: new Date(BASE), offset: 0, limit: 10 }))).toEqual(['colleague-P', 'me-P']);
  expect(ids(await executionMappingPage({ projectId: P, tenantId: T, offset: 1, limit: 1 }))).toEqual(['me-P']);
});

itDb("agent actions: the project's rows in the active tenant, newest first, no input column served", async () => {
  const rows = await executionAuditRows({ projectId: P, tenantId: T, limit: 10 });
  expect(rows.map((r) => [r.capability_id, r.user_id])).toEqual([
    ['kanban.add_comment', ME],
    ['kanban.create_card', COL],
  ]);
  // The store selects exactly the served columns (never input_hash / thread / proposal).
  expect(Object.keys(rows[0]!).sort()).toEqual(['capability_id', 'initiator', 'status', 'ts', 'user_id']);
});

itDb("blocked cards' open gates: PENDING approvals of THIS project and tenant, for the asked cards", async () => {
  const rows = await executionOpenGates({ projectId: P, tenantId: T, cardIds: ['c-1', 'c-2', 'c-3', 'c-9'] });
  expect(rows.map((r) => [r.card_id, r.description])).toEqual([['c-1', 'gate on c-1']]);
  expect(await executionOpenGates({ projectId: P, tenantId: U, cardIds: ['c-1'] })).toEqual([]);
  expect(await executionOpenGates({ projectId: P, tenantId: T, cardIds: [] })).toEqual([]);
});
