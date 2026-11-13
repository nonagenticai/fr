// tests/integration/services/cockpit-approvals-bound.integration.test.ts
//
// The cockpit's approvals read was UNBOUNDED: every approval the project ever
// had, plus each one's roster and decisions by id, on every cockpit load. It is
// now every PENDING row (they drive open_gates and the blocked-card set, so
// none may be dropped) plus the newest COCKPIT_DECIDED_APPROVALS_LIMIT decided
// rows (they only feed the timeline's decision events).
import { afterAll, beforeEach, expect } from 'bun:test';

import { queryClient as sql } from '../../../src/db/client';
import {
  COCKPIT_DECIDED_APPROVALS_LIMIT,
  loadApprovals,
} from '../../../src/services/cockpit/project-cockpit';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('cockpit-approvals-bound');

const TENANT = '0195f48b-d000-7000-8000-0000000c0b01';
const PROJECT = '0195f48b-d000-7000-8000-0000000c0b02';
const OWNER = '0195f48b-d000-7000-8000-0000000c0b03';
const DECIDED_SEEDED = COCKPIT_DECIDED_APPROVALS_LIMIT + 7;

async function cleanup(): Promise<void> {
  // 210 fixture rows: on a fresh database this scoped delete empties the table,
  // which fr's destructive-statement guard (migration 142) refuses above 50.
  // The sanctioned opt-out is a transaction-local GUC, scoped to this delete.
  await sql.begin(async (tx) => {
    await tx`SET LOCAL fr.allow_destructive = 'on'`;
    await tx`DELETE FROM approvals WHERE project_id = ${PROJECT}::uuid`;
    await tx`DELETE FROM projects WHERE id = ${PROJECT}::uuid`;
  });
}

beforeEach(async () => {
  await cleanup();
  await sql`
    INSERT INTO projects (id, owner_id, name, repository_url, branch, project_data)
    VALUES (${PROJECT}::uuid, ${OWNER}, 'cockpit bound probe', 'https://github.com/x/y.git', 'main',
            ${JSON.stringify({ keycloak_tenant_id: TENANT })}::jsonb)
  `;
  // Pending rows are the OLDEST, so a single "newest N" cap would drop them.
  await sql`
    INSERT INTO approvals (tenant_id, project_id, description, status, created_at, updated_at)
    SELECT ${TENANT}::uuid, ${PROJECT}::uuid, 'pending ' || g, 'pending',
           now() - make_interval(days => 400 + g), now()
      FROM generate_series(1, 3) AS g
  `;
  await sql`
    INSERT INTO approvals (tenant_id, project_id, description, status, created_at, updated_at)
    SELECT ${TENANT}::uuid, ${PROJECT}::uuid, 'decided ' || g, 'approved',
           now() - make_interval(mins => g), now()
      FROM generate_series(1, ${DECIDED_SEEDED}) AS g
  `;
});

afterAll(async () => {
  await cleanup();
});

itDb('reads every pending approval plus only the newest decided ones', async () => {
  const rows = await loadApprovals(PROJECT, TENANT);
  const pending = rows.filter((r) => r.status === 'pending');
  const decided = rows.filter((r) => r.status !== 'pending');
  expect(pending).toHaveLength(3);
  expect(decided).toHaveLength(COCKPIT_DECIDED_APPROVALS_LIMIT);
  // The NEWEST decided rows are the ones kept.
  expect(decided.map((r) => r.description)).toContain('decided 1');
  expect(decided.map((r) => r.description)).not.toContain(`decided ${DECIDED_SEEDED}`);
  // Still newest-first overall.
  expect(rows[0]!.description).toBe('decided 1');
  expect(rows.at(-1)!.description).toBe('pending 3');
});
