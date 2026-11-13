// src/workers/project-delivered-reconcile.ts
//
// STORES the RM delivery that every read path DERIVES (services/project-delivered.ts).
//
// Why a stored status is still needed at all: a repository has ONE live
// bug_hunt slot, enforced by the partial unique index
// `projects_one_live_bug_hunt_per_repo_idx` (db/schema.ts), and a derived
// value is invisible to an index. The index frees the slot only when the
// project's STORED status is 'delivered' — and `assertNoLiveBugHuntProject`
// (routes/projects.ts) keys on the same stored status. So with delivery never
// stored, a bug_hunt project whose RM project closed stayed 'active' forever
// and every later bug_hunt on that repo got a permanent 409
// `bug_hunt_project_exists`. That was the guarantee D-run12-9 broke.
//
// What this tick does: take a bounded, ROTATING page of projects with a LIVE
// stored status, read their RM state through `projectStatesFor` — the SAME bulk
// loader (one paged RM list per tenant, 60 s cached) the project list route
// uses, not a second RM client — and call `stampDeliveryIfRmClosed` for each
// whose RM pm_project is closed. Reads are untouched: this worker is the only
// thing that writes a delivery.
//
// ⭐ The state source is a REQUIRED parameter of
// `runProjectDeliveredReconcileTick` (`ProjectStatesLoader`), never a module
// lookup and never an optional parameter. Its ONE production caller —
// `startProjectDeliveredReconcileWorker` below — passes the real
// `projectStatesFor`, so nothing is defaulted and nothing can be omitted. A
// required parameter supplied by the only production caller is ordinary
// dependency injection; an OPTIONAL parameter defaulting to the real one would
// exist solely so a test could swap in a collaborator, and that is a test-only
// hook (backend/CLAUDE.md, owner ruling 2026-10-29: no optional
// fake-collaborator parameters). The tests supply the required argument like
// any other caller.
//
// ⭐ SELECTION: A ROTATING CURSOR, NOT "THE OLDEST N" (audit finding, 2026-10-31).
// The first version took the 25 oldest by `updated_at` on every tick. That
// starves the tail: a project whose RM never closes is never stamped, so its
// row never changes, so it keeps its place at the head and is re-picked every
// tick — and above one batch of live projects the newer ones are NEVER examined
// at all, so a delivered project past the head never frees its repo's bug_hunt
// slot. Selection is now:
//
//     WHERE live AND (cursor IS NULL OR id > cursor) ORDER BY id LIMIT <batch>
//
// with a worker-local cursor holding the last id the previous tick examined. A
// SHORT page (fewer rows than the batch) proves the end of the ordered set was
// reached, so the cursor WRAPS to the first page on the next tick: every live
// project is examined within one full cycle, and the per-tick bound is
// unchanged. `id` is the cursor key, not `updated_at`, because `id` is
// IMMUTABLE: any write — including this worker's own stamp — moves
// `updated_at`, and a cursor on a mutable sort key can skip rows that move
// behind it until the following cycle. No freshness ordering is lost: this
// tick stores a state RM already holds, so it is a sweep for COVERAGE, not a
// race to the newest.
//
// The cursor is PROCESS-local, deliberately. Two replicas sweeping the same
// table is harmless: the cursor only chooses which page is read, and every
// write is a self-guarded UPDATE (see Concurrency). A restart resets the
// cursor to the first page — a repeat, never a miss.
//
// Concurrency: NO ADVISORY LOCK, deliberately. Every write is a single
// conditional UPDATE whose WHERE re-checks `projectIsLive()` and
// `ne(status,'failed')` on the row it locks, so two replicas ticking together
// stamp each project at most once and neither can re-open an archived or
// cancelled row. A lost race is a zero-row UPDATE, not an error.
//
// Failure isolation: an RM state that could not be read (or a DB error while
// stamping) skips THAT project and is reported via `reportSwallowedFailure`;
// the rest of the page still runs, and the skipped project is retried on a
// later tick — its next visit in the rotation at the latest. The cursor is
// advanced BEFORE the RM read on purpose: a page this tick HAS examined must
// never be re-pinned, or a persistently failing lookup would re-create exactly
// the head-of-line blocking the cursor exists to remove.
//
// Env: PROJECT_DELIVERED_RECONCILE_DISABLED=true (kill switch, read by
// server.ts at registration), PROJECT_DELIVERED_RECONCILE_INTERVAL_MS
// (default 5 min), PROJECT_DELIVERED_RECONCILE_BATCH_SIZE (default 25).

import { and, asc, gt } from 'drizzle-orm';

import { db as defaultDb } from '../db/client';
import { projects } from '../db/schema';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { PM_PROJECT_CLOSED_STATUS } from '../integrations/pm';
import { projectIsLive } from '../lib/project-live-status';
import { projectStatesFor, type ProjectStatesLoader } from '../services/catalogue/project-state';
import { PROJECT_TENANT_UNKNOWN } from '../services/catalogue/tenant-catalogue';
import { stampDeliveryIfRmClosed } from '../services/project-delivered';

const DEFAULT_INTERVAL_MS = 5 * 60 * 1000; // 5 min
const DEFAULT_BATCH_SIZE = 25;

export interface DeliveryReconcileTickResult {
  outcome: 'ok' | 'failed';
  /** Projects this tick stamped `delivered` (empty on a quiet tick). */
  stamped: string[];
  /** How many projects this tick read the RM state of (the page size). */
  checked: number;
  /** Ids of the projects on that page, in the order examined (the rotation position). */
  checkedIds: string[];
  error?: string;
}

function batchSize(): number {
  const raw = Number(process.env.PROJECT_DELIVERED_RECONCILE_BATCH_SIZE ?? DEFAULT_BATCH_SIZE);
  if (!Number.isFinite(raw)) return DEFAULT_BATCH_SIZE;
  return Math.min(Math.max(Math.trunc(raw), 1), 200);
}

/**
 * `projects.id` of the last row the previous tick examined, or null at the
 * start of a cycle (no tick yet this process, or the previous page was short —
 * the end of the ordered set — so the next page is the first one).
 */
let cursor: string | null = null;

/** The rotation state AFTER a page: null when the page was short (wrap). */
function cursorAfter(rows: ReadonlyArray<{ id: string }>, size: number): string | null {
  if (rows.length < size) return null;
  return rows[rows.length - 1]!.id;
}

/**
 * One sweep. Batch: PROJECT_DELIVERED_RECONCILE_BATCH_SIZE (read per call).
 *
 * `loadStates` is REQUIRED: the RM state source, `projectStatesFor` from the
 * worker's only caller. It is not defaulted, so the production path and every
 * test path name the same single argument — see the header for why a default
 * (an optional parameter existing only for tests) is banned.
 */
export async function runProjectDeliveredReconcileTick(
  loadStates: ProjectStatesLoader,
): Promise<DeliveryReconcileTickResult> {
  const db = defaultDb;
  try {
    const size = batchSize();
    const rows = await db
      .select({
        id: projects.id,
        name: projects.name,
        status: projects.status,
        project_data: projects.project_data,
      })
      .from(projects)
      .where(cursor === null ? projectIsLive() : and(projectIsLive(), gt(projects.id, cursor)))
      .orderBy(asc(projects.id))
      .limit(size);
    // Advance the rotation BEFORE the RM read: this tick HAS examined this
    // page (see "Failure isolation" in the header).
    cursor = cursorAfter(rows, size);
    const checkedIds = rows.map((r) => r.id);
    if (rows.length === 0) return { outcome: 'ok', stamped: [], checked: 0, checkedIds };

    // The list route's loader: one paged RM list per tenant, cached 60 s. It
    // encodes an RM failure as `{ok:false}` per project instead of throwing.
    const states = await loadStates(rows);

    const stamped: string[] = [];
    for (const row of rows) {
      const st = states.get(row.id);
      if (!st) continue;
      if (!st.ok) {
        // An untagged project has no RM project to close, so it can never be
        // delivered — a configuration fact, not a failing RM call. Skipped
        // without an error line, or every tick would report it as an outage.
        if (st.code === PROJECT_TENANT_UNKNOWN) continue;
        reportSwallowedFailure(new Error(`${st.code}: ${st.message}`), {
          service: 'project-delivered-reconcile',
          method: 'GET',
          path: `project-state:${row.id}`,
          degradedTo: `project ${row.id} not evaluated this tick (retried on a later tick)`,
        });
        continue;
      }
      // Skip before touching the write path: only a closed RM project can be
      // delivered. `stampDeliveryIfRmClosed` re-checks this itself.
      if (st.state.pm.status !== PM_PROJECT_CLOSED_STATUS) continue;
      try {
        if (await stampDeliveryIfRmClosed(row, st)) stamped.push(row.id);
      } catch (err) {
        reportSwallowedFailure(err, {
          service: 'project-delivered-reconcile',
          degradedTo: `project ${row.id} left unstamped this tick (retried on a later tick)`,
        });
      }
    }
    return { outcome: 'ok', stamped, checked: rows.length, checkedIds };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'project-delivered-reconcile',
      degradedTo: 'no delivery stamped this tick (retried on a later tick)',
    });
    return {
      outcome: 'failed',
      stamped: [],
      checked: 0,
      checkedIds: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/** Idempotent. Interval override: PROJECT_DELIVERED_RECONCILE_INTERVAL_MS. */
export function startProjectDeliveredReconcileWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.PROJECT_DELIVERED_RECONCILE_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[project-delivered-reconcile] interval invalid, refusing to start');
    return;
  }
  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      // The ONE production call site: the real state source, named explicitly
      // because the parameter is required (see the header).
      const r = await runProjectDeliveredReconcileTick(projectStatesFor);
      if (r.stamped.length > 0 || r.outcome === 'failed') {
        console.log(
          `[project-delivered-reconcile] outcome=${r.outcome} checked=${r.checked}` +
            (r.checkedIds.length ? ` checked_ids=${r.checkedIds.join(',')}` : '') +
            ` stamped=${r.stamped.length}` +
            (r.stamped.length ? ` ids=${r.stamped.join(',')}` : '') +
            (r.error ? ` error=${r.error}` : ''),
        );
      }
    } finally {
      tickInFlight = false;
    }
  };
  void runOnce();
  timer = setInterval(() => void runOnce(), intervalMs);
  console.log(`[project-delivered-reconcile] scheduler started, interval=${intervalMs}ms batch=${batchSize()}`);
}

export function stopProjectDeliveredReconcileWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
