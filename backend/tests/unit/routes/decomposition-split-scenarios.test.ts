// tests/unit/routes/decomposition-split-scenarios.test.ts
//
// G-25 — a READYING-split child carries the same deterministic Gherkin
// skeleton the commit path mints. PURE (no DB).
//
// MUTATION CONTROLS (each applied, run RED, reverted):
//   * drop `gherkin_scenarios` from buildSplitChildDescription → presence + parity RED.
//   * build the skeleton from a different hash (e.g. sha256 ids) → parity RED.

import { describe, expect, test } from 'bun:test';

import { buildSplitChildDescription, splitChildHash } from '../../../src/routes/decomposition-split';
import {
  criteriaFromAcceptance,
  mintedCardDescription,
  scenarioSkeleton,
} from '../../../src/routes/decomposition-commit';

const AC = ['a user can log in', 'a bad password is refused', 'a user can log in'];
const build = (ac: string[]) =>
  buildSplitChildDescription({
    description: 'child text',
    projectId: '11111111-1111-4111-8111-111111111111',
    parentCardId: 'parent-1',
    splitDepth: 2,
    acceptanceCriteria: ac,
  });
const fence = (d: string) => JSON.parse(/```json\n([\s\S]*?)\n```/.exec(d)![1]!);

describe('buildSplitChildDescription gherkin skeleton', () => {
  test('one scn_ per distinct AC, crit_ ids from criteriaFromAcceptance', () => {
    const j = fence(build(AC));
    expect(j.gherkin_scenarios.length).toBe(2);
    const crit = criteriaFromAcceptance(AC);
    expect(j.gherkin_scenarios.map((s: { criterion_id: string }) => s.criterion_id)).toEqual([
      crit[0]!.id,
      crit[1]!.id,
    ]);
    for (const s of j.gherkin_scenarios) expect(s.scenario_id).toMatch(/^scn_[0-9a-f]{8}$/);
  });

  test('parity with the commit path for the same ACs', () => {
    const minted = JSON.parse(
      mintedCardDescription({
        decompositionId: 'd',
        deliverable: { id: 'x', kind: 'k', title: 't', description: 'd', acceptance_criteria: AC } as never,
      }),
    );
    expect(fence(build(AC)).gherkin_scenarios).toEqual(minted.gherkin_scenarios);
    expect(fence(build(AC)).gherkin_scenarios).toEqual(scenarioSkeleton(criteriaFromAcceptance(AC)));
  });

  test('existing fields, key order (split_depth before the skeleton) and provenance unchanged', () => {
    const d = build(AC);
    expect(Object.keys(fence(d))).toEqual([
      'project_id',
      'split_depth',
      'acceptance_criteria',
      'gherkin_scenarios',
    ]);
    expect(d.startsWith('child text\n\n```json\n')).toBe(true);
    expect(d.endsWith('{"parent_card":"parent-1","split_depth":2}\n```\n<!-- aa:decomposition:end -->')).toBe(true);
  });

  test('replay is byte-identical and scope_hash does not depend on the skeleton', () => {
    expect(build(AC)).toBe(build(AC));
    const child = { title: 't', description: 'child text', acceptance_criteria: AC, card_type: 'task' };
    expect(splitChildHash(child as never, 2)).toBe(splitChildHash(child as never, 2));
    expect(splitChildHash(child as never, 2)).not.toBe(splitChildHash(child as never, 3));
  });
});
