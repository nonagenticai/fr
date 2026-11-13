// tests/integration/routes/andon-kata-cord.integration.test.ts
//
// The kata's hold on the conveyor n8n instance (George 2026-11-03) — routes/andon.ts
// joinKataCordWith / leaveKataCordWith (what services/katas drives) and the operator's cord,
// against a REAL Postgres. The instance cord is a HOLDER SET: the operator
// (`andon_state.engaged`) and every kata (`andon_state.kata_holders`). The worker goes to 0 on
// every hold and back to 1 only when NOBODY holds.
//
// No collaborator is faked. The k8s scale is genuinely attempted and genuinely FAILS here (no
// mounted ServiceAccount on a dev box, a 403 on ARC), so an attempt is visible as its recorded
// error — "k8s scale to 0 failed" / "k8s scale to 1 failed" — and a NON-attempt as an unchanged
// `worker_scaled_at`. That is what these cases pin: which decisions scale and which do not.
//
// A holder is a real kata: a kata-tenant project + its `katas` row in `running`
// (insertRunningKata joins the cord in the same transaction), because the operator's release
// prunes every holder with no running/qa kata row.
//
// ⚠️ andon_state is a singleton other suites read: every case leaves it released and empty.

import { afterAll, beforeAll, beforeEach, describe, expect } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db, queryClient as sql } from '../../../src/db/client';
import { andonState, katas, projects } from '../../../src/db/schema';
import { KATA_TENANT_ID } from '../../../src/middleware/internal-tenant-only';
import { engageGlobalCord, joinKataCordWith, leaveKataCordWith, releaseGlobalCord } from '../../../src/routes/andon';
import { insertRunningKata } from '../../../src/services/katas/core';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('andon-kata-cord');

const OPERATOR = 'ops@andon.test';
const OWNER = '00000000-0000-4000-8000-0000000000a1';
const CUSTOMER = '00000000-0000-0000-0000-0000000000c1';

const ids: string[] = [];
let source = '';
let kata = '';
let kata2 = '';
let orphan = '';

async function project(name: string, tenant: string): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name, repository_url: 'https://example.com/repo', shape: 'continuous_flow', project_data: { keycloak_tenant_id: tenant } })
    .returning({ id: projects.id });
  ids.push(row!.id);
  return row!.id;
}

async function cord() {
  const [r] = await db.select().from(andonState).where(eq(andonState.id, 1)).limit(1);
  return r!;
}

async function resetCord(): Promise<void> {
  await sql`INSERT INTO andon_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE andon_state
               SET engaged = false, engaged_at = NULL, engaged_by = NULL, kata_holders = '{}',
                   worker_replicas = NULL, worker_scaled_at = NULL, worker_scale_error = NULL
             WHERE id = 1`;
}

/** Make `id` a running kata (row inserted on first call) and a holder; returns the join outcome. */
const rowsMade = new Set<string>();
async function hold(id: string) {
  if (!rowsMade.has(id)) {
    rowsMade.add(id);
    return insertRunningKata({
      id,
      source_project_id: source,
      source_tenant_id: CUSTOMER,
      symptom: 'andon-kata-cord fixture',
      opened_by: 'coach',
      signature: `andon-kata-cord:${id}`,
    });
  }
  return joinKataCordWith(id, async () => undefined);
}
const leave = (id: string) => leaveKataCordWith(id, async () => undefined);

/** Real clock (fake timers are banned): make a later write's timestamp strictly later. */
const tick = () => new Promise((r) => setTimeout(r, 5));

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
  source = await project('cord-source', CUSTOMER);
  kata = await project('cord-kata', KATA_TENANT_ID);
  kata2 = await project('cord-kata-2', KATA_TENANT_ID);
  orphan = await project('cord-orphan', KATA_TENANT_ID);
});

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
  // One row at a time: katas carries migration 142's bulk-delete guard.
  for (const id of rowsMade) await db.delete(katas).where(eq(katas.id, id));
  if (ids.length > 0) await db.delete(projects).where(inArray(projects.id, ids));
});

describe('a kata holds the conveyor n8n instance', () => {
  itDb('a join commits the holder and then scales the worker to 0', async () => {
    const res = await hold(kata);
    expect(res.holders).toEqual([kata]);
    const row = await cord();
    expect(row.kata_holders.map(String)).toEqual([kata]);
    // The scale-to-0 was attempted after the commit and its outcome recorded (it fails here).
    expect(row.worker_scaled_at).not.toBeNull();
    expect(row.worker_scale_error).toContain('scale to 0');
    expect(res.worker_scale_error).toBe(row.worker_scale_error);
    expect(res.worker_replicas).toBe(row.worker_replicas);
    // A kata never touches the operator's flag.
    expect(row.engaged).toBe(false);
  });

  itDb('the last kata release with the operator released scales the worker back to 1', async () => {
    await hold(kata);
    const before = await cord();
    await tick();
    const res = await leave(kata);
    expect(res).toMatchObject({ released: true, holders: [] });
    const row = await cord();
    expect(row.worker_scaled_at!.getTime()).toBeGreaterThan(before.worker_scaled_at!.getTime());
    expect(row.worker_scale_error).toContain('scale to 1');
    expect(res.worker_scale_error).toBe(row.worker_scale_error);
    // `worker_scaled_up` is the scale-up having landed — never claimed while it failed.
    expect(res.worker_scaled_up).toBe(res.worker_scale_error === null);
  });

  itDb('a kata release while the operator holds does NOT scale up, and leaves the operator engaged', async () => {
    await hold(kata);
    await engageGlobalCord(OPERATOR);
    const before = await cord();
    await tick();
    const res = await leave(kata);
    expect(res).toMatchObject({ released: true, holders: [], worker_scaled_up: false, worker_scale_error: null });
    const row = await cord();
    expect(row.engaged).toBe(true);
    expect(row.engaged_by).toBe(OPERATOR);
    expect(row.worker_scaled_at!.getTime()).toBe(before.worker_scaled_at!.getTime());
    expect(row.worker_scale_error).toContain('scale to 0');
  });

  itDb('the first of two katas to release does not scale up; the second does', async () => {
    await hold(kata);
    await hold(kata2);
    const before = await cord();
    await tick();
    const first = await leave(kata);
    expect(first).toMatchObject({ released: true, holders: [kata2], worker_scaled_up: false, worker_scale_error: null });
    expect((await cord()).worker_scaled_at!.getTime()).toBe(before.worker_scaled_at!.getTime());
    const second = await leave(kata2);
    expect(second).toMatchObject({ released: true, holders: [] });
    expect((await cord()).worker_scale_error).toContain('scale to 1');
  });

  itDb("a kata cannot release another kata's hold", async () => {
    await hold(kata);
    const before = await cord();
    await tick();
    const res = await leave(kata2);
    expect(res).toMatchObject({ released: false, holders: [kata], worker_scaled_up: false, worker_scale_error: null });
    const row = await cord();
    expect(row.kata_holders.map(String)).toEqual([kata]);
    expect(row.worker_scaled_at!.getTime()).toBe(before.worker_scaled_at!.getTime());
  });

  itDb('a join whose body throws commits nothing and scales nothing', async () => {
    await expect(
      joinKataCordWith(kata, async () => {
        throw new Error('body failed');
      }),
    ).rejects.toThrow('body failed');
    const row = await cord();
    expect(row.kata_holders).toEqual([]);
    expect(row.worker_scaled_at).toBeNull();
  });
});

describe('every instance-cord decision is serialised (withInstanceCordLock)', () => {
  itDb('a kata join WAITS while another decision holds the instance-cord lock', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // Another pod's decision, mid-flight: the same transaction-scoped advisory lock.
    const holder = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext('fr.andon.instance-cord'))`;
      locked();
      await gate;
    });
    await isLocked;
    let done = false;
    const join = hold(kata).then((r) => {
      done = true;
      return r;
    });
    // Real clock: long enough for an unserialised join to have written its row.
    await new Promise((r) => setTimeout(r, 400));
    expect(done).toBe(false);
    expect((await cord()).kata_holders).toEqual([]);
    release();
    await holder;
    expect((await join).holders).toEqual([kata]);
    expect((await cord()).kata_holders.map(String)).toEqual([kata]);
  });

  itDb('a concurrent last-leave and join always end on the join’s scale-to-0', async () => {
    for (let i = 0; i < 5; i++) {
      await resetCord();
      await hold(kata);
      await Promise.all([leave(kata), hold(kata2)]);
      const row = await cord();
      expect(row.kata_holders.map(String)).toEqual([kata2]);
      // Serialised, the last recorded attempt is the join's 0 whichever ran first; a leave that
      // decided "nobody holds" before the join and scaled after it would leave "scale to 1" here.
      expect(row.worker_scale_error).toContain('scale to 0');
    }
  });
});

describe("the operator's release while a kata holds", () => {
  itDb('clears the flag but does NOT scale up: released_kata_holds, with the holders', async () => {
    await engageGlobalCord(OPERATOR);
    await hold(kata);
    const before = await cord();
    await tick();
    const res = await releaseGlobalCord(OPERATOR);
    expect(res.release_status).toBe('released_kata_holds');
    expect(res.kata_holders).toEqual([kata]);
    expect(res.engaged).toBe(false);
    expect(res.worker_scale_error).toBeNull();
    const row = await cord();
    expect(row.engaged).toBe(false);
    // The operator's release never empties the kata set, and no scale-up was attempted.
    expect(row.kata_holders.map(String)).toEqual([kata]);
    expect(row.worker_scaled_at!.getTime()).toBe(before.worker_scaled_at!.getTime());
    expect(row.worker_scale_error).toContain('scale to 0');

    // …and the kata's own release then brings the worker back.
    await tick();
    const last = await leave(kata);
    expect(last).toMatchObject({ released: true, holders: [] });
    expect((await cord()).worker_scale_error).toContain('scale to 1');
  });

  itDb('with no kata holding, the release attempts the scale-up as before', async () => {
    await engageGlobalCord(OPERATOR);
    const res = await releaseGlobalCord(OPERATOR);
    expect(['released', 'released_incomplete']).toContain(res.release_status);
    expect(res.kata_holders).toEqual([]);
    // The scale-up was attempted: its outcome replaced the pull's.
    const row = await cord();
    expect(row.worker_scale_error).toBe(res.worker_scale_error);
    if (res.worker_scale_error !== null) expect(res.worker_scale_error).toContain('scale to 1');
    expect(res.release_status === 'released').toBe(res.worker_scale_error === null);
  });

  itDb('prunes an orphan holder (no running/qa kata row) and keeps a live kata holding', async () => {
    await hold(kata);
    // An orphan: a holder id with no katas row (the dead engage route could add one).
    await sql`UPDATE andon_state SET kata_holders = array_append(kata_holders, ${orphan}::uuid) WHERE id = 1`;
    await engageGlobalCord(OPERATOR);
    const before = await cord();
    await tick();
    const warned: string[] = [];
    const orig = console.warn;
    console.warn = (...a: unknown[]) => void warned.push(a.map(String).join(' '));
    let res;
    try {
      res = await releaseGlobalCord(OPERATOR);
    } finally {
      console.warn = orig;
    }
    expect(warned.some((l) => l.includes(`removed orphan kata holder ${orphan}`))).toBe(true);
    expect(res.release_status).toBe('released_kata_holds');
    expect(res.kata_holders).toEqual([kata]);
    const row = await cord();
    expect(row.kata_holders.map(String)).toEqual([kata]);
    // A live kata still holds: no scale-up attempted.
    expect(row.worker_scaled_at!.getTime()).toBe(before.worker_scaled_at!.getTime());
  });

  itDb('with ONLY orphan holders, the release prunes them and attempts the scale-up', async () => {
    await sql`UPDATE andon_state SET kata_holders = ARRAY[${orphan}::uuid] WHERE id = 1`;
    await engageGlobalCord(OPERATOR);
    const res = await releaseGlobalCord(OPERATOR);
    expect(['released', 'released_incomplete']).toContain(res.release_status);
    expect(res.kata_holders).toEqual([]);
    expect((await cord()).kata_holders).toEqual([]);
    if (res.worker_scale_error !== null) expect(res.worker_scale_error).toContain('scale to 1');
  });

  itDb('a kata in qa is live, not an orphan', async () => {
    await hold(kata2);
    await db.update(katas).set({ state: 'qa' }).where(eq(katas.id, kata2));
    try {
      const res = await releaseGlobalCord(OPERATOR);
      expect(res.kata_holders).toEqual([kata2]);
    } finally {
      await db.update(katas).set({ state: 'running' }).where(eq(katas.id, kata2));
    }
  });

  itDb("the operator's pull is unaffected by kata holders", async () => {
    await hold(kata);
    const res = await engageGlobalCord(OPERATOR);
    expect(res.engaged).toBe(true);
    expect(res.already_engaged).toBeUndefined();
    const row = await cord();
    expect(row.engaged_by).toBe(OPERATOR);
    expect(row.kata_holders.map(String)).toEqual([kata]);
  });
});
