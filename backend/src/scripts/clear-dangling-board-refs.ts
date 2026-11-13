#!/usr/bin/env bun
//
// Clear `projects.planka_board_id` on fr rows whose Planka board no longer
// exists.
//
// Why this exists: measured on prod 2026-09-24, 187 of the 202 project rows
// carrying a board id point at a board Planka's GET answers 404 for — every one
// of them `archived`. (A 404 means gone OR not visible to the agent; see below.) They come from archive teardowns that deleted the board without
// NULLing the pointer (2026-07-01 #540 → 2026-09-17 #1145), from teardowns that
// hit a 404 on a board already deleted out-of-band (fixed alongside this
// script in services/project-archive.ts), and from
// scripts/reconcile-orphaned-projects.ts, which archived dead-board projects
// but left the id (it now clears a proven-missing pointer; so does the super-admin
// board DELETE in routes/assets/kanban.ts). Every reader then has to tell "board live"
// from "board gone, pointer never cleared" — the Runtime-State backfill, for
// one, planned 220 boards and failed 187 of them.
//
// What it does: for every project row with a non-placeholder planka_board_id,
// ask `confirmBoardMissing` (services/planka/confirm-board-missing.ts) whether
// the board is PROVABLY gone. A board 404 alone is NOT proof — Planka also 404s
// a board the agent may not see (boards/show.js `BOARD_NOT_FOUND; // Forbidden`)
// — so a ref is `dangling` only when the board GET 404s AND the agent is a
// project manager of the row's `planka_project_id` and that project does not
// list the board. A board 404 without that proof (no project id, project 404,
// agent not a PM) is `unverified_404`: counted, listed, never cleared. A live
// board is left alone; any other failure (401, 403, 5xx, network) is an error
// and the row is left alone. With --apply, each dangling ref is NULLed with a
// conditional UPDATE (`WHERE id = ? AND planka_board_id = ?`), so a row that
// was repointed in the meantime is not touched and a re-run is a no-op.
//
// Streams are out of scope: `streams.planka_board_id` is NOT NULL (migration
// 017), so a dead stream board cannot be cleared by NULLing.
//
// Usage (inside the fr-backend pod — DATABASE_URL + PLANKA_* env):
//   bun src/scripts/clear-dangling-board-refs.ts            # dry-run (DEFAULT)
//   bun src/scripts/clear-dangling-board-refs.ts --dry-run  # same, explicit
//   bun src/scripts/clear-dangling-board-refs.ts --apply    # NULL the refs
//
// Exits 1 if any board read (or, with --apply, any write) failed.

import { and, eq, isNotNull } from 'drizzle-orm';
import { db } from '../db/client';
import { projects } from '../db/schema';
import { PlankaClient } from '../services/planka';
import {
  agentConfirmDeps,
  confirmBoardMissing,
  type BoardAbsenceVerdict,
} from '../services/planka/confirm-board-missing';

const PLACEHOLDER = 'planka-tbd';

export interface ProjectBoardRef {
  id: string;
  planka_board_id: string;
  /** The board's owning Planka project, as fr recorded it. Null ⇒ absence unprovable. */
  planka_project_id: string | null;
  status: string;
}

export type DanglingStatus = 'live' | 'dangling' | 'cleared' | 'unverified_404' | 'error';

export interface DanglingItemResult {
  project_id: string;
  board_id: string;
  project_status: string;
  status: DanglingStatus;
  error?: string;
}

export interface DanglingSummary {
  total: number;
  live: number;
  dangling: number;
  cleared: number;
  /** Board 404 whose absence could NOT be proven — never cleared. */
  unverified_404: number;
  errors: number;
  results: DanglingItemResult[];
}

export interface RunClearDanglingOpts {
  /** true unless the caller explicitly asked for --apply. */
  dryRun: boolean;
  /** Project rows carrying a board id (placeholder rows are filtered here too). */
  loadRefs: () => Promise<ProjectBoardRef[]>;
  /** `confirmBoardMissing` bound to the agent. Only `missing` permits a clear. */
  confirmMissing: (boardId: string, projectId: string | null) => Promise<BoardAbsenceVerdict>;
  /** NULL the pointer iff it still equals `boardId`. Returns rows affected. */
  clearRef: (projectId: string, boardId: string) => Promise<number>;
}

function errMsg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

export async function runClearDanglingBoardRefs(
  opts: RunClearDanglingOpts,
): Promise<DanglingSummary> {
  const log = (m: string) => console.log(m);
  const mode = opts.dryRun ? ' (dry-run)' : ' (APPLY)';
  const refs = (await opts.loadRefs()).filter(
    (r) => r.planka_board_id && r.planka_board_id !== PLACEHOLDER,
  );
  log(`[plan]${mode} ${refs.length} project row(s) carrying a planka_board_id`);

  // One verdict per distinct (board, project) pair.
  const verdict = new Map<string, BoardAbsenceVerdict>();
  const results: DanglingItemResult[] = [];

  for (const ref of refs) {
    const boardId = ref.planka_board_id;
    const key = `${boardId}|${ref.planka_project_id ?? ''}`;
    let v = verdict.get(key);
    if (!v) {
      try {
        v = await opts.confirmMissing(boardId, ref.planka_project_id);
      } catch (err) {
        v = { verdict: 'error', reason: errMsg(err) };
      }
      verdict.set(key, v);
    }
    const base = {
      project_id: ref.id,
      board_id: boardId,
      project_status: ref.status,
    };
    if (v.verdict === 'exists') {
      results.push({ ...base, status: 'live' });
      continue;
    }
    if (v.verdict === 'error') {
      log(`[error] project=${ref.id} board=${boardId}: ${v.reason}`);
      results.push({ ...base, status: 'error', error: v.reason });
      continue;
    }
    if (v.verdict === 'unverified_404') {
      log(`[unverified] project=${ref.id} board=${boardId}: ${v.reason} — NOT cleared`);
      results.push({ ...base, status: 'unverified_404', error: v.reason });
      continue;
    }
    if (opts.dryRun) {
      log(
        `[plan] project=${ref.id} status=${ref.status} board=${boardId} ` +
          `proven missing in Planka — would clear planka_board_id`,
      );
      results.push({ ...base, status: 'dangling' });
      continue;
    }
    try {
      const n = await opts.clearRef(ref.id, boardId);
      log(
        n > 0
          ? `[ok] project=${ref.id} board=${boardId} planka_board_id cleared`
          : `[ok] project=${ref.id} board=${boardId} already changed — nothing to clear`,
      );
      results.push({ ...base, status: 'cleared' });
    } catch (err) {
      const msg = errMsg(err);
      log(`[error] project=${ref.id} board=${boardId}: clear failed: ${msg}`);
      results.push({ ...base, status: 'error', error: msg });
    }
  }

  const summary: DanglingSummary = {
    total: results.length,
    live: results.filter((r) => r.status === 'live').length,
    dangling: results.filter((r) => r.status === 'dangling').length,
    cleared: results.filter((r) => r.status === 'cleared').length,
    unverified_404: results.filter((r) => r.status === 'unverified_404').length,
    errors: results.filter((r) => r.status === 'error').length,
    results,
  };
  log(
    `[summary]${mode} total=${summary.total} live=${summary.live} ` +
      `dangling=${summary.dangling} cleared=${summary.cleared} ` +
      `unverified_404=${summary.unverified_404} errors=${summary.errors}`,
  );
  if (summary.unverified_404 > 0) {
    log('[summary] unverified 404s (board 404 but absence not proven — kept):');
    for (const r of results.filter((r) => r.status === 'unverified_404')) {
      log(`  - project=${r.project_id} board=${r.board_id}: ${r.error}`);
    }
  }
  return summary;
}

/** --apply is the only way to write; everything else (incl. no flag) is dry-run. */
export function isDryRun(argv: readonly string[]): boolean {
  return !argv.includes('--apply') || argv.includes('--dry-run');
}

/** Real reader: every project row carrying a board id. */
export async function loadProjectBoardRefs(): Promise<ProjectBoardRef[]> {
  const rows = await db
    .select({
      id: projects.id,
      planka_board_id: projects.planka_board_id,
      planka_project_id: projects.planka_project_id,
      status: projects.status,
    })
    .from(projects)
    .where(isNotNull(projects.planka_board_id));
  return rows.map((r) => ({
    id: r.id,
    planka_board_id: r.planka_board_id as string,
    planka_project_id: r.planka_project_id,
    status: String(r.status),
  }));
}

/**
 * Real writer: NULL the pointer iff it STILL names `boardId`. The
 * `planka_board_id = boardId` guard is what keeps a row repointed between the
 * read and this UPDATE from being wiped — tested against Postgres in
 * tests/unit/scripts/board-pointer-conditional-clear.test.ts.
 */
export async function clearProjectBoardRef(projectId: string, boardId: string): Promise<number> {
  const rows = await db
    .update(projects)
    .set({ planka_board_id: null, updated_at: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.planka_board_id, boardId)))
    .returning({ id: projects.id });
  return rows.length;
}

// --- Production wiring (tests never execute this block) ------------------

if (import.meta.main) {
  const dryRun = isDryRun(process.argv);
  const deps = agentConfirmDeps(PlankaClient.fromConfig().asAgent());
  runClearDanglingBoardRefs({
    dryRun,
    loadRefs: loadProjectBoardRefs,
    confirmMissing: (boardId, projectId) => confirmBoardMissing(boardId, projectId, deps),
    clearRef: clearProjectBoardRef,
  })
    .then((s) => process.exit(s.errors > 0 ? 1 : 0))
    .catch((err) => {
      console.error('[fatal]', err instanceof Error ? (err.stack ?? err.message) : err);
      process.exit(1);
    });
}
