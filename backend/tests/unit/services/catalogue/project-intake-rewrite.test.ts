// tests/unit/services/catalogue/project-intake-rewrite.test.ts
//
// The `it` rewrite flow (RS-D1): fr's create body → RM intake mapping for an
// `it` project of flow `rewrite` (repository role + sha, brief.target_language), and
// the STRICTLY ADDITIVE guarantee: every non-rewrite body maps
// BYTE-IDENTICALLY to what origin/main (367a890cd, before these fields existed)
// produced. The GOLDEN strings below were captured by running origin/main's
// project-intake.ts over these exact bodies; do not regenerate them from the
// code under test. One deliberate change since then (George 2026-10-31):
// it_inputs always carries approval_mode ('brief_and_closure' when the body has
// none), hand-added below.
//
// ⛔ py2rust is NOT a rewrite project TYPE any more. RM reports it retired, and
// the route now refuses it with 422 project_type_retired; the pin at the bottom
// is on the shared startability predicate (the same one behind the picker's
// `startable` flag and that refusal).
//
// Hermetic: pure functions, no DB.

import { describe, expect, test } from 'bun:test';

import { ProjectCreateSchema } from '../../../../src/types/api';
import {
  BRIEF_KEYS,
  frKeptProjectData,
  IT_INPUT_KEYS,
  RM_ONLY_PROJECT_DATA_KEYS,
  rmIntakeOfCreate,
  rmRepositoriesOf,
} from '../../../../src/services/catalogue/project-intake';
import { isStartableProjectType } from '../../../../src/services/catalogue/tenant-catalogue';

const map = (body: unknown): string => {
  const v = ProjectCreateSchema.parse(body);
  return JSON.stringify({
    intake: rmIntakeOfCreate(v as never, { scopeLevel: 'repo', priorityLevelId: null }),
    kept: frKeptProjectData(v as never),
  });
};

const NON_REWRITE: Record<string, { body: unknown; golden: string }> = {
  legacy_url: {
    body: { name: 'L', repository_url: 'https://github.com/o/a', branch: 'dev', project_type: 'it', it_flow: 'bug', bug_test_command: ['pytest'], problem_statement: 'p' },
    golden:
      '{"intake":{"repositories":[{"url":"https://github.com/o/a","branch":"dev","primary":true}],"coordination_mode":"coordinated","scope_level":"repo","shape":"deliverable","it_inputs":{"it_flow":"bug","bug_test_command":["pytest"],"approval_mode":"brief_and_closure"},"brief":{"problem_statement":"p"}},"kept":{"it_flow":"bug"}}',
  },
  repo_obj: {
    body: {
      name: 'R',
      project_type: 'feature',
      repo: { primary: { url: 'https://github.com/o/a', branch: 'main', path: 'svc' }, additional: [{ url: 'https://github.com/o/b', name: 'B' }, { url: 'https://github.com/o/c', branch: 'x' }] },
      coordination_mode: 'independent',
      requestor: 'me',
      fixture: true,
    },
    golden:
      '{"intake":{"repositories":[{"url":"https://github.com/o/a","branch":"main","path":"svc","primary":true},{"url":"https://github.com/o/b","branch":null,"name":"B","primary":false},{"url":"https://github.com/o/c","branch":"x","primary":false}],"coordination_mode":"independent","scope_level":"repo","shape":"deliverable","fixture":true,"requested_by":"me","it_inputs":{"approval_mode":"brief_and_closure"},"brief":{}},"kept":{"fixture":true,"requestor":"me"}}',
  },
  it_dep: {
    body: { name: 'D', project_type: 'it', it_flow: 'dependency', target_packages: [{ name: 'a', target_version: '1' }], cve_sweep: true, min_severity: 'HIGH', test_command: ['make'], target_files: ['x'], secret_ids: ['11111111-1111-4111-8111-111111111111'] },
    golden:
      '{"intake":{"coordination_mode":"coordinated","scope_level":"repo","shape":"deliverable","it_inputs":{"it_flow":"dependency","min_severity":"HIGH","cve_sweep":true,"target_packages":[{"name":"a","target_version":"1"}],"test_command":["make"],"target_files":["x"],"approval_mode":"brief_and_closure"},"attachments":{"secret_ids":["11111111-1111-4111-8111-111111111111"],"document_ids":[]},"brief":{}},"kept":{"cve_sweep":true,"it_flow":"dependency"}}',
  },
  no_repo: {
    body: { name: 'N', description: 'x', success_criteria: ['s'] },
    golden: '{"intake":{"coordination_mode":"coordinated","scope_level":"repo","shape":"deliverable","it_inputs":{"approval_mode":"brief_and_closure"},"brief":{"success_criteria":["s"]}},"kept":{}}',
  },
};

describe('non-rewrite bodies map byte-identically to origin/main', () => {
  for (const [name, { body, golden }] of Object.entries(NON_REWRITE)) {
    test(name, () => {
      expect(map(body)).toBe(golden);
    });
  }
});

const SHA = '0123456789abcdef0123456789ABCDEF01234567';

describe('rewrite bodies', () => {
  const body = {
    name: 'W',
    it_flow: 'rewrite',
    target_language: 'rust',
    repository_url: 'https://github.com/o/target',
    repo: {
      primary: { url: 'https://github.com/o/target', branch: 'main', role: 'target' },
      additional: [
        { url: 'https://github.com/o/src1', branch: 'dev', role: 'source', sha: SHA },
        { url: 'https://github.com/o/src2', role: 'source', sha: 'f'.repeat(40) },
      ],
    },
  };

  test('role + sha pass through on every repository; the target stays primary', () => {
    const v = ProjectCreateSchema.parse(body);
    expect(rmRepositoriesOf(v as never)).toEqual([
      { url: 'https://github.com/o/target', branch: 'main', primary: true, role: 'target' },
      { url: 'https://github.com/o/src1', branch: 'dev', primary: false, role: 'source', sha: SHA },
      { url: 'https://github.com/o/src2', branch: null, primary: false, role: 'source', sha: 'f'.repeat(40) },
    ]);
  });

  test('the target language lands in the BRIEF (RM) and NOT in it_inputs or project_data', () => {
    const v = ProjectCreateSchema.parse(body);
    const intake = rmIntakeOfCreate(v as never, {});
    // George 2026-11-07: it is a fact about the REQUEST, so it is recorded with the rest
    // of the brief — not among the conveyor's execution knobs.
    expect(intake.brief).toEqual({ target_language: 'rust' });
    expect(intake.it_inputs).toEqual({ it_flow: 'rewrite', approval_mode: 'brief_and_closure' });
    expect(frKeptProjectData(v as never)).toEqual({ it_flow: 'rewrite' });
    expect(BRIEF_KEYS).toContain('target_language');
    expect(IT_INPUT_KEYS).not.toContain('language');
    expect(RM_ONLY_PROJECT_DATA_KEYS).toContain('target_language');
  });

  test('a RETIRED type is not startable, whatever its phase list looks like', () => {
    // py2rust used to be a rewrite project TYPE in this form; RM now reports it
    // retired. `isStartableProjectType` is the one predicate behind the picker's
    // `startable` flag AND the create route's refusals, so it must answer false
    // on the retirement stamp alone — a retired type can still list `setup`
    // first, and that must not make it startable.
    const setupPhase = { phase_id: 'setup', name: 'setup', title: 'Setup', position: 0, has_gate: false };
    expect(isStartableProjectType({ phases: [setupPhase], retired_at: null })).toBe(true);
    expect(isStartableProjectType({ phases: [setupPhase], retired_at: '2026-11-01T00:00:00Z' })).toBe(false);
    // ... and the type is still a RESOLVABLE name: retirement is not deletion, so
    // the route's retired branch (not "unknown") is the one that answers.
    expect(ProjectCreateSchema.parse({ ...body, project_type: 'py2rust' }).project_type).toBe('py2rust');
  });

  test('format only: fr does NOT judge the repository set (no source, no target) — RM decides', () => {
    expect(ProjectCreateSchema.safeParse({ name: 'W', it_flow: 'rewrite' }).success).toBe(true);
    expect(
      ProjectCreateSchema.safeParse({ name: 'W', it_flow: 'rewrite', repo: { primary: { url: 'https://github.com/o/a', role: 'source' } } }).success,
    ).toBe(true);
  });

  test('format: sha / pin must be a commit or a PR; role / language must be in the vocabulary', () => {
    const repo = (sha: string) => ({ name: 'W', repo: { primary: { url: 'u', role: 'target' }, additional: [{ url: 'v', role: 'source', sha }] } });
    expect(ProjectCreateSchema.safeParse(repo(SHA)).success).toBe(true);
    expect(ProjectCreateSchema.safeParse(repo('abc1234')).success).toBe(false);
    expect(ProjectCreateSchema.safeParse(repo('g'.repeat(40))).success).toBe(false);
    expect(ProjectCreateSchema.safeParse(repo('a'.repeat(41))).success).toBe(false);
    expect(ProjectCreateSchema.safeParse({ name: 'W', repo: { primary: { url: 'u', role: 'owner' } } }).success).toBe(false);
    expect(ProjectCreateSchema.safeParse({ name: 'W', target_language: 'go' }).success).toBe(false);
    // `language` is GONE from the wire schema: zod strips it, so it can never reach RM
    // (same rule as `max_cards` below). A stale caller loses it loudly at RM, which
    // demands brief.target_language on a rewrite.
    expect('language' in ProjectCreateSchema.parse({ name: 'W', language: 'rust' })).toBe(false);
    // A repository PIN (George 2026-11-07): a full commit SHA, a PR number or a PR URL.
    const pinned = (pin: string) => ({ name: 'W', repo: { primary: { url: 'https://github.com/o/a', pin } } });
    for (const ok of [SHA, '#42', '42', 'https://github.com/o/a/pull/42']) {
      expect(ProjectCreateSchema.safeParse(pinned(ok)).success).toBe(true);
    }
    for (const bad of ['', 'abc1234', 'main', '#', 'https://github.com/o/a/pull/x']) {
      expect(ProjectCreateSchema.safeParse(pinned(bad)).success).toBe(false);
    }
    // `max_cards` is gone from the wire schema: zod STRIPS it, so it can never reach RM.
    const withCap = ProjectCreateSchema.parse({ name: 'W', max_cards: 7 });
    expect('max_cards' in withCap).toBe(false);
  });
});
