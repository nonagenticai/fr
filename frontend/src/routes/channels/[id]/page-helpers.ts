// page-helpers.ts — pure derivations for /channels/[id].
//
// Same convention as `routes/settings/usage/page-helpers.ts`: vitest runs in
// `environment: 'node'` and this page pulls `$app/stores` + `$app/navigation`,
// so the decision that matters is factored out here and asserted directly.

/**
 * What the schedule detail page may claim about the viewer's permissions.
 *
 * ## The defect
 *
 * `canEditSchedule` needs the owning project's `dept_id`. That read sat in its
 * own inner try, and its catch was `scheduleProjectDeptId = null` — so a failed
 * `GET /api/projects/:id` failed CLOSED, which is right, and did it SILENTLY,
 * which is not. Every action (Run now, Save, Delete) disappeared and the page
 * rendered as an ordinary read-only view. The user reads that as "I do not have
 * permission here", when the truth is that nothing about their permission was
 * ever determined. A deny and an unanswered question must not paint the same
 * pixels.
 *
 * - `actions`            — the RBAC check passed. Note it can pass even with the
 *   dept read lost: a workspace-admin is granted regardless of `dept_id`, so for
 *   them the lost input changed nothing and there is nothing to warn about.
 * - `permission-unknown` — not granted, AND the input the grant depends on could
 *   not be read. Hide the actions (the backend is the security boundary either
 *   way) but say WHY they are hidden.
 * - `denied`             — every input was read and the answer is no.
 */
export type ScheduleActionsState = 'actions' | 'permission-unknown' | 'denied';

export function scheduleActionsState(args: {
  canEdit: boolean;
  deptUnreadable: string | null | undefined;
}): ScheduleActionsState {
  if (args.canEdit) return 'actions';
  if (args.deptUnreadable != null && args.deptUnreadable !== '') {
    return 'permission-unknown';
  }
  return 'denied';
}
