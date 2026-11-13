// tests/integration/routes/katas.integration.test.ts
//
// The kata record's state machine (services/katas/core.ts) against a REAL Postgres, and the
// /api/katas caller table (routes/katas.ts) with plain `User` fixtures — the identity validateAuth
// would produce. Nothing is faked: the cord's k8s scale is genuinely attempted and genuinely fails
// here (no ServiceAccount on a dev box), which is visible only as `worker_scale_error`.
//
// The invariant every case pins: the kata's id is in andon_state.kata_holders EXACTLY while its
// state is running or qa — or failed and not yet released by a super-admin (George 2026-11-04: a
// failed kata keeps the cord) — and `cord_held_seconds` accrues on every release.
//
// External steps of an open (RM catalogue, the project create through Planka/RM, the first card)
// are verified live, not here (backend/CLAUDE.md: no test doubles).
//
// ⚠️ andon_state is a singleton other suites read: every case leaves it released and empty.

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { db, queryClient as sql } from '../../../src/db/client';
import { andonState, katas, projectConveyorStartAttempts, projects } from '../../../src/db/schema';
import { drainDetachedWork } from '../../../src/lib/detached-work';
import { linkBoardThenStartConveyor } from '../../../src/services/rm-board-link';
import { LICENCE_ROUTE_ALLOWLIST } from '../../../src/lib/licence-route-allowlist';
import {
  AA_CONVEYOR_TENANT_ID,
  KATA_TENANT_ID,
  V4_CONVEYOR_TENANT_ID,
} from '../../../src/middleware/internal-tenant-only';
import { KATA_ROUTE_CALLERS, LicenceOpenBody, assertKataCaller } from '../../../src/routes/katas';
import { joinSystemKataAndon, pruneOrphanKataHolders } from '../../../src/services/kata-andon';
import { refreshAndonStateInitialisedGauge } from '../../../src/lib/global-andon-gate';
import { renderAndonHaltMetrics } from '../../../src/lib/andon-halt-metrics';
import {
  KATA_CARD_READY_GRACE_MS,
  closeKata,
  conveyorPause,
  failedHolderIds,
  holdingKata,
  kataStatsWindows,
  kataWindowStats,
  listKataRows,
  readKataHolderSet,
  decideOpen,
  decideOpenSelfHealing,
  insertRunningKata,
  markRollbackDelivered,
  patchKata,
  readKata,
  releaseFailedKata,
  requestKataRollback,
  stopKata,
  withSignatureLock,
} from '../../../src/services/katas/core';
import { assertCordMeasuredAtZero, openKataForLicence } from '../../../src/services/katas/open';
import type { User } from '../../../src/types/api';
import { createDbSuite } from '../helpers/db-suite';

const { itDb } = createDbSuite('katas');

const CUSTOMER = '00000000-0000-4000-8000-0000000c0de1';
const OWNER = '00000000-0000-4000-8000-0000000000b1';

const projectIds: string[] = [];
let sourceProject = '';
/** The conveyor licence caller (the identity validateAuth would produce). */
const caller = { id: 'licence-subject', email: '', name: 'coach', roles: [], tenantId: V4_CONVEYOR_TENANT_ID, authKind: 'licence' } as unknown as User;

/** `tenant` null ⇒ an UNTAGGED project (RM can hold no pm_project for it: an archive asks RM nothing). */
async function project(name: string, tenant: string | null): Promise<string> {
  const [row] = await db
    .insert(projects)
    .values({ owner_id: OWNER, name, shape: 'deliverable', status: 'active', project_data: tenant ? { keycloak_tenant_id: tenant } : {} })
    .returning({ id: projects.id });
  projectIds.push(row!.id);
  return row!.id;
}

async function resetCord(): Promise<void> {
  await sql`INSERT INTO andon_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`;
  await sql`UPDATE andon_state
               SET engaged = false, engaged_at = NULL, engaged_by = NULL, kata_holders = '{}',
                   worker_replicas = NULL, worker_scaled_at = NULL, worker_scale_error = NULL
             WHERE id = 1`;
}

async function holders(): Promise<string[]> {
  const [r] = await db.select({ h: andonState.kata_holders }).from(andonState).where(eq(andonState.id, 1)).limit(1);
  return (r?.h ?? []).map(String);
}

let seq = 0;
/** A fresh signature per case: the partial unique index is global. */
const sig = (label: string) => `test-sig:${label}:${Date.now()}:${seq++}`;

/** A kata project + its running row (cord held), with a base version (publishable). */
// The kata project is UNTAGGED here: every kata archive closes the project's RM pm_project first
// (R351) and these tests exercise fr's kata state machine, not RM (which the suite cannot reach).
// The tagged case — RM refusing, so the archive fails closed — is its own test below.
async function runningKata(signature: string, card?: string, extra: { target_flow?: string; tenant?: string } = {}) {
  const { tenant, ...rest } = extra;
  const id = await project(`kata ${signature}`, tenant ?? null);
  const r = await insertRunningKata({
    id,
    source_project_id: sourceProject,
    source_tenant_id: CUSTOMER,
    source_card_id: card ?? null,
    symptom: 'BLOCKED: rewrite_plan.DOING refused the plan',
    opened_by: 'coach',
    signature,
    base_version_id: 'v-base',
    ...rest,
    evidence: { node: 'Check plan', check: 'plan_present' },
  });
  return { id, join: r };
}

beforeAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
  sourceProject = await project('katas-source', CUSTOMER);
});

beforeEach(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
});

afterAll(async () => {
  if (!process.env.DATABASE_URL) return;
  await resetCord();
  for (const id of projectIds) await db.delete(projectConveyorStartAttempts).where(eq(projectConveyorStartAttempts.project_id, id));
  // One row at a time: katas carries migration 142's bulk-delete guard.
  for (const id of projectIds) await db.delete(katas).where(eq(katas.id, id));
  // In chunks under the guard's EMPTIED_MIN (50): this file creates more fixtures than that, and on
  // a fresh database they can be the only projects, so one delete would empty the table.
  for (let i = 0; i < projectIds.length; i += 25) {
    await db.delete(projects).where(inArray(projects.id, projectIds.slice(i, i + 25)));
  }
});

describe('GET /api/katas reads (handleListKatas) through the real driver', () => {
  // Live bug 2026-11-04: kataWindowStats bound a JS Date into a raw `sql` template, which
  // postgres.js cannot serialize, so every list was a 500. No test called it; this runs every
  // read the handler makes, in its order, against the real postgres.
  itDb('list rows, holders, both stat windows, the holding kata and the failed holders', async () => {
    const live = await runningKata(sig('list-live'));
    const failed = await runningKata(sig('list-failed'));
    await patchKata(failed.id, { state: 'failed' });
    await sql`UPDATE katas SET cord_engaged_at = now() - interval '2 minutes' WHERE id = ${failed.id}`;
    const rows = await listKataRows({});
    expect(rows.map((r) => r.id)).toEqual(expect.arrayContaining([live.id, failed.id]));
    const holderSet = await readKataHolderSet();
    const windows = kataStatsWindows();
    const [today, last7d, holding, failedHolders] = await Promise.all([
      kataWindowStats(windows.today),
      kataWindowStats(windows.last7d),
      holdingKata(holderSet),
      failedHolderIds(holderSet),
    ]);
    expect(last7d.opened).toBeGreaterThanOrEqual(2);
    expect(last7d.failed).toBeGreaterThanOrEqual(1);
    expect(last7d.paused_seconds).toBeGreaterThanOrEqual(120);
    expect(today.opened).toBeGreaterThanOrEqual(0);
    expect(holding?.kata_id).toBe(failed.id);
    expect(failedHolders).toEqual([failed.id]);
    // The window bound is applied: a window starting in the future counts nothing.
    expect(await kataWindowStats(new Date(Date.now() + 60 * 60 * 1000))).toMatchObject({ opened: 0, failed: 0, paused_seconds: 0 });
  });
});

describe('open: a kata starts running and holds the cord', () => {
  itDb('insertRunningKata → state running, the id in kata_holders, cord_engaged_at set, the source card linked', async () => {
    const { id, join } = await runningKata(sig('open'), 'card-1');
    expect(join.result.state).toBe('running');
    expect(join.holders).toEqual([id]);
    expect(await holders()).toEqual([id]);
    const row = (await readKata(id))!;
    expect(row.cord_engaged_at).not.toBeNull();
    expect(row.cord_held_seconds).toBe(0);
    expect(row.linked_cards.map((c) => c.card_id)).toEqual(['card-1']);
    // The scale-to-0 was attempted (it fails without a cluster).
    expect(join.worker_scale_error).toContain('scale to 0');
  });

  itDb('a second open kata with the same signature is refused by the index (409 kata_signature_open)', async () => {
    const s = sig('dup-index');
    await runningKata(s);
    const other = await project('kata dup', KATA_TENANT_ID);
    await expect(
      insertRunningKata({ id: other, source_project_id: sourceProject, source_tenant_id: CUSTOMER, symptom: 'x', opened_by: 'coach', signature: s }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'kata_signature_open' });
    // The refused insert rolled back with its hold: only the first kata holds.
    expect((await holders()).includes(other)).toBe(false);
  });
});

describe('the open decision (one open kata per signature; amendment 7)', () => {
  itDb('duplicate signature while running → linked, the card appended once', async () => {
    const s = sig('linked');
    const { id } = await runningKata(s, 'card-a');
    const first = await withSignatureLock(s, (tx) => decideOpen(tx, s, { card_id: 'card-b', board_id: 'b1', phase: 'DOING' }));
    expect(first.action).toBe('linked');
    const again = await withSignatureLock(s, (tx) => decideOpen(tx, s, { card_id: 'card-b' }));
    expect(again.action).toBe('linked');
    const row = (await readKata(id))!;
    expect(row.linked_cards.map((c) => c.card_id)).toEqual(['card-a', 'card-b']);
    expect(row.state).toBe('running');
  });

  itDb('no kata with the signature → open', async () => {
    const s = sig('none');
    expect((await withSignatureLock(s, (tx) => decideOpen(tx, s, null))).action).toBe('open');
  });

  itDb('repeat after published → rollback_requested (once), not a new kata', async () => {
    const s = sig('repeat');
    const { id } = await runningKata(s);
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v2' });
    const d = await withSignatureLock(s, (tx) => decideOpen(tx, s, { card_id: 'card-again' }));
    expect(d.action).toBe('rollback_requested');
    if (d.action !== 'rollback_requested') throw new Error('unreachable');
    expect(d.newlyRequested).toBe(true);
    expect(d.kata.id).toBe(id);
    expect(d.kata.rollback_requested_at).not.toBeNull();
    expect(d.kata.linked_cards.map((c) => c.card_id)).toContain('card-again');
    const d2 = await withSignatureLock(s, (tx) => decideOpen(tx, s, null));
    expect(d2.action === 'rollback_requested' && d2.newlyRequested).toBe(false);
    // No cord was pulled by a repeat.
    expect(await holders()).toEqual([]);
  });

  itDb('a repeat COMMITS the rollback request before posting; a failed post keeps it and the next repeat resends', async () => {
    const s = sig('repeat-post');
    const { id } = await runningKata(s);
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    const input = { source_project_id: sourceProject, symptom: 'again', signature: s, evidence: {}, source_card_id: 'card-repeat' };
    // A real, failing delivery: kata-n8n's base points at a closed local port.
    const saved = { base: process.env.KATA_N8N_WEBHOOK_BASE, token: process.env.KATA_ROLLBACK_WEBHOOK_TOKEN };
    process.env.KATA_N8N_WEBHOOK_BASE = 'http://127.0.0.1:1';
    process.env.KATA_ROLLBACK_WEBHOOK_TOKEN = 'test-token';
    try {
      await expect(openKataForLicence(caller, input)).rejects.toMatchObject({ statusCode: 502, code: 'kata_rollback_webhook_failed' });
      const after = (await readKata(id))!;
      expect(after.rollback_requested_at).not.toBeNull();
      expect(after.rollback_delivered_at).toBeNull();
      expect(after.linked_cards.map((c) => c.card_id)).toContain('card-repeat');
      // Not consumed: the next repeat tries again (and fails again, honestly), keeping the first request time.
      await expect(openKataForLicence(caller, input)).rejects.toMatchObject({ statusCode: 502, code: 'kata_rollback_webhook_failed' });
      expect((await readKata(id))!.rollback_requested_at!.getTime()).toBe(after.rollback_requested_at!.getTime());
      // Unconfigured: 503, the request still committed.
      delete process.env.KATA_ROLLBACK_WEBHOOK_TOKEN;
      await expect(openKataForLicence(caller, input)).rejects.toMatchObject({ statusCode: 503, code: 'kata_rollback_not_configured' });
    } finally {
      if (saved.base === undefined) delete process.env.KATA_N8N_WEBHOOK_BASE;
      else process.env.KATA_N8N_WEBHOOK_BASE = saved.base;
      if (saved.token === undefined) delete process.env.KATA_ROLLBACK_WEBHOOK_TOKEN;
      else process.env.KATA_ROLLBACK_WEBHOOK_TOKEN = saved.token;
    }
    // Once delivered it is stamped and a later repeat sends nothing.
    await markRollbackDelivered(id);
    const out = await openKataForLicence(caller, input);
    expect(out).toMatchObject({ action: 'rollback_pending' });
    expect(out.kata.id).toBe(id);
    expect(await holders()).toEqual([]);
  });

  itDb('closed < 7 days ago → rollback_requested; closed ≥ 7 days ago, failed or rolled_back → open', async () => {
    const s = sig('closed');
    const { id } = await runningKata(s);
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    await closeKata(id);
    expect((await withSignatureLock(s, (tx) => decideOpen(tx, s, null))).action).toBe('rollback_requested');
    await sql`UPDATE katas SET closed_at = now() - interval '8 days', rollback_requested_at = NULL WHERE id = ${id}`;
    expect((await withSignatureLock(s, (tx) => decideOpen(tx, s, null))).action).toBe('open');

    const f = sig('failed');
    const failed = await runningKata(f);
    await patchKata(failed.id, { state: 'failed' });
    expect((await withSignatureLock(f, (tx) => decideOpen(tx, f, null))).action).toBe('open');

    const rb = sig('rolled-back');
    const r = await runningKata(rb);
    await patchKata(r.id, { state: 'qa' });
    await patchKata(r.id, { state: 'published', published_version_id: 'v-pub' });
    await requestKataRollback(r.id);
    await patchKata(r.id, { state: 'rolled_back' });
    expect((await readKata(r.id))!.rolled_back_at).not.toBeNull();
    expect((await withSignatureLock(rb, (tx) => decideOpen(tx, rb, null))).action).toBe('open');
  });

  itDb('a concurrent open of the same signature WAITS for the first decision, then runs (the coach does not retry)', async () => {
    const s = sig('lock');
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    const order: string[] = [];
    const holder = withSignatureLock(s, async () => {
      locked();
      await gate;
      order.push('first');
    });
    await isLocked;
    const second = withSignatureLock(s, async () => {
      order.push('second');
      return 'second';
    });
    // Real clock: the second caller is still parked on the lock 300 ms later.
    await new Promise((r) => setTimeout(r, 300));
    expect(order).toEqual([]);
    release();
    await holder;
    expect(await second).toBe('second');
    expect(order).toEqual(['first', 'second']);
  });

  itDb('the second open of a signature waits on the first decision and is LINKED to the kata it committed', async () => {
    const s = sig('lock-link');
    const firstId = await project(`kata ${s}`, KATA_TENANT_ID);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let locked!: () => void;
    const isLocked = new Promise<void>((r) => (locked = r));
    // The first caller decides `open` and commits its running row while still holding the lock.
    const first = withSignatureLock(s, async (tx) => {
      expect((await decideOpen(tx, s, null)).action).toBe('open');
      await tx.insert(katas).values({
        id: firstId,
        source_project_id: sourceProject,
        source_tenant_id: CUSTOMER,
        symptom: 's',
        opened_by: 'coach',
        signature: s,
        state: 'running',
        card_ready_at: new Date(),
        linked_cards: [{ card_id: 'card-first', board_id: null, phase: null, linked_at: new Date().toISOString() }],
      });
      locked();
      await gate;
    });
    await isLocked;
    // Started while the first still holds the lock: it must wait, not 409.
    const second = decideOpenSelfHealing(s, { card_id: 'card-second' });
    await new Promise((r) => setTimeout(r, 200));
    release();
    await first;
    const d = await second;
    expect(d.action).toBe('linked');
    if (d.action !== 'linked') throw new Error('unreachable');
    expect(d.kata.id).toBe(firstId);
    expect(d.kata.linked_cards.map((c) => c.card_id)).toEqual(['card-first', 'card-second']);
  });

  itDb('a wait past the lock timeout is 409 kata_open_in_progress (SET LOCAL: nothing leaks to the next transaction)', async () => {
    const s = sig('lock-timeout');
    // Hold the signature lock on a separate connection for longer than the 10 s bound.
    const holderTx = sql.begin(async (tx) => {
      await tx`SELECT pg_advisory_xact_lock(hashtext(${`fr.kata.signature:${s}`}))`;
      await tx`SELECT pg_sleep(11)`;
    });
    await new Promise((r) => setTimeout(r, 200));
    const t0 = Date.now();
    await expect(withSignatureLock(s, async () => 'never')).rejects.toMatchObject({ statusCode: 409, code: 'kata_open_in_progress' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(9_000);
    await holderTx;
    // The timeout was transaction-local: a plain transaction afterwards sees the server default.
    const [row] = await sql<{ lt: string }[]>`SELECT current_setting('lock_timeout') AS lt`;
    expect(row?.lt).not.toBe('10s');
  }, 30_000);
});

describe('open ordering (services/katas/open.ts; the Planka/RM steps are proven live)', () => {
  itDb('the operator cord is checked BEFORE anything is created', async () => {
    await sql`UPDATE andon_state SET engaged = true, engaged_by = 'ops@katas.test' WHERE id = 1`;
    const s = sig('cord-first');
    const [before] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
    await expect(openKataForLicence(caller, { source_project_id: sourceProject, symptom: 'x', signature: s, evidence: {} })).rejects.toMatchObject({
      statusCode: 409,
    });
    const [after] = await sql<{ n: number }[]>`SELECT count(*)::int AS n FROM projects`;
    expect(after?.n).toBe(before?.n);
    expect((await sql`SELECT 1 FROM katas WHERE signature = ${s}`).length).toBe(0);
    expect(await holders()).toEqual([]);
  });

  itDb('the running row is inserted WITH its first card and re-checks the signature under its lock', async () => {
    const s = sig('with-card');
    const id = await project(`kata ${s}`, KATA_TENANT_ID);
    const r = await insertRunningKata({
      id,
      source_project_id: sourceProject,
      source_tenant_id: CUSTOMER,
      symptom: 's',
      opened_by: 'coach',
      signature: s,
      base_version_id: 'v-base',
      kata_board_id: 'board-1',
      kata_card_id: 'card-1',
    });
    expect(r.result).toMatchObject({ state: 'running', kata_board_id: 'board-1', kata_card_id: 'card-1' });
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    // A published kata of the signature is open too: a racing insert is refused, nothing held.
    const loser = await project(`kata ${s} loser`, KATA_TENANT_ID);
    await expect(
      insertRunningKata({ id: loser, source_project_id: sourceProject, source_tenant_id: CUSTOMER, symptom: 's', opened_by: 'coach', signature: s }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'kata_signature_open' });
    expect(await readKata(loser)).toBeNull();
    expect(await holders()).toEqual([]);
  });

  itDb('a running kata whose project is archived is a dead open: the next open fails it, lets go and decides open', async () => {
    const s = sig('dead-archived');
    const { id } = await runningKata(s, 'card-a');
    await db.update(projects).set({ status: 'archived' }).where(eq(projects.id, id));
    // decideOpen alone only reports it (nothing written: the card is not linked to a dead kata).
    const d = await withSignatureLock(s, (tx) => decideOpen(tx, s, { card_id: 'card-b' }));
    expect(d).toMatchObject({ action: 'stale', reason: 'its kata project is archived' });
    expect((await readKata(id))!.linked_cards.map((c) => c.card_id)).toEqual(['card-a']);
    expect(await holders()).toEqual([id]);

    const healed = await decideOpenSelfHealing(s, { card_id: 'card-b' });
    expect(healed.action).toBe('open');
    const row = (await readKata(id))!;
    expect(row.state).toBe('failed');
    expect(row.failed_at).not.toBeNull();
    expect(row.state_detail).toContain('its kata project is archived');
    // George 2026-11-04: the failed kata KEEPS the cord until a super-admin releases it.
    expect(row.cord_engaged_at).not.toBeNull();
    expect(row.cord_released_at).toBeNull();
    expect(await holders()).toEqual([id]);
  });

  itDb('a running kata whose first card never reached READY: linked within the grace, cleared past it', async () => {
    const s = sig('dead-not-ready');
    const { id } = await runningKata(s);
    // Fresh (an open may still be moving the card): linked, nothing failed.
    expect((await decideOpenSelfHealing(s, null)).action).toBe('linked');
    expect(await holders()).toEqual([id]);

    // A card that DID reach READY keeps the kata live however old it is.
    const old = new Date(Date.now() - KATA_CARD_READY_GRACE_MS - 60_000);
    await db.update(katas).set({ opened_at: old, card_ready_at: old }).where(eq(katas.id, id));
    expect((await decideOpenSelfHealing(s, null)).action).toBe('linked');

    // Past the grace with no card_ready_at: failed + released + archived, then a fresh open.
    await db.update(katas).set({ card_ready_at: null }).where(eq(katas.id, id));
    expect((await decideOpenSelfHealing(s, null)).action).toBe('open');
    const row = (await readKata(id))!;
    expect(row.state).toBe('failed');
    expect(row.state_detail).toContain('never reached READY');
    expect(row.cord_engaged_at).not.toBeNull();
    expect(await holders()).toEqual([id]);
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p?.status).toBe('archived');
  });
});

describe('the cord join is verified against the LIVE Deployment before the kata starts', () => {
  // ⭐ An accepted PATCH is not proof the worker STAYED at 0: kustomize re-applies the Deployment
  // every 5m and the replica count is deliberately not in git, so the open re-reads the live
  // Deployment and fails the kata whenever it does not measure exactly 0 — BEFORE the card can
  // reach READY, which is what starts the kata on kata-n8n.
  //
  // The reading is passed to the verdict (assertCordMeasuredAtZero) so this runs against a real
  // kata row without a cluster; the live read itself is never faked (backend/CLAUDE.md).
  //
  // ⚠️ The open ITSELF cannot be driven here: its project create needs live RM + Planka, which CI
  // does not have (backend/CLAUDE.md: no test doubles). What these pin is the verdict the open
  // applies, immediately before its card move.
  const reading = (replicas: number | null, error: string | null = null) => ({ replicas, available: null, error });

  itDb('the worker measured at 1: the kata is failed, keeps the cord, and its project is archived', async () => {
    const { id } = await runningKata(sig('cord-live-1'), 'card-1');
    await expect(assertCordMeasuredAtZero(id, reading(1))).rejects.toMatchObject({
      statusCode: 502,
      code: 'kata_cord_not_effective',
    });
    const row = (await readKata(id))!;
    expect(row.state).toBe('failed');
    expect(row.failed_at).not.toBeNull();
    expect(row.state_detail).toContain('n8n-worker measured 1, not 0');
    // George 2026-11-04: the failed kata KEEPS the cord until a super-admin releases it.
    expect(row.cord_engaged_at).not.toBeNull();
    expect(row.cord_released_at).toBeNull();
    expect(await holders()).toEqual([id]);
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p?.status).toBe('archived');
  });

  itDb('UNMEASURABLE (replicas null, never 0): the same failure, naming the read error', async () => {
    const { id } = await runningKata(sig('cord-live-null'), 'card-1');
    await expect(assertCordMeasuredAtZero(id, reading(null, 'k8s read failed: token is not mounted'))).rejects.toMatchObject({
      statusCode: 502,
      code: 'kata_cord_not_effective',
    });
    const row = (await readKata(id))!;
    expect(row.state).toBe('failed');
    expect(row.state_detail).toContain('unmeasurable (k8s read failed: token is not mounted)');
    expect(row.cord_engaged_at).not.toBeNull();
    expect(await holders()).toEqual([id]);
  });

  itDb('CONTROL: a MEASURED 0 lets it proceed — the kata stays running, holds the cord, project active', async () => {
    const { id } = await runningKata(sig('cord-live-0'), 'card-1');
    await expect(assertCordMeasuredAtZero(id, reading(0))).resolves.toBeUndefined();
    const row = (await readKata(id))!;
    expect(row.state).toBe('running');
    expect(row.state_detail).toBeNull();
    expect(await holders()).toEqual([id]);
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p?.status).toBe('active');
  });
});

describe('the cord verdict is WIRED into the open, not merely importable', () => {
  // ⭐ A test on `assertCordMeasuredAtZero` CANNOT FAIL if the open stops calling it: the call is
  // a bare statement, `noUnusedLocals` is off (backend/tsconfig.json), and the open's own path
  // needs live RM + Planka — so deleting it, or moving it after the card move, leaves every other
  // test green while the defect (a kata starting on an unverified cord) comes straight back.
  // Measured: the whole suite still passed 47/47 with the call deleted.
  // This pins the ORDERING invariant on the source instead — exactly one call, before the move
  // that starts the kata. It is a structural check, not a behaviour test, and it is the only one
  // available without a test double (banned in backend/CLAUDE.md).
  test('open.ts calls it exactly once, before moveCardToReady', async () => {
    const src = await Bun.file(new URL('../../../src/services/katas/open.ts', import.meta.url)).text();
    const call = src.indexOf('await assertCordMeasuredAtZero(');
    const move = src.indexOf('await moveCardToReady(');
    expect(call).toBeGreaterThanOrEqual(0);
    expect(move).toBeGreaterThan(call);
    expect(src.split('await assertCordMeasuredAtZero(').length - 1).toBe(1);
  });
});

describe('transitions (PATCH /api/katas/:id)', () => {
  itDb('an invalid transition is 409 kata_invalid_transition and changes nothing', async () => {
    const { id } = await runningKata(sig('invalid'));
    await expect(patchKata(id, { state: 'published', published_version_id: 'v-pub' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    await expect(patchKata(id, { state: 'closed' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    await expect(patchKata(id, { state: 'rolled_back' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    const row = (await readKata(id))!;
    expect(row.state).toBe('running');
    expect(await holders()).toEqual([id]);
  });

  itDb('published → failed is allowed (a post-publish failure is not stuck); published → closed stays a close-route move', async () => {
    const { id } = await runningKata(sig('post-publish-fail'));
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    // Close is its own route (POST /api/katas/:id/close), never a PATCH target.
    await expect(patchKata(id, { state: 'closed' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    expect(await holders()).toEqual([]);
    const out = await patchKata(id, { state: 'failed', state_detail: 'DONE failed after publish' });
    expect(out.kata.state).toBe('failed');
    expect(out.kata.failed_at).not.toBeNull();
    expect(out.kata.state_detail).toBe('DONE failed after publish');
    // The publish already released the cord: a post-publish failure neither releases nor re-holds it.
    expect(out.cord).toBeUndefined();
    expect(await holders()).toEqual([]);
  });

  itDb('fields update in any state without a state change (ops while running, replays in qa, rerun after publish)', async () => {
    const { id } = await runningKata(sig('fields'), 'card-x');
    expect((await patchKata(id, { ops: [{ op: 'set_prompt' }], target_flow: 'bug_analysis.DOING' })).kata.state).toBe('running');
    await patchKata(id, { state: 'qa' });
    const q = await patchKata(id, { state: 'qa', replays: [{ ok: true }], replay_passed: 2, replay_total: 3 });
    expect(q.kata.state).toBe('qa');
    expect(q.kata.replay_passed).toBe(2);
    expect(q.cord).toBeUndefined();
    expect(await holders()).toEqual([id]);
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    const r = await patchKata(id, { linked_card_rerun: ['card-x'] });
    expect(r.kata.state).toBe('published');
    expect(r.kata.linked_cards[0]!.rerun_at).toBeString();
  });

  itDb('signature / base_version_id / target_flow(_id) change only while running: 409 kata_field_frozen otherwise', async () => {
    const { id } = await runningKata(sig('frozen'));
    // While running, and in the same call that moves it on from running.
    await patchKata(id, { base_version_id: 'v1', target_flow_id: 'wf1' });
    // The signature is immutable in EVERY state, running included.
    await expect(patchKata(id, { signature: 'rewritten' })).rejects.toMatchObject({ statusCode: 400, code: 'kata_signature_immutable' });
    await patchKata(id, { state: 'qa', target_flow: 'bug_analysis.DOING' });
    for (const field of ['base_version_id', 'target_flow', 'target_flow_id'] as const) {
      await expect(patchKata(id, { [field]: 'rewritten' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_field_frozen' });
    }
    // Refused together with a state change out of qa too, and nothing changed.
    await expect(patchKata(id, { state: 'published', base_version_id: 'v0' })).rejects.toMatchObject({ code: 'kata_field_frozen' });
    const row = (await readKata(id))!;
    expect(row).toMatchObject({ state: 'qa', base_version_id: 'v1', target_flow_id: 'wf1', target_flow: 'bug_analysis.DOING' });
    expect(await holders()).toEqual([id]);
    // The other fields still update outside running.
    await patchKata(id, { state: 'published', published_version_id: 'v2' });
    await expect(patchKata(id, { base_version_id: 'v0' })).rejects.toMatchObject({ code: 'kata_field_frozen' });
    expect((await patchKata(id, { state_detail: 'ok' })).kata.state_detail).toBe('ok');
  });

  itDb('qa → running (a retry) keeps the hold', async () => {
    const { id } = await runningKata(sig('retry'));
    await patchKata(id, { state: 'qa' });
    const back = await patchKata(id, { state: 'running', state_detail: 'QA 1/3, retrying' });
    expect(back.kata.state).toBe('running');
    expect(back.cord).toBeUndefined();
    expect(back.kata.cord_engaged_at).not.toBeNull();
    expect(await holders()).toEqual([id]);
  });

  itDb('leaving qa (published) releases the cord in the same change and accrues cord_held_seconds', async () => {
    const { id } = await runningKata(sig('release'));
    await patchKata(id, { state: 'qa' });
    // Real clock (fake timers are banned): back-date the hold so the accrual is measurable.
    await sql`UPDATE katas SET cord_engaged_at = now() - interval '90 seconds' WHERE id = ${id}`;
    const out = await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    expect(out.kata.state).toBe('published');
    expect(out.kata.published_at).not.toBeNull();
    expect(out.kata.cord_engaged_at).toBeNull();
    expect(out.kata.cord_held_seconds).toBeGreaterThanOrEqual(90);
    expect(out.kata.cord_held_seconds).toBeLessThan(150);
    expect(out.cord).toMatchObject({ released: true });
    expect(await holders()).toEqual([]);
  });

  itDb('running → failed KEEPS the cord (George 2026-11-04); rolled_back needs a requested rollback', async () => {
    const { id } = await runningKata(sig('fail'));
    const out = await patchKata(id, { state: 'failed', state_detail: 'failed twice' });
    expect(out.kata.failed_at).not.toBeNull();
    expect(out.cord).toBeUndefined();
    expect(out.kata.cord_engaged_at).not.toBeNull();
    expect(await holders()).toEqual([id]);
    const q = await runningKata(sig('fail-qa'));
    await patchKata(q.id, { state: 'qa' });
    await patchKata(q.id, { state: 'failed' });
    expect((await holders()).sort()).toEqual([id, q.id].sort());

    const p = await runningKata(sig('rb-guard'));
    await patchKata(p.id, { state: 'qa' });
    await patchKata(p.id, { state: 'published', published_version_id: 'v-pub' });
    await expect(patchKata(p.id, { state: 'rolled_back' })).rejects.toMatchObject({ statusCode: 409, code: 'kata_rollback_not_requested' });
  });
});

describe('publish needs both versions; the signature never changes', () => {
  itDb('qa → published without base_version_id or published_version_id is 409 kata_versions_missing, nothing changed', async () => {
    const s = sig('pub-versions');
    const id = await project(`kata ${s}`, KATA_TENANT_ID);
    await insertRunningKata({ id, source_project_id: sourceProject, source_tenant_id: CUSTOMER, symptom: 's', opened_by: 'coach', signature: s });
    await patchKata(id, { state: 'qa' });
    await expect(patchKata(id, { state: 'published', published_version_id: 'v-pub' })).rejects.toMatchObject({
      statusCode: 409,
      code: 'kata_versions_missing',
      details: { fields: ['base_version_id'] },
    });
    expect((await readKata(id))!.state).toBe('qa');
    expect(await holders()).toEqual([id]);

    const ok = await runningKata(sig('pub-versions-ok'));
    await patchKata(ok.id, { state: 'qa' });
    await expect(patchKata(ok.id, { state: 'published' })).rejects.toMatchObject({ code: 'kata_versions_missing', details: { fields: ['published_version_id'] } });
    expect((await patchKata(ok.id, { state: 'published', published_version_id: 'v2' })).kata.state).toBe('published');
  });

  itDb('a PATCH may repeat the signature but never change it; the column refuses NULL', async () => {
    const s = sig('sig-immutable');
    const { id } = await runningKata(s);
    expect((await patchKata(id, { signature: s, state_detail: 'same' })).kata.signature).toBe(s);
    await expect(patchKata(id, { signature: `${s}-other` })).rejects.toMatchObject({ statusCode: 400, code: 'kata_signature_immutable' });
    const clearIt = async () => {
      await sql`UPDATE katas SET signature = NULL WHERE id = ${id}`;
    };
    await expect(clearIt()).rejects.toThrow(/null value in column "signature"/);
    expect((await readKata(id))!.signature).toBe(s);
  });
});

describe('a failed kata keeps the cord; only the super-admin Release frees it (George 2026-11-04)', () => {
  itDb('Release: failed + holding → released (who/when recorded, held time accrued); the worker scale-up is attempted', async () => {
    const { id } = await runningKata(sig('release-failed'));
    await patchKata(id, { state: 'failed' });
    await sql`UPDATE katas SET cord_engaged_at = now() - interval '60 seconds' WHERE id = ${id}`;
    const out = await releaseFailedKata(id, 'super_admin:00000000-0000-4000-8000-0000000000c1');
    expect(out.kata.state).toBe('failed');
    expect(out.kata.cord_released_by).toBe('super_admin:00000000-0000-4000-8000-0000000000c1');
    expect(out.kata.cord_released_at).not.toBeNull();
    expect(out.kata.cord_engaged_at).toBeNull();
    expect(out.kata.cord_held_seconds).toBeGreaterThanOrEqual(60);
    expect(out.cord).toMatchObject({ released: true, worker_scaled_up: false });
    // Nobody else held: the scale-up to 1 was genuinely attempted (and fails without a cluster).
    expect(out.cord!.worker_scale_error).toContain('scale to 1');
    expect(await holders()).toEqual([]);
    await expect(releaseFailedKata(id, 'super_admin:x')).rejects.toMatchObject({ statusCode: 409, code: 'kata_already_released' });
  });

  itDb('Release while another holder remains (a running kata, or the operator) does not attempt the scale-up', async () => {
    const failed = await runningKata(sig('release-other-f'));
    await patchKata(failed.id, { state: 'failed' });
    const live = await runningKata(sig('release-other-live'));
    const out = await releaseFailedKata(failed.id, 'super_admin:a');
    expect(out.cord).toMatchObject({ released: true, worker_scaled_up: false, worker_scale_error: null });
    expect(await holders()).toEqual([live.id]);

    const f2 = await runningKata(sig('release-operator-f'));
    await patchKata(f2.id, { state: 'failed' });
    await patchKata(live.id, { state: 'failed' });
    await sql`UPDATE andon_state SET engaged = true, engaged_by = 'ops@katas.test' WHERE id = 1`;
    await releaseFailedKata(live.id, 'super_admin:a');
    const out2 = await releaseFailedKata(f2.id, 'super_admin:a');
    // The operator still holds: the worker stays at 0, no scale-up attempted.
    expect(out2.cord).toMatchObject({ released: true, worker_scaled_up: false, worker_scale_error: null });
    expect(await holders()).toEqual([]);
  });

  itDb('Release refuses a kata that is not failed (409 kata_invalid_transition), nothing changed', async () => {
    const { id } = await runningKata(sig('release-running'));
    await expect(releaseFailedKata(id, 'super_admin:a')).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    expect(await holders()).toEqual([id]);
  });

  itDb("the operator's orphan prune never drops a failed holder; a released or published one is an orphan", async () => {
    const failed = await runningKata(sig('prune-failed'));
    await patchKata(failed.id, { state: 'failed' });
    const done = await runningKata(sig('prune-published'));
    await patchKata(done.id, { state: 'qa' });
    await patchKata(done.id, { state: 'published', published_version_id: 'v-pub' });
    // Re-add the published kata out of band (a stale holder): an orphan.
    await joinSystemKataAndon(done.id);
    expect(await pruneOrphanKataHolders()).toEqual([done.id]);
    expect(await holders()).toEqual([failed.id]);
    // A released failed kata re-added out of band is an orphan too.
    await releaseFailedKata(failed.id, 'super_admin:a');
    await joinSystemKataAndon(failed.id);
    expect(await pruneOrphanKataHolders()).toEqual([failed.id]);
  });

  itDb('fr_kata_failed_holders counts failed katas holding the cord (scrape-time read)', async () => {
    const metric = () => {
      const line = renderAndonHaltMetrics().find((l) => l.startsWith('fr_kata_failed_holders '));
      return line === undefined ? null : Number(line.split(' ')[1]);
    };
    await refreshAndonStateInitialisedGauge();
    expect(metric()).toBe(0);
    // fr_andon_engaged is published by the scrape itself (an operator stop generates no consults).
    const engaged = () => renderAndonHaltMetrics().find((l) => l.startsWith('fr_andon_engaged ')) ?? null;
    expect(engaged()).toBe('fr_andon_engaged 0');
    await sql`UPDATE andon_state SET engaged = true WHERE id = 1`;
    await refreshAndonStateInitialisedGauge();
    expect(engaged()).toBe('fr_andon_engaged 1');
    await sql`UPDATE andon_state SET engaged = false WHERE id = 1`;
    await refreshAndonStateInitialisedGauge();
    expect(engaged()).toBe('fr_andon_engaged 0');
    const a = await runningKata(sig('metric-a'));
    await runningKata(sig('metric-live'));
    await refreshAndonStateInitialisedGauge();
    expect(metric()).toBe(0);
    await patchKata(a.id, { state: 'failed' });
    await refreshAndonStateInitialisedGauge();
    expect(metric()).toBe(1);
    await releaseFailedKata(a.id, 'super_admin:a');
    await refreshAndonStateInitialisedGauge();
    expect(metric()).toBe(0);
  });

  itDb('conveyorPause names the operator flag and every kata holder (a hand-open refuses while set)', async () => {
    expect(await conveyorPause()).toBeNull();
    const { id } = await runningKata(sig('paused'));
    await patchKata(id, { state: 'failed' });
    expect(await conveyorPause()).toEqual({ operator: false, kata_holders: [id] });
    await releaseFailedKata(id, 'super_admin:a');
    expect(await conveyorPause()).toBeNull();
    await sql`UPDATE andon_state SET engaged = true WHERE id = 1`;
    expect(await conveyorPause()).toEqual({ operator: true, kata_holders: [] });
  });
});

describe('close and stop', () => {
  itDb('close: not published → 409 kata_invalid_transition; 409 kata_cord_held while the id is a holder; then closed + project archived', async () => {
    const { id } = await runningKata(sig('close-held'));
    await expect(closeKata(id)).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    // A stale hold (e.g. a holder re-added out of band): close must refuse, not hide it.
    await joinSystemKataAndon(id);
    await expect(closeKata(id)).rejects.toMatchObject({ statusCode: 409, code: 'kata_cord_held' });
    expect((await readKata(id))!.state).toBe('published');
    await resetCord();
    const closed = await closeKata(id);
    expect(closed.state).toBe('closed');
    expect(closed.closed_at).not.toBeNull();
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p!.status).toBe('archived');
  });

  itDb('stop: running → failed + kata project archived; the cord is KEPT; a published kata cannot be stopped', async () => {
    const { id } = await runningKata(sig('stop'));
    const out = await stopKata(id, 'ops@kata.test');
    expect(out.kata.state).toBe('failed');
    expect(out.kata.state_detail).toContain('ops@kata.test');
    expect(out.cord).toBeUndefined();
    expect(await holders()).toEqual([id]);
    const [p0] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p0!.status).toBe('archived');

    const p = await runningKata(sig('stop-published'));
    await patchKata(p.id, { state: 'qa' });
    await patchKata(p.id, { state: 'published', published_version_id: 'v-pub' });
    await expect(stopKata(p.id, 'ops@kata.test')).rejects.toMatchObject({ statusCode: 409, code: 'kata_invalid_transition' });
  });

  itDb('the failed transition archives the project on the PATCH path too (the conveyor, not just Stop)', async () => {
    // The conveyor marks a kata failed over PATCH (`updateKata`), which used to set only the kata
    // state: the project kept reading `active`, so the UI showed a kata project "Running" forever.
    // The archive now lives on the transition itself, so EVERY path that enters `failed` gets it.
    const { id } = await runningKata(sig('patch-failed-archives'));
    const [before] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(before!.status).toBe('active');
    const out = await patchKata(id, { state: 'failed', state_detail: 'wf_change.READY: agent returned no ops' });
    expect(out.kata.state).toBe('failed');
    const [after] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(after!.status).toBe('archived');
    // George 2026-11-04: a failed kata KEEPS the cord — archiving must not release it.
    expect(await holders()).toEqual([id]);
  });

  itDb('stop of a TAGGED kata project with RM unreachable: 502 rm_project_close_failed, kata still running, project still active', async () => {
    const { id } = await runningKata(sig('stop-rm-down'), undefined, { tenant: KATA_TENANT_ID });
    await expect(stopKata(id, 'ops@kata.test')).rejects.toMatchObject({ statusCode: 502, code: 'rm_project_close_failed' });
    expect((await readKata(id))!.state).toBe('running');
    const [p] = await db.select({ status: projects.status }).from(projects).where(eq(projects.id, id));
    expect(p!.status).toBe('active');
  });

  itDb('rollback request: refused without a base version, or when a LATER kata published on the same target_flow', async () => {
    const flow = `flow-${Date.now()}-${seq++}`;
    const noBase = sig('rb-no-base');
    const nb = await project(`kata ${noBase}`, KATA_TENANT_ID);
    await insertRunningKata({ id: nb, source_project_id: sourceProject, source_tenant_id: CUSTOMER, symptom: 's', opened_by: 'coach', signature: noBase });
    await patchKata(nb, { state: 'qa' });
    // Out of band (a pre-guard published row): no base recorded.
    await sql`UPDATE katas SET state = 'published', published_at = now(), cord_engaged_at = NULL WHERE id = ${nb}`;
    await resetCord();
    await expect(requestKataRollback(nb)).rejects.toMatchObject({ statusCode: 409, code: 'kata_rollback_no_base' });
    expect((await readKata(nb))!.rollback_requested_at).toBeNull();

    const older = await runningKata(sig('rb-older'), undefined, { target_flow: flow });
    await patchKata(older.id, { state: 'qa' });
    await patchKata(older.id, { state: 'published', published_version_id: 'v-1' });
    const newer = await runningKata(sig('rb-newer'), undefined, { target_flow: flow });
    // An open (not yet published) later kata does not block.
    expect((await requestKataRollback(older.id)).newlyRequested).toBe(true);
    await sql`UPDATE katas SET rollback_requested_at = NULL WHERE id = ${older.id}`;
    await patchKata(newer.id, { state: 'qa' });
    await patchKata(newer.id, { state: 'published', published_version_id: 'v-2' });
    await expect(requestKataRollback(older.id)).rejects.toMatchObject({
      statusCode: 409,
      code: 'kata_rollback_superseded',
      details: { later_kata_id: newer.id },
    });
    expect((await readKata(older.id))!.rollback_requested_at).toBeNull();
    // The newest one may still be rolled back.
    expect((await requestKataRollback(newer.id)).newlyRequested).toBe(true);
  });

  itDb('superseded is decided by PUBLISH time, not open time', async () => {
    const flow = `flow-pubtime-${Date.now()}-${seq++}`;
    const openedFirst = await runningKata(sig('pt-opened-first'), undefined, { target_flow: flow });
    const openedSecond = await runningKata(sig('pt-opened-second'), undefined, { target_flow: flow });
    // The kata opened SECOND publishes FIRST; the one opened first publishes last.
    await patchKata(openedSecond.id, { state: 'qa' });
    await patchKata(openedSecond.id, { state: 'published', published_version_id: 'v-a' });
    await sql`UPDATE katas SET published_at = now() - interval '1 hour' WHERE id = ${openedSecond.id}`;
    await patchKata(openedFirst.id, { state: 'qa' });
    await patchKata(openedFirst.id, { state: 'published', published_version_id: 'v-b' });
    // The last-published fix (opened first) may roll back: nothing landed on the flow after it.
    expect((await requestKataRollback(openedFirst.id)).newlyRequested).toBe(true);
    // The earlier-published one (opened second) is superseded by it.
    await expect(requestKataRollback(openedSecond.id)).rejects.toMatchObject({
      code: 'kata_rollback_superseded',
      details: { later_kata_id: openedFirst.id },
    });
  });

  itDb("a coach repeat applies the same guard: superseded or no base → rollback_refused, nothing requested, recorded on the kata", async () => {
    const flow = `flow-repeat-${Date.now()}-${seq++}`;
    const s = sig('repeat-superseded');
    const older = await runningKata(s, undefined, { target_flow: flow });
    await patchKata(older.id, { state: 'qa' });
    await patchKata(older.id, { state: 'published', published_version_id: 'v-1' });
    const newer = await runningKata(sig('repeat-newer'), undefined, { target_flow: flow });
    await patchKata(newer.id, { state: 'qa' });
    await patchKata(newer.id, { state: 'published', published_version_id: 'v-2' });
    // Configured webhook: a refused repeat must not even try to post.
    const saved = { base: process.env.KATA_N8N_WEBHOOK_BASE, token: process.env.KATA_ROLLBACK_WEBHOOK_TOKEN };
    process.env.KATA_N8N_WEBHOOK_BASE = 'http://127.0.0.1:1';
    process.env.KATA_ROLLBACK_WEBHOOK_TOKEN = 'test-token';
    try {
      const out = await openKataForLicence(caller, { source_project_id: sourceProject, symptom: 'again', signature: s, evidence: {}, source_card_id: 'card-rep' });
      expect(out).toMatchObject({ action: 'rollback_refused', reason: 'kata_rollback_superseded', later_kata_id: newer.id });
      const row = (await readKata(older.id))!;
      expect(row.rollback_requested_at).toBeNull();
      expect(row.rollback_delivered_at).toBeNull();
      expect(row.rollback_refused_reason).toBe('kata_rollback_superseded');
      expect(row.rollback_refused_at).not.toBeNull();
      expect(row.linked_cards.map((c) => c.card_id)).toContain('card-rep');

      const nb = sig('repeat-no-base');
      const nbId = await project(`kata ${nb}`, KATA_TENANT_ID);
      await insertRunningKata({ id: nbId, source_project_id: sourceProject, source_tenant_id: CUSTOMER, symptom: 's', opened_by: 'coach', signature: nb });
      await sql`UPDATE katas SET state = 'published', published_at = now(), cord_engaged_at = NULL WHERE id = ${nbId}`;
      await resetCord();
      const d = await withSignatureLock(nb, (tx) => decideOpen(tx, nb, null));
      expect(d).toMatchObject({ action: 'rollback_refused', refusal: { code: 'kata_rollback_no_base' } });
      expect((await readKata(nbId))!.rollback_requested_at).toBeNull();
    } finally {
      if (saved.base === undefined) delete process.env.KATA_N8N_WEBHOOK_BASE;
      else process.env.KATA_N8N_WEBHOOK_BASE = saved.base;
      if (saved.token === undefined) delete process.env.KATA_ROLLBACK_WEBHOOK_TOKEN;
      else process.env.KATA_ROLLBACK_WEBHOOK_TOKEN = saved.token;
    }
    expect(await holders()).toEqual([]);
  });

  itDb('rollback request: only published/closed, idempotent', async () => {
    const { id } = await runningKata(sig('rollback'));
    await expect(requestKataRollback(id)).rejects.toMatchObject({ statusCode: 409 });
    await patchKata(id, { state: 'qa' });
    await patchKata(id, { state: 'published', published_version_id: 'v-pub' });
    const first = await requestKataRollback(id);
    expect(first.newlyRequested).toBe(true);
    const second = await requestKataRollback(id);
    expect(second.newlyRequested).toBe(false);
    expect(second.kata.rollback_requested_at!.getTime()).toBe(first.kata.rollback_requested_at!.getTime());
  });
});

describe('a kata project never starts the conveyor (fr creates its first card itself)', () => {
  // The board link runs detached after a create (services/rm-board-link.ts). A conveyor start
  // ALWAYS records its attempt row in project_conveyor_start_attempts before the link — even when
  // the link then fails — so the row's absence is the observable "no start was attempted". The
  // board here lacks the six conveyor lists, so the link fails at once and nothing leaves fr.
  const linkInput = (frProjectId: string) => ({
    tenantId: KATA_TENANT_ID,
    rmPmProjectId: '00000000-0000-4000-8000-00000000aaaa',
    frProjectId,
    plankaProjectId: null,
    plankaBoardId: 'board-without-lists',
    listIds: {},
  });
  const attempts = (projectId: string) =>
    db.select().from(projectConveyorStartAttempts).where(eq(projectConveyorStartAttempts.project_id, projectId));

  itDb('startConveyor:false (the kata open) records no start attempt and sends no start', async () => {
    const kataProject = await project('kata no-start', KATA_TENANT_ID);
    linkBoardThenStartConveyor({ ...linkInput(kataProject), startConveyor: false });
    expect(await drainDetachedWork()).toBe(true);
    expect(await attempts(kataProject)).toEqual([]);
  });

  itDb('CONTROL: the default create path does record its start attempt (the instrument can see one)', async () => {
    const other = await project('kata control-start', CUSTOMER);
    linkBoardThenStartConveyor(linkInput(other));
    expect(await drainDetachedWork()).toBe(true);
    const rows = await attempts(other);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).toBe('board_link_failed');
  });

  itDb('boardLinked:true (the create linked in its transaction) sends the start WITHOUT re-linking', async () => {
    // Same board without lists: a re-link would fail at once (`board_link_failed`, CONTROL above).
    // The create already linked the board inside its transaction (R351), so the detached chain
    // records the start and sends it; it never reaches the link.
    const created = await project('kata create-linked', CUSTOMER);
    linkBoardThenStartConveyor({ ...linkInput(created), boardLinked: true });
    expect(await drainDetachedWork()).toBe(true);
    const rows = await attempts(created);
    expect(rows.length).toBe(1);
    expect(rows[0]!.outcome).not.toBe('board_link_failed');
  });
});

// ── who: pure, over identity fixtures ──────────────────────────────────────

const human = (roles: string[], tenantId = CUSTOMER): User =>
  ({ id: '00000000-0000-4000-8000-0000000000c1', email: 'u@t.test', name: 'u', roles, tenantId, isServiceAccount: false }) as User;
const licence = (tenantId: string): User =>
  ({ id: '00000000-0000-4000-8000-0000000000c2', email: '', name: 'licence', roles: [], tenantId, isServiceAccount: false, authKind: 'licence' }) as User;

const OPS = Object.keys(KATA_ROUTE_CALLERS) as Array<keyof typeof KATA_ROUTE_CALLERS>;
const SUPER_ONLY = ['listKatas', 'stopKata', 'rollbackKata', 'releaseKata'] as const;
const KATA_ROUTES: Record<string, { method: string; pattern: string }> = {
  listKatas: { method: 'GET', pattern: '/api/katas' },
  getKata: { method: 'GET', pattern: '/api/katas/:id' },
  openKata: { method: 'POST', pattern: '/api/katas' },
  updateKata: { method: 'PATCH', pattern: '/api/katas/:id' },
  closeKata: { method: 'POST', pattern: '/api/katas/:id/close' },
  stopKata: { method: 'POST', pattern: '/api/katas/:id/stop' },
  rollbackKata: { method: 'POST', pattern: '/api/katas/:id/rollback' },
  releaseKata: { method: 'POST', pattern: '/api/katas/:id/release' },
};

describe('who reaches /api/katas', () => {
  test('no tenant role reaches any route — workspace-admin, tenant_admin and a member included', () => {
    for (const user of [human(['tenant_admin', 'admin']), human(['workspace-admin']), human([]), human(['tenant_admin'], KATA_TENANT_ID)]) {
      for (const op of OPS) {
        expect(() => assertKataCaller(user, op)).toThrow(expect.objectContaining({ statusCode: 403, code: 'kata_caller_not_allowed' }));
      }
    }
  });

  test("a customer tenant's licence reaches none; the conveyor licence reaches only its routes", () => {
    for (const op of OPS) {
      expect(() => assertKataCaller(licence(CUSTOMER), op)).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    for (const tenant of [V4_CONVEYOR_TENANT_ID, AA_CONVEYOR_TENANT_ID]) {
      for (const op of OPS) {
        const admitted = (KATA_ROUTE_CALLERS[op] as readonly string[]).includes('conveyor_licence');
        if (admitted) expect(assertKataCaller(licence(tenant), op)).toBe('conveyor_licence');
        else expect(() => assertKataCaller(licence(tenant), op)).toThrow(expect.objectContaining({ statusCode: 403 }));
      }
    }
  });

  test('the licence is refused on every super-admin-only route, at the server door too (not allowlisted)', () => {
    for (const op of SUPER_ONLY) {
      expect(() => assertKataCaller(licence(V4_CONVEYOR_TENANT_ID), op)).toThrow(expect.objectContaining({ statusCode: 403 }));
      const r = KATA_ROUTES[op]!;
      expect(LICENCE_ROUTE_ALLOWLIST.some((row) => row.method === r.method && row.pattern === r.pattern)).toBe(false);
    }
    for (const op of ['getKata', 'openKata', 'updateKata', 'closeKata']) {
      const r = KATA_ROUTES[op]!;
      expect(LICENCE_ROUTE_ALLOWLIST.some((row) => row.method === r.method && row.pattern === r.pattern)).toBe(true);
    }
  });

  test('a super-admin reaches the super-admin routes but not the licence-only writes', () => {
    const sa = human(['super_admin']);
    for (const op of OPS) {
      const admitted = (KATA_ROUTE_CALLERS[op] as readonly string[]).includes('super_admin');
      if (admitted) expect(assertKataCaller(sa, op)).toBe('super_admin');
      else expect(() => assertKataCaller(sa, op)).toThrow(expect.objectContaining({ statusCode: 403 }));
    }
    expect(KATA_ROUTE_CALLERS.updateKata).toEqual(['conveyor_licence']);
    expect(KATA_ROUTE_CALLERS.closeKata).toEqual(['conveyor_licence']);
  });
});

describe("a hand-open's requester is never provenance (opened_by = 'coach')", () => {
  const base = { source_project_id: '00000000-0000-4000-8000-0000000000aa', symptom: 's', signature: 'x', evidence: {} };
  test('the licence body still accepts the sub the coach passes back (so the coach is not refused); anything but a uuid is refused', () => {
    expect(LicenceOpenBody.parse({ ...base, requested_by: '00000000-0000-4000-8000-0000000000ab' }).requested_by).toBe(
      '00000000-0000-4000-8000-0000000000ab',
    );
    expect(LicenceOpenBody.parse(base).requested_by).toBeUndefined();
    expect(() => LicenceOpenBody.parse({ ...base, requested_by: 'super_admin:someone' })).toThrow();
  });
});
