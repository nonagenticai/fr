// Where the header project switcher navigates when the user picks `nextId`.
//
// Picking a project always opens it. On a project-scoped route
// (`/projects/<id>[/<sub>]`) the id is swapped and the sub-path kept, so a user
// on the Board of project A lands on the Board of project B; from anywhere else
// the user lands on the project's own page. `/projects/new` and
// `/projects/requests…` are not project-scoped routes.
const NOT_A_PROJECT_ID = new Set(['new', 'requests']);

export function projectSwitchTarget(pathname: string, nextId: string): string {
  const m = /^\/projects\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!m || NOT_A_PROJECT_ID.has(m[1])) return `/projects/${nextId}`;
  const sub = m[2] ?? '';
  // A per-approval page belongs to the old project; land on its approvals hub.
  if (sub.startsWith('/approve/')) return `/projects/${nextId}`;
  return `/projects/${nextId}${sub}`;
}
