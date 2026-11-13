// G-12 A6 — the pre-registered QUESTION → ANSWER table (src/services/approvals/question-registry.ts).
//
// What this pins:
//   * the registry equals G-12 v2 §3 VERBATIM. The expected rows below are hard-coded from
//     the table in docs/contracts/u3-a3-ncn-contracts.md §2 (markdown's `\|` unescaped) —
//     NOT derived from the module, so a drifted row cannot certify itself. A change here is
//     a change to a SIGNED rule and needs a new G-12 version.
//   * only Q8 is unanswerable (its registered answer is `no_registered_answer`).
//   * answeredCode / isQuestionId spellings.
//   * ONE definition: no other src file holds a Q1..Q8 table (a second table is how the mint
//     gate and the decide gate come to disagree on which ids exist). Modelled on
//     tests/unit/domain/web-only-single-definition.test.ts.
//
// ⚠️ THE GREP PATTERN IS ASSEMBLED AT RUNTIME, so this file never matches itself.
import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import {
  NO_REGISTERED_ANSWER,
  QUESTION_IDS,
  QUESTION_REGISTRY,
  answeredCode,
  isQuestionId,
} from '../../../../src/services/approvals/question-registry';

/** G-12 v2 §3, as the contract doc prints it: [id, "If the question asks…", "Answer"]. */
const SECTION_3: ReadonlyArray<readonly [string, string, string]> = [
  ['Q1', 'which branch, base or repo to work on', "`run/<proof>-<A|B>` on `nonagenticai/ems` (the card's own run branch)"],
  ['Q2', 'whether to include dependency or lockfile changes', 'NO (§V: out of scope; P1.10)'],
  ['Q3', 'whether to fix CVEs / the audit findings', 'NO (§V baseline, excluded)'],
  ['Q4', 'whether to edit or skip existing tests', 'NO (test hygiene, A1.a iv)'],
  ['Q5', 'what test framework or command to use', "the repo's own (`pytest tests/`, per the S0 ci.yml)"],
  ['Q6', 'whether to expand scope beyond the approved bugs or contract', 'NO'],
  ['Q7', '(proof 2) a contract detail already pinned in the request', 'quote the pinned contract field verbatim'],
  [
    'Q8',
    '(proof 2) a contract detail NOT pinned in the request',
    '`no_registered_answer`: the request is underspecified, which is a finding about the request, not something George fills',
  ],
];

describe('QUESTION_REGISTRY = G-12 v2 §3, verbatim', () => {
  test('exactly the eight ids, in order', () => {
    expect<string[]>([...QUESTION_IDS]).toEqual(SECTION_3.map(([id]) => id));
    expect(Object.keys(QUESTION_REGISTRY)).toEqual(SECTION_3.map(([id]) => id));
  });

  for (const [id, asks, answer] of SECTION_3) {
    test(`${id}: asks + answer match the signed table`, () => {
      const row = QUESTION_REGISTRY[id as keyof typeof QUESTION_REGISTRY];
      expect(row.asks).toBe(asks);
      expect(row.answer).toBe(answer);
    });
  }

  test('only Q8 is unanswerable, and its answer is the reject code', () => {
    expect(QUESTION_IDS.filter((id) => !QUESTION_REGISTRY[id].answerable)).toEqual(['Q8']);
    expect(NO_REGISTERED_ANSWER).toBe('no_registered_answer');
    // Verbatim §3 text; it is never recorded (Q8 is reject-only), but it STARTS with the code.
    expect(QUESTION_REGISTRY.Q8.answer.startsWith(`\`${NO_REGISTERED_ANSWER}\``)).toBe(true);
  });

  test('answeredCode spelling is `answered:<Q-id>`', () => {
    expect(answeredCode('Q1')).toBe('answered:Q1');
    expect(answeredCode('Q7')).toBe('answered:Q7');
  });

  test('isQuestionId: exact Q1..Q8 strings only', () => {
    for (const id of SECTION_3.map(([i]) => i)) expect(isQuestionId(id)).toBe(true);
    for (const v of ['q1', 'Q9', 'Q0', ' Q1', '', 'answered:Q1', 1, null, undefined, ['Q1']]) {
      expect([v, isQuestionId(v)]).toEqual([v, false]);
    }
  });
});

// ── single definition ───────────────────────────────────────────────────────────────

/** repo root: .../backend/tests/unit/services/approvals → up five. */
const REPO = join(import.meta.dir, '..', '..', '..', '..', '..');
const SRC = join(REPO, 'backend', 'src');
const HOME = 'backend/src/services/approvals/question-registry.ts';

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (p.endsWith('.ts')) out.push(p);
  }
  return out;
}

function holders(re: RegExp): string[] {
  return walk(SRC)
    .filter((f) => re.test(readFileSync(f, 'utf8')))
    .map((f) => relative(REPO, f));
}

/** A quoted `Q1` literal (either quote style) — any Q1..Q8 table must spell its first id. */
const Q1_LITERAL = new RegExp(`['"]${['Q', '1'].join('')}['"]`);

describe('question registry: exactly one Q1..Q8 table, in question-registry.ts', () => {
  test(`no src file outside ${HOME} holds a quoted Q1 literal`, () => {
    expect(holders(Q1_LITERAL)).toEqual([HOME]);
  });

  test('CONTROL: the instrument sees a literal in either quote style, and not a bare word', () => {
    expect(Q1_LITERAL.test(`const T = ['${'Q'}1', 'Q2'];`)).toBe(true);
    expect(Q1_LITERAL.test(`const T = { "${'Q'}1": 'x' };`)).toBe(true);
    expect(Q1_LITERAL.test('// see Q1 in the table')).toBe(false);
  });
});
