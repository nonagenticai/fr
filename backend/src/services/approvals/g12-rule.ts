// src/services/approvals/g12-rule.ts
//
// G-12 — the pre-registered approval rule for the ems proof runs, held as DATA.
//
// Sources: ~/.claude/plans/program/10-roadmap/G-12-approval-rule-v1.md (SIGNED by George
// 2026-10-01) and G-12-approval-rule-v2.md (SIGNED 2026-10-02), both frozen; each file's
// sha256 (recorded in the matching .sha256 file) IS its rule_version. A decision stamped
// with any other rule_version is refused: the verdict (R10) refuses decisions made under
// an unregistered rule version, so fr refusing them at the door is the same rule one hop
// earlier.
//
// BOTH v1 and v2 are registered. v2 §7.3: "fr keys its reason-code set by
// (rule_version, rule_row). A decision carrying v1's rule_version is still validated
// against v1's set." So v2 supersedes v1 for NEW decisions, but a v1-stamped decision is
// neither refused nor silently upgraded: it is checked against v1's own codes.
//
// v2 = v1 + the two changes in v2 §7:
//   1. A3 gains `test_plan_not_executable` for predicate (iii), which had no code in v1.
//      ⇒ under v1, a design failing only (iii) has no reject code and is refused 422.
//   2. Spellings pinned (no change of meaning — §7.2 says this "was already v1's plain
//      reading", so v1's `<which clause>` / `<field>` templates expand to the SAME codes):
//      * A1 `not_real_bug:<which clause>` = exactly `not_real_bug:(i)` … `not_real_bug:(iv)`
//        — PARENTHESES, as §4 and the operator checker (ems-bug-rerun.py) write it.
//        `(controls)` is an operator HALT, not a reason code, and is not in the set.
//      * A3 `contract_mismatch:<field>` = exactly the F3 contract's TOP-LEVEL items:
//        `tool | args | semantics | result | errors`. "Out of scope" is `scope_creep`.
//        A nested location of the mismatch is EVIDENCE — it goes in
//        `predicate_inputs.mismatch_path`, never into the code.
//   The "(i)…(iv)" after the A3 codes in the v2 table are PREDICATE annotations, not codes.
//
// ⭐ DATA, NOT LOGIC. A v3 of the rule is a new entry in G12_RULES (new sha, new code
// sets); the decide gate in u3-gates.ts reads this table and nothing else, so a
// re-signed rule flips data, not code.
//
// Only the rows fr GATES are listed. A4 (AC coverage) is decided through
// `qa.coverage_signoff`, whose decide-side validation is owned by fr#1333; it is not
// gated here and therefore not listed (listing it would read as a gate that exists).
//
// ⭐ THE CODE SET IS KEYED BY (rule_version, rule_row). A row's codes are looked up
// only through `g12CodesFor(rule_version, rule_row)` / `g12RuleFor(rule_version)`, so a
// decision stamped with one version can never be validated against another version's
// codes.

import { QUESTION_IDS, QUESTION_REGISTRY, NO_REGISTERED_ANSWER, answeredCode } from './question-registry';

export const G12_RULE_VERSION_V1 =
  '3f705295e150007b2412e12ba67bedda900856e616b8c636e2afa3c56ec26654';

export const G12_RULE_VERSION_V2 =
  '6cb9ebaea51e6f4acdca31b262c8e487277a85df5dcc05d0ee7fea5e162f0cd7';

export type G12ItemDecision = 'approve' | 'reject';

export interface G12RuleRow {
  /**
   * What this row governs: an approval KIND (A3 = `execution.feature_design_approval`), or for
   * A1 the live bug-fix gate MARKER `bug_fix_authorization` — A1 is not a kind. Ruling 10-01
   * (movies-13) dropped `execution.bug_fix_approval`: no producer ever emitted it, so a row
   * keyed on it governed nothing. A1 now governs any approvals row (generic deblock or
   * execution.ready_signoff) whose `metadata.approval_kind = 'bug_fix_authorization'`.
   */
  governs: string;
  /** What an item IS for this row (the `item_id` namespace). */
  item: 'bug_id' | 'design_artifact_id' | 'question_id';
  /** Closed reason-code sets, by the item's decision. */
  codes: Readonly<Record<G12ItemDecision, readonly string[]>>;
}

export interface G12Rule {
  rule_version: string;
  rows: Readonly<Record<string, G12RuleRow>>;
}

/** A1 — the four real-bug clauses, PARENTHESISED (operator checker spelling). */
export const NOT_REAL_BUG_CODES = [
  'not_real_bug:(i)',
  'not_real_bug:(ii)',
  'not_real_bug:(iii)',
  'not_real_bug:(iv)',
] as const;

/** A3 — the F3 contract's TOP-LEVEL items only. Nested location → predicate_inputs.mismatch_path. */
export const CONTRACT_MISMATCH_CODES = [
  'contract_mismatch:tool',
  'contract_mismatch:args',
  'contract_mismatch:semantics',
  'contract_mismatch:result',
  'contract_mismatch:errors',
] as const;

/**
 * A6 — a conveyor QUESTION (`execution.question`), identical in v1 and v2. One item: the
 * stamped question_id (or the literal `no_registered_answer` when the conveyor found no §3
 * row). APPROVE only as `answered:<Q-id>` for Q1–Q7; everything else is the single reject code.
 * WHICH code a given approval may carry is pinned by u3-gates' A6 decide gate (the stamp).
 */
const A6_ROW: G12RuleRow = {
  governs: 'execution.question',
  item: 'question_id',
  codes: {
    approve: QUESTION_IDS.filter((id) => QUESTION_REGISTRY[id].answerable).map(answeredCode),
    reject: [NO_REGISTERED_ANSWER],
  },
};

/** A1 — identical in v1 and v2 (v2 §7.2 only pinned spellings v1 already meant). */
const A1_ROW: G12RuleRow = {
  governs: 'bug_fix_authorization',
  item: 'bug_id',
  codes: {
    approve: ['real_bug_ok'],
    reject: [...NOT_REAL_BUG_CODES, 'prechosen_reject'],
  },
};

export const G12_RULES: readonly G12Rule[] = [
  {
    // v1 — signed 2026-10-01. Kept registered per v2 §7.3. A3 has NO code for predicate (iii).
    rule_version: G12_RULE_VERSION_V1,
    rows: {
      A1: A1_ROW,
      A3: {
        governs: 'execution.feature_design_approval',
        item: 'design_artifact_id',
        codes: {
          approve: ['design_ok'],
          reject: [
            ...CONTRACT_MISMATCH_CODES,
            'ac_without_scenario', // predicate (ii)
            'scope_creep', // predicate (iv)
          ],
        },
      },
      A6: A6_ROW,
    },
  },
  {
    // v2 — signed 2026-10-02.
    rule_version: G12_RULE_VERSION_V2,
    rows: {
      A1: A1_ROW,
      A3: {
        governs: 'execution.feature_design_approval',
        item: 'design_artifact_id',
        codes: {
          approve: ['design_ok'],
          reject: [
            ...CONTRACT_MISMATCH_CODES,
            'ac_without_scenario', // predicate (ii)
            'test_plan_not_executable', // predicate (iii) — new in v2
            'scope_creep', // predicate (iv)
          ],
        },
      },
      A6: A6_ROW,
    },
  },
];

/** The registered rule for a version, or undefined (⇒ refuse). */
export function g12RuleFor(ruleVersion: string): G12Rule | undefined {
  return G12_RULES.find((r) => r.rule_version === ruleVersion);
}

/**
 * The closed code set keyed by (rule_version, rule_row), or undefined when that pair is
 * not a registered row.
 */
export function g12CodesFor(ruleVersion: string, ruleRow: string): G12RuleRow['codes'] | undefined {
  return g12RuleFor(ruleVersion)?.rows[ruleRow]?.codes;
}

/** The row key (A1, A3, …) that governs `governs` (a kind, or the bug-fix marker) under `rule`. */
export function g12RowKeyFor(rule: G12Rule, governs: string): string | undefined {
  return Object.keys(rule.rows).find((k) => rule.rows[k]!.governs === governs);
}
