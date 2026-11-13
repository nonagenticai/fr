// tests/unit/routes/decomposition-commit-scenarios-repos.test.ts
//
// C1-58 follow-up, the PURE halves (no DB):
//   A. D14 — the deterministic Gherkin scenario skeleton written onto every
//      minted card: `scn_<8hex>` 1:1 with `crit_<8hex>`, same order, stable.
//   B. fr#1332 — per-deliverable repo attribution: promote carries `repos`,
//      a child `repo` must be one of its deliverable's attributed repos, and
//      the card description gets `repository_url` only when a repo was named.
// The DB + route halves (the decomposition-commit and
// project-request-outline-carry-through integration suites) were deleted
// 2026-10-29 — no longer in the suite.
//
// MUTATION CONTROLS (each applied, run RED, reverted):
//   * scenarioSkeleton: `scn_${crypto.randomUUID().slice(0, 8)}` → the
//     "same AC text → same scn id" and "stable across calls" tests go RED.
//   * mintedCardDescription: always emit `repository_url` → "absent repo keeps
//     today's description" goes RED.
//   * validateChildRepos: skip the membership check → the 422 test goes RED.

import { createHash } from 'node:crypto';

import { describe, expect, test } from 'bun:test';

import {
  canonRepo,
  criteriaFromAcceptance,
  mintedCardDescription,
  scenarioSkeleton,
  validateChildRepos,
} from '../../../src/routes/decomposition-commit';
import { buildApprovedScopeRows } from '../../../src/routes/project-requests';

const hex8 = (t: string) => createHash('sha1').update(t).digest('hex').slice(0, 8);

const DELIV = {
  id: '00000000-0000-4000-8000-00000000d001',
  kind: 'deliverable',
  title: 'D1',
  description: 'about D1',
  acceptance_criteria: ['the export is a CSV', 'every row has an id', 'the export is a CSV'],
};

describe('A. scenario skeleton (D14)', () => {
  test('1:1 with criteria, same order, scn id = scn_ + the criterion 8 hex', () => {
    const crit = criteriaFromAcceptance(DELIV.acceptance_criteria);
    const scn = scenarioSkeleton(crit);
    // 3 ACs, one repeated ⇒ 2 distinct criteria ⇒ 2 scenarios (first-occurrence order).
    expect(scn).toHaveLength(2);
    expect(scn.map((s) => s.criterion_id)).toEqual([...new Set(crit.map((c) => c.id))]);
    expect(scn.map((s) => s.title)).toEqual(['the export is a CSV', 'every row has an id']);
    expect(scn[0]).toStrictEqual({
      scenario_id: `scn_${hex8('the export is a CSV')}`,
      criterion_id: `crit_${hex8('the export is a CSV')}`,
      title: 'the export is a CSV',
      gherkin: null,
      status: 'pending',
    });
    for (const s of scn) expect(s.scenario_id.slice(4)).toBe(s.criterion_id.slice(5));
  });

  test('the same AC text gives the same scn id — across calls and across cards', () => {
    const a = scenarioSkeleton(criteriaFromAcceptance(['x happens', 'y happens']));
    const b = scenarioSkeleton(criteriaFromAcceptance(['other', 'x happens']));
    expect(a[0]!.scenario_id).toBe(b[1]!.scenario_id);
    expect(a[0]!.scenario_id).toBe(`scn_${hex8('x happens')}`);
    // A duplicated criterion within one card is ONE criterion ⇒ ONE scenario: a
    // repeated scn_ id is refused by the strict schema and by the canonical hash.
    const dup = scenarioSkeleton(criteriaFromAcceptance(DELIV.acceptance_criteria));
    expect(dup).toHaveLength(2);
    expect(new Set(dup.map((s) => s.scenario_id)).size).toBe(dup.length);
  });

  test('stable across replays: two descriptions for one deliverable are byte-identical', () => {
    const one = mintedCardDescription({ decompositionId: 'dec-1', deliverable: DELIV });
    const two = mintedCardDescription({ decompositionId: 'dec-1', deliverable: DELIV });
    expect(one).toBe(two);
    const parsed = JSON.parse(one) as { gherkin_scenarios: Array<{ scenario_id: string }> };
    expect(parsed.gherkin_scenarios.map((s) => s.scenario_id)).toEqual(
      [...new Set(DELIV.acceptance_criteria)].map((t) => `scn_${hex8(t)}`),
    );
  });

  test('an empty AC list gives an empty array (never absent); junk ACs are skipped like criteria', () => {
    expect(scenarioSkeleton(criteriaFromAcceptance([]))).toEqual([]);
    expect(scenarioSkeleton(criteriaFromAcceptance(null))).toEqual([]);
    expect(scenarioSkeleton(criteriaFromAcceptance(['', 7, 'ok']))).toHaveLength(1);
    const d = JSON.parse(
      mintedCardDescription({ decompositionId: 'dec-1', deliverable: { ...DELIV, acceptance_criteria: [] } }),
    ) as Record<string, unknown>;
    expect(d.gherkin_scenarios).toEqual([]);
  });
});

describe('B. per-deliverable repo attribution (fr#1332)', () => {
  const R1 = 'https://github.com/acme/api';
  const R2 = 'git@github.com:acme/worker.git';

  test('promote carries repos verbatim; an unattributed item stores null, never []', () => {
    const rows = buildApprovedScopeRows(
      {
        id: '00000000-0000-4000-8000-0000147a0001',
        deliverables: [
          { kind: 'code_change', title: 'D1', acceptance_criteria: ['a'], repos: [R1, R2] },
          { kind: 'artifact', title: 'D2', acceptance_criteria: ['b'] },
        ],
        intermediate_deliverables: [
          { kind: 'code_change', title: 'I1', acceptance_criteria: [], repos: [R2], repos_source: 'default_primary' },
        ],
        milestones: [],
        effort_estimate: null,
      },
      '00000000-0000-4000-8000-0000147a0002',
    );
    expect(rows.deliverables.map((r) => r.repos)).toEqual([[R1, R2], null, [R2]]);
    // repos_source has no column and no reader: still dropped.
    expect(Object.keys(rows.deliverables[2]!)).not.toContain('repos_source');
  });

  test('a child repo among its deliverable\'s attributed repos is accepted; the STORED spelling wins', () => {
    const r = validateChildRepos(
      [
        { deliverable_id: 'd1', repo: 'HTTPS://github.com/acme/api.git/' },
        { deliverable_id: 'd2' },
      ],
      [
        { id: 'd1', repos: [R1, R2] },
        { id: 'd2', repos: null },
      ],
    );
    expect('refusal' in r).toBe(false);
    if ('refusal' in r) return;
    expect([...r.repoByDeliverable.entries()]).toEqual([['d1', R1]]);
    expect(canonRepo('HTTPS://github.com/acme/api.git/')).toBe(canonRepo(R1));
  });

  test('a non-attributed repo → 422 repo_not_attributed, listing each offender (also for an UNATTRIBUTED deliverable)', () => {
    const r = validateChildRepos(
      [
        { deliverable_id: 'd1', repo: 'https://github.com/acme/other' },
        { deliverable_id: 'd2', repo: R1 },
        { deliverable_id: 'd3', repo: R2 },
      ],
      [
        { id: 'd1', repos: [R1] },
        { id: 'd2', repos: null },
        { id: 'd3', repos: [R2] },
      ],
    );
    expect('refusal' in r).toBe(true);
    if (!('refusal' in r)) return;
    expect(r.refusal.status).toBe(422);
    expect(r.refusal.body.error).toBe('repo_not_attributed');
    expect(r.refusal.body.invalid).toEqual([
      { deliverable_id: 'd1', repo: 'https://github.com/acme/other', attributed: [R1] },
      { deliverable_id: 'd2', repo: R1, attributed: null },
    ]);
  });

  test('description: repository_url present only when a repo was named; absent repo keeps today\'s keys', () => {
    const withRepo = JSON.parse(
      mintedCardDescription({ decompositionId: 'dec-1', deliverable: DELIV, repositoryUrl: R1 }),
    ) as Record<string, unknown>;
    expect(withRepo.repository_url).toBe(R1);
    const without = JSON.parse(
      mintedCardDescription({ decompositionId: 'dec-1', deliverable: DELIV }),
    ) as Record<string, unknown>;
    expect('repository_url' in without).toBe(false);
    expect(Object.keys(without)).toEqual([
      'decomposition_id',
      'deliverable_id',
      'kind',
      'title',
      'description',
      'acceptance_criteria',
      'gherkin_scenarios',
    ]);
  });
});
