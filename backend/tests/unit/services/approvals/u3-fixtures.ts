// Shared fixtures for the U3 suites (u3-gates.test.ts).
// Not a test file: no `test()` is registered here.
import { randomUUID } from 'node:crypto';

import { db, projectReports } from '../../../../src/db/client';
import { bugFingerprint, bugReportHash } from '../../../../src/lib/bug-report-hash';
import { scenariosHash } from '../../../../src/lib/scenarios-hash';
import { writeSetSeal } from '../../../../src/lib/write-set';
import { G12_RULE_VERSION_V2 } from '../../../../src/services/approvals/g12-rule';
import { a3InputsHash } from '../../../../src/services/approvals/u3-gates';

export const QA_HEAD = 'a'.repeat(40);
export const COMMIT = 'b'.repeat(40);

export const U3_BUGS = [
  {
    id: bugFingerprint('src/a.ts', 3, 'null-deref'),
    kind: 'null-deref',
    location: { file: 'src/a.ts', line: 3 },
    failing_test: { path: 'tests/a.test.ts', name: 'a breaks' },
    fix_outline: ['guard null'],
  },
  {
    id: bugFingerprint('src/b.ts', 7, 'empty-list'),
    kind: 'empty-list',
    location: { file: 'src/b.ts', line: 7 },
    failing_test: { path: 'tests/b.test.ts', name: 'b breaks' },
    fix_outline: ['handle empty list'],
  },
  {
    id: bugFingerprint('src/c.ts', 11, 'off-by-one'),
    kind: 'off-by-one',
    location: { file: 'src/c.ts', line: 11 },
    failing_test: { path: 'tests/c.test.ts', name: 'c breaks' },
    fix_outline: ['fix bound'],
  },
];

/** Insert a stored U2 bug_report row (H_r computed the real way). Returns {id, hash}. */
export async function seedBugReport(
  tenantId: string,
  bugs: unknown[] = U3_BUGS,
  // A second report for the SAME bug card (different bugs → different H_r).
  cardId: string = `u3-card-${randomUUID()}`,
): Promise<{ id: string; hash: string; cardId: string }> {
  const hunt = {
    status: 'completed' as const,
    scanned_files: 3,
    tracked_source_files: 3,
    root_cause_analysis: null,
    excluded_dirs: ['.git', 'node_modules'],
    excluded_entry_kinds: ['non_utf8_path' as const, 'submodule' as const, 'symlink' as const],
    worktree_dirty: false,
  };
  const details = { schema: 'bug_report/v1', hunt, repo: 'nonagenticai/ems', commit_sha: COMMIT, bugs };
  const hash = bugReportHash({
    tenant_id: tenantId,
    project_id: null,
    card_id: cardId,
    hunt,
    repo: details.repo,
    commit_sha: details.commit_sha,
    bugs: bugs as typeof U3_BUGS,
  });
  const [row] = await db
    .insert(projectReports)
    .values({
      tenant_id: tenantId,
      card_id: cardId,
      report_type: 'bug_report',
      title: 'u3 report',
      summary: 'three bugs',
      details,
      content_hash: hash,
    })
    .returning({ id: projectReports.id });
  return { id: row!.id, hash, cardId };
}

export function coverageRequest(cardId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    card_id: cardId,
    card_type: 'development_feature_new',
    qa_head_sha: QA_HEAD,
    pr_url: 'https://github.com/nonagenticai/ems/pull/1',
    commit_sha: COMMIT,
    criteria: [
      {
        criterion_id: 'ac-1',
        text: 'returns 200',
        scenario_id: 'scn-1',
        scenario_gherkin: 'Scenario: ok',
        computed: { outcome: 'not_run' },
        reason_not_computed: 'no test',
      },
      { criterion_id: 'ac-2', text: 'logs', scenario_id: null, reason_not_computed: 'manual' },
      { criterion_id: 'ac-3', text: 'errors', scenario_id: 'scn-3', reason_not_computed: 'no test' },
    ],
    artifacts: [{ kind: 'pr', ref: 'https://github.com/nonagenticai/ems/pull/1', sha: QA_HEAD }],
    test_summary: { passed: 4, failed: 0, skipped: 1 },
    ...overrides,
  };
}

export const SCENARIOS = [
  { scenario_id: 'scn_b', criterion_id: 'crit_b', title: 'B', gherkin: 'Scenario: b\r\n  Then ok  \n' },
  { scenario_id: 'scn_a', criterion_id: 'crit_a', title: 'A', gherkin: 'Scenario: a\n' },
];

/** A valid A3 write set: exact paths, unique, UTF-8 byte order (FROZEN WRITE_SET CONTRACT). */
export const WRITE_SET = ['src/design.ts', 'tests/design.test.ts'];

/** The A3 MINT request metadata (what ncn sends): the design + its write_set. */
export function designMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    design_artifact_id: 'design-1',
    design_hash: 'd'.repeat(64),
    contract_hash: 'c'.repeat(64),
    scenarios: SCENARIOS,
    scenarios_hash: scenariosHash(SCENARIOS),
    write_set: WRITE_SET,
    ...overrides,
  };
}

/**
 * The A3 metadata as fr STORES it after mint: the request plus write_set_seal and
 * a3_inputs_hash, recomputed from the (overridden) design_hash + write_set — i.e. a
 * consistent re-mint. Tamper a stored field by spreading over THIS result instead.
 */
export function sealedDesignMetadata(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const m = designMetadata(overrides);
  const seal = writeSetSeal(m.write_set as string[]);
  return { ...m, write_set_seal: seal, a3_inputs_hash: a3InputsHash(m.design_hash as string, seal) };
}

/** The inputs_hash an A3 decision on {@link sealedDesignMetadata}() must carry. */
export const A3_INPUTS_HASH = sealedDesignMetadata().a3_inputs_hash as string;

export function g12(rowAndItems: { rule_row: string; inputs_hash: string; items: unknown[] }, version = G12_RULE_VERSION_V2) {
  return { rule_version: version, ...rowAndItems };
}

/** The metadata ncn stamps on a live bug-fix gate row (RULING 10-01): marker + report + bugs. */
export function bugFixMeta(
  rep: { id: string; hash: string; cardId: string },
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    approval_kind: 'bug_fix_authorization',
    report_id: rep.id,
    report_hash: rep.hash,
    bug_ids: U3_BUGS.map((b) => b.id),
    bug_card_id: rep.cardId,
    ...overrides,
  };
}

/**
 * ncn#1969's DERIVED coverage request (legacy QA path, no computed check ran): source
 * 'derived', null SHAs, no artifacts, an all-zero summary, every criterion not_run.
 */
export function derivedCoverageRequest(cardId: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const notRun = { executed: false, outcome: 'not_run' };
  return {
    source: 'derived',
    card_id: cardId,
    card_type: 'development_feature_new',
    qa_head_sha: null,
    pr_url: 'https://github.com/nonagenticai/ems/pull/1',
    commit_sha: null,
    criteria: [
      { criterion_id: 'ac-1', text: 'returns 200', scenario_id: null, computed: notRun, reason_not_computed: 'legacy QA' },
      { criterion_id: 'ac-2', text: 'logs', scenario_id: null, computed: notRun, reason_not_computed: 'legacy QA' },
      { criterion_id: 'ac-3', text: 'errors', scenario_id: 'scn-3', computed: notRun, reason_not_computed: 'legacy QA' },
    ],
    artifacts: [],
    test_summary: { passed: 0, failed: 0, skipped: 0 },
    ...overrides,
  };
}

/**
 * `assertU3DecideGates` takes the decider's user id; it gates nothing, it only stamps the honest
 * `decider_kind` on an A3. A human (Keycloak sub) and an agent member (version-8 UUID).
 */
export const HUMAN_DECIDER_ID = '0b6a3c1e-2f4d-4a5b-9c6d-7e8f9a0b1c2d';
export const AGENT_DECIDER_ID = '0b6a3c1e-2f4d-8a5b-9c6d-7e8f9a0b1c2d';
