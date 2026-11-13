// Reconcile script: archive fr projects whose Planka board no longer exists.
//
// Why this exists: fr stamps `projects.planka_board_id` at creation but never
// reconciles it against Planka. When a board is deleted in Planka out-of-band
// (e.g. a finished IT-flow/AA test board cleaned up there), the fr project row
// survives with a dead board id — so the project keeps appearing in the list and
// 404s the moment a user opens its board ("This board no longer exists in Planka").
//
// This walks every non-archived project that carries a planka_board_id, cross-
// checks it against the live Planka board set (one agent call — the SA sees every
// board), and soft-deletes the orphans (status -> 'archived'), the same state
// handleDeleteProject uses. handleListProjects already excludes 'archived', so a
// fresh login stops offering boards that don't exist.
//
// BOARD POINTER: an archived orphan whose board is PROVEN gone also has its
// `planka_board_id` NULLed, in the same UPDATE as the archive (conditional on
// the pointer still naming that board). Proof is `confirmBoardMissing`
// (src/services/planka/confirm-board-missing.ts): a board GET 404 is NOT enough
// on its own — Planka 404s boards the agent may not see — so it also requires
// the agent to be a project manager of the row's `planka_project_id`, a project
// that no longer lists the board. Mere absence from the list is never proof.
// Before 2026-09-24 this script kept the dead id, one source of the 187
// dangling refs measured on prod. A board 404 without that proof
// (`unverified_404`) and any other probe failure (401/403/5xx/network) archive
// as before but leave the pointer.
//
// SAFETY: dry-run by DEFAULT — it only reports. Pass --apply to archive. If the
// live Planka call fails we abort (never archive on an empty/partial board set).
// It also REFUSES to archive any project that still has `documents` rows — see the
// HIPAA right-to-delete guard in main() for why this script skips rather than purges.
//
// Usage (run inside the fr-backend pod, which carries DATABASE_URL + PLANKA_* env):
//   bun run scripts/reconcile-orphaned-projects.ts            # dry-run, report only
//   bun run scripts/reconcile-orphaned-projects.ts --apply    # archive the orphans

import { and, eq, inArray, isNotNull, ne } from 'drizzle-orm';
import { db, projects, documents, closeConnection } from '../src/db/client';
import { plankaClient } from '../src/services/planka';
import {
  agentConfirmDeps,
  confirmBoardMissing,
  type BoardAbsenceVerdict,
} from '../src/services/planka/confirm-board-missing';

interface OrphanRef {
  id: string;
  board: string;
  /** fr's record of the board's owning Planka project; null ⇒ absence unprovable. */
  plankaProjectId: string | null;
}

interface ArchiveOrphansResult {
  archived: number;
  /** Subset of `archived` whose board pointer was also NULLed. */
  cleared: number;
  /** Rows whose pointer changed between plan and write — left alone. */
  repointed: number;
  /** Board 404 whose absence could not be proven — archived, pointer KEPT. */
  unverified_404: number;
}

/**
 * Ask `confirmBoardMissing` (as the agent) about each orphan's board; archive every orphan, and
 * clear the pointer ONLY for a board proven missing. Dry-run probes (read-only)
 * and reports.
 */
async function archiveOrphans(
  orphans: OrphanRef[],
  apply: boolean,
): Promise<ArchiveOrphansResult> {
  const confirmDeps = agentConfirmDeps(plankaClient.asAgent());
  const result: ArchiveOrphansResult = { archived: 0, cleared: 0, repointed: 0, unverified_404: 0 };
  for (const p of orphans) {
    let v: BoardAbsenceVerdict;
    try {
      v = await confirmBoardMissing(p.board, p.plankaProjectId, confirmDeps);
    } catch (err) {
      v = { verdict: 'error', reason: err instanceof Error ? err.message : String(err) };
    }
    const provenMissing = v.verdict === 'missing';
    if (v.verdict === 'exists') {
      console.log(`  - ${p.id}  board=${p.board} answered a GET (not 404) — pointer kept`);
    } else if (v.verdict === 'unverified_404') {
      result.unverified_404++;
      console.log(`  - ${p.id}  board=${p.board} unverified 404 (${v.reason}) — pointer kept`);
    } else if (v.verdict === 'error') {
      console.log(`  - ${p.id}  board=${p.board} probe failed (${v.reason}) — absence NOT verified, pointer kept`);
    }
    if (!apply) {
      if (provenMissing) console.log(`  - ${p.id}  board=${p.board} proven missing — would clear pointer`);
      continue;
    }
    if (provenMissing) {
      const n = await archiveAndClearBoardRow(p.id, p.board);
      if (n === 0) {
        result.repointed++;
        console.log(`  - ${p.id}  pointer no longer ${p.board} — repointed meanwhile, left alone`);
        continue;
      }
      result.cleared++;
    } else {
      await db
        .update(projects)
        .set({ status: 'archived', updated_at: new Date() })
        .where(eq(projects.id, p.id));
    }
    result.archived++;
  }
  return result;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  console.log(`[reconcile] mode: ${apply ? 'APPLY (will archive orphans)' : 'DRY-RUN (report only)'}`);

  // Live board set from Planka (the SA agent sees every board).
  let liveBoardIds: Set<string>;
  try {
    const resp = await plankaClient.asAgent().projects.listWithIncluded();
    liveBoardIds = new Set((resp.included?.boards ?? []).map((b) => b.id));
  } catch (err) {
    console.error('[reconcile] ABORT — could not list live Planka boards:', err);
    process.exit(1);
  }
  console.log(`[reconcile] live Planka boards: ${liveBoardIds.size}`);

  // Candidate projects: not already archived, carrying a planka_board_id.
  const candidates = await db
    .select({
      id: projects.id,
      name: projects.name,
      board: projects.planka_board_id,
      plankaProjectId: projects.planka_project_id,
      status: projects.status,
    })
    .from(projects)
    .where(and(ne(projects.status, 'archived'), isNotNull(projects.planka_board_id)));

  const orphans = candidates.filter((p) => p.board && !liveBoardIds.has(p.board));
  console.log(`[reconcile] candidates: ${candidates.length}, orphaned (dead board): ${orphans.length}`);
  for (const p of orphans) {
    console.log(`  - ${p.id}  board=${p.board}  status=${p.status}  "${p.name}"`);
  }

  if (!apply) {
    await archiveOrphans(toRefs(orphans), false);
    console.log('[reconcile] dry-run complete — re-run with --apply to archive the above.');
    return;
  }

  // ---------------------------------------------------------------------------
  // HIPAA right-to-delete guard.
  //
  // Archiving hides a project from handleListProjects, so archiving one that
  // still has `documents` rows would leave that document's ePHI live downstream
  // (kag_graph chunks/entities/Neo4j, orchestrator job state, MinIO images) AND
  // invisible in fr — the same bypass the two DELETE surfaces were fixed for.
  //
  // DECISION: this script REFUSES those projects rather than calling
  // `archiveProjectWithPurge`. That is deliberate, and it is the opposite call
  // from the two DELETE handlers. Reason: a DELETE is a human expressing intent
  // to destroy THAT project's data, so purging is exactly what they asked for.
  // This script is not that. Its trigger is "a Planka board vanished" — a kanban
  // housekeeping event that carries no deletion intent whatsoever and is not
  // per-project reviewed. Firing irreversible, cross-tenant PHI purges from an
  // unattended batch job on that signal would make a board cleanup silently
  // destroy customer medical data, with a blast radius equal to however many
  // orphans the run happened to find. Skipping is fully recoverable (the operator
  // runs DELETE /api/projects/:id, which purges properly and is auditable);
  // purging is not. So: archive only the projects where archiving is a pure
  // visibility change, and report the rest loudly.
  // ---------------------------------------------------------------------------
  const orphanIds = orphans.map((p) => p.id);
  const docRows =
    orphanIds.length > 0
      ? await db
          .select({ project_id: documents.project_id })
          .from(documents)
          .where(inArray(documents.project_id, orphanIds))
      : [];
  const idsWithDocuments = new Map<string, number>();
  for (const r of docRows) {
    if (r.project_id) idsWithDocuments.set(r.project_id, (idsWithDocuments.get(r.project_id) ?? 0) + 1);
  }

  const skipped = orphans.filter((p) => idsWithDocuments.has(p.id));
  const archivable = orphans.filter((p) => !idsWithDocuments.has(p.id));

  if (skipped.length > 0) {
    console.warn(
      `[reconcile] REFUSING to archive ${skipped.length} orphaned project(s): they still ` +
        'have uploaded document rows, and archiving would hide the project while its ' +
        'ePHI stayed live downstream (kag_graph/Neo4j/MinIO/orchestrator). This script ' +
        'will not issue PHI purges — a dead Planka board is not a deletion request. ' +
        'To retire one of these, use DELETE /api/projects/:id (or the admin console\'s ' +
        'DELETE), which purges each document\'s downstream PHI fail-closed first:',
    );
    for (const p of skipped) {
      console.warn(
        `  - SKIPPED ${p.id}  board=${p.board}  documents=${idsWithDocuments.get(p.id)}  "${p.name}"`,
      );
    }
  }

  const { archived, cleared, repointed, unverified_404 } = await archiveOrphans(
    toRefs(archivable),
    true,
  );
  console.log(
    `[reconcile] archived ${archived} orphaned project(s) (board pointer cleared on ${cleared} ` +
      `proven-missing; kept on ${unverified_404} unverified 404); ${repointed} repointed ` +
      'meanwhile and left alone; ' +
      `skipped ${skipped.length} that still hold documents (see above).`,
  );
}

function toRefs(
  rows: Array<{ id: string; board: string | null; plankaProjectId: string | null }>,
): OrphanRef[] {
  return rows.flatMap((p) =>
    p.board ? [{ id: p.id, board: p.board, plankaProjectId: p.plankaProjectId }] : [],
  );
}

/**
 * Real writer: archive AND NULL the pointer iff it STILL names `boardId`. The
 * `planka_board_id = boardId` guard keeps a row repointed between the read and
 * this UPDATE intact — tested against Postgres in
 * tests/unit/scripts/board-pointer-conditional-clear.test.ts.
 */
export async function archiveAndClearBoardRow(projectId: string, boardId: string): Promise<number> {
  const rows = await db
    .update(projects)
    .set({ status: 'archived', planka_board_id: null, updated_at: new Date() })
    .where(and(eq(projects.id, projectId), eq(projects.planka_board_id, boardId)))
    .returning({ id: projects.id });
  return rows.length;
}

if (import.meta.main) {
  try {
    await main();
  } finally {
    await closeConnection();
  }
}
