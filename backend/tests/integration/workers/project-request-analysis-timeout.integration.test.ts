// tests/integration/workers/project-request-analysis-timeout.integration.test.ts
//
// A request stranded in `analysing` (the agent's outline callback never came)
// must become `failed` + `analysis_timeout` after the TTL, with a history
// entry — and nothing else may move: a fresh `analysing` row, and an old row in
// any other state, stay exactly as they were.

import { afterEach, expect } from 'bun:test';
import { eq } from 'drizzle-orm';

import { db, projectRequests } from '../../../src/db/client';
import {
  ANALYSIS_TIMEOUT_ERROR,
  runProjectRequestAnalysisTimeoutTick,
} from '../../../src/workers/project-request-analysis-timeout';
import { eventSources } from '../../../src/routes/project-request-lifecycle';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '22222222-2222-2222-2222-222222222222';
const { itDb } = createDbSuite('project-request-analysis-timeout');

// The tick reads PROJECT_REQUEST_ANALYSIS_TTL_MS per call and uses the real clock.
const TTL = 2 * 60 * 60 * 1000;
process.env.PROJECT_REQUEST_ANALYSIS_TTL_MS = String(TTL);
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000);

async function seed(ref: string, status: string, updatedAt: Date): Promise<string> {
  const [row] = await db
    .insert(projectRequests)
    .values({
      tenant_id: TENANT,
      source: 'fr',
      external_ref: ref,
      payload: {},
      status,
      history: [],
      created_at: updatedAt,
      updated_at: updatedAt,
    } as typeof projectRequests.$inferInsert)
    .returning({ id: projectRequests.id });
  return row!.id;
}

async function load(id: string) {
  const [row] = await db.select().from(projectRequests).where(eq(projectRequests.id, id));
  return row!;
}

afterEach(async () => {
  await db.delete(projectRequests).where(eq(projectRequests.tenant_id, TENANT));
});

itDb('fails a stale analysing request and leaves every other row alone', async () => {
  const stale = await seed('stale', 'analysing', hoursAgo(3));
  const fresh = await seed('fresh', 'analysing', hoursAgo(1));
  const staleButProposed = await seed('proposed', 'outline_proposed', hoursAgo(5));

  const r = await runProjectRequestAnalysisTimeoutTick();
  expect(r.outcome).toBe('ok');
  expect(r.timedOut).toContain(stale);
  expect(r.timedOut).not.toContain(fresh);
  expect(r.timedOut).not.toContain(staleButProposed);

  const s = await load(stale);
  expect(s.status).toBe('failed');
  expect(s.error).toBe(ANALYSIS_TIMEOUT_ERROR);
  const hist = s.history as Array<{ action: string; from_status?: string }>;
  expect(hist.at(-1)?.action).toBe('analysis_timed_out');
  expect(hist.at(-1)?.from_status).toBe('analysing');

  expect((await load(fresh)).status).toBe('analysing');
  expect((await load(staleButProposed)).status).toBe('outline_proposed');
});

itDb('a second tick is a no-op — each row times out exactly once', async () => {
  const stale = await seed('once', 'analysing', hoursAgo(3));
  await runProjectRequestAnalysisTimeoutTick();
  const again = await runProjectRequestAnalysisTimeoutTick();
  expect(again.timedOut).not.toContain(stale);
  expect(((await load(stale)).history as unknown[]).length).toBe(1);
});

itDb('a timed-out request can be re-submitted', async () => {
  expect(eventSources('submit')).toContain('failed');
});
