// src/lib/projects/project-status.ts
//
// Project statuses after which the conveyor must not be handed more work from
// the UI. `archived` is fr's soft-delete; `delivered` (backend migration 173) is
// a project RM closed (older rows: a bug_hunt whose PR exists) — finished, shown,
// but closed. A card of such a project is not moved back to READY from fr.
//
// RM's own lifecycle status counts too (F9): a project the PM CLOSED reads fr `status`
// 'delivered' from its first read on (backend services/project-delivered.ts), but a row
// fr could not stamp (e.g. `failed`) keeps its status — `rm_status === 'closed'` still says
// it is closed, and without it the page offered every draft report of a closed project.

const CLOSED_PROJECT_STATUSES: readonly string[] = ['archived', 'delivered'];

/** true ⇒ hide card-moving / gate / review controls. Unknown (null/undefined) is NOT closed. */
export function isClosedProjectStatus(
  status: string | null | undefined,
  rmStatus: string | null | undefined = null,
): boolean {
  if (rmStatus === 'closed') return true;
  return status != null && CLOSED_PROJECT_STATUSES.includes(status);
}
