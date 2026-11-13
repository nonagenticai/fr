// tests/integration/services/kata-andon.integration.test.ts
//
// The kata holder set (`andon_state.kata_holders`, migration 225) against a REAL Postgres: a kata
// joins once, leaves only its own entry, a second kata keeps holding after the first leaves, and
// the operator's release prunes holders with no running/qa kata. A kata holds the whole conveyor n8n instance (George 2026-11-03),
// never a project: a project's own andon stays released while katas hold, and the per-project
// 'kata' reason is gone from the schema (migration 227). What the set does to the worker is pinned
// in tests/integration/routes/andon-kata-cord.integration.test.ts.
//
// ⚠️ andon_state is a singleton other suites read: every case leaves `kata_holders` empty.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';

import { db, queryClient as sql } from '../../../src/db/client';
import { projects } from '../../../src/db/schema';
import { joinSystemKataAndon, leaveSystemKataAndon, pruneOrphanKataHolders } from '../../../src/services/kata-andon';
import { readProjectAndon } from '../../../src/services/project-andon';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('kata-andon');

const TENANT = '00000000-0000-0000-0000-0000000000a7';
const OTHER_TENANT = '00000000-0000-0000-0000-0000000000a8';
const ids: string[] = [];
let held = '';
let kata = '';
let kata2 = '';
let foreign = '';

async function project(name: string, tenant: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({
      owner_id: tenant,
      name,
      repository_url: 'https://example.com/repo',
      shape: 'continuous_flow',
      project_data: { keycloak_tenant_id: tenant },
    })
    .returning({ id: projects.id });
  ids.push(row!.id);
  return row!.id;
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await sql`INSERT INTO andon_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  held = await project('kata-held', TENANT);
  kata = await project('kata-1', TENANT);
  kata2 = await project('kata-2', TENANT);
  foreign = await project('kata-foreign', OTHER_TENANT);
});

beforeEach(async () => {
  if (!process.env.DATABASE_URL || ids.length === 0) return;
  await sql`UPDATE andon_state SET kata_holders = '{}' WHERE id = 1`;
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await sql`UPDATE andon_state SET kata_holders = '{}' WHERE id = 1`;
  if (ids.length > 0) await db.delete(projects).where(inArray(projects.id, ids));
});

describe('the kata holder set', () => {
  itDb('join is idempotent; a kata leaves only its own entry; the last leave empties the set', async () => {
    expect(await joinSystemKataAndon(kata)).toEqual([kata]);
    expect(await joinSystemKataAndon(kata)).toEqual([kata]);
    expect(await joinSystemKataAndon(kata2)).toEqual([kata, kata2]);
    expect(await leaveSystemKataAndon(kata)).toEqual({ released: true, holders: [kata2] });
    expect(await leaveSystemKataAndon(kata)).toEqual({ released: false, holders: [kata2] });
    expect(await leaveSystemKataAndon(kata2)).toEqual({ released: true, holders: [] });
  });

  itDb('a kata holds the instance, not a project: project andons stay released', async () => {
    await joinSystemKataAndon(kata);
    expect(await readProjectAndon(held)).toMatchObject({ engaged: false, reason: null });
    expect(await readProjectAndon(foreign)).toMatchObject({ engaged: false, reason: null });
    expect(await readProjectAndon(kata)).toMatchObject({ engaged: false, reason: null });
  });

  itDb("the per-project 'kata' reason is gone from the schema (migration 227)", async () => {
    // An async wrapper: postgres.js runs a query only when it is awaited, and `expect().rejects`
    // on the bare query object never starts it.
    const holdByKata = async () => {
      await sql`UPDATE projects SET andon_engaged = true, andon_reason = 'kata' WHERE id = ${held}`;
    };
    await expect(holdByKata()).rejects.toThrow(/projects_andon_reason_check/);
  });

  itDb('a holder with no running/qa kata row is an orphan: pruned, and reported once', async () => {
    await joinSystemKataAndon(kata);
    await joinSystemKataAndon(kata2);
    expect((await pruneOrphanKataHolders()).sort()).toEqual([kata, kata2].sort());
    expect(await leaveSystemKataAndon(kata)).toEqual({ released: false, holders: [] });
    expect(await pruneOrphanKataHolders()).toEqual([]);
  });
});
