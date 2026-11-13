// fr-agui SPEC §13 P1c (OQ-17 = c): the tenant-page agent is the DOORWAY, so its
// empty state must not promise the retired tenant-rail tools (library search,
// workflows). The project agent's copy names the project core.
import { describe, expect, it } from 'vitest';
import { agentEmptyStateCopy, DOORWAY_EMPTY_STATE, PROJECT_EMPTY_STATE } from './empty-state';

const RETIRED = [/librar/i, /workflow/i, /trigger/i, /search/i, /asset/i];

describe('agent empty-state copy', () => {
	it('an unbound (tenant-page) thread gets the doorway copy, naming only the intake set', () => {
		const copy = agentEmptyStateCopy(false);
		expect(copy).toBe(DOORWAY_EMPTY_STATE);
		for (const re of RETIRED) expect({ re: String(re), hit: re.test(copy) }).toEqual({ re: String(re), hit: false });
		expect(copy).toMatch(/create a project/i);
		expect(copy).toMatch(/project requests/i);
		expect(copy).toMatch(/project types/i);
	});

	it('a project-bound thread gets the project copy, without the retired tenant tools', () => {
		const copy = agentEmptyStateCopy(true);
		expect(copy).toBe(PROJECT_EMPTY_STATE);
		for (const re of [/librar/i, /workflow/i]) expect(re.test(copy)).toBe(false);
		expect(copy).toMatch(/this project/i);
	});
});
