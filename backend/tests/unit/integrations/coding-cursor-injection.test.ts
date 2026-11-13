// tests/unit/integrations/coding-cursor-injection.test.ts
//
// SQL-injection regression for the coding listJobs cursor. The cursor is a
// client-supplied base64url(JSON) string; `decoded.ts` used to be spliced raw
// into SQL via `sql.raw(...)` inside a `'...'::timestamptz` literal — a
// single-quote breakout (same class as the #390 effective-set.ts SQLi). The fix
// validates the ts as a Date and BINDS it as a query parameter.
//
// The sink is only observable against real SQL (the stub-db unit test in
// coding.test.ts never executes a query), so this is DB-backed + skip-if-
// unreachable, and lives under tests/unit/ so CI's `bun test tests/unit/` gates
// it. Pre-fix the malicious cursor reaches postgres and throws
// `invalid input syntax for type timestamp` → this test goes RED.

import { test, expect, describe, beforeAll, beforeEach, afterEach } from 'bun:test';

import { eq } from 'drizzle-orm';
import { db, queryClient, codingAnalysisRuns } from '../../../src/db/client';
import { listJobs } from '../../../src/integrations/coding/adapter';

const USER_ID = '00000000-0000-0000-0000-0000000000c0';
const OTHER_USER_ID = '00000000-0000-0000-0000-0000000000ff';
const REPO_ID = '00000000-0000-0000-0000-0000000000aa';

const OLD_TS = new Date('2026-01-01T00:00:00.000Z');
const NEW_TS = new Date('2026-06-01T00:00:00.000Z');

function b64(obj: unknown): string {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

let reachable = false;

beforeAll(async () => {
  try {
    await queryClient`SELECT 1 FROM coding_analysis_runs LIMIT 1`;
    reachable = true;
  } catch (err) {
    console.warn(
      '[coding-cursor-injection] postgres unreachable — skipping:',
      (err as Error).message,
    );
  }
});

async function cleanup(): Promise<void> {
  await queryClient`DELETE FROM coding_analysis_runs WHERE user_id IN (${USER_ID}, ${OTHER_USER_ID})`;
}

async function seedTwoRuns(): Promise<void> {
  await db.insert(codingAnalysisRuns).values([
    {
      user_id: USER_ID,
      repo_id: REPO_ID,
      container_name: 'c-old',
      type: 'security',
      status: 'succeeded', // 'completed' is an UPSTREAM status; the DB CHECK only allows queued|running|succeeded|failed|canceled
      correlation_id: 'corr-old',
      client_idempotency_key: 'idem-old',
      created_at: OLD_TS,
    },
    {
      user_id: USER_ID,
      repo_id: REPO_ID,
      container_name: 'c-new',
      type: 'security',
      status: 'succeeded', // 'completed' is an UPSTREAM status; the DB CHECK only allows queued|running|succeeded|failed|canceled
      correlation_id: 'corr-new',
      client_idempotency_key: 'idem-new',
      created_at: NEW_TS,
    },
  ]);
}

beforeEach(async () => {
  if (!reachable) return;
  await cleanup();
  await seedTwoRuns();
});

afterEach(async () => {
  if (!reachable) return;
  await cleanup();
});

function it(name: string, fn: () => Promise<void>): void {
  test(name, async () => {
    if (!reachable) {
      console.warn(`skipping "${name}" — postgres unreachable`);
      return;
    }
    await fn();
  });
}

describe('coding listJobs — cursor SQL-injection regression', () => {
  it('benign cursor paginates correctly (returns only rows older than the cursor ts)', async () => {
    // Cursor at the NEW row's ts → predicate `cursorTs > created_at` keeps only
    // the OLD row. Guards against a semantics regression from the fix.
    const res = await listJobs({ userId: USER_ID, cursor: b64({ ts: NEW_TS.toISOString() }) });
    expect(res.jobs.map((j) => j.correlation_id)).toEqual(['corr-old']);
  });

  it('malicious cursor does NOT throw and does NOT bypass the filter', async () => {
    // `decoded.ts` is a quote-breakout SQLi payload. Pre-fix it was spliced raw
    // → postgres throws `invalid input syntax for type timestamp` (RED). Post-
    // fix the unparseable ts is ignored → first page returned deterministically.
    const payload = "1999-01-01'::timestamptz OR '1'='1";
    const res = await listJobs({ userId: USER_ID, cursor: b64({ ts: payload }) });
    // First page = both seeded rows, newest first. No throw, no injection.
    expect(res.jobs.map((j) => j.correlation_id)).toEqual(['corr-new', 'corr-old']);
  });

  it('a UNION-style injection payload is treated as a literal, not executed', async () => {
    const payload = "x' UNION SELECT user_id::text FROM coding_analysis_runs --";
    const res = await listJobs({ userId: USER_ID, cursor: b64({ ts: payload }) });
    expect(res.jobs.length).toBe(2);
    // Still scoped to this user — the injection cannot widen the result set.
    expect(res.jobs.every((j) => j.correlation_id.startsWith('corr-'))).toBe(true);
  });

  it('garbage (non-JSON / non-base64) cursor falls through to the first page', async () => {
    const res = await listJobs({ userId: USER_ID, cursor: 'not-a-valid-cursor!!!' });
    expect(res.jobs.length).toBe(2);
  });

  it('does not leak another user’s rows', async () => {
    // Sanity: the user scope holds regardless of cursor.
    const res = await listJobs({ userId: OTHER_USER_ID, cursor: b64({ ts: NEW_TS.toISOString() }) });
    const rows = await db
      .select({ id: codingAnalysisRuns.id })
      .from(codingAnalysisRuns)
      .where(eq(codingAnalysisRuns.user_id, USER_ID));
    expect(rows.length).toBe(2); // our seed is intact
    expect(res.jobs.length).toBe(0); // other user sees nothing
  });
});
