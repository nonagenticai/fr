// Decide whether a Planka board is PROVABLY gone — the one gate every code
// path that clears `projects.planka_board_id` must pass.
//
// ── WHY A BARE 404 IS NOT PROOF ─────────────────────────────────────────────
// Planka answers 404 for boards the caller may not see, not only for boards
// that do not exist. In the deployed fork (planka-private 2.1.0):
//   * `server/api/controllers/boards/show.js`   — `throw Errors.BOARD_NOT_FOUND;
//     // Forbidden` unless the caller is a project manager of the board's
//     project or a member of the board (an admin bypasses only on a project
//     with no `ownerProjectManagerId`).
//   * `server/api/controllers/boards/delete.js` — the same 404 unless the caller
//     is a project manager; being admin does not bypass it.
//   * `server/api/controllers/projects/show.js` — `throw Errors.PROJECT_NOT_FOUND;
//     // Forbidden` unless the caller is a project manager or holds a board
//     membership in the project. ⚠️ So a PROJECT 404 is ambiguous in exactly the
//     same way, and is NOT treated as proof here either.
// If fr's agent ever loses project-manager rights, every one of those 404s
// would read as "gone" and a clear would wipe a pointer to a board that still
// exists.
//
// ── THE RULE ────────────────────────────────────────────────────────────────
// A board is `missing` ONLY when ALL of these hold:
//   1. `GET /api/boards/:id` → 404, AND
//   2. fr knows the board's owning Planka project id, AND
//   3. `GET /api/projects/:projectId` → 200, AND
//   4. the agent's Planka user id is in that response's
//      `included.projectManagers[].userId` — a project manager can see every
//      board in its project (boards/show.js skips the membership check), so for
//      it a board 404 can only come from `getPathToProjectById` → pathNotFound,
//      i.e. the board row does not exist; AND
//   5. the board is NOT listed in `included.boards` (for a PM that is every
//      board of the project — `Board.qm.getByProjectId`); listed = contradicts
//      the 404, so we do not trust either answer.
// Boards cannot move between projects (boards/update.js takes no projectId), so
// the fr-recorded project id stays the board's owner for its whole life.
//
// Anything else after a board 404 — no project id, project 404, project read
// failure, agent not a PM, `me` unreadable — is `unverified_404`: the caller
// must NOT clear, and should count and list it. A non-404 board failure is
// `error`; a board that answers is `exists`.

import { PlankaNotFoundError } from './errors';
import type { ProjectDetailResponse } from './projects';

export type BoardAbsenceVerdict =
  | { verdict: 'exists' }
  | { verdict: 'missing'; reason: string }
  | { verdict: 'unverified_404'; reason: string }
  | { verdict: 'error'; reason: string };

export interface ConfirmBoardMissingDeps {
  /** `GET /api/boards/:id` as the agent. Throws PlankaNotFoundError on 404. */
  getBoard: (boardId: string) => Promise<unknown>;
  /** `GET /api/projects/:id` as the agent, WITH its `included` block. */
  getProjectDetail: (projectId: string) => Promise<ProjectDetailResponse>;
  /** The agent's own Planka user id (`GET /api/users/me`). */
  agentUserId: () => Promise<string>;
}

function msg(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.length > 200 ? raw.slice(0, 200) + '…' : raw;
}

export async function confirmBoardMissing(
  boardId: string,
  projectId: string | null | undefined,
  deps: ConfirmBoardMissingDeps,
): Promise<BoardAbsenceVerdict> {
  try {
    await deps.getBoard(boardId);
    return { verdict: 'exists' };
  } catch (err) {
    if (!(err instanceof PlankaNotFoundError)) {
      return { verdict: 'error', reason: `board read failed: ${msg(err)}` };
    }
  }

  if (!projectId) {
    return { verdict: 'unverified_404', reason: 'board 404, but fr has no Planka project id for it' };
  }

  let detail: ProjectDetailResponse;
  try {
    detail = await deps.getProjectDetail(projectId);
  } catch (err) {
    return {
      verdict: 'unverified_404',
      reason:
        err instanceof PlankaNotFoundError
          ? `board 404 and project ${projectId} 404 — Planka 404s a project the agent is not a manager/member of, so this does not prove absence`
          : `board 404, project ${projectId} read failed: ${msg(err)}`,
    };
  }

  let agentId: string;
  try {
    agentId = await deps.agentUserId();
  } catch (err) {
    return { verdict: 'unverified_404', reason: `board 404, agent identity unreadable: ${msg(err)}` };
  }

  const managers = detail.included?.projectManagers ?? [];
  if (!agentId || !managers.some((m) => m?.userId === agentId)) {
    return {
      verdict: 'unverified_404',
      reason: `board 404, but the agent is not a project manager of project ${projectId}`,
    };
  }

  if ((detail.included?.boards ?? []).some((b) => b?.id === boardId)) {
    return {
      verdict: 'unverified_404',
      reason: `board 404, yet project ${projectId} still lists it — contradictory answers`,
    };
  }

  return { verdict: 'missing', reason: `board 404 and the agent manages project ${projectId}, which does not list it` };
}

/** Production deps: the agent Planka client, with `me` cached per deps object. */
export function agentConfirmDeps(agent: {
  boards: { get: (id: string) => Promise<unknown> };
  projects: { getDetail: (id: string) => Promise<ProjectDetailResponse> };
  members: { me: () => Promise<{ id: string }> };
}): ConfirmBoardMissingDeps {
  let me: Promise<string> | undefined;
  return {
    getBoard: (id) => agent.boards.get(id),
    getProjectDetail: (id) => agent.projects.getDetail(id),
    agentUserId: () => {
      me ??= agent.members.me().then((u) => u.id);
      // A failed lookup must not be cached forever.
      me.catch(() => {
        me = undefined;
      });
      return me;
    },
  };
}
