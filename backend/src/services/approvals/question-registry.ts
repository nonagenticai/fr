// src/services/approvals/question-registry.ts
//
// G-12 A6 — the PRE-REGISTERED QUESTION → ANSWER table, held as DATA.
//
// Source: ~/.claude/plans/program/10-roadmap/G-12-approval-rule-v2.md §3 (SIGNED 2026-10-02;
// identical in v1). Copied VERBATIM: a change here is a change to a signed rule and needs a
// new G-12 version.
//
// ⛔ fr NEVER MAPS QUESTION TEXT TO A Q-ID. The conveyor stamps `metadata.question_id` at mint;
// fr only checks it is one of these ids (or absent = "not covered by §3"). Matching text to the
// table is a reading, not a computation, and a decision built on a reading cannot be recomputed
// by the verdict (R10). There is deliberately no lookup-by-text in this module.
//
// THE ONE DEFINITION. Imported by u3-gates.ts (mint + decide) and pinned by
// tests/unit/services/approvals/question-registry.test.ts.

export const QUESTION_IDS = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8'] as const;
export type QuestionId = (typeof QUESTION_IDS)[number];

/** The reason code for a question §3 does not cover (and for Q8, whose answer is exactly that). */
export const NO_REGISTERED_ANSWER = 'no_registered_answer' as const;

export interface RegisteredQuestion {
  /** "If the question asks…" — documentation only; never matched against question text. */
  asks: string;
  /** The registered answer, recorded as the decision text when the question is approved. */
  answer: string;
  /** False only for Q8, whose registered answer is `no_registered_answer` (reject-only). */
  answerable: boolean;
}

export const QUESTION_REGISTRY: Readonly<Record<QuestionId, RegisteredQuestion>> = {
  Q1: {
    asks: 'which branch, base or repo to work on',
    answer: "`run/<proof>-<A|B>` on `nonagenticai/ems` (the card's own run branch)",
    answerable: true,
  },
  Q2: { asks: 'whether to include dependency or lockfile changes', answer: 'NO (§V: out of scope; P1.10)', answerable: true },
  Q3: { asks: 'whether to fix CVEs / the audit findings', answer: 'NO (§V baseline, excluded)', answerable: true },
  Q4: { asks: 'whether to edit or skip existing tests', answer: 'NO (test hygiene, A1.a iv)', answerable: true },
  Q5: {
    asks: 'what test framework or command to use',
    answer: "the repo's own (`pytest tests/`, per the S0 ci.yml)",
    answerable: true,
  },
  Q6: { asks: 'whether to expand scope beyond the approved bugs or contract', answer: 'NO', answerable: true },
  Q7: {
    asks: '(proof 2) a contract detail already pinned in the request',
    answer: 'quote the pinned contract field verbatim',
    answerable: true,
  },
  Q8: {
    asks: '(proof 2) a contract detail NOT pinned in the request',
    answer:
      '`no_registered_answer`: the request is underspecified, which is a finding about the request, not something George fills',
    answerable: false,
  },
};

export function isQuestionId(v: unknown): v is QuestionId {
  return typeof v === 'string' && (QUESTION_IDS as readonly string[]).includes(v);
}

/** The approve code for a registered, answerable question: `answered:<Q-id>`. */
export function answeredCode(id: QuestionId): string {
  return `answered:${id}`;
}
