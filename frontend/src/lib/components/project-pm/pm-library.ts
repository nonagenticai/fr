/**
 * fr-agui SPEC §16 D12 (George 2026-10-14) / §13 P2-b — the project shell's
 * READ-ONLY PM library, sourced from requirements_management through P2-a's
 * project reads:
 *
 *   GET /api/projects/:id/pm/projects      this project's RM pm_projects
 *   GET /api/projects/:id/pm/programmes    their programmes
 *   GET /api/projects/:id/pm/risks         their risks
 *
 * "fr PM library UI: re-homed read-only in the project shell … Catalogue
 * editing stays in RM." There is no write here, and the retired risk quality
 * judge stays retired: fr facilitates, it never judges. Activities (WBS) and
 * dependencies went with RM's schedule apparatus (R352).
 *
 * Each section loads on its own, so one failed read says so ("could not load")
 * without hiding the others — and never reads as an empty list.
 */
import { authFetch } from '$lib/api/auth-fetch';

export type PmSectionKey = 'projects' | 'programmes' | 'risks';

export const PM_SECTIONS: ReadonlyArray<{ key: PmSectionKey; title: string; empty: string }> = [
	{ key: 'projects', title: 'PM projects', empty: 'No PM project has been created for this project in requirements management yet.' },
	{ key: 'programmes', title: 'Programmes', empty: 'This project belongs to no programme.' },
	{ key: 'risks', title: 'Risks', empty: 'No risks are recorded.' }
];

export type PmRow = Record<string, unknown>;

export type PmSectionState = { status: 'ok'; rows: PmRow[] } | { status: 'error'; message: string };

export function pmSectionPath(projectId: string, key: PmSectionKey): string {
	return `/api/projects/${encodeURIComponent(projectId)}/pm/${key}`;
}

/** One section: the `{ data: T[] }` envelope, or the route's refusal verbatim. */
export async function loadPmSection(projectId: string, key: PmSectionKey): Promise<PmSectionState> {
	try {
		const res = await authFetch(pmSectionPath(projectId, key));
		const body = (await res.json().catch(() => null)) as { data?: unknown; error?: unknown; message?: unknown } | null;
		if (!res.ok || !body || !Array.isArray(body.data)) {
			const why =
				(typeof body?.message === 'string' && body.message) || (typeof body?.error === 'string' && body.error) || `HTTP ${res.status}`;
			return { status: 'error', message: why };
		}
		return { status: 'ok', rows: body.data.filter((r): r is PmRow => !!r && typeof r === 'object') };
	} catch {
		return { status: 'error', message: 'the request did not complete' };
	}
}

export async function loadPmLibrary(projectId: string): Promise<Record<PmSectionKey, PmSectionState>> {
	const entries = await Promise.all(PM_SECTIONS.map(async (s) => [s.key, await loadPmSection(projectId, s.key)] as const));
	return Object.fromEntries(entries) as Record<PmSectionKey, PmSectionState>;
}

/** The columns each section shows (read-only), as [label, field]. */
export const PM_COLUMNS: Readonly<Record<PmSectionKey, ReadonlyArray<readonly [string, string]>>> = {
	projects: [
		['Title', 'title'],
		['Status', 'status'],
		['Phase', 'current_phase'],
		['Start', 'start_date'],
		['End', 'end_date']
	],
	programmes: [
		['Title', 'title'],
		['Status', 'status'],
		['Start', 'start_date'],
		['End', 'end_date']
	],
	risks: [
		['Title', 'title'],
		['Category', 'category'],
		['Probability', 'probability'],
		['Impact', 'impact_score'],
		['Score', 'risk_score'],
		['Response', 'response_strategy']
	]
};

/** A cell's text: strings and numbers as-is, booleans as yes/no, anything else blank. */
export function pmCell(row: PmRow, field: string): string {
	const v = row[field];
	if (typeof v === 'string') return v;
	if (typeof v === 'number' && Number.isFinite(v)) return String(v);
	if (typeof v === 'boolean') return v ? 'yes' : 'no';
	return '';
}
