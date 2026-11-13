// ProjectForm — the REWRITE flow (an `it` project whose flow is `rewrite`) and
// its strictly-additive guarantee.
//
// ⛔ There is NO rewrite project TYPE any more: `py2rust` was one until RM
// retired it, and the picker offers only RM's startable types. A stored
// `py2rust` value is pinned below as an ORDINARY non-rewrite type, so nothing
// re-grows a frontend allowlist of "types that are secretly a rewrite".
//
// George 2026-11-07: the form no longer asks for the target language (the backend
// extracts it from the request) and the never-requested card cap is gone. A
// repository PIN (a full commit SHA or a GitHub PR) is asked on every repository
// row and on each rewrite source.
//
// GOLDEN below: the exact JSON buildPayload produced on origin/main (367a890cd),
// BEFORE the rewrite fields existed, for each non-rewrite form state. The rewrite
// change must leave every one of them byte-identical — including when the rewrite
// inputs hold values (they are only read for it_flow 'rewrite'). Do not regenerate
// these strings from the code under test. One deliberate change since then (George
// 2026-10-31): an `it` payload always carries `approval_mode` ('brief_and_closure' by
// default since R329; was 'autonomous'), hand-added to the it_* strings below.

import { describe, expect, it } from 'vitest';
import {
	buildPayload,
	COMMIT_SHA_RE,
	emptyBoundAssets,
	emptyFormState,
	isRepoPin,
	isRewriteForm,
	rewriteRepositoryUrls,
	validateItInputs,
	type ProjectFormState
} from './ProjectForm.svelte';

const ctx = () => ({ boundAssets: { ...emptyBoundAssets(), requirement: ['11111111-1111-4111-8111-111111111111'] } });

function nonRewriteFixtures(): Record<string, ProjectFormState> {
	const base = () => ({ ...emptyFormState(), name: 'Pinned', description: 'd', problem_statement: 'p' });
	return {
		empty: { ...emptyFormState(), name: 'Empty' },
		feature_one_repo: {
			...base(),
			project_type: 'feature',
			repositories: [{ url: 'https://github.com/o/a', branch: 'dev', name: '', is_primary: true, pin: '' }]
		},
		it_dependency: {
			...base(),
			project_type: 'it',
			it_flow: 'dependency',
			target_packages: [{ name: 'fastmcp', target_version: '2.3.0' }],
			test_command: 'pytest -q',
			repositories: [{ url: 'https://github.com/o/a', branch: '', name: '', is_primary: true, pin: '' }]
		},
		it_bug_multi_repo: {
			...base(),
			project_type: 'it',
			it_flow: 'bug',
			bug_test_command: 'pytest -q tests/test_x.py',
			bug_description: 'boom',
			failing_test_ref: 'tests/test_x.py::t',
			target_files: ['src/x.py'],
			coordination_mode: 'independent',
			repositories: [
				{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: false, pin: '' },
				{ url: 'https://github.com/o/b', branch: 'feat', name: 'B', is_primary: true, pin: '' }
			]
		},
		it_refactor: { ...base(), project_type: 'it', it_flow: 'refactor', target_files: ['a.py'], test_command: 'make test' },
		it_security: { ...base(), project_type: 'it', it_flow: 'security', min_severity: 'CRITICAL' },
		it_bug_hunt: {
			...base(),
			project_type: 'it',
			it_flow: 'bug',
			bug_hunt: true,
			test_command: 'uv run pytest',
			repositories: [{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: true, pin: '' }]
		}
	};
}

const GOLDEN: Record<string, string> = {
	empty:
		"{\"name\":\"Empty\",\"shape\":\"deliverable\",\"branch\":\"main\",\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	feature_one_repo:
		"{\"name\":\"Pinned\",\"repository_url\":\"https://github.com/o/a\",\"shape\":\"deliverable\",\"branch\":\"dev\",\"description\":\"d\",\"project_type\":\"feature\",\"problem_statement\":\"p\",\"repo\":{\"primary\":{\"url\":\"https://github.com/o/a\",\"branch\":\"dev\"}},\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	it_dependency:
		"{\"it_flow\":\"dependency\",\"target_packages\":[{\"name\":\"fastmcp\",\"target_version\":\"2.3.0\"}],\"test_command\":[\"pytest\",\"-q\"],\"min_severity\":\"HIGH\",\"approval_mode\":\"brief_and_closure\",\"name\":\"Pinned\",\"repository_url\":\"https://github.com/o/a\",\"shape\":\"deliverable\",\"branch\":\"main\",\"description\":\"d\",\"project_type\":\"it\",\"problem_statement\":\"p\",\"repo\":{\"primary\":{\"url\":\"https://github.com/o/a\",\"branch\":\"main\"}},\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	it_bug_multi_repo:
		"{\"it_flow\":\"bug\",\"bug_test_command\":[\"pytest\",\"-q\",\"tests/test_x.py\"],\"failing_test_ref\":\"tests/test_x.py::t\",\"target_files\":[\"src/x.py\"],\"bug_description\":\"boom\",\"approval_mode\":\"brief_and_closure\",\"name\":\"Pinned\",\"repository_url\":\"https://github.com/o/b\",\"shape\":\"deliverable\",\"branch\":\"feat\",\"description\":\"d\",\"project_type\":\"it\",\"coordination_mode\":\"independent\",\"problem_statement\":\"p\",\"repo\":{\"primary\":{\"url\":\"https://github.com/o/b\",\"branch\":\"feat\"},\"additional\":[{\"url\":\"https://github.com/o/a\",\"branch\":\"main\"}]},\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	it_refactor:
		"{\"it_flow\":\"refactor\",\"test_command\":[\"make\",\"test\"],\"target_files\":[\"a.py\"],\"approval_mode\":\"brief_and_closure\",\"name\":\"Pinned\",\"shape\":\"deliverable\",\"branch\":\"main\",\"description\":\"d\",\"project_type\":\"it\",\"problem_statement\":\"p\",\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	it_security:
		"{\"it_flow\":\"security\",\"min_severity\":\"CRITICAL\",\"approval_mode\":\"brief_and_closure\",\"name\":\"Pinned\",\"shape\":\"deliverable\",\"branch\":\"main\",\"description\":\"d\",\"project_type\":\"it\",\"problem_statement\":\"p\",\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
	it_bug_hunt:
		"{\"it_flow\":\"bug\",\"bug_hunt\":true,\"test_command\":[\"uv\",\"run\",\"pytest\"],\"approval_mode\":\"brief_and_closure\",\"name\":\"Pinned\",\"repository_url\":\"https://github.com/o/a\",\"shape\":\"deliverable\",\"branch\":\"main\",\"description\":\"d\",\"project_type\":\"it\",\"problem_statement\":\"p\",\"repo\":{\"primary\":{\"url\":\"https://github.com/o/a\",\"branch\":\"main\"}},\"bound_assets\":{\"requirement\":[\"11111111-1111-4111-8111-111111111111\"]}}",
};

describe('non-rewrite payloads are byte-identical to origin/main', () => {
	for (const [name, form] of Object.entries(nonRewriteFixtures())) {
		it(name, () => {
			expect(JSON.stringify(buildPayload(form, ctx()))).toBe(GOLDEN[name]);
		});
		it(`${name} — even with the rewrite inputs filled in`, () => {
			const filled: ProjectFormState = {
				...form,
				rewrite_sources: [{ url: 'https://github.com/o/src', branch: 'dev', pin: 'a'.repeat(40) }],
				rewrite_target_url: 'https://github.com/o/target'
			};
			const payload = buildPayload(filled, ctx());
			expect(JSON.stringify(payload)).toBe(GOLDEN[name]);
			expect(Object.keys(payload)).not.toContain('language');
			expect(Object.keys(payload)).not.toContain('pin');
		});
	}
	it('covers every fixture', () => {
		expect(Object.keys(GOLDEN).sort()).toEqual(Object.keys(nonRewriteFixtures()).sort());
	});
});

const SHA = '0123456789abcdef0123456789abcdef01234567';
const rewriteForm = (over: Partial<ProjectFormState> = {}): ProjectFormState => ({
	...emptyFormState(),
	name: 'Port to Rust',
	project_type: 'it',
	it_flow: 'rewrite',
	// ordinary repository rows are NOT used by a rewrite
	repositories: [{ url: 'https://github.com/o/ignored', branch: 'x', name: '', is_primary: true, pin: '' }],
	coordination_mode: 'independent',
	rewrite_sources: [
		{ url: ' https://github.com/o/src1 ', branch: 'dev', pin: SHA },
		{ url: 'https://github.com/o/src2', branch: '', pin: 'F'.repeat(40) },
		{ url: '  ', branch: '', pin: '' }
	],
	rewrite_target_url: 'https://github.com/o/target',
	...over
});

describe('rewrite payload', () => {
	it('target = primary with role target; each named source = additional row with role source + pin', () => {
		const p = buildPayload(rewriteForm(), { boundAssets: emptyBoundAssets() });
		expect(p.it_flow).toBe('rewrite');
		expect(p.repository_url).toBe('https://github.com/o/target');
		expect(p.branch).toBe('main');
		expect(p.repo).toEqual({
			primary: { url: 'https://github.com/o/target', branch: 'main', role: 'target' },
			additional: [
				{ url: 'https://github.com/o/src1', branch: 'dev', role: 'source', pin: SHA },
				{ url: 'https://github.com/o/src2', role: 'source', pin: 'F'.repeat(40) }
			]
		});
		// no coordination claim: the user was never asked one for a rewrite
		expect(p.coordination_mode).toBeUndefined();
	});

	it('a source pinned to a PR is sent as-is — the backend resolves the head commit', () => {
		const p = buildPayload(
			rewriteForm({ rewrite_sources: [{ url: 'https://github.com/o/src', branch: '', pin: ' #42 ' }] }),
			{ boundAssets: emptyBoundAssets() }
		);
		expect(p.repo?.additional).toEqual([{ url: 'https://github.com/o/src', role: 'source', pin: '#42' }]);
	});

	it('the form asks for NEITHER a language NOR a card cap (George 2026-11-07)', () => {
		const p = buildPayload(rewriteForm(), { boundAssets: emptyBoundAssets() });
		expect('language' in p).toBe(false);
		expect('max_cards' in p).toBe(false);
	});

	it('the access check covers the target and every source', () => {
		expect(rewriteRepositoryUrls(rewriteForm())).toEqual([
			'https://github.com/o/target',
			'https://github.com/o/src1',
			'https://github.com/o/src2'
		]);
	});
});

describe('rewrite validation is format-only', () => {
	const v = (over: Partial<ProjectFormState>) => validateItInputs(rewriteForm(over));
	it('a complete rewrite passes, with no target_packages asked for', () => {
		expect(v({})).toBeNull();
	});
	it('needs at least one source repository', () => {
		expect(v({ rewrite_sources: [{ url: '', branch: '', pin: '' }] })).toMatch(/at least one repository/);
	});
	it('every named source needs a commit SHA or a PR', () => {
		expect(v({ rewrite_sources: [{ url: 'https://github.com/o/s', branch: '', pin: '' }] })).toMatch(
			/40-character commit SHA or a PR/
		);
		expect(v({ rewrite_sources: [{ url: 'https://github.com/o/s', branch: '', pin: 'abc1234' }] })).toMatch(
			/40-character commit SHA or a PR/
		);
		expect(COMMIT_SHA_RE.test('g'.repeat(40))).toBe(false);
		// A PR (number or URL) is a valid pin.
		expect(isRepoPin('#42')).toBe(true);
		expect(isRepoPin('42')).toBe(true);
		expect(isRepoPin('https://github.com/o/s/pull/42')).toBe(true);
		expect(isRepoPin(SHA)).toBe(true);
		expect(isRepoPin('main')).toBe(false);
		expect(v({ rewrite_sources: [{ url: 'https://github.com/o/s', branch: '', pin: '#42' }] })).toBeNull();
	});
	it('needs the target repository', () => {
		expect(v({ rewrite_target_url: ' ' })).toMatch(/rewritten code should go/);
	});
});

describe('ordinary repository pins', () => {
	it('a pinned primary and a pinned additional row reach the payload as `pin`', () => {
		const form: ProjectFormState = {
			...emptyFormState(),
			name: 'Pinned repo',
			project_type: 'it',
			it_flow: 'dependency',
			target_packages: [{ name: 'fastmcp', target_version: '2.3.0' }],
			repositories: [
				{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: true, pin: SHA },
				{ url: 'https://github.com/o/b', branch: 'main', name: 'b', is_primary: false, pin: '#7' }
			]
		};
		const p = buildPayload(form, { boundAssets: emptyBoundAssets() });
		expect(p.repo).toEqual({
			primary: { url: 'https://github.com/o/a', branch: 'main', pin: SHA },
			additional: [{ url: 'https://github.com/o/b', branch: 'main', name: 'b', pin: '#7' }]
		});
	});

	it('an empty pin adds nothing, so an unpinned payload is unchanged', () => {
		const form: ProjectFormState = {
			...emptyFormState(),
			name: 'Unpinned',
			project_type: 'it',
			it_flow: 'security',
			repositories: [{ url: 'https://github.com/o/a', branch: 'main', name: '', is_primary: true, pin: ' ' }]
		};
		expect(buildPayload(form, { boundAssets: emptyBoundAssets() }).repo).toEqual({
			primary: { url: 'https://github.com/o/a', branch: 'main' }
		});
	});
});

// py2rust is NOT a form type: RM reports it retired, so the picker no longer
// offers it and this form must not special-case it. The rewrite inputs are left
// filled in on purpose — only a genuine `it` rewrite may read them.
const py2rustForm = (over: Partial<ProjectFormState> = {}): ProjectFormState => ({
	...emptyFormState(),
	name: 'Port to Rust',
	project_type: 'py2rust',
	it_flow: 'dependency',
	repositories: [{ url: 'https://github.com/o/a', branch: 'dev', name: '', is_primary: true, pin: '' }],
	rewrite_sources: [{ url: 'https://github.com/o/src', branch: '', pin: SHA }],
	rewrite_target_url: 'https://github.com/o/target',
	...over
});

describe('py2rust is not a rewrite form', () => {
	it('isRewriteForm is true ONLY for an it project whose flow is rewrite', () => {
		expect(isRewriteForm(py2rustForm())).toBe(false);
		expect(isRewriteForm({ project_type: 'it', it_flow: 'rewrite' })).toBe(true);
		expect(isRewriteForm({ project_type: 'feature', it_flow: 'rewrite' })).toBe(false);
	});

	it('payload: ordinary repositories, and no language / rewrite additional rows', () => {
		const p = buildPayload(py2rustForm(), { boundAssets: emptyBoundAssets() });
		expect(p.project_type).toBe('py2rust');
		expect(p.repository_url).toBe('https://github.com/o/a');
		expect(p.branch).toBe('dev');
		expect(p.repo).toEqual({ primary: { url: 'https://github.com/o/a', branch: 'dev' } });
		expect(Object.keys(p)).not.toContain('language');
		expect(Object.keys(p)).not.toContain('max_cards');
		expect(Object.keys(p)).not.toContain('it_flow');
	});

	it('is validated like any non-it type: no source/target repository is demanded', () => {
		expect(validateItInputs(py2rustForm())).toBeNull();
		expect(validateItInputs(py2rustForm({ rewrite_sources: [], rewrite_target_url: '' }))).toBeNull();
	});
});

describe('user-facing copy', () => {
	it('asks for no card cap and no language control, and points at the request instead', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./ProjectForm.svelte', import.meta.url), 'utf8');
		expect(src).not.toMatch(/Maximum number of cards/i);
		expect(src).not.toMatch(/MAX_CARDS_LIMIT/);
		expect(src).not.toContain('data-testid="rewrite-language"');
		expect(src).toContain('The target language comes from your request');
		expect(src).not.toMatch(/no limit/i);
	});
	it('names no internal system', async () => {
		const { readFileSync } = await import('node:fs');
		const src = readFileSync(new URL('./ProjectForm.svelte', import.meta.url), 'utf8');
		const markup = src.slice(src.indexOf('data-testid="rewrite-fields"'));
		const rewriteMarkup = markup.slice(0, markup.indexOf('{/snippet}'));
		const repoMarkup = src.slice(src.indexOf('data-testid="rewrite-repositories"'), src.indexOf('{:else}', src.indexOf('data-testid="rewrite-repositories"')));
		for (const text of [rewriteMarkup, repoMarkup]) {
			expect(text.length).toBeGreaterThan(200);
			expect(text).not.toMatch(/\bRM\b|conveyor|it_flow|requirements_management|n8n/i);
		}
	});
});
