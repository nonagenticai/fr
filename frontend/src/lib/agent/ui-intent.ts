/**
 * fr-agui SPEC §5.4 / §13 P1c-b — where a `ui-intent` (navigation) may take the
 * browser.
 *
 * The backend already checked the route (agui/actions/ui-navigate.ts: the
 * project agent stays inside its own project shell, the doorway agent on the
 * doorway pages). This is the browser's own fail-closed check before `goto()`,
 * so a route the client did not expect — another project's shell, a tenant
 * page, an external URL, a protocol-relative `//host` — is never followed even
 * if a stream were tampered with or a backend regressed:
 *
 *   bound to project P  → only `/projects/P` and `/projects/P/…`
 *   unbound (doorway)   → only the doorway pages, or (after a create) a
 *                         project shell root `/projects/<id>`
 */
import { isDoorwayPath } from './doorway';

/**
 * ⛔ RESOLVE, THEN VALIDATE (P1c-b audit). Checking the raw string is not enough:
 * the browser — `goto()` and the chip's `<a href>` alike — resolves `%2e%2e` and
 * `.%2e` as dot segments, so `/projects/P/%2e%2e/Q/board` LANDS on Q. So:
 *   1. refuse anything that is not a plain root-relative path: a scheme, `//`,
 *      a backslash, whitespace/control chars, a fragment, ANY percent-encoding
 *      in the path, and an encoded `.` `/` `\` `%` anywhere (also in the query);
 *   2. resolve it with `new URL(route, origin)`, require the same origin, and
 *      require the resolved path to equal the raw one (nothing normalised away);
 *   3. validate the RESOLVED path against the binding, and return the resolved
 *      path + query — the ONE value both `goto` and the chip href use.
 * The backend's own check (`ui-navigate.ts`) never emits `%`, a query or a dot
 * segment, so none of these refusals can hit a route it would send.
 */
const PLAIN_PATH_RE = /^\/[A-Za-z0-9._~\-/]*$/;
const PLAIN_QUERY_RE = /^[A-Za-z0-9._~\-=&%+,]*$/;
const ENCODED_SEPARATOR_RE = /%(?:2e|2f|5c|25)/i;
const PROJECT_ROOT_RE = /^\/projects\/([0-9a-fA-F-]{36})\/?$/;
const FALLBACK_ORIGIN = 'http://fr.invalid';

export type IntentVerdict = { ok: true; route: string } | { ok: false; reason: string };

const NOT_FR = { ok: false, reason: 'only fr routes can be opened' } as const;

function currentOrigin(): string {
	try {
		const o = globalThis.location?.origin;
		return typeof o === 'string' && /^https?:\/\//.test(o) ? o : FALLBACK_ORIGIN;
	} catch {
		return FALLBACK_ORIGIN;
	}
}

/** The resolved, same-origin `{path, query}` of a plain route, or null. */
function resolvePlainRoute(route: string): { path: string; search: string } | null {
	if (!route.startsWith('/') || route.startsWith('//')) return null;
	if (ENCODED_SEPARATOR_RE.test(route)) return null;
	const q = route.indexOf('?');
	const rawPath = q === -1 ? route : route.slice(0, q);
	const rawQuery = q === -1 ? '' : route.slice(q + 1);
	if (!PLAIN_PATH_RE.test(rawPath) || !PLAIN_QUERY_RE.test(rawQuery)) return null;
	if (rawPath.split('/').some((seg) => seg === '..' || seg === '.')) return null;
	let url: URL;
	const origin = currentOrigin();
	try {
		url = new URL(route, origin);
	} catch {
		return null;
	}
	if (url.origin !== origin || url.username || url.password || url.hash) return null;
	if (url.pathname !== rawPath) return null;
	return { path: url.pathname, search: url.search };
}

export function checkUiIntent(route: unknown, boundProjectId: string | null | undefined): IntentVerdict {
	if (typeof route !== 'string' || route === '' || route.length > 512) {
		return { ok: false, reason: 'not a route' };
	}
	const r = resolvePlainRoute(route);
	if (!r) return NOT_FR;
	const { path } = r;
	const resolved = `${r.path}${r.search}`;
	if (boundProjectId) {
		const root = `/projects/${boundProjectId}`;
		return path === root || path.startsWith(`${root}/`)
			? { ok: true, route: resolved }
			: { ok: false, reason: "outside this project's shell" };
	}
	if (isDoorwayPath(path) || PROJECT_ROOT_RE.test(path)) return { ok: true, route: resolved };
	return { ok: false, reason: 'outside the doorway pages' };
}

/** The chip text for a navigation ("Opened Board"). */
export function intentChipLabel(route: string): string {
	const path = route.split('?')[0]!.replace(/\/$/, '');
	const m = /^\/projects\/[^/]+(?:\/(.*))?$/.exec(path);
	const area = m ? (m[1] ?? '') : path.replace(/^\//, '');
	const first = area.split('/')[0] ?? '';
	const label: Record<string, string> = {
		'': 'Overview',
		board: 'Board',
		cards: 'Card',
		brief: 'Brief',
		plan: 'Plan',
		'needs-you': 'Needs you',
		approvals: 'Approvals',
		approve: 'Approval',
		threads: 'Threads',
		artifacts: 'Artifacts',
		'flow-runs': 'Flow runs',
		library: 'Assets',
		settings: 'Settings'
	};
	return `Opened ${label[first] ?? (first ? first.replace(/-/g, ' ') : 'page')}`;
}
