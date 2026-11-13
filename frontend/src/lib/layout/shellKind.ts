// Which shell the root layout renders for a route (fr-agui SPEC §7.2).
//
// A project gets its own environment: every page under
// `routes/(project)/projects/[id]/**` renders inside `ProjectShellLayout`
// (project nav + project header), and every other authenticated page keeps the
// tenant `ShellLayout`. The two never mix — a tenant page never shows project
// navigation, and the project shell never shows tenant admin.
//
// ⭐ KEYED ON THE ROUTE ID, NOT A PATHNAME REGEX. SvelteKit's `page.route.id`
// carries the `(project)` group segment; the URL does not. A pathname test
// (`/^\/projects\/[^/]+/`) would also capture the tenant-level doorway pages
// that share the `/projects/` prefix (`/projects/new`, `/projects/intake`,
// `/projects/requests`), which must stay in the tenant shell.

export type ShellKind = 'project' | 'tenant';

/** The route-group segment that marks a project-shell route. */
export const PROJECT_SHELL_GROUP = '(project)';

/** True for a route id inside the `(project)` group (`/(project)/projects/[id]/…`). */
export function isProjectShellRoute(routeId: string | null | undefined): boolean {
  if (!routeId) return false;
  return routeId === `/${PROJECT_SHELL_GROUP}` || routeId.startsWith(`/${PROJECT_SHELL_GROUP}/`);
}

export function shellKindFor(routeId: string | null | undefined): ShellKind {
  return isProjectShellRoute(routeId) ? 'project' : 'tenant';
}
