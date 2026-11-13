// ProjectForm — the IT remediation inputs (project_type === 'it').
//
// The backend's ProjectCreateSchema has accepted it_flow / cve_sweep /
// target_packages / test_command / bug_test_command / failing_test_ref /
// target_files / min_severity all along, and project_type is an open z.string().
// The form simply never exposed any of it — so the ONLY way to start a
// code-changing project was the CLI drive scripts, and George (who works only in
// the frontend) could not reach the code-running path at all.
//
// These cover the two pieces of real logic the form now owns: turning a typed
// command into the ARGV array the wire format requires, and mirroring the
// backend's IT guards so the user sees the error in the form instead of a 422.
// Backend authority: backend/src/routes/projects.ts (assertItProjectInputs).

import { describe, expect, it } from 'vitest';
import { GIT_SHA_LIKE_REF_RE, parseArgv, validateItInputs } from './ProjectForm.svelte';

describe('parseArgv', () => {
	it('splits a plain command into argv', () => {
		expect(parseArgv('pytest -q')).toEqual(['pytest', '-q']);
		expect(parseArgv('npm test')).toEqual(['npm', 'test']);
	});

	it('collapses runs of whitespace', () => {
		expect(parseArgv('  pytest   -q  ')).toEqual(['pytest', '-q']);
	});

	it('honours quotes — a naive whitespace split would ship a broken command', () => {
		// This is the case that matters: the wrong parse only fails later, inside the
		// container, and reads as a test failure rather than a form bug.
		expect(parseArgv('pytest -k "foo bar"')).toEqual(['pytest', '-k', 'foo bar']);
		expect(parseArgv("pytest -k 'foo bar'")).toEqual(['pytest', '-k', 'foo bar']);
	});

	it('preserves an intentionally empty quoted argument', () => {
		expect(parseArgv('cmd ""')).toEqual(['cmd', '']);
	});

	it('returns [] for empty input', () => {
		expect(parseArgv('')).toEqual([]);
		expect(parseArgv('   ')).toEqual([]);
	});
});

const base = {
	project_type: 'it',
	it_flow: 'dependency',
	cve_sweep: false,
	target_packages: [] as { name: string; target_version: string }[],
	bug_test_command: ''
};

describe('validateItInputs — mirrors the backend guards', () => {
	it('is a no-op for any non-it project type', () => {
		expect(validateItInputs({ ...base, project_type: 'feature' })).toBeNull();
		// A LEGACY stored project_type. The form stopped offering `greenfield`
		// (and brownfield/migration/refactor/poc/maintenance) on 2026-10-01, but
		// `project_type` is an open `z.string()` on the wire and existing projects
		// still carry these values — the guard must stay a no-op for them.
		expect(validateItInputs({ ...base, project_type: 'greenfield' })).toBeNull();
		expect(validateItInputs({ ...base, project_type: '' })).toBeNull();
	});

	it('requires target_packages for a dependency upgrade', () => {
		expect(validateItInputs(base)).toMatch(/target package/i);
	});

	it('accepts a dependency upgrade with explicit targets', () => {
		expect(validateItInputs({ ...base, target_packages: [{ name: 'fastmcp', target_version: '2.3.0' }] })).toBeNull();
	});

	it('accepts a dependency upgrade with cve_sweep instead of targets (discovery mode)', () => {
		expect(validateItInputs({ ...base, cve_sweep: true })).toBeNull();
	});

	it('a CVE sweep needs a repository; a plain dependency upgrade does not', () => {
		const blank = [{ url: '  ', branch: '' }];
		expect(validateItInputs({ ...base, cve_sweep: true, repositories: blank })).toMatch(/CVE sweep, a repository is required/);
		expect(
			validateItInputs({ ...base, cve_sweep: true, repositories: [{ url: 'https://github.com/acme/a', branch: '' }] })
		).toBeNull();
		expect(
			validateItInputs({ ...base, target_packages: [{ name: 'x', target_version: '1' }], repositories: blank })
		).toBeNull();
	});

	it('does NOT require target_packages for the remediation flows — they carry their own inputs', () => {
		for (const flow of ['security', 'source-security', 'iac']) {
			expect(validateItInputs({ ...base, it_flow: flow })).toBeNull();
		}
	});

	it('requires a failing test command for the bug flow', () => {
		expect(validateItInputs({ ...base, it_flow: 'bug' })).toMatch(/failing test/i);
		// whitespace-only is not a command
		expect(validateItInputs({ ...base, it_flow: 'bug', bug_test_command: '   ' })).toMatch(
			/failing test/i
		);
	});

	it('accepts the bug flow with a failing test command', () => {
		expect(
			validateItInputs({ ...base, it_flow: 'bug', bug_test_command: 'pytest -q tests/x.py' })
		).toBeNull();
	});
});

// Bug HUNT (it_flow 'bug' + bug_hunt) — mirrors backend assertItExecIntakeInputs
// (backend/tests/unit/routes/it-intake-guard.test.ts is the authority's twin).
describe('validateItInputs — bug hunt', () => {
	const hunt = {
		...base,
		it_flow: 'bug',
		bug_hunt: true,
		test_command: 'uv run --no-sync python -m pytest',
		repositories: [{ url: 'https://github.com/acme/ems', branch: 'dry/p1-a' }]
	};

	it('accepts a hunt with a suite command and a named branch (no failing test needed)', () => {
		expect(validateItInputs(hunt)).toBeNull();
	});

	it('requires the suite test command when hunting', () => {
		expect(validateItInputs({ ...hunt, test_command: '' })).toMatch(/test suite command/i);
		expect(validateItInputs({ ...hunt, test_command: '   ' })).toMatch(/test suite command/i);
	});

	it.each(['37fe271', 'deadbeef', '0123456789abcdef0123456789abcdef01234567'])(
		'refuses a sha-like branch %s on any named repository row',
		(sha) => {
			expect(
				validateItInputs({ ...hunt, repositories: [{ url: 'https://x/y', branch: sha }] })
			).toMatch(/branch NAME/);
			expect(
				validateItInputs({
					...hunt,
					repositories: [
						{ url: 'https://x/y', branch: 'main' },
						{ url: 'https://x/z', branch: sha }
					]
				})
			).toMatch(/branch NAME/);
		}
	);

	it('non-hunt bug flow without bug_test_command is still refused (regression)', () => {
		expect(
			validateItInputs({ ...hunt, bug_hunt: false })
		).toMatch(/failing test/i);
	});

	it('pins the sha regex to the backend/provisioner copy', () => {
		expect(GIT_SHA_LIKE_REF_RE.source).toBe('^[0-9a-fA-F]{7,40}$');
	});
});
