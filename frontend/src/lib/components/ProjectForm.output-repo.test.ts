// @vitest-environment jsdom
//
// ProjectForm — the OPTIONAL output repository (`it` projects only, never a
// rewrite): where it renders, where it must NOT, and the three payload shapes
// buildPayload emits for it. The empty case is pinned as the unchanged baseline:
// no output URL ⇒ not a byte of the payload moves.
//
// Mount pattern: Svelte 5 mount/unmount/flushSync (@testing-library/svelte is
// not installed). No transport is stubbed: the form's picker loads fail in jsdom
// and the form renders without them; teardown waits for them to settle.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ProjectForm, {
	buildPayload,
	emptyBoundAssets,
	emptyFormState,
	type ProjectFormState
} from './ProjectForm.svelte';

let instance: ReturnType<typeof mount> | null = null;
let target: HTMLElement | null = null;

function render(initial: Partial<ProjectFormState>): HTMLElement {
	target = document.createElement('div');
	document.body.appendChild(target);
	instance = mount(ProjectForm, { target, props: { initial, onSubmit: async () => {} } });
	flushSync();
	return target;
}

afterEach(async () => {
	// Let the form's own picker loads finish (they fail in jsdom and log) before
	// teardown, so no log is still in flight when the worker closes.
	await vi.waitFor(() => expect(target?.querySelector('[data-testid="project-types-failed"]')).not.toBeNull());
	await new Promise((r) => setTimeout(r, 0));
	if (instance) unmount(instance);
	target?.remove();
	instance = null;
	target = null;
});

const ctx = () => ({ boundAssets: emptyBoundAssets() });

const form = (over: Partial<ProjectFormState> = {}): ProjectFormState => ({
	...emptyFormState(),
	name: 'Writes somewhere',
	project_type: 'it',
	it_flow: 'dependency',
	cve_sweep: true,
	repositories: [{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: true, pin: '' }],
	...over
});

describe('where the output repository renders', () => {
	it('renders for a non-rewrite it project, with a URL and a branch field', () => {
		const root = render({ project_type: 'it', it_flow: 'dependency' });
		expect(root.querySelector('[data-testid="output-repo-url"]')).not.toBeNull();
		expect(root.querySelector('[data-testid="output-repo-branch"]')).not.toBeNull();
	});

	it('does NOT render for an it rewrite (that flow has its own target repository)', () => {
		const root = render({ project_type: 'it', it_flow: 'rewrite' });
		expect(root.querySelector('[data-testid="output-repo-url"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-target-url"]')).not.toBeNull();
	});

	it('does not render for another project type (kata)', () => {
		const root = render({ project_type: 'kata' });
		expect(root.querySelector('[data-testid="output-repo-url"]')).toBeNull();
	});
});

describe('payload: the three output-repository shapes', () => {
	it('named rows exist → the output row is APPENDED after them with role target', () => {
		const p = buildPayload(
			form({
				repositories: [
					{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: true, pin: '' },
					{ url: 'https://github.com/o/b', branch: 'dev', name: 'B', is_primary: false, pin: '' }
				],
				output_repo_url: '  https://github.com/o/out  ',
				output_repo_branch: ' out-branch '
			}),
			ctx()
		);
		expect(p.repository_url).toBe('https://github.com/o/a');
		expect(p.repo!.primary).toEqual({ url: 'https://github.com/o/a', branch: 'main' });
		expect(p.repo!.additional).toEqual([
			{ url: 'https://github.com/o/b', branch: 'dev', name: 'B' },
			{ url: 'https://github.com/o/out', branch: 'out-branch', role: 'target' }
		]);
	});

	it('no named row → the output repository IS the primary, with role target', () => {
		const p = buildPayload(
			form({
				repositories: [],
				output_repo_url: 'https://github.com/o/out',
				output_repo_branch: 'mainline'
			}),
			ctx()
		);
		expect(p.repository_url).toBe('https://github.com/o/out');
		expect(p.branch).toBe('mainline');
		expect(p.repo).toEqual({
			primary: { url: 'https://github.com/o/out', branch: 'mainline', role: 'target' }
		});
	});

	it('no named row and no output branch → the primary branch is main', () => {
		const p = buildPayload(
			form({ repositories: [], output_repo_url: 'https://github.com/o/out', output_repo_branch: ' ' }),
			ctx()
		);
		expect(p.repository_url).toBe('https://github.com/o/out');
		expect(p.branch).toBe('main');
		expect(p.repo!.primary).toEqual({ url: 'https://github.com/o/out', branch: 'main', role: 'target' });
	});

	it('no output URL → no role anywhere; an output URL on another type is ignored', () => {
		const none = buildPayload(form(), ctx());
		expect(JSON.stringify(none)).not.toContain('"role"');
		// ... and a stray value on a type that does not offer the field moves nothing
		const kata = buildPayload(
			form({ project_type: 'kata', output_repo_url: 'https://github.com/o/out', output_repo_branch: 'x' }),
			ctx()
		);
		expect(JSON.stringify(kata)).not.toContain('"role"');
		expect(kata.repository_url).toBe('https://github.com/o/a');
		expect(kata.branch).toBe('main');
	});

	it('the output repository does NOT make a project multi-repository for coordination', () => {
		const p = buildPayload(
			form({ output_repo_url: 'https://github.com/o/out', coordination_mode: 'independent' }),
			ctx()
		);
		expect(p.coordination_mode).toBeUndefined();
	});
});
