import { notInArray } from 'drizzle-orm';
import { projects } from '../db/schema';
import { AppError } from '../utils/errors';

/**
 * Project statuses that are NOT live work (George 2026-10-08).
 *
 * - `archived`  — the soft-delete state (unchanged meaning).
 * - `pending`   — allocated at project-request SUBMIT so every conveyor LLM
 *                 call made before approval (the outline workflow) can carry a
 *                 projectId. It has no board, no intake card, no stakeholders:
 *                 it becomes a real project ONLY when the request is approved
 *                 (routes/projects.ts createSingleProject promotes the SAME row
 *                 pending → active).
 * - `cancelled` — the pending row of a request that was rejected or withdrawn.
 *                 Kept (never deleted) so the spend already attributed to it
 *                 stays attributed.
 *
 * ⛔ Use this wherever a query means "live work" — the project list, live-
 * duplicate guards, workspace counts. Do NOT use it where a query means "not
 * soft-deleted" (e.g. the archived count) or where a pending project's own
 * records must stay visible (approvals lanes).
 *
 * - `delivered` — (migration 173) finished work. RM `closed` is DERIVED per
 *                 read (services/project-delivered.ts); the ONLY thing that
 *                 stores it is the reconcile worker
 *                 (workers/project-delivered-reconcile.ts), and only so this
 *                 index can free the repo's bug-hunt slot — a read never
 *                 writes. Rows stored before that or by the removed bug-hunt
 *                 check are the same state. Not live work
 *                 (it frees the repo's one-live-hunt slot) — but NOT hidden: it is
 *                 a real project a user opens. See HIDDEN_PROJECT_STATUSES.
 *
 * Mirrored in SQL by migrations 164/173 (the bug-hunt partial unique index) and
 * in db/schema.ts's declaration of that index — three emitters of one list.
 */
export const NON_LIVE_PROJECT_STATUSES = ['archived', 'pending', 'cancelled', 'delivered'] as const;

/** The terminal status a project reaches once RM closes it (migration 173; services/project-delivered.ts). */
export const DELIVERED_PROJECT_STATUS = 'delivered' as const;

/**
 * Statuses that are hidden from the default project list and workspace counts:
 * NON_LIVE_PROJECT_STATUSES minus `delivered`. A delivered project is finished
 * work, not a deleted or never-approved one — the list must still show it (with
 * its DELIVERED badge), exactly as it showed it a moment before delivery.
 */
export const HIDDEN_PROJECT_STATUSES = ['archived', 'pending', 'cancelled'] as const;

/** The two statuses a project request's pre-approval row can carry. */
export const PRE_APPROVAL_PROJECT_STATUSES = ['pending', 'cancelled'] as const;

/** Pure form of {@link projectIsLive}, for a status already in hand. */
export function isLiveProjectStatus(status: string | null | undefined): boolean {
  return !(NON_LIVE_PROJECT_STATUSES as readonly string[]).includes(status ?? '');
}

/** drizzle predicate: `projects.status` is live work. */
export function projectIsLive() {
  return notInArray(projects.status, [...NON_LIVE_PROJECT_STATUSES]);
}

/**
 * drizzle predicate: `projects.status` is shown by default — live work OR a
 * delivered project. For lists and counts; NEVER for duplicate guards (those
 * mean "live work" and must use {@link projectIsLive}).
 */
export function projectIsVisible() {
  return notInArray(projects.status, [...HIDDEN_PROJECT_STATUSES]);
}

/** drizzle predicate: `projects.status` is not a request's pre-approval row. */
export function projectIsNotPreApproval() {
  return notInArray(projects.status, [...PRE_APPROVAL_PROJECT_STATUSES]);
}

/** Machine-readable code on the 409 an archived project gets on a write lane (fr#1499). */
export const PROJECT_ARCHIVED = 'project_archived';

/**
 * Refuse a WRITE against an archived project: 409 `project_archived` (fr#1499).
 *
 * Why a write must not land there: archive is one-way (DELETE /api/projects/:id;
 * PatchProjectBodySchema has no `status`), and every operator view of a
 * project's records hides archived projects — the approvals project lane is
 * `ne(projects.status,'archived')` (routes/approvals.ts). An approval or card
 * minted on an archived project is therefore written and then INVISIBLE: the
 * card it gates waits forever on a question nobody can see. Refuse loudly at
 * the resolver instead of succeeding silently.
 *
 * ⛔ `archived` ONLY — deliberately NOT `NON_LIVE_PROJECT_STATUSES`. A `pending`
 * project exists precisely so the pre-approval conveyor calls can carry its id,
 * and the approvals lanes keep `pending`/`cancelled` visible (see that list's
 * comment). The refusal matches the exact predicate that makes a write
 * invisible, nothing wider.
 *
 * Call it only AFTER the tenant-scoped lookup has found the row, so a foreign
 * or unknown id still gets the existing 404 (no existence oracle).
 */
export function assertProjectNotArchived(project: { id: string; status?: string | null }): void {
  if (project.status === 'archived') {
    throw new AppError(
      409,
      `project_archived: project ${project.id} is archived; writes to an archived project are refused`,
      { project_id: project.id, status: project.status },
    ).withCode(PROJECT_ARCHIVED);
  }
}
