// tests/integration/domain/engagement/action-approvals-reaper.integration.test.ts
//
// Phase 2.E sub-batch 2.A — converted from
// tests/unit/domain/engagement/action-approvals-reaper.test.ts.
//
// The unit version stubbed `mock.module('db/client', ...)` with a
// hand-rolled `db.select().from().where()` fake whose return values were
// mutated per-test, and asserted on a `updates[]` array captured by a
// likewise hand-rolled `db.update().set().where()` stub. That only proved
// the stub captured the values it was handed — the SELECT WHERE clause
// (drizzle's `and(eq(status,'executing'), lt(updated_at, cutoff))`) and
// the conditional UPDATE were never exercised.
//
// This integration version uses real Postgres, real drizzle SQL, and
// asserts on actual row state in the `approvals` table.
//
// Skip-if-unreachable mirrors idempotency.integration.
//
// Behaviour preserved from the unit test:
//   1. Rows older than STALE_EXECUTING_THRESHOLD_MS flip from executing → failed
//   2. Rows younger than the threshold are left alone
//   3. STALE_EXECUTING_THRESHOLD_MS is exactly 5 minutes
//
// Behaviour added by integration coverage (not in the unit version):
//   - The `error_message` set on reaped rows is the real column write,
//     not a stub-captured object.
//   - The reaper only touches `executing` rows — `pending`/`approved`
//     rows beyond the cutoff are left untouched (the unit test couldn't
//     exercise this because the WHERE clause was a no-op stub).

import {
  test,
  expect,
  describe,
  beforeAll,
  beforeEach,
} from 'bun:test';
import { sql as drizzleSql, eq } from 'drizzle-orm';
import { db, queryClient, approvals } from '../../../../src/db/client';
import {
  reapStaleExecutingActions,
  STALE_EXECUTING_THRESHOLD_MS,
} from '../../../../src/domain/engagement/action-approvals';

import { createDbSuite } from '../../helpers/db-suite';

const sql = queryClient;

// Pinned UUIDs — keeps cleanup bounded to this file's owned data.
const TENANT_ID = '00000000-0000-4000-8000-000000bbbb01';
const REQUESTER_ID = '00000000-0000-4000-8000-000000bbbb02';

// Action ids on the rows we insert. Each test seeds its own subset; the
// before-each delete is bounded to this set so we never stomp other suites.
const ACTION_ID_STALE_EXECUTING = '00000000-0000-4000-8000-000000bbbb11';
const ACTION_ID_FRESH_EXECUTING = '00000000-0000-4000-8000-000000bbbb12';
const ACTION_ID_STALE_PENDING = '00000000-0000-4000-8000-000000bbbb13';
const ACTION_ID_STALE_APPROVED = '00000000-0000-4000-8000-000000bbbb14';

const ALL_ACTION_IDS = [
  ACTION_ID_STALE_EXECUTING,
  ACTION_ID_FRESH_EXECUTING,
  ACTION_ID_STALE_PENDING,
  ACTION_ID_STALE_APPROVED,
];

let reachable = false;

beforeAll(async () => {
  try {
    await sql`SELECT 1 FROM approvals LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[action-approvals-reaper.integration] DB not reachable, skipping. — ' +
        (err instanceof Error ? err.message : String(err)),
    );
  }
});

beforeEach(async () => {
  if (!reachable) return;
  for (const aid of ALL_ACTION_IDS) {
    await db.execute(
      drizzleSql`DELETE FROM approvals WHERE action_id = ${aid}`,
    );
  }
});

const { itDb } = createDbSuite('action-approvals-reaper');

interface SeedRow {
  action_id: string;
  status: string;
  /** Offset (ms) to subtract from now() when stamping updated_at.
   *  Positive value → updated_at is that many ms in the past. */
  ageMs: number;
  action_name: string;
}

async function seed(rows: SeedRow[]): Promise<void> {
  for (const r of rows) {
    const stamp = new Date(Date.now() - r.ageMs);
    await db.insert(approvals).values({
      tenant_id: TENANT_ID,
      requester_id: REQUESTER_ID,
      status: r.status,
      description: `reaper integration row (${r.action_name})`,
      expires_at: new Date(Date.now() + 86400000),
      action_id: r.action_id,
      action_name: r.action_name,
      // Override the .defaultNow() so the row lands at the desired age. We
      // can't set updated_at via insertion `values` if the schema didn't
      // expose it — but it does (see schema.ts approvals.updated_at).
      updated_at: stamp,
      created_at: stamp,
    });
  }
}

async function fetchByActionId(aid: string) {
  const [row] = await db
    .select()
    .from(approvals)
    .where(eq(approvals.action_id, aid));
  return row;
}

describe('reapStaleExecutingActions (integration)', () => {
  itDb('flips rows older than threshold from executing to failed', async () => {
    await seed([
      {
        action_id: ACTION_ID_STALE_EXECUTING,
        status: 'executing',
        ageMs: STALE_EXECUTING_THRESHOLD_MS + 60_000,
        action_name: 'stale-executing-action',
      },
    ]);

    await reapStaleExecutingActions();

    const row = await fetchByActionId(ACTION_ID_STALE_EXECUTING);
    expect(row).toBeDefined();
    expect(row!.status).toBe('failed');
    expect(row!.error_message).toContain('process restart');
  });

  itDb('leaves rows younger than threshold alone', async () => {
    await seed([
      {
        action_id: ACTION_ID_FRESH_EXECUTING,
        status: 'executing',
        ageMs: 1000, // 1s old, well under the 5-min threshold
        action_name: 'fresh-executing-action',
      },
    ]);

    await reapStaleExecutingActions();

    const row = await fetchByActionId(ACTION_ID_FRESH_EXECUTING);
    expect(row).toBeDefined();
    expect(row!.status).toBe('executing');
    expect(row!.error_message).toBeNull();
  });

  itDb('does not touch stale rows that are not in executing status', async () => {
    // Coverage gap from the unit version: WHERE filter on status='executing'
    // is now exercised against real SQL.
    await seed([
      {
        action_id: ACTION_ID_STALE_PENDING,
        status: 'pending',
        ageMs: STALE_EXECUTING_THRESHOLD_MS + 60_000,
        action_name: 'stale-pending-action',
      },
      {
        action_id: ACTION_ID_STALE_APPROVED,
        status: 'approved',
        ageMs: STALE_EXECUTING_THRESHOLD_MS + 60_000,
        action_name: 'stale-approved-action',
      },
    ]);

    await reapStaleExecutingActions();

    const pendingRow = await fetchByActionId(ACTION_ID_STALE_PENDING);
    const approvedRow = await fetchByActionId(ACTION_ID_STALE_APPROVED);
    expect(pendingRow!.status).toBe('pending');
    expect(approvedRow!.status).toBe('approved');
    expect(pendingRow!.error_message).toBeNull();
    expect(approvedRow!.error_message).toBeNull();
  });

  test('STALE_EXECUTING_THRESHOLD_MS is 5 minutes', () => {
    // Pure constant assertion — runs even when DB is unreachable.
    expect(STALE_EXECUTING_THRESHOLD_MS).toBe(5 * 60 * 1000);
  });
});
