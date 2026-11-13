// @vitest-environment jsdom
//
// RepositoryRepeater.test.ts
//
// The defect: the project request form offered scope_level 'multi_repo' but let
// the user enter only ONE repository. The backend has accepted N repos since
// migration 072. These tests pin the pure helpers and drive the mounted
// component, asserting on rendered DOM.
//
// ⛔ The `coherenceError` cases WERE HERE and are deleted (2026-09-30) along with
// the function: they asserted a bidirectional rule ("'multi_repo' needs >=2
// repositories" / ">1 repository needs 'multi_repo'") that would now REFUSE the
// ordinary case — two repositories at granularity `module`. Repository count is a
// fact the server reads off the payload, not a claim the user has to keep
// consistent with a dropdown. The coordination-mode question that replaced it is
// asked on the parent form.
//
// Mount pattern: Svelte 5 mount/unmount/flushSync/tick (@testing-library/svelte
// is not installed).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';

import RepositoryRepeater, {
	emptyRepoRow,
	normalisePrimary,
	type RepoRow
} from './RepositoryRepeater.svelte';

function row(url: string, is_primary = false): RepoRow {
	return { url, branch: '', name: '', is_primary, pin: '' };
}

describe('normalisePrimary', () => {
	it('returns an empty array for no rows', () => {
		expect(normalisePrimary([])).toEqual([]);
	});

	it('makes the first row primary when none is flagged', () => {
		const out = normalisePrimary([row('a'), row('b')]);
		expect(out.map((r) => r.is_primary)).toEqual([true, false]);
	});

	it('keeps only the first flagged row when several are primary', () => {
		const out = normalisePrimary([row('a'), row('b', true), row('c', true)]);
		expect(out.map((r) => r.is_primary)).toEqual([false, true, false]);
	});

	it('does not mutate its input', () => {
		const input = [row('a'), row('b')];
		normalisePrimary(input);
		expect(input.every((r) => !r.is_primary)).toBe(true);
	});

	it('emptyRepoRow is blank and not primary', () => {
		expect(emptyRepoRow()).toEqual({ url: '', branch: '', name: '', is_primary: false, pin: '' });
	});
});

describe('RepositoryRepeater — mounted', () => {
	let host: HTMLElement;
	let app: ReturnType<typeof mount> | null = null;

	beforeEach(() => {
		host = document.createElement('div');
		document.body.appendChild(host);
	});
	afterEach(() => {
		if (app) unmount(app);
		app = null;
		host.remove();
	});

	async function mountIt(repositories: RepoRow[]) {
		app = mount(RepositoryRepeater, { target: host, props: { repositories } });
		await tick();
		flushSync();
	}

	function type(el: HTMLInputElement, value: string) {
		el.value = value;
		el.dispatchEvent(new Event('input', { bubbles: true }));
		flushSync();
	}

	const rows = () => host.querySelectorAll('[data-testid="repo-row"]');

	it('clicking "Add repository" renders a second row', async () => {
		await mountIt([{ ...emptyRepoRow(), is_primary: true }]);
		expect(rows().length).toBe(1);
		host.querySelector<HTMLButtonElement>('[data-testid="add-repository"]')!.click();
		flushSync();
		expect(rows().length).toBe(2);
		expect(host.querySelector('#repo-url-1')).not.toBeNull();
		expect(host.querySelector<HTMLInputElement>('#repo-url-1')!.placeholder).toBe(
			'https://github.com/owner/repo'
		);
	});

	it('each row carries an optional pin (commit SHA or PR)', async () => {
		await mountIt([{ ...emptyRepoRow(), is_primary: true, pin: '#42' }]);
		const pin = host.querySelector<HTMLInputElement>('#repo-pin-0')!;
		expect(pin.value).toBe('#42');
		expect(pin.required).toBe(false);
	});

	it('a repository URL is optional: the empty default row does not block the form', async () => {
		await mountIt([{ ...emptyRepoRow(), is_primary: true }]);
		const url = host.querySelector<HTMLInputElement>('#repo-url-0')!;
		expect(url.required).toBe(false);
		expect(url.checkValidity()).toBe(true);
	});

	it('two filled rows raise NO error of any kind inside the repeater', async () => {
		// MUTATION: re-adding a `coherenceError`-shaped rule (or any `role="alert"`
		// on a repository count) makes this fail. Two repositories is the ordinary
		// case now — the repeater has nothing left to refuse.
		await mountIt([{ ...emptyRepoRow(), is_primary: true }]);
		type(host.querySelector<HTMLInputElement>('#repo-url-0')!, 'https://github.com/acme/a');
		host.querySelector<HTMLButtonElement>('[data-testid="add-repository"]')!.click();
		flushSync();
		type(host.querySelector<HTMLInputElement>('#repo-url-1')!, 'https://github.com/acme/b');
		expect(rows().length).toBe(2);
		expect(host.querySelector('[role="alert"]')).toBeNull();
		expect(host.querySelector('[data-testid="repo-coherence-error"]')).toBeNull();
		expect(host.textContent).not.toContain('multi_repo');
	});

	it('remove is disabled when only one row remains, enabled with two', async () => {
		await mountIt([{ ...emptyRepoRow(), is_primary: true }]);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="repo-remove-0"]')!.disabled).toBe(
			true
		);
		host.querySelector<HTMLButtonElement>('[data-testid="add-repository"]')!.click();
		flushSync();
		const remove1 = host.querySelector<HTMLButtonElement>('[data-testid="repo-remove-1"]')!;
		expect(remove1.disabled).toBe(false);
		remove1.click();
		flushSync();
		expect(rows().length).toBe(1);
		expect(host.querySelector<HTMLButtonElement>('[data-testid="repo-remove-0"]')!.disabled).toBe(
			true
		);
	});

	it('changing the primary radio leaves exactly one primary', async () => {
		await mountIt([
			row('https://github.com/acme/a', true),
			row('https://github.com/acme/b'),
			row('https://github.com/acme/c')
		]);
		const radio = (i: number) =>
			host.querySelector<HTMLInputElement>(`[data-testid="repo-primary-${i}"]`)!;
		expect(radio(0).checked).toBe(true);

		radio(2).checked = true;
		radio(2).dispatchEvent(new Event('change', { bubbles: true }));
		flushSync();

		const checked = [0, 1, 2].filter((i) => radio(i).checked);
		expect(checked).toEqual([2]);
	});
});
