import { describe, expect, test } from 'bun:test';

import {
  assertItExecIntakeInputs,
  assertRepositoryForRepoFeatures,
  GIT_SHA_LIKE_REF_RE,
  projectCreateRepoUrl,
} from '../../../src/routes/projects';
import { EXECUTION_TENANT_ID } from '../../../src/routes/tenants';

const NON_EXEC = '0195f48b-d000-7000-8000-000000000099';
const BUG_CMD = ['python', '-m', 'pytest', 'tests/test_foo.py::test_bar', '-q'];

const call = (
  v: Record<string, unknown>,
  tenant: string = EXECUTION_TENANT_ID,
): void => assertItExecIntakeInputs(v as never, tenant);

describe('assertItExecIntakeInputs — EXEC-tenant `it` intake guard', () => {
  // --- dependency flow (unchanged) ---------------------------------------
  test('dependency flow with NO target_packages + no cve_sweep → throws', () => {
    expect(() => call({ project_type: 'it' })).toThrow(/target_packages/);
  });

  test('dependency flow WITH target_packages → ok', () => {
    expect(() =>
      call({
        project_type: 'it',
        target_packages: [{ name: 'fastmcp', target_version: '3.0.0' }],
      }),
    ).not.toThrow();
  });

  test('dependency flow with cve_sweep=true (discovery) → ok', () => {
    expect(() =>
      call({ project_type: 'it', cve_sweep: true }),
    ).not.toThrow();
  });

  // --- remediation flows (the fix) ---------------------------------------
  test('bug flow with bug_test_command + NO target_packages → ok (was wrongly blocked)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'bug', bug_test_command: BUG_CMD }),
    ).not.toThrow();
  });

  test('bug flow WITHOUT bug_test_command → throws (must carry the failing test)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'bug' }),
    ).toThrow(/bug_test_command/);
  });

  test('security flow with NO target_packages → ok (carries min_severity)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'security', min_severity: 'HIGH' }),
    ).not.toThrow();
  });

  test('source-security flow with NO target_packages → ok (SAST remediation)', () => {
    expect(() =>
      call({
        project_type: 'it',
        it_flow: 'source-security',
        min_severity: 'HIGH',
      }),
    ).not.toThrow();
  });

  test('iac flow with NO target_packages → ok (trivy-config remediation)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'iac', min_severity: 'HIGH' }),
    ).not.toThrow();
  });

  // --- refactor flow (rung 5: architecture_refactoring) -------------------
  // A refactor project carries target_files + test_command, never target_packages.
  // If `refactor` is missing from isRemediationFlow the guard demands packages and
  // intake 400s, so this is the RED that pins the guard half of the change.
  test('refactor flow with NO target_packages → ok (carries target_files instead)', () => {
    expect(() =>
      call({
        project_type: 'it',
        it_flow: 'refactor',
        target_files: ['src/aacyc_alpha/core.py', 'src/aacyc_beta/core.py'],
        test_command: ['python', '-m', 'src.aacyc_check'],
      }),
    ).not.toThrow();
  });

  // Negative control: the guard must still bite when the flow is NOT a remediation
  // flow, so the test above cannot pass by the guard having been disabled wholesale.
  test('unset it_flow with NO target_packages → still throws (guard not disabled)', () => {
    expect(() => call({ project_type: 'it', target_files: ['a.py'] })).toThrow(
      /target_packages/,
    );
  });

  // --- scope: only EXEC-tenant `it` is guarded ---------------------------
  test('non-EXEC tenant `it` with no target_packages → no-op', () => {
    expect(() => call({ project_type: 'it' }, NON_EXEC)).not.toThrow();
  });

  test('non-`it` project_type on EXEC → no-op', () => {
    expect(() => call({ project_type: 'feature' })).not.toThrow();
  });
});

// --- bug_hunt: hunt mode of it_flow='bug' (G1 design §1/§4, B2) -------------
describe('assertItExecIntakeInputs — bug_hunt', () => {
  const SUITE = ['uv', 'run', '--no-sync', 'python', '-m', 'pytest'];
  const hunt = (extra: Record<string, unknown> = {}) => ({
    project_type: 'it',
    it_flow: 'bug',
    bug_hunt: true,
    test_command: SUITE,
    branch: 'dry/p1-a',
    ...extra,
  });

  test('hunt with suite test_command + named branch → ok', () => {
    expect(() => call(hunt())).not.toThrow();
  });

  test('hunt on branch "main" → ok', () => {
    expect(() => call(hunt({ branch: 'main' }))).not.toThrow();
  });

  test('hunt WITHOUT test_command → throws', () => {
    expect(() => call(hunt({ test_command: undefined }))).toThrow(
      /^bug_hunt_requires_test_command:/,
    );
  });

  test('hunt with blank-only test_command → throws', () => {
    expect(() => call(hunt({ test_command: ['  '] }))).toThrow(
      /^bug_hunt_requires_test_command:/,
    );
  });

  test('hunt WITH bug_test_command (even []) → throws', () => {
    expect(() => call(hunt({ bug_test_command: [] }))).toThrow(
      /^bug_test_command_not_allowed_for_hunt:/,
    );
    expect(() => call(hunt({ bug_test_command: BUG_CMD }))).toThrow(
      /^bug_test_command_not_allowed_for_hunt:/,
    );
  });

  test('hunt with it_flow "security" → throws', () => {
    expect(() => call(hunt({ it_flow: 'security' }))).toThrow(/^bug_hunt_requires_bug_flow:/);
  });

  test('hunt on a NON-EXEC tenant → throws bug_hunt_exec_only (not silently skipped)', () => {
    expect(() => call(hunt(), NON_EXEC)).toThrow(/^bug_hunt_exec_only:/);
  });

  // RM's defaults replaced `it` with `bug_hunt_fix`; create must accept the flag there.
  test('RM bug_hunt_fix hunt with suite test_command + named branch → ok', () => {
    expect(() => call(hunt({ project_type: 'bug_hunt_fix' }))).not.toThrow();
  });

  test('bug_hunt_fix hunt still gets every hunt rule (no test_command → throws)', () => {
    expect(() => call(hunt({ project_type: 'bug_hunt_fix', test_command: undefined }))).toThrow(
      /^bug_hunt_requires_test_command:/,
    );
    expect(() => call(hunt({ project_type: 'bug_hunt_fix', branch: '37fe271' }))).toThrow(
      /^bug_hunt_branch_must_be_name:/,
    );
  });

  test('bug_hunt_fix hunt on a NON-EXEC tenant → throws bug_hunt_exec_only', () => {
    expect(() => call(hunt({ project_type: 'bug_hunt_fix' }), NON_EXEC)).toThrow(/^bug_hunt_exec_only:/);
  });

  test('hunt with project_type "feature" → throws bug_hunt_exec_only', () => {
    expect(() => call(hunt({ project_type: 'feature' }))).toThrow(/^bug_hunt_exec_only:/);
  });

  test.each([
    ['short sha', { branch: '37fe271' }],
    ['all-hex name', { branch: 'deadbeef' }],
    ['40-hex sha', { branch: 'a'.repeat(20) + '0123456789ABCDEF0123' }],
    ['primary branch sha', { repo: { primary: { url: 'https://x/y', branch: '37fe271' } } }],
    [
      '40-hex in repo.additional[0]',
      {
        repo: {
          primary: { url: 'https://x/y', branch: 'dry/p1-a' },
          additional: [{ url: 'https://x/z', branch: '0123456789abcdef0123456789abcdef01234567' }],
        },
      },
    ],
  ])('hunt with sha-like branch (%s) → throws', (_label, extra) => {
    expect(() => call(hunt(extra))).toThrow(/^bug_hunt_branch_must_be_name:/);
  });

  test('hunt with fixture:true → throws', () => {
    expect(() => call(hunt({ fixture: true }))).toThrow(/^bug_hunt_fixture_forbidden:/);
  });

  test('hunt whose requestor is in FR_FIXTURE_REQUESTORS → throws', () => {
    const prev = process.env.FR_FIXTURE_REQUESTORS;
    process.env.FR_FIXTURE_REQUESTORS = 'g1-hunt-fixture-driver.sh';
    try {
      expect(() => call(hunt({ requestor: 'g1-hunt-fixture-driver.sh' }))).toThrow(
        /^bug_hunt_fixture_forbidden:/,
      );
      // control: a non-listed requestor passes under the same env
      expect(() => call(hunt({ requestor: 'george' }))).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.FR_FIXTURE_REQUESTORS;
      else process.env.FR_FIXTURE_REQUESTORS = prev;
    }
  });

  test('non-hunt bug flow without bug_test_command → still throws (regression)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'bug', bug_hunt: false, test_command: SUITE }),
    ).toThrow(/bug_test_command/);
  });

  test('non-hunt bug flow with a sha branch → not this guard\'s business (ok)', () => {
    expect(() =>
      call({ project_type: 'it', it_flow: 'bug', bug_test_command: BUG_CMD, branch: '37fe271' }),
    ).not.toThrow();
  });

  // Drift pin: MUST equal coding-containers
  // src/core/kubernetes_container_provisioner.py:379 `_GIT_SHA_RE`.
  test('GIT_SHA_LIKE_REF_RE is pinned to the provisioner regex', () => {
    expect(GIT_SHA_LIKE_REF_RE.source).toBe('^[0-9a-fA-F]{7,40}$');
    expect(GIT_SHA_LIKE_REF_RE.flags).toBe('');
  });
});

// George 2026-10-13: a repository is OPTIONAL. Only the features that cannot run
// without one refuse a repo-less create; everything else is not applicable.
describe('assertRepositoryForRepoFeatures — repo-less creates', () => {
  const gate = (v: Record<string, unknown>): void => assertRepositoryForRepoFeatures(v as never);
  const codeOf = (fn: () => void): string | undefined => {
    try {
      fn();
      return undefined;
    } catch (err) {
      return (err as { details?: { code?: string } }).details?.code;
    }
  };

  test('no repo, ordinary project → ok', () => {
    expect(() => gate({})).not.toThrow();
    expect(() => gate({ repository_url: null })).not.toThrow();
  });

  test('bug hunt with no repo → 422 repository_required_for_bug_hunt', () => {
    expect(codeOf(() => gate({ bug_hunt: true }))).toBe('repository_required_for_bug_hunt');
  });

  test('CVE sweep with no repo → 422 repository_required_for_cve_sweep', () => {
    expect(codeOf(() => gate({ cve_sweep: true, repository_url: null }))).toBe('repository_required_for_cve_sweep');
  });

  test('bug hunt / CVE sweep WITH a repo (either spelling) → ok', () => {
    expect(() => gate({ bug_hunt: true, repository_url: 'https://github.com/a/b' })).not.toThrow();
    expect(() => gate({ cve_sweep: true, repo: { primary: { url: 'https://github.com/a/b' } } })).not.toThrow();
  });

  test('a PROVIDED CP sentinel → 422 repository_url_required (both spellings)', () => {
    const S = 'https://example.invalid/REPLACE-IN-FR';
    expect(codeOf(() => gate({ repository_url: S }))).toBe('repository_url_required');
    expect(codeOf(() => gate({ repo: { primary: { url: S } } }))).toBe('repository_url_required');
  });

  test('projectCreateRepoUrl: blank/whitespace/null read as "no repo", never ""', () => {
    expect(projectCreateRepoUrl({} as never)).toBeUndefined();
    expect(projectCreateRepoUrl({ repository_url: null } as never)).toBeUndefined();
    expect(projectCreateRepoUrl({ repo: { primary: { url: '  ' } } } as never)).toBeUndefined();
    expect(projectCreateRepoUrl({ repository_url: 'https://github.com/a/b' } as never)).toBe('https://github.com/a/b');
  });
});
