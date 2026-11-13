// tests/integration/workers/scheduled-trigger-run-prune.integration.test.ts
//
// Proves the `scheduled_trigger_runs` retention reaper against a REAL Postgres.
//
// WHY IT MUST BE AN INTEGRATION TEST. The reaper's whole body is one SQL
// statement: a `WITH doomed AS (SELECT ctid … LIMIT n) DELETE … USING doomed`.
// A mocked `db.execute` would assert that we wrote the string we wrote. The
// things that can actually be wrong here are all database-side — whether
// `make_interval(days => $1::int)` binds, whether the ctid batching really
// bounds the statement, whether the affected-row count is readable off the
// driver handle — and none of them are observable without a server.
//
// ⚠️ THE DISCRIMINATING ASSERTION is that FRESH ROWS SURVIVE. A reaper with the
// comparison inverted, or with the interval dropped, deletes the whole table and
// would sail through any "old rows are gone" / "row count went down" check. Every
// case below therefore pins BOTH sides: the doomed count AND the survivor count,
// by id.
//
// Rows are stamped by writing `created_at` EXPLICITLY rather than by waiting:
// the horizon is 90 days, so there is no version of this test that can pass by
// sleeping. That also means the fixture must set `created_at` past its
// `DEFAULT now()`, which is exactly what the production INSERT path never does —
// hence the raw SQL insert here instead of the drizzle helper.

import { afterAll, beforeAll, beforeEach, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db } from '../../../src/db/client';
import { queryClient as sql } from '../../../src/db/client';
import { projects } from '../../../src/db/schema';
import { runScheduledTriggerRunPruneTick } from '../../../src/workers/scheduled-trigger-run-prune';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('scheduled-trigger-run-prune');

const TENANT = '00000000-0000-0000-0000-000000000043';
let projectId = '';

// The tick reads its horizon from SCHEDULED_TRIGGER_RUN_RETENTION_DAYS, exactly
// as production does. Each case starts from the unset (90-day default) state and
// the caller's value is restored afterwards.
const RETENTION_ENV = 'SCHEDULED_TRIGGER_RUN_RETENTION_DAYS';
const originalRetention = process.env[RETENTION_ENV];

/**
 * Insert a run row at an explicit age in days. Returns its id.
 *
 * `status` defaults to 'error', NOT 'ok': the reaper exempts each trigger's most
 * recent 'ok' run, so a fixture that silently defaulted to 'ok' would make every
 * single-row case in this file exempt and quietly assert nothing. `triggerId`
 * defaults to a fresh uuid so unrelated rows never share a trigger by accident.
 */
async function insertRun(
  ageDays: number,
  opts: { status?: string; triggerId?: string } = {},
): Promise<string> {
  const status = opts.status ?? 'error';
  const triggerId = opts.triggerId ?? crypto.randomUUID();
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_trigger_runs
      (trigger_kind, trigger_id, tenant_id, project_id, status, fired_at, created_at)
    VALUES (
      'scheduled_intake',
      ${triggerId}::uuid,
      ${TENANT},
      ${projectId}::uuid,
      ${status},
      now() - make_interval(days => ${ageDays}::int),
      now() - make_interval(days => ${ageDays}::int)
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

/**
 * Create a REAL `scheduled_triggers` row and return its id.
 *
 * Load-bearing for the last-'ok' exemption: the exemption only applies while the
 * trigger still EXISTS, because that is the only thing it protects
 * (scheduled-trigger-health.ts reads FROM scheduled_triggers). There is no FK from
 * scheduled_trigger_runs.trigger_id, so a run whose trigger was never created is
 * indistinguishable from one whose trigger was deleted — which is exactly the
 * orphan case, and exactly what every other test in this file produces by using a
 * bare uuid.
 */
async function insertTrigger(name: string): Promise<string> {
  const rows = await sql<{ id: string }[]>`
    INSERT INTO scheduled_triggers
      (tenant_id, project_id, name, cron, timezone, source_connector,
       connector_config, payload_mapper, target_list, card_template, enabled, origin_kind)
    VALUES (
      ${TENANT}, ${projectId}::uuid, ${name}, '*/5 * * * *', 'UTC', 'rss',
      '{}'::jsonb, '{}'::jsonb, 'INBOX', '{}'::jsonb, true, 'project'
    )
    RETURNING id
  `;
  return rows[0]!.id;
}

async function survivingIds(): Promise<string[]> {
  const rows = await sql<{ id: string }[]>`
    SELECT id FROM scheduled_trigger_runs WHERE tenant_id = ${TENANT} ORDER BY created_at
  `;
  return rows.map((r) => r.id);
}

beforeAll(async () => {
  const [row] = await db
    .insert(projects)
    .values({
      owner_id: TENANT,
      name: 'run-prune-test',
      repository_url: 'https://example.com/repo',
      shape: 'continuous_flow',
    })
    .returning({ id: projects.id });
  projectId = row!.id;
});

afterAll(async () => {
  if (originalRetention === undefined) delete process.env[RETENTION_ENV];
  else process.env[RETENTION_ENV] = originalRetention;
  if (!projectId) return;
  // scheduled_trigger_runs.project_id is ON DELETE CASCADE, so this clears the
  // fixture rows too.
  await db.delete(projects).where(eq(projects.id, projectId));
});

beforeEach(async () => {
  delete process.env[RETENTION_ENV];
  await sql`DELETE FROM scheduled_trigger_runs WHERE tenant_id = ${TENANT}`;
  // Triggers too, now that the last-'ok' exemption is conditional on the trigger
  // EXISTING: a leftover trigger from a prior case would keep exempting rows in the
  // next one, and the failure would look like a reaper bug rather than dirty state.
  await sql`DELETE FROM scheduled_triggers WHERE tenant_id = ${TENANT}`;
});

itDb('deletes rows past the horizon and LEAVES fresh rows (both sides pinned)', async () => {
  const old1 = await insertRun(200);
  const old2 = await insertRun(91);
  const edge = await insertRun(89); // inside the horizon by a day
  const fresh = await insertRun(0);

  const r = await runScheduledTriggerRunPruneTick();

  expect(r.outcome).toBe('ok');
  expect(r.deleted).toBe(2);

  const left = await survivingIds();
  // The survivors are asserted BY ID, not by count: a reaper that deleted the
  // wrong two rows would still leave "2".
  expect(left.sort()).toEqual([edge, fresh].sort());
  expect(left).not.toContain(old1);
  expect(left).not.toContain(old2);
});

itDb('is idempotent — a second tick over the same table deletes nothing', async () => {
  await insertRun(120);
  await insertRun(1);

  const first = await runScheduledTriggerRunPruneTick();
  expect(first.deleted).toBe(1);

  const second = await runScheduledTriggerRunPruneTick();
  expect(second.deleted).toBe(0);
  expect(second.outcome).toBe('ok');
  expect(await survivingIds()).toHaveLength(1);
});

itDb('the horizon is honoured — a 1-day retention reaps what a 90-day one keeps', async () => {
  const twoDays = await insertRun(2);
  const today = await insertRun(0);

  // Same table, same rows, only the horizon differs. This is what proves the
  // interval is actually bound into the statement rather than ignored.
  const wide = await runScheduledTriggerRunPruneTick();
  expect(wide.deleted).toBe(0);
  expect(await survivingIds()).toHaveLength(2);

  process.env[RETENTION_ENV] = '1';
  const narrow = await runScheduledTriggerRunPruneTick();
  expect(narrow.retentionDays).toBe(1);
  expect(narrow.deleted).toBe(1);
  expect(await survivingIds()).toEqual([today]);
  expect(await survivingIds()).not.toContain(twoDays);
});

itDb('a batch is BOUNDED (the drain is not one unbounded statement)', async () => {
  // 1001 doomed rows: one more than a batch. The tick must take two batches.
  await sql`
    INSERT INTO scheduled_trigger_runs
      (trigger_kind, trigger_id, tenant_id, project_id, status, fired_at, created_at)
    SELECT 'scheduled_intake', gen_random_uuid(), ${TENANT}, ${projectId}::uuid, 'error',
           now() - make_interval(days => 100), now() - make_interval(days => 100)
      FROM generate_series(1, 1001)
  `;

  const r = await runScheduledTriggerRunPruneTick();
  expect(r.acquiredLock).toBe(true);
  expect(r.outcome).toBe('ok');
  expect(r.batches).toBe(2);
  expect(r.deleted).toBe(1001);
  expect(r.more).toBe(false);
  expect(await survivingIds()).toHaveLength(0);
});

itDb('a non-positive or garbage retention override CANNOT empty the table', async () => {
  // The dangerous shape: `0` reaching the interval means "older than now()",
  // i.e. delete the entire audit log. Each of these must fall back to the
  // 90-day default rather than be honoured.
  const fresh = await insertRun(0);
  for (const raw of ['0', '-1', 'abc', '', '1.5']) {
    process.env[RETENTION_ENV] = raw;
    const r = await runScheduledTriggerRunPruneTick();
    expect(r.retentionDays).toBe(90);
    expect(r.deleted).toBe(0);
  }
  expect(await survivingIds()).toEqual([fresh]);

  // …and a legitimate override IS honoured, so the guard is not just "always default".
  process.env[RETENTION_ENV] = '30';
  expect((await runScheduledTriggerRunPruneTick()).retentionDays).toBe(30);
});

itDb("NEVER deletes a trigger's last 'ok' run, however old — the health signal depends on it", async () => {
  // scheduled-trigger-health.ts computes last_ok_age_seconds from
  // `max(fired_at) WHERE status='ok'`, falling back to the TRIGGER's created_at.
  // Reap that row and "succeeded once, long ago" becomes indistinguishable from
  // "never succeeded", and consecutive_failures is recounted from -infinity.
  // A REAL trigger row — the exemption is conditional on the trigger existing.
  const triggerId = await insertTrigger('exempt-live');
  const oldOk = await insertRun(300, { status: 'ok', triggerId });
  const olderOk = await insertRun(400, { status: 'ok', triggerId });
  const oldFail = await insertRun(320, { status: 'error', triggerId });

  const r = await runScheduledTriggerRunPruneTick();

  const left = await survivingIds();
  // The most recent 'ok' survives despite being 300 days old...
  expect(left).toContain(oldOk);
  // ...while the SUPERSEDED older 'ok' and the failure are still reaped, so the
  // exemption is exactly one row per trigger and not "keep all ok rows".
  expect(left).not.toContain(olderOk);
  expect(left).not.toContain(oldFail);
  expect(r.deleted).toBe(2);
});

itDb("the last-'ok' exemption is PER TRIGGER, not one row globally", async () => {
  const t1 = await insertTrigger('exempt-per-trigger-1');
  const t2 = await insertTrigger('exempt-per-trigger-2');
  const ok1 = await insertRun(200, { status: 'ok', triggerId: t1 });
  const ok2 = await insertRun(200, { status: 'ok', triggerId: t2 });

  await runScheduledTriggerRunPruneTick();

  const left = await survivingIds();
  expect(left.sort()).toEqual([ok1, ok2].sort());
});

itDb("an ORPHANED run is NOT exempt — a deleted trigger has no health signal to protect", async () => {
  // THE LEAK THIS CLOSES. There is no FK from scheduled_trigger_runs.trigger_id, so
  // deleting a trigger orphans its runs. Exempting an orphan's newest 'ok' pins that
  // row FOREVER while protecting nothing: scheduled-trigger-health.ts reads FROM
  // scheduled_triggers, and a deleted trigger contributes no row.
  // Measured on prod 2026-08-05 after the reaper's first live tick: 32 rows past the
  // horizon, 4 exempt, and ALL 4 orphaned — every surviving exemption was a leak.
  const orphanOk = await insertRun(300, { status: 'ok' }); // bare uuid => no trigger row
  const liveTrigger = await insertTrigger('orphan-control-live');
  const liveOk = await insertRun(300, { status: 'ok', triggerId: liveTrigger });

  const r = await runScheduledTriggerRunPruneTick();

  const left = await survivingIds();
  expect(left).not.toContain(orphanOk); // the leak is gone
  expect(left).toContain(liveOk); // ...and the real exemption still holds
  expect(r.deleted).toBe(1);
});

itDb("deleting a trigger makes its previously-exempt 'ok' run prunable", async () => {
  // The end-to-end shape: a live trigger's last 'ok' survives a tick; delete the
  // trigger and the SAME row is reaped on the next tick. Without the EXISTS clause
  // that row would outlive the trigger permanently.
  const triggerId = await insertTrigger('to-be-deleted');
  const ok = await insertRun(300, { status: 'ok', triggerId });

  const before = await runScheduledTriggerRunPruneTick();
  expect(before.deleted).toBe(0);
  expect(await survivingIds()).toEqual([ok]);

  await sql`DELETE FROM scheduled_triggers WHERE id = ${triggerId}::uuid`;

  const after = await runScheduledTriggerRunPruneTick();
  expect(after.deleted).toBe(1);
  expect(await survivingIds()).toEqual([]);
});

itDb('the supporting index exists (else every tick seq-scans forever)', async () => {
  const rows = await sql<{ indexname: string }[]>`
    SELECT indexname FROM pg_indexes
    WHERE tablename = 'scheduled_trigger_runs'
      AND indexname = 'scheduled_trigger_runs_created_at_idx'
  `;
  expect(rows).toHaveLength(1);
});
