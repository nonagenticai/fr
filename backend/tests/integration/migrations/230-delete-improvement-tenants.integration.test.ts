// tests/integration/migrations/230-delete-improvement-tenants.integration.test.ts
//
// Migration 230's DATA half is ONE-SHOT. fr lazily recreates a `workspaces` row for …0002 (the
// `platform-core` licence carries that tenant id; routes/assets/_lib/effective-query.ts
// ensureWorkspace), and the rows re-derived under it must survive every later boot. The original
// probe witnessed "no workspaces row for the three ids", so with reapplyIfProbeFails the runner
// re-ran the 43-table DELETE on every boot after that row came back.
//
// Drives the REAL runner (runMigrations, the same code `bun run migrate` and boot call) twice
// around a recreated …0002 workspace + an asset_assignments row, and asserts both survive.
// Against the row-absence probe the second run re-applies 230 and this goes red.

import { afterAll, describe, expect } from 'bun:test';

import { queryClient as sql } from '../../../src/db/client';
import { probeForMigration, runMigrations } from '../../../src/db/migration-runner';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('230-delete-improvement-tenants');

const TENANT = '0195f48b-d000-7000-8000-000000000002';
const ASSET = `mig230-fixture-${process.pid}-${Date.now()}`;

let createdWorkspace = false;

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await sql`DELETE FROM asset_assignments WHERE workspace_id = ${TENANT}::uuid AND asset_id = ${ASSET}`;
  if (createdWorkspace) await sql`DELETE FROM workspaces WHERE id = ${TENANT}::uuid`;
});

describe('migration 230 deletes the improvement tenants ONCE', () => {
  itDb('a recreated …0002 workspace and its asset row survive a second migrate', async () => {
    await runMigrations(sql);
    const [ledger] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM _migrations WHERE filename = '230_delete_improvement_tenants.sql'`;
    expect(ledger?.n).toBe(1);

    // What ensureWorkspace + the lazy seed do for a platform-core licence caller.
    const before = await sql`SELECT 1 FROM workspaces WHERE id = ${TENANT}::uuid`;
    createdWorkspace = before.length === 0;
    await sql`INSERT INTO workspaces (id, name) VALUES (${TENANT}::uuid, 'platform-core') ON CONFLICT (id) DO NOTHING`;
    await sql`
      INSERT INTO asset_assignments (workspace_id, asset_type, asset_id, scope_kind, link_kind, assigned_by)
      VALUES (${TENANT}::uuid, 'workflow', ${ASSET}, 'workspace', 'owns', 'system-lazy')`;

    // The registered probe stays TRUE with the row present (it reads schema facts only)…
    const probe = probeForMigration('230_delete_improvement_tenants.sql');
    expect(probe).toBeDefined();
    expect(await probe!(sql)).toBe(true);

    // …so the next boot's migrate does not re-run the DELETE.
    await runMigrations(sql);
    expect((await sql`SELECT 1 FROM workspaces WHERE id = ${TENANT}::uuid`).length).toBe(1);
    expect(
      (await sql`SELECT 1 FROM asset_assignments WHERE workspace_id = ${TENANT}::uuid AND asset_id = ${ASSET}`).length,
    ).toBe(1);
  });
});
