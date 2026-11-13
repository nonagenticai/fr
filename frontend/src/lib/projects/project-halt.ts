// A project is HALTED while a platform operator has paused it (its andon cord). This module is
// the pure half: the read model of GET /api/projects/:id/andon and every sentence a member reads
// about it. (R349 retired R318's board-move hold: a drag is now the plain board move.)
//
// ⛔ Plain language only. Members never read internal system names; customer-copy.guard.test.ts
// and project-halt.test.ts pin that.

export interface ProjectHaltView {
	project_id: string;
	engaged: boolean;
	reason: 'operator' | null;
	engaged_at: string | null;
	engaged_by: string | null;
}

/** The banner's headline; null when the project is not halted. */
export function haltHeadline(view: ProjectHaltView | null): string | null {
	if (!view || !view.engaged) return null;
	return 'Halted: this project is paused by a platform operator. Nothing runs on it until it is released.';
}

export const HALT_TEXT = Object.freeze({
	badge: 'Halted',
	unreadable: 'We could not check whether this project is paused.',
});

/** Pure: parse the route's `{ data: view }` body; null when it is not a view. */
export function parseHaltView(body: unknown): ProjectHaltView | null {
	const data = (body as { data?: unknown } | null)?.data as Partial<ProjectHaltView> | undefined;
	if (!data || typeof data !== 'object' || typeof data.engaged !== 'boolean' || typeof data.project_id !== 'string') return null;
	return {
		project_id: data.project_id,
		engaged: data.engaged,
		reason: data.engaged ? 'operator' : null,
		engaged_at: typeof data.engaged_at === 'string' ? data.engaged_at : null,
		engaged_by: typeof data.engaged_by === 'string' ? data.engaged_by : null,
	};
}
