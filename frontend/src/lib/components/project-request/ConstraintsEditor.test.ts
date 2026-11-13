// @vitest-environment jsdom
//
// ConstraintsEditor.test.ts
//
// Two things are pinned here:
//  1. The frontend describeConstraint() renders EXACTLY what the backend delivers
//     to the agent — imported from backend source, so drift on either side reds
//     this test rather than silently showing the user a different promise.
//  2. The editor tells the user which kind of promise each constraint is, and
//     refuses incomplete entries.
//
// Mount pattern: Svelte 5 mount/unmount/flushSync (@testing-library/svelte is
// not installed).

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mount, unmount, flushSync, tick } from 'svelte';

import ConstraintsEditor from './ConstraintsEditor.svelte';
import {
	CONSTRAINT_KINDS,
	describeConstraint,
	isMachineCheckable,
	type ProjectConstraint
} from '$lib/types/project-constraints';

/**
 * The EXACT strings backend/src/types/project-constraints.ts::describeConstraint
 * emits — what the agent actually reads in its brief. Pinned as literals rather
 * than imported: the frontend CI job runs `npm ci` in frontend/ only, so an
 * import from backend/ cannot resolve `zod` there and would fail CI while
 * passing locally. If the backend wording changes, this table must change with
 * it — which is the point: the UI must show the user the words the agent gets.
 */
const BACKEND_TEXT: Record<string, { text: string; checkable: boolean }> = {
	no_language_version_change: { text: 'Do NOT change the language version.', checkable: true },
	pin_language_version: {
		text: 'Keep python pinned at exactly 3.12; do not upgrade or downgrade it.',
		checkable: true
	},
	no_dependency_upgrades: { text: 'Do NOT upgrade any existing dependency.', checkable: true },
	no_new_dependencies: { text: 'Do NOT add any new dependency.', checkable: true },
	no_files_touched: { text: 'Do NOT modify these paths: migrations/**, src/legacy/*.py.', checkable: true },
	must_keep_api_compatible: {
		text: 'The public API must remain backwards compatible; no breaking changes.',
		checkable: false
	},
	custom: { text: 'Keep the CLI flags stable.', checkable: false }
};

const SAMPLES: ProjectConstraint[] = [
	{ kind: 'no_language_version_change' },
	{ kind: 'pin_language_version', language: 'python', version: '3.12' },
	{ kind: 'no_dependency_upgrades' },
	{ kind: 'no_new_dependencies' },
	{ kind: 'no_files_touched', globs: ['migrations/**', 'src/legacy/*.py'] },
	{ kind: 'must_keep_api_compatible' },
	{ kind: 'custom', text: 'Keep the CLI flags stable.' }
];

describe('describeConstraint — parity with the backend (what the agent reads)', () => {
	it('covers every kind in CONSTRAINT_KINDS', () => {
		expect(new Set(SAMPLES.map((s) => s.kind))).toEqual(new Set(CONSTRAINT_KINDS.map((k) => k.kind)));
	});

	for (const c of SAMPLES) {
		it(`${c.kind}: same text and same checkability as the backend`, () => {
			expect(describeConstraint(c)).toBe(BACKEND_TEXT[c.kind].text);
			expect(isMachineCheckable(c)).toBe(BACKEND_TEXT[c.kind].checkable);
		});
	}

	it('pins the literal strings too (both sides changing together is still a change)', () => {
		expect(describeConstraint(SAMPLES[0])).toBe('Do NOT change the language version.');
		expect(describeConstraint(SAMPLES[1])).toBe(
			'Keep python pinned at exactly 3.12; do not upgrade or downgrade it.'
		);
		expect(describeConstraint(SAMPLES[4])).toBe('Do NOT modify these paths: migrations/**, src/legacy/*.py.');
		expect(isMachineCheckable(SAMPLES[6])).toBe(false);
	});
});

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

async function mountIt() {
	app = mount(ConstraintsEditor, {
		target: host,
		props: { constraints: [], dependencies: [], risks: [] }
	});
	await tick();
	flushSync();
}

const q = <T extends Element>(sel: string) => host.querySelector<T>(sel);

function type(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
	el.value = value;
	el.dispatchEvent(new Event('input', { bubbles: true }));
	flushSync();
}

function choose(el: HTMLSelectElement, value: string) {
	el.value = value;
	el.dispatchEvent(new Event('change', { bubbles: true }));
	flushSync();
}

function click(sel: string) {
	q<HTMLButtonElement>(sel)!.click();
	flushSync();
}

describe('ConstraintsEditor — constraints', () => {
	it('adds no_language_version_change with its text and a "Checkable rule" badge', async () => {
		await mountIt();
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'no_language_version_change');
		click('[data-testid="add-constraint"]');

		expect(q('[data-testid="constraint-text-0"]')?.textContent).toBe('Do NOT change the language version.');
		expect(q('[data-testid="constraint-badge-0"]')?.textContent?.trim()).toBe('Checkable rule');
		// Nothing enforces a typed rule yet; the UI must not say it does.
		expect(q('[data-testid="constraint-list"]')?.textContent).not.toMatch(/enforced/i);
	});

	it('hint states exactly what the merge gate does, per kind', async () => {
		await mountIt();
		const hint = () => q('[data-testid="constraint-kind-hint"]')?.textContent?.trim();
		for (const k of ['no_new_dependencies', 'no_dependency_upgrades', 'no_language_version_change', 'pin_language_version']) {
			choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, k);
			expect(hint()).toBe(
				'Checked before merge. A dependency or language-version change we cannot read blocks the merge; installs inside Dockerfiles or CI steps are not checked.'
			);
		}
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'no_files_touched');
		expect(hint()).toBe('Checked before merge. A pull request that breaks this rule is not merged.');
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'must_keep_api_compatible');
		expect(hint()).toMatch(/not enforced/);
		expect(hint()).not.toMatch(/Checked before merge/);
	});

	it('adds a custom rule labelled "Guidance — not enforced"', async () => {
		await mountIt();
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'custom');
		const ta = q<HTMLTextAreaElement>('[data-testid="constraint-custom"]');
		expect(ta, 'custom textarea rendered').not.toBeNull();
		type(ta!, 'Keep the CLI flags stable.');
		click('[data-testid="add-constraint"]');

		expect(q('[data-testid="constraint-text-0"]')?.textContent).toBe('Keep the CLI flags stable.');
		expect(q('[data-testid="constraint-badge-0"]')?.textContent?.trim()).toBe('Guidance — not enforced');
	});

	it('refuses an incomplete pin_language_version (version missing)', async () => {
		await mountIt();
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'pin_language_version');
		type(q<HTMLInputElement>('[data-testid="constraint-language"]')!, 'python');
		click('[data-testid="add-constraint"]');

		expect(q('[data-testid="constraint-item-0"]')).toBeNull();
		expect(q('[data-testid="constraint-error"]')?.textContent).toMatch(/language and a version/);

		// Control: completing it is accepted, so the refusal above was the gate, not a dead button.
		type(q<HTMLInputElement>('[data-testid="constraint-version"]')!, '3.12');
		click('[data-testid="add-constraint"]');
		expect(q('[data-testid="constraint-text-0"]')?.textContent).toBe(
			'Keep python pinned at exactly 3.12; do not upgrade or downgrade it.'
		);
	});

	it('refuses no_files_touched with only blank globs, accepts trimmed globs', async () => {
		await mountIt();
		choose(q<HTMLSelectElement>('[data-testid="constraint-kind"]')!, 'no_files_touched');
		type(q<HTMLInputElement>('[data-testid="constraint-globs"]')!, ' , ,');
		click('[data-testid="add-constraint"]');
		expect(q('[data-testid="constraint-item-0"]')).toBeNull();

		type(q<HTMLInputElement>('[data-testid="constraint-globs"]')!, 'a/**, ,b.py');
		click('[data-testid="add-constraint"]');
		expect(q('[data-testid="constraint-text-0"]')?.textContent).toBe('Do NOT modify these paths: a/**, b.py.');
	});

	it('removes a constraint', async () => {
		await mountIt();
		click('[data-testid="add-constraint"]');
		expect(q('[data-testid="constraint-item-0"]')).not.toBeNull();
		click('[data-testid="remove-constraint-0"]');
		expect(q('[data-testid="constraint-item-0"]')).toBeNull();
	});
});

describe('ConstraintsEditor — dependencies and risks', () => {
	it('refuses a dependency with a blank name, accepts a named one', async () => {
		await mountIt();
		type(q<HTMLInputElement>('[data-testid="dependency-name"]')!, '   ');
		click('[data-testid="add-dependency"]');
		expect(q('[data-testid="dependency-item-0"]')).toBeNull();
		expect(q('[data-testid="dependency-error"]')).not.toBeNull();

		type(q<HTMLInputElement>('[data-testid="dependency-name"]')!, 'billing-service');
		choose(q<HTMLSelectElement>('[data-testid="dependency-kind"]')!, 'api');
		click('[data-testid="add-dependency"]');
		expect(q('[data-testid="dependency-item-0"]')?.textContent).toContain('billing-service (api)');
	});

	it('refuses a risk without a description, accepts one with details', async () => {
		await mountIt();
		click('[data-testid="add-risk"]');
		expect(q('[data-testid="risk-item-0"]')).toBeNull();

		type(q<HTMLInputElement>('[data-testid="risk-description"]')!, 'Migration locks the table');
		type(q<HTMLInputElement>('[data-testid="risk-impact"]')!, 'high');
		click('[data-testid="add-risk"]');
		expect(q('[data-testid="risk-item-0"]')?.textContent).toContain('Migration locks the table');
		expect(q('[data-testid="risk-item-0"]')?.textContent).toContain('Impact: high');
	});
});
