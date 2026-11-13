// fr-agui SPEC §7.5 — the tenant-level URLs whose content now lives in the
// project shell, and where each one goes. Pure functions: the pages that own
// the old URLs call these with what the SERVER resolved (never a client
// guess) and `goto(target, { replaceState: true })` when a target comes back.
//
//   /kanban?board=<board of project P>  → /projects/P/board
//   /cards/[id]   (card → board → P)    → /projects/P/cards/[id]
//   /threads/[id] (thread.project_id P) → /projects/P/threads/[id]
//
// Each answers `null` = stay. A board / card / thread with NO project (a
// stream board, an ad-hoc card, an unbound thread) stays on its tenant view;
// so does one whose project the server did not state (`undefined`: an older
// backend). "Unknown" is never treated as "no project", and never invents one.
//
// The project-shell twins (`/projects/P/cards/[id]`, `/projects/P/threads/[id]`)
// use the same functions with their route's project id, so a card or thread
// opened under the WRONG project moves to its own one, and one with no project
// goes back to the tenant view. The two directions cannot loop: the tenant view
// redirects only on a non-null project, the project view only on a mismatch.

const enc = encodeURIComponent;

function isProjectId(v: unknown): v is string {
  return typeof v === 'string' && v.trim() !== '';
}

/** A board row as GET /api/kanban/boards returns it (only the fields used here). */
export interface BoardProjectRow {
  id: string;
  /** fr project whose `planka_board_id` is this board; null = not a project board. */
  frProjectId?: string | null;
}

/** `/kanban?board=<id>` → the owning project's board, or null (stay on /kanban). */
export function kanbanBoardRedirect(
  requestedBoardId: string | null,
  boards: readonly BoardProjectRow[],
): string | null {
  if (!requestedBoardId) return null;
  const board = boards.find((b) => b.id === requestedBoardId);
  if (!board || !isProjectId(board.frProjectId)) return null;
  return `/projects/${enc(board.frProjectId)}/board`;
}

/**
 * Where a card view should be, given the route it is on and the card's
 * server-resolved project.
 *
 * @param routeProjectId the `[id]` of a `/projects/[id]/cards/[cardId]` route,
 *                       or null on the tenant `/cards/[id]` route.
 */
export function cardViewRedirect(
  cardId: string,
  routeProjectId: string | null,
  cardProjectId: string | null | undefined,
): string | null {
  if (cardProjectId === undefined) return null; // not stated ⇒ stay
  if (isProjectId(cardProjectId)) {
    if (cardProjectId === routeProjectId) return null;
    return `/projects/${enc(cardProjectId)}/cards/${enc(cardId)}`;
  }
  // Explicitly no project: the tenant card view is its home.
  return routeProjectId === null ? null : `/cards/${enc(cardId)}`;
}

/** Same rule for an agent thread and its bound `project_id`. */
export function threadViewRedirect(
  threadId: string,
  routeProjectId: string | null,
  threadProjectId: string | null | undefined,
): string | null {
  if (threadProjectId === undefined) return null;
  if (isProjectId(threadProjectId)) {
    if (threadProjectId === routeProjectId) return null;
    return `/projects/${enc(threadProjectId)}/threads/${enc(threadId)}`;
  }
  return routeProjectId === null ? null : `/threads/${enc(threadId)}`;
}
