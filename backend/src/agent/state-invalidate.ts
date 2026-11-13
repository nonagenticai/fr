/**
 * fr-agui SPEC §4.3 / §5.3 — which UI resources a write may have changed.
 *
 * Invalidation, not a patch: fr has no shared state model to patch against.
 * The frontend stores subscribe by resource key and re-fetch:
 *
 *   project:<id>    activeProject / cockpit
 *   board:<id>      kanbanStore (the project's board)
 *   approvals:me    the caller's approvals / needs-you
 *   approvals:<id>  the project's sign-offs
 *   assets:<id>     the project's library tabs
 *
 * Emitted by the agent loop after a write that ran or parked
 * (`state-invalidate`), and returned by the confirm-card route
 * (`POST /api/capabilities/:id/invoke`) as `invalidate` so the card can raise it.
 * Pure and env-free.
 */

const NS_RESOURCES: Readonly<Record<string, ReadonlyArray<'project' | 'board' | 'approvals' | 'assets'>>> = {
  kanban: ['board', 'project'],
  approvals: ['approvals', 'project', 'board'],
  agent: ['assets', 'project'],
  toc: ['assets', 'project'],
  coding: ['project'],
  projects: ['project'],
  // P2-b: an OQ-16 edit and a FileCard upload change the project's assets.
  project_assets: ['assets', 'project'],
  documents: ['assets', 'project'],
  // P2-c2: a reviewed artifact changes the project's outputs.
  artifacts: ['assets', 'project'],
  // A confirmed ArchiMate modeling write changes the project's architecture models.
  architecture: ['assets', 'project'],
};

export function invalidationsFor(actionName: string, projectId: string | null): string[] {
  const ns = actionName.slice(0, Math.max(0, actionName.indexOf('.')));
  const kinds = NS_RESOURCES[ns] ?? [];
  const out = new Set<string>();
  // A write can always change what needs the caller.
  if (ns === 'approvals' || kinds.length > 0) out.add('approvals:me');
  if (!projectId) return [...out];
  for (const k of kinds) out.add(`${k}:${projectId}`);
  return [...out];
}
