// @vitest-environment jsdom
//
// ProjectForm — WHERE the rewrite inputs render. For an `it` rewrite they sit
// inside the IT box, between the flow picker and the test command. There is no
// language picker and no card cap any more (George 2026-11-07); the snippet says
// the language comes from the request.
//
// ⛔ A rewrite project TYPE no longer exists: `py2rust` was one until RM retired
// it. It is pinned below as an ORDINARY type that renders no rewrite inputs —
// the picker offers only RM's startable types, and no frontend list may
// resurrect one.
//
// Mount pattern: Svelte 5 mount/unmount/flushSync (@testing-library/svelte is
// not installed). No transport is stubbed: the form's picker loads fail in jsdom
// and the form renders without them; teardown waits for them to settle.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { flushSync, mount, unmount } from 'svelte';

import ProjectForm, { type ProjectFormState } from './ProjectForm.svelte';

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

const precedes = (a: Element, b: Element) =>
	(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;

describe('rewrite inputs placement', () => {
	it('it rewrite: inside the IT box, flow picker → the request-language hint → test command', () => {
		const root = render({ project_type: 'it', it_flow: 'rewrite' });
		const box = root.querySelector('[data-testid="it-flow-fields"]');
		const flow = root.querySelector('#it_flow');
		const fields = root.querySelector('[data-testid="rewrite-fields"]');
		const hint = root.querySelector('[data-testid="rewrite-language-hint"]');
		const testCommand = root.querySelector('#test_command');
		for (const el of [box, flow, fields, hint, testCommand]) expect(el).not.toBeNull();
		expect(root.querySelectorAll('[data-testid="rewrite-fields"]')).toHaveLength(1);
		for (const el of [flow, fields, testCommand]) expect(box!.contains(el)).toBe(true);
		expect(precedes(flow!, fields!)).toBe(true);
		expect(precedes(hint!, testCommand!)).toBe(true);
		// Neither control exists any more.
		expect(root.querySelector('[data-testid="rewrite-language"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-max-cards"]')).toBeNull();
	});

	it('py2rust: NO rewrite inputs — it is an ordinary type now (RM reports it retired)', () => {
		// `it_flow: 'rewrite'` is deliberate: a stray py2rust row must not reach the
		// rewrite inputs through the IT flow either.
		const root = render({ project_type: 'py2rust', it_flow: 'rewrite' });
		expect(root.querySelector('[data-testid="it-flow-fields"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-fields"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-language-hint"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-repositories"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-source-pin"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-target-url"]')).toBeNull();
		// the ordinary repository rows are what such a project uses
		expect(root.querySelector('[data-testid="repository-repeater"]')).not.toBeNull();
	});

	it('a non-rewrite it flow renders no rewrite inputs', () => {
		const root = render({ project_type: 'it', it_flow: 'dependency' });
		expect(root.querySelector('[data-testid="rewrite-fields"]')).toBeNull();
		expect(root.querySelector('[data-testid="rewrite-repositories"]')).toBeNull();
	});
});
