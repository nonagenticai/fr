// src/services/project-archive.ts
//
// The ONE way a project gets archived.
//
// Why this is a service and not a route helper
// --------------------------------------------
// `projects` rows have TWO archive surfaces: the user-facing
// `DELETE /api/projects/:id` and the super-admin console's
// `DELETE /api/admin/assets/projects/:id`. Both soft-delete by flipping
// `status` to `'archived'`. Until this module existed only the first one
// purged PHI; the admin one went straight to the UPDATE — and because a
// fleet-view super-admin can target ANY tenant's project from that surface,
// it was a cross-tenant HIPAA right-to-delete bypass (kag_graph chunks,
// Neo4j nodes, MinIO images and orchestrator job state survived the
// "delete"). Every archive path now funnels through `archiveProjectWithPurge`
// so a new surface cannot re-open the hole by forgetting a step.
//
// What an archive does, in order (each step's "why" is on the step):
//   0. CLOSE the project's RM pm_project                   (R351 / rm#272, fail-closed:
//      `status: closed`, the one later write RM accepts from fr. An RM failure
//      fails the archive BEFORE anything else happens — 502
//      `rm_project_close_failed`, nothing purged, voided or archived. RM holding
//      no pm_project for it (none of that origin, RM 404) is logged and the
//      archive goes on.)
//   1. purge the project's documents' downstream PHI            (fail-closed)
//   2. VOID the project's pending approvals                (fr#1134, fail-closed)
//   3. flip `status` to 'archived'
//   4. tear the Planka board/project down                  (fr#1142, best-effort,
//      guarded against shared boards, skippable with `keepBoard`)
//
// Steps 2-4 are `archiveProjectRow`; `archiveProjectWithPurge` is step 1 plus a
// call to it. That split exists so there is exactly ONE implementation of "flip
// a project to archived": the CVE-sweep supersede has a legitimate need to
// archive document-free priors without ever calling KAG (a KAG outage must not
// break project creation), and when it owned a second, bulk implementation of
// the flip it silently skipped step 2. Read the ⛔ on `archiveProjectRow`
// before calling it — the no-purge shortcut is safe only with evidence that the
// project has zero documents.
//
// Step 2 is new and its POSITION is the point: archiving hides a project's
// pending approvals from every operator surface while the cards they gate stay
// BLOCKED, so the rows must be withdrawn while they are still visible and
// while a failure can still abort the archive. Step 4's guard is new for the
// same class of reason: `planka_board_id` is not unique anywhere in the schema,
// so an unguarded board delete can destroy a live board another row still uses.

import { and, eq, ne, type SQL } from 'drizzle-orm';

import { db } from '../db/client';
import { closeRmProjectOrRefuse } from './catalogue/project-state';
import { AppError } from '../utils/errors';
import { approvals, projects, scheduledTriggers, streams } from '../db/schema';
import {
  emptyVoidCounts,
  voidApprovals,
} from '../lib/void-approvals';
import { purgeAndDeleteProjectDocuments } from '../routes/documents';
import { plankaAsAgent } from './planka/with-auth';
import { PlankaNotFoundError } from './planka/errors';
import { agentConfirmDeps, confirmBoardMissing } from './planka/confirm-board-missing';

/** Other rows that reference the same Planka board — see `findBoardHolders`. */
interface BoardHolders {
  /** `projects.id` of OTHER project rows carrying this `planka_board_id`. */
  projectIds: string[];
  /** `streams.id` of stream rows carrying this `planka_board_id` (migration 017). */
  streamIds: string[];
}

/** `scheduled_triggers.disabled_reason` written when archiving a project switches its triggers off. */
const ARCHIVED_SCHEDULE_DISABLED_REASON = 'project_archived';

/**
 * Every OTHER row holding `boardId`. A board is shared when a second
 * `projects` row was repointed at it, or when a `streams` row (whose
 * `planka_board_id` is NOT NULL, migration 017) lives on it.
 */
async function findBoardHolders(boardId: string, excludeProjectId: string): Promise<BoardHolders> {
  const [otherProjects, holdingStreams] = await Promise.all([
    db
      .select({ id: projects.id })
      .from(projects)
      .where(
        and(eq(projects.planka_board_id, boardId), ne(projects.id, excludeProjectId)),
      ),
    db.select({ id: streams.id }).from(streams).where(eq(streams.planka_board_id, boardId)),
  ]);
  return {
    projectIds: otherProjects.map((r) => r.id),
    streamIds: holdingStreams.map((r) => r.id),
  };
}

/** NULL out ONE Planka id column on the project row, after a confirmed delete. */
async function clearPlankaId(projectId: string, column: 'planka_board_id' | 'planka_project_id'): Promise<void> {
  await db
    .update(projects)
    .set(
      column === 'planka_board_id'
        ? { planka_board_id: null, updated_at: new Date() }
        : { planka_project_id: null, updated_at: new Date() },
    )
    .where(eq(projects.id, projectId));
}

/** Ids of this project's approvals still `status='pending'`. */
async function listPendingApprovalIds(projectId: string): Promise<string[]> {
  const rows = await db
    .select({ id: approvals.id })
    .from(approvals)
    .where(and(eq(approvals.project_id, projectId), eq(approvals.status, 'pending')));
  return rows.map((r) => r.id);
}

/**
 * The soft delete itself: `status='archived'`. With `guard`, the UPDATE's
 * WHERE is `id AND guard` and the number of rows flipped is returned, so a
 * caller's access predicate is enforced by the write itself (fr row 14d).
 */
async function setProjectArchived(projectId: string, guard?: SQL): Promise<number> {
  return db.transaction(async (tx) => {
    const now = new Date();
    const flipped = await tx
      .update(projects)
      .set({ status: 'archived', updated_at: now })
      .where(guard ? and(eq(projects.id, projectId), guard) : eq(projects.id, projectId))
      .returning({ id: projects.id });
    if (flipped.length === 0) return 0;
    // Switch the project's schedules off in the SAME transaction as the flip.
    // The tick already skips non-live projects, but a still-enabled row on an
    // archived project reads as "this runs" on every surface that lists it.
    // `disabled_reason` is the durable auto-disable marker (migration 094).
    await tx
      .update(scheduledTriggers)
      .set({ enabled: false, disabled_reason: ARCHIVED_SCHEDULE_DISABLED_REASON, updated_at: now })
      .where(and(eq(scheduledTriggers.project_id, projectId), eq(scheduledTriggers.enabled, true)));
    return flipped.length;
  });
}

/**
 * Thrown by `archiveProjectRow` when the caller passed a `guard` and the status
 * flip matched zero rows: the project stopped satisfying the caller's access
 * predicate between its load and the write (fr row 14d). The route maps it to
 * 404. Nothing after the flip (Planka teardown) runs.
 */
export class ProjectArchiveGuardRefusedError extends AppError {
  constructor(readonly projectId: string) {
    super(404, `archive of project ${projectId} refused: access predicate no longer matches`);
    this.name = 'ProjectArchiveGuardRefusedError';
  }
}

/** `voidApprovals` accepts at most 500 ids per call (`VoidApprovalsSchema`). */
const VOID_CHUNK = 500;

// Best-effort teardown of a project's Planka board + project. Planka has NO
// enforced FKs (Waterline/Sails app-layer integrity), so deleting the project
// does not cascade the board — delete the board FIRST, then the project.
// NEVER throws: a Planka hiccup must not fail the caller (the fr `projects` row
// is the source of truth for lifecycle state and is already archived by the
// caller). Used by (a) soft-delete/archive so an archived project stops leaving
// a live board behind, and (b) CVE-sweep re-drive supersession.
//
// ── Two things this does NOT do, and why (fr#1142) ─────────────────────────
// 1. It does not delete a board that ANOTHER row still points at. Nothing in
//    the schema makes `planka_board_id` unique: a second `projects` row can be
//    repointed at the same board, and `streams.planka_board_id` (migration 017,
//    NOT NULL) names boards from an entirely different table. Measured on prod
//    2026-09-17: 194 archived projects, 193 of them still carrying a non-null
//    `planka_board_id` — so the population that could collide is real and
//    large, even though no board is shared by two projects TODAY. An unguarded
//    `boards.delete` destroys a live board belonging to something that was
//    never archived, and Planka has no undelete. The guard skips the Planka
//    PROJECT delete too: a Planka project CONTAINS its board, so deleting it
//    while the board is shared is the same destruction by another route.
// 2. It does not leave a stale id behind after a delete that SUCCEEDED. The
//    board/project is gone from Planka but the fr row kept pointing at it —
//    which is exactly why 193 archived rows still carry a dead board id, and
//    why a later reader cannot tell "board still live" from "board deleted,
//    pointer never cleared". After a confirmed delete the column is NULLed; on
//    a CAUGHT failure it is deliberately left in place, because the resource
//    still exists in Planka and the pointer is still true.
//    A Planka 404 on the BOARD delete is ambiguous, not proof: planka-private
//    `boards/delete.js` answers `BOARD_NOT_FOUND; // Forbidden` to any caller
//    that is not a project manager (admin does not bypass). So after a board
//    404 the pointer is NULLed ONLY when `confirmBoardMissing` proves absence —
//    board GET 404 AND the agent manages this row's `planka_project_id`, which
//    no longer lists the board. An unproven 404 (`unverified_404`) keeps the
//    pointer. Measured on prod 2026-09-24: 187 of 202 project rows with a board
//    id get a 404 on the board GET, all `archived`, including 7 archived on
//    2026-09-21, i.e. AFTER #1145.
//    A 404 on the Planka PROJECT delete is NOT cleared at all: projects/delete.js
//    and projects/show.js both 404 a non-manager, and no agent-visible read can
//    tell a deleted project from one the agent no longer manages. The
//    `planka_project_id` pointer is kept, as for any other caught failure.
export async function teardownProjectPlankaResources(
  project: {
    id: string;
    planka_board_id: string | null;
    planka_project_id: string | null;
  },
  opts?: { keepBoard?: boolean },
): Promise<void> {
  // fr#1142: archive WITHOUT tearing the board down. The decision there was to
  // archive the project and LEAVE its board, so the operator surface loses the
  // project while the kanban work in flight on that board survives. Return
  // before anything constructs a Planka client — "keep the board" must mean
  // zero calls, not a call that happens to be a no-op.
  if (opts?.keepBoard) {
    console.log(
      `[projects.teardown] keepBoard set for project ${project.id} — leaving ` +
        `Planka board ${project.planka_board_id ?? 'none'} and Planka project ` +
        `${project.planka_project_id ?? 'none'} in place, no Planka calls made`,
    );
    return;
  }

  if (!project.planka_board_id && !project.planka_project_id) return;

  if (project.planka_board_id) {
    let holders: BoardHolders;
    try {
      holders = await findBoardHolders(project.planka_board_id, project.id);
    } catch (err) {
      // Cannot prove the board is unshared → treat sharing as UNKNOWN and fail
      // CLOSED, exactly like a confirmed holder. This function's contract is
      // "never throws"; a DB blip here must not become an admin-facing 500 on
      // an otherwise-successful archive, and it must not risk deleting a board
      // another row still points at just because the check itself failed.
      console.warn(
        `[projects.teardown] SKIPPING Planka teardown for project ${project.id}: ` +
          `findBoardHolders failed for board ${project.planka_board_id} (treating as ` +
          `possibly shared): ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }
    if (holders.projectIds.length > 0 || holders.streamIds.length > 0) {
      console.warn(
        `[projects.teardown] SKIPPING Planka teardown for project ${project.id}: ` +
          `board ${project.planka_board_id} is still referenced by ` +
          `project(s) [${holders.projectIds.join(', ') || 'none'}] and ` +
          `stream(s) [${holders.streamIds.join(', ') || 'none'}] — deleting it (or the ` +
          `Planka project containing it) would destroy a board those rows still use`,
      );
      return;
    }
  }

  const agent = plankaAsAgent();
  if (project.planka_board_id) {
    let deleted = false;
    try {
      await agent.boards.delete(project.planka_board_id);
      deleted = true;
    } catch (err) {
      if (err instanceof PlankaNotFoundError) {
        const v = await confirmBoardMissing(
          project.planka_board_id,
          project.planka_project_id,
          agentConfirmDeps(agent),
        );
        if (v.verdict === 'missing') {
          console.warn(
            `[projects.teardown] board ${project.planka_board_id} for project ` +
              `${project.id} proven absent (delete 404; ${v.reason}) — clearing the pointer`,
          );
          deleted = true;
        } else {
          console.warn(
            `[projects.teardown] board ${project.planka_board_id} for project ` +
              `${project.id}: delete 404 but absence NOT proven (${v.verdict}: ` +
              `${'reason' in v ? v.reason : 'board answered a GET'}) — pointer kept`,
          );
        }
      } else console.warn(
        `[projects.teardown] board delete failed for project ${project.id} ` +
          `(board ${project.planka_board_id}): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    // Only now is the pointer false. Clearing it before the call, or after a
    // failure, would assert a deletion that did not happen — hence the flag
    // rather than a trailing statement inside the `try` (which would also
    // mis-report a DB error as a Planka board-delete error).
    if (deleted) {
      try {
        await clearPlankaId(project.id, 'planka_board_id');
      } catch (err) {
        // The board IS gone from Planka; only the fr pointer write failed. This
        // function never throws, so warn and leave the (now-stale) pointer in
        // place rather than fail an otherwise-successful archive — the pointer
        // still names something real to a later reader, which is the same
        // "leave it in place" behaviour a caught Planka delete failure gets.
        console.warn(
          `[projects.teardown] clearPlankaId(planka_board_id) failed for project ` +
            `${project.id} after a successful board delete: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
  if (project.planka_project_id) {
    let deleted = false;
    try {
      await agent.projects.delete(project.planka_project_id);
      deleted = true;
    } catch (err) {
      console.warn(
        `[projects.teardown] project delete failed for project ${project.id} ` +
          `(planka ${project.planka_project_id}): ${err instanceof Error ? err.message : String(err)}` +
          (err instanceof PlankaNotFoundError
            ? ' — a project 404 may mean "not a project manager", so the pointer is kept'
            : ''),
      );
    }
    if (deleted) {
      try {
        await clearPlankaId(project.id, 'planka_project_id');
      } catch (err) {
        console.warn(
          `[projects.teardown] clearPlankaId(planka_project_id) failed for project ` +
            `${project.id} after a successful Planka project delete: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }
}

/**
 * Archive a project the ONLY sanctioned way: purge its documents' PHI, flip the
 * status, tear the Planka board down.
 *
 * `project` must already have been looked up AND authorized by the caller — this
 * function performs no access control; it is the shared effect, not the gate.
 *
 * `opts.tenantId` is the CALLER's active tenant. It is passed through for context
 * symmetry only and deliberately does NOT scope the document set — see the note on
 * `purgeAndDeleteProjectDocuments`: each document is purged under ITS OWN recorded
 * `documents.tenant_id` (record-and-replay). Filtering by the caller's active tenant
 * would be actively harmful here: a fleet-view admin's active tenant is
 * INTERNAL_SYSTEM_TENANT_ID, which matches ZERO real document rows, so the purge
 * would silently do nothing.
 *
 * `opts.actor` is REQUIRED and is written verbatim to `approvals.voided_by` for
 * every approval this archive withdraws. It is required rather than defaulted
 * so a NEW archive surface cannot quietly land an unattributed void — the
 * typechecker asks the question the audit column exists to answer.
 *
 * `opts.keepBoard` archives the project but leaves its Planka board standing
 * (fr#1142). It is forwarded to the teardown and nothing else.
 *
 * ── Why this voids the project's pending approvals, BEFORE the flip (fr#1134) ─
 * The approvals list query filters `ne(projects.status, 'archived')`
 * (`routes/approvals.ts:1354`), so the instant this function flips the status
 * every pending approval on the project disappears from every operator surface
 * — while the Planka cards those approvals gate stay BLOCKED, waiting on an
 * answer no human can now see the question for. Measured on prod 2026-09-17:
 * 55 such rows across already-archived projects, each one a permanently stuck
 * card. So the rows are VOIDED (not decided — see `lib/void-approvals.ts`: a
 * void is "this ask was never answerable; withdraw it", and it may never write
 * an `approval_decisions` row). The void is what unblocks the card: the
 * redelivery worker (`workers/deblock-callback-redelivery.ts:1731`) delivers a
 * voided row's callback with NO archived-project filter, so the card receives a
 * named reason (`approval_hold:X | decision:voided`) rather than silence.
 *
 * ORDER MATTERS, and this is the whole point of doing it here: the void must
 * run BEFORE the status flip. Afterwards the rows are invisible to the list
 * query, so a void attempted later is a write against rows no operator can
 * verify, and a FAILED void would leave the project archived with its stuck
 * approvals still pending and now unreachable. Running first makes the failure
 * mode fail-closed and retryable — exactly the discipline the purge above uses.
 * A throw from `voidApprovals` therefore propagates: the archive does NOT
 * proceed.
 */
export async function archiveProjectWithPurge(
  project: {
    id: string;
    name?: string | null;
    planka_board_id: string | null;
    planka_project_id: string | null;
    project_data?: unknown;
  },
  opts: { tenantId?: string; keepBoard?: boolean; actor: string; guard?: SQL },
): Promise<void> {
  // Step 0 FIRST: an RM failure must stop the archive before any irreversible purge.
  await closeRmProjectOrRefuse(project);
  // HIPAA right-to-delete: archiving a project MUST also purge its documents'
  // downstream PHI (product decision). This purges each document's kag_graph
  // chunks/entities/Neo4j, orchestrator job state and MinIO images via the
  // fail-closed ingestion coordinator, THEN deletes the fr document rows — all
  // BEFORE we archive the project. It is fail-closed: if any purge fails it
  // THROWS, so the archive does not proceed and no PHI is left orphaned behind an
  // archived project; the whole delete stays retryable. This must run before the
  // archive because the documents.project_id → projects FK is ON DELETE RESTRICT
  // (migration 090): the rows have to go before the project can ever be removed.
  await purgeAndDeleteProjectDocuments(project.id, {
    tenantId: opts.tenantId,
  });

  await archiveProjectRow(project, {
    keepBoard: opts.keepBoard,
    actor: opts.actor,
    guard: opts.guard,
    rmClosed: true,
  });
}

/**
 * The archive itself, WITHOUT the document purge: void the project's pending
 * approvals → flip `status` to 'archived' → tear the Planka board down.
 *
 * ⛔ This is NOT a public alternative to `archiveProjectWithPurge`. A caller may
 * use it ONLY when it has already established that the project has ZERO
 * documents, because skipping the purge on a project that HAS documents is the
 * exact cross-tenant HIPAA right-to-delete bypass this module exists to close.
 * There is precisely one such caller today: the document-free half of
 * `routes/projects.ts :: supersedePriorCveSweepProjects`, which SELECTs the
 * `documents` rows for its priors first and splits on the result. If you are
 * reaching for this function without that evidence in hand, you want
 * `archiveProjectWithPurge`.
 *
 * It exists as a seam for one reason (fr#1134): before the split, the
 * document-free branch archived with a bare bulk UPDATE plus a teardown loop,
 * which meant it flipped the status WITHOUT voiding the project's pending
 * approvals — a second archive path carrying the very defect
 * `archiveProjectWithPurge` had just been taught to close. Two archive
 * implementations is how that happens; there is now one, and the purge is the
 * only thing layered on top of it.
 *
 * Fail-closed on the void, exactly like the purge: a throw propagates and the
 * status is NOT flipped, so the project stays visible with its approvals still
 * answerable and the whole operation stays retryable.
 */
export async function archiveProjectRow(
  project: {
    id: string;
    name?: string | null;
    planka_board_id: string | null;
    planka_project_id: string | null;
    project_data?: unknown;
  },
  opts: { keepBoard?: boolean; actor: string; guard?: SQL; /** archiveProjectWithPurge already ran step 0. */ rmClosed?: boolean },
): Promise<void> {
  if (!opts.rmClosed) await closeRmProjectOrRefuse(project);
  // fr#1134 — withdraw the pending approvals BEFORE they become invisible. See
  // the ORDER MATTERS note on `archiveProjectWithPurge`; this must stay ahead
  // of the flip.
  const pendingIds = await listPendingApprovalIds(project.id);
  if (pendingIds.length > 0) {
    const tally = emptyVoidCounts();
    // `VoidApprovalsSchema` caps a call at 500 ids and `voidApprovals` takes ids only,
    // never a filter — so a project with more pending approvals than that is
    // chunked rather than converted into a query.
    for (let i = 0; i < pendingIds.length; i += VOID_CHUNK) {
      const outcomes = await voidApprovals({
        ids: pendingIds.slice(i, i + VOID_CHUNK),
        // >= 10 chars, as `VoidApprovalsSchema` requires; names the project so
        // `approvals.voided_reason` says WHY on the row itself.
        reason: `project archived: ${project.id}`,
        actor: opts.actor,
        dryRun: false,
      });
      for (const outcome of outcomes.values()) tally[outcome] += 1;
    }
    console.log(
      `[projects.archive] voided pending approvals for project ${project.id} ` +
        `(actor ${opts.actor}): ${pendingIds.length} pending at select — ` +
        `voided=${tally.voided} skipped_not_pending=${tally.skipped_not_pending} ` +
        `not_found=${tally.not_found} would_void=${tally.would_void}`,
    );
  }

  // Soft delete by setting status to archived
  const flipped = await setProjectArchived(project.id, opts.guard);
  if (opts.guard && flipped === 0) throw new ProjectArchiveGuardRefusedError(project.id);

  // Also tear down the Planka board+project so an archived project does not
  // leave a live board behind (previously the board lingered — a source of the
  // CVE-sweep board pile). Best-effort; the fr row is already archived above.
  // Guarded against shared boards, and skipped entirely under `keepBoard`.
  await teardownProjectPlankaResources(project, { keepBoard: opts.keepBoard });
}

