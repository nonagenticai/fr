// The pure read model + copy of a halted project (lib/projects/project-halt.ts).
import { describe, expect, it } from 'vitest';
import { HALT_TEXT, haltHeadline, parseHaltView, type ProjectHaltView } from './project-halt';

const view = (over: Partial<ProjectHaltView>): ProjectHaltView => ({
	project_id: 'p-1',
	engaged: true,
	reason: 'operator',
	engaged_at: '2026-10-20T10:00:00Z',
	engaged_by: 'ops@t.test',
	...over,
});

describe('haltHeadline', () => {
	it('an engaged cord is an operator pause; a released project has no banner', () => {
		expect(haltHeadline(view({}))).toMatch(/paused by a platform operator/);
		expect(haltHeadline(view({ engaged: false, reason: null }))).toBeNull();
		expect(haltHeadline(null)).toBeNull();
	});
	it('every member-facing sentence is plain language', () => {
		const banned = /conveyor|n8n|andon|planka|\bRM\b|psra|webhook|approval/i;
		for (const t of [...Object.values(HALT_TEXT), haltHeadline(view({}))]) expect(t).not.toMatch(banned);
	});
});

describe('parseHaltView', () => {
	it('reads the route body and refuses garbage', () => {
		expect(parseHaltView({ data: view({}) })).toEqual(view({}));
		expect(parseHaltView({ data: { engaged: 'yes' } })).toBeNull();
		expect(parseHaltView(null)).toBeNull();
	});
});
