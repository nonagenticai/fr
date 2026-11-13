// tests/unit/workers/project-delivered-reconcile.test.ts
//
// `runProjectDeliveredReconcileTick` against the real CI postgres. The worker
// had ZERO tests: nothing exercised selection, the batch bound, per-project
// failure isolation or the rotation, so the original head-of-line starvation
// (`ORDER BY updated_at LIMIT 25` re-picking the same 25 rows forever, never
// examining project 26) shipped with a green suite.
//
// The test rows use the FIVE SMALLEST uuids so that `ORDER BY id` puts them
// first: other suites run concurrently against this database and may own live
// projects, and this file must never depend on their absence.
//
// The RM state source is a REQUIRED argument of the tick (`loadStates`); its
// ONE production caller passes the real `projectStatesFor`. Supplying it here is
// ordinary dependency injection, not a test-only hook: the state of a project is
// the domain value `ProjectStateOrError`, not a replaced RM transport, and CI
// has no RM to read.
//
// ⛔ Assertions about WHICH projects a tick examined are scoped to THIS file's
// own ids. The tick correctly sweeps EVERY live project, and other suites leave
// live rows behind in this shared database (owners 4444/8888/a1100099) — an
// unscoped set-equality assertion fails on THEIR ids, not on the rotation.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { asc, eq } from 'drizzle-orm';

import { db } from '../../../src/db/client';
import { projects } from '../../../src/db/schema';
import { projectIsLive } from '../../../src/lib/project-live-status';
import type { ProjectStateOrError } from '../../../src/services/catalogue/project-state';
import { runProjectDeliveredReconcileTick } from '../../../src/workers/project-delivered-reconcile';

const OWNER = '66666666-6666-4666-8666-666666666666';
/** Prefix of this file's rows — the smallest uuids, so they lead `ORDER BY id`. */
const ID = (suffix: string) => `00000000-0000-4000-8000-0000000000${suffix}`;

function rm(status: string | null): ProjectStateOrError {
  return {
    ok: true,
    state: {
      projectId: 'x',
      tenantId: OWNER,
      rmPmProjectId: 'rm-1',
      projectTypeId: null,
      projectType: 'it',
      phase: 'execution',
      phaseId: null,
      phaseUpdatedAt: null,
      priority: null,
      pm: { status, updated_at: '2026-10-31T09:00:00Z' } as never,
    },
  };
}

const UNREADABLE: ProjectStateOrError = { ok: false, code: 'RM_UNREACHABLE', message: 'unreachable' };

/** A state source answering only for this file's rows; the rest stay unexamined. */
function statesFrom(plan: Map<string, ProjectStateOrError>) {
  return async (rows: readonly { id: string }[]) =>
    new Map(rows.flatMap((r) => (plan.has(r.id) ? [[r.id, plan.get(r.id)!] as const] : [])));
}

async function seed(ids: readonly string[]): Promise<void> {
  await db.insert(projects).values(
    ids.map((id) => ({ id, owner_id: OWNER, name: `reconcile-${id.slice(-2)}`, status: 'active' })),
  );
}

async function load(id: string) {
  const [r] = await db.select().from(projects).where(eq(projects.id, id));
  return r!;
}

const savedBatch = process.env.PROJECT_DELIVERED_RECONCILE_BATCH_SIZE;

function setBatch(n: number | undefined): void {
  if (n === undefined) delete process.env.PROJECT_DELIVERED_RECONCILE_BATCH_SIZE;
  else process.env.PROJECT_DELIVERED_RECONCILE_BATCH_SIZE = String(n);
}

/**
 * Drive the rotation to a full sweep's END, which is where the cursor wraps
 * (`rows.length < batch` ⇒ the next tick starts at the first page again). A
 * batch above any plausible live population makes that one tick; the loop only
 * matters if foreign suites grew the table past it.
 */
async function resetRotation(): Promise<void> {
  setBatch(200);
  for (let i = 0; i < 10; i++) {
    const r = await runProjectDeliveredReconcileTick(async () => new Map());
    if (r.checkedIds.length < 200) return;
  }
  throw new Error('could not wrap the reconcile cursor: the live population exceeds 2000 rows');
}

async function otherLiveIds(mine: readonly string[]): Promise<string[]> {
  const rows = await db.select({ id: projects.id }).from(projects).where(projectIsLive()).orderBy(asc(projects.id));
  return rows.map((r) => r.id).filter((id) => !mine.includes(id));
}

beforeEach(async () => {
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
});

afterEach(async () => {
  await db.delete(projects).where(eq(projects.owner_id, OWNER));
  setBatch(savedBatch === undefined ? undefined : Number(savedBatch));
});

describe('selection — a bounded page, and only the RM-closed projects are stamped', () => {
  test('a tick stamps the closed project, leaves an open one alone and survives a failed lookup', async () => {
    // Order matters: the UNREADABLE project sorts FIRST, so a tick that
    // aborted on the first failed RM lookup would never reach the closed one.
    const failing = ID('01');
    const open = ID('02');
    const closed = ID('03');
    await seed([failing, open, closed]);
    await resetRotation();
    setBatch(10);

    const plan = new Map<string, ProjectStateOrError>([
      [failing, UNREADABLE],
      [open, rm('active')],
      [closed, rm('closed')],
    ]);
    const r = await runProjectDeliveredReconcileTick(statesFrom(plan));

    expect(r.outcome).toBe('ok');
    expect(r.stamped).toEqual([closed]);
    expect(r.checkedIds).toContain(failing);
    expect(r.checkedIds).toContain(open);
    expect(r.checkedIds).toContain(closed);
    expect(r.checked).toBe(r.checkedIds.length);

    // ⛔ ISOLATION: the failed lookup did not abort the tick — the closed
    // project AFTER it in the page was still stamped.
    expect((await load(closed)).status).toBe('delivered');
    expect((await load(open)).status).toBe('active');
    expect((await load(failing)).status).toBe('active');
  });

  test('an oversized page never exceeds the batch, and the page is the rotation head', async () => {
    const mine = [ID('11'), ID('12'), ID('13'), ID('14')];
    await seed(mine);
    await resetRotation();
    setBatch(2);

    const r = await runProjectDeliveredReconcileTick(statesFrom(new Map()));

    expect(r.checkedIds).toEqual([mine[0]!, mine[1]!]);
    expect(r.checkedIds.length).toBeLessThanOrEqual(2);
  });
});

describe('the rotating cursor reaches every live project and wraps', () => {
  test('three ticks over five rows in batches of two visit all five', async () => {
    const mine = [ID('21'), ID('22'), ID('23'), ID('24'), ID('25')];
    await seed(mine);
    await resetRotation();
    setBatch(2);

    const seen: string[] = [];
    const pages: string[][] = [];
    for (let i = 0; i < 3; i++) {
      const r = await runProjectDeliveredReconcileTick(statesFrom(new Map()));
      expect(r.checkedIds.length).toBeLessThanOrEqual(2);
      pages.push(r.checkedIds);
      seen.push(...r.checkedIds);
    }

    // ⛔ THE STARVATION REGRESSION: the old selection re-read the same two
    // oldest rows every tick, so the newer three were never examined. Scoped to
    // THIS file's ids — the page also contains foreign live rows (see the
    // header); "at least one" would prove nothing, the WHOLE of `mine` must be
    // reached.
    const seenMine = seen.filter((id) => mine.includes(id));
    expect(new Set(seenMine)).toEqual(new Set(mine));
    expect(pages[0]).not.toEqual(pages[1]);
  });

  test('once the end of the ordered set is reached, the next tick serves the first page again', async () => {
    const mine = [ID('31'), ID('32'), ID('33'), ID('34'), ID('35')];
    await seed(mine);
    await resetRotation();
    setBatch(2);

    // Walk the whole ordered set (our five lead it) and keep ticking until the
    // smallest id comes round again. Bounded by the live population, so a few
    // foreign rows only lengthen the walk.
    const live = (await otherLiveIds(mine)).length + mine.length;
    const maxTicks = Math.ceil(live / 2) + 4;
    // Collect from EVERY tick, INCLUDING the wrapping one: our first page comes
    // round again on that tick, and omitting it is how the two leading ids went
    // missing when only the post-wrap ticks were collected.
    const seen: string[] = [];
    let wrapped = false;
    for (let i = 0; i < maxTicks; i++) {
      const r = await runProjectDeliveredReconcileTick(statesFrom(new Map()));
      seen.push(...r.checkedIds);
      if (i > 0 && r.checkedIds[0] === mine[0]) {
        wrapped = true;
        break;
      }
    }
    expect(wrapped).toBe(true);

    // The rotation never skips: every one of our rows was seen on the way (the
    // walk starts at the head of the ordered set, and ours are the smallest
    // ids). Collect the post-wrap ticks too, then scope to THIS file's ids —
    // foreign live rows are expected in the page (see the header).
    for (let i = 0; i < maxTicks && !mine.every((id) => seen.includes(id)); i++) {
      const r = await runProjectDeliveredReconcileTick(statesFrom(new Map()));
      seen.push(...r.checkedIds);
    }
    const seenMine = seen.filter((id) => mine.includes(id));
    expect(new Set(seenMine)).toEqual(new Set(mine));
  });
});
