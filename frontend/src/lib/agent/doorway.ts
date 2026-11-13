/**
 * fr-agui SPEC §6.0 (OQ-15 = a): the tenant-level DOORWAY pages, where the agent
 * runs in request-intake mode (create a project, the request lifecycle, type
 * listing — nothing else). Exact paths: `/projects/new`, `/projects/intake`,
 * `/projects/requests` and `/projects/requests/<id>`.
 */
const DOORWAY_RE = /^\/projects\/(?:new|intake|requests(?:\/[^/]+)?)\/?$/;

export function isDoorwayPath(pathname: string): boolean {
	return DOORWAY_RE.test(pathname);
}

/**
 * fr-agui SPEC §5.1 / §13 P1c (OQ-17 = c): what the tenant shell's right rail is
 * on `pathname` — the doorway agent on a doorway page, and NO agent anywhere
 * else (the side pane with "Open a project to use the agent").
 */
export function tenantRailKind(pathname: string): 'doorway' | 'none' {
	return isDoorwayPath(pathname) ? 'doorway' : 'none';
}
