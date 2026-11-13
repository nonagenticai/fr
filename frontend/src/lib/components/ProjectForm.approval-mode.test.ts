// ProjectForm — the approval-mode control (George 2026-10-27; default 2026-10-31).
//
// 'brief_and_closure' is the default (R329; was 'autonomous'), and the chosen mode is ALWAYS
// sent as `approval_mode` for an `it` project — 'all' included, so the stored mode never
// depends on the flows' fallback for an unset value.

import { describe, expect, it } from 'vitest';
import { buildPayload, emptyBoundAssets, emptyFormState, type ProjectFormState } from './ProjectForm.svelte';

const ctx = () => ({ boundAssets: emptyBoundAssets() });
const itForm = (over: Partial<ProjectFormState> = {}): ProjectFormState => ({
	...emptyFormState(),
	name: 'A',
	problem_statement: 'p',
	project_type: 'it',
	it_flow: 'bug',
	bug_test_command: 'pytest -q',
	...over
});

describe('approval_mode', () => {
	it('defaults to brief_and_closure (R329)', () => {
		expect(emptyFormState().approval_mode).toBe('brief_and_closure');
	});

	it('the default is sent, so the flows never see it unset', () => {
		const p = buildPayload(itForm(), ctx());
		expect(p.approval_mode).toBe('brief_and_closure');
	});

	it.each(['all', 'auto_drafts', 'brief_and_closure', 'autonomous'] as const)('%s is sent when chosen', (mode) => {
		const p = buildPayload(itForm({ approval_mode: mode }), ctx());
		expect(p.approval_mode).toBe(mode);
	});

	it('works for the rewrite flow too', () => {
		const p = buildPayload(itForm({ it_flow: 'rewrite', approval_mode: 'brief_and_closure' }), ctx());
		expect(p.approval_mode).toBe('brief_and_closure');
		// The target language is NOT asked by the form (George 2026-11-07): the backend
		// extracts it from the request, so the payload carries none.
		expect('language' in p).toBe(false);
	});

	it('is never sent for a non-it project', () => {
		const p = buildPayload({ ...emptyFormState(), name: 'F', project_type: 'feature', approval_mode: 'autonomous' }, ctx());
		expect('approval_mode' in p).toBe(false);
	});
});
