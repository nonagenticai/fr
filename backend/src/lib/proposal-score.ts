// src/lib/proposal-score.ts
//
// Scores a conveyor's PROPOSED ANSWER to a question with laya BEFORE a person reads it
// (George 2026-11-01: "use laya to choose and/or score the coach proposed answers and loop
// back to coach with feedback").
//
// ── WHY THIS LIVES IN fr AND NOT IN n8n ───────────────────────────────────────────────
// Minting a laya licence requires the `bundle-token-minter` realm role
// (licenses auth/dependencies.py :: require_bundle_token_minter — a licence-token caller is
// refused). The n8n pod does not hold it; fr already mints per-tenant laya licences for chat
// replies (lib/bundle-token-minter.ts, getBundleTokenMinter('laya')). So fr is the only
// service that can ask laya on the conveyor's behalf, and the call belongs beside — not
// inside — the reply interpreter, so a proposal score can never change how a HUMAN's reply
// is read.
//
// ── WHAT IT JUDGES, MEASURED 2026-11-01 ───────────────────────────────────────────────
// laya-english-0.4.2, same bridge and token path, three hand-written cases through
// `choice` `{actionable, vague}`:
//   * a specific proposal naming the setting and the retry        → actionable 0.76
//   * "a person should create the diagram by hand"                 → actionable 0.07
//   * a specific proposal resting on an unverified claim           → actionable 0.16
// So the score separates CONCRETE from VAGUE, and an unsure answer (0.16) does not pass —
// which is the safe direction: a proposal that cannot be shown to be actionable goes back
// to the coach. ⛔ laya CANNOT check whether a claim is TRUE (measured false negative: it
// called "the quality service reports those paths match no files" grounded at 0.70 while
// the listing showed both files present). Truthfulness stays a prompt rule on the coach;
// this module judges actionability only, and its question says so.
//
// ── FAIL OPEN, ALWAYS ─────────────────────────────────────────────────────────────────
// `available: false` on every failure (no minter, no licence for the tenant, timeout,
// non-200, unparseable body). The caller then asks the question UNS CORED: a question that
// a human must answer is never withheld because a judge was down.

import {
  DEFAULT_LAYA_SYSTEMONE_URL,
  LAYA_DECISION_MIN_CONFIDENCE,
  LAYA_SYSTEMONE_URL_ENV,
} from './approval-reply-interpreter';
import { getBundleTokenMinter } from './bundle-token-minter';

/** Stable log tag. Grep / Loki-query this, never the free-text message. */
export const PROPOSAL_SCORE_LOG_TAG = '[proposal-score]';
const LAYA_TIMEOUT_MS = 8_000;
const TEXT_MAX = 2_000;

export type ProposalScore =
  | {
      available: true;
      /** `actionable` only when laya is CONFIDENT; `vague` covers both a confident vague and an unclear answer. */
      choice: 'actionable' | 'vague';
      confidence: number;
      /** True only for `actionable` at or above {@link LAYA_DECISION_MIN_CONFIDENCE}. */
      pass: boolean;
      /** What the coach is told when it does not pass — never empty. */
      feedback: string;
    }
  | { available: false; reason: string };

/** The two sides of the judgement. Exported for the tests. */
export const PROPOSAL_CRITERIA: Record<'actionable' | 'vague', string> = {
  actionable:
    'It names the concrete next step: the file, command, setting, value or person to change, ' +
    'so the reader could act on it immediately. It may be terse; it does not need to be polite.',
  vague:
    'It restates the problem, says a person should handle the work, gives general advice, or ' +
    'names no concrete next step (no file, command, setting or value).',
};

/** The Jev request body. Exported for the tests. */
export function buildProposalScoreRequest(input: { question: string; proposal: string }): Record<string, unknown> {
  return {
    model: 'jev-latest',
    state: {
      question: input.question.slice(0, TEXT_MAX),
      proposal: input.proposal.slice(0, TEXT_MAX),
    },
    questions: {
      choice: {
        type: 'choice',
        instructions:
          'An agent is about to ask a person this question and proposes an answer. Is the ' +
          'proposed answer a concrete, actionable next step, or is it vague?',
        criteria: PROPOSAL_CRITERIA,
      },
    },
  };
}

/**
 * The decision rule over laya's answer. Pure; exported for the tests.
 *
 * `actionable` passes ONLY at or above the shared 0.5 margin. Everything else — a confident
 * `vague`, an unknown option, a confidence under the floor — does not pass, and the feedback
 * names what is missing so the coach can rewrite rather than guess.
 */
export function readProposalScore(answers: unknown): ProposalScore {
  const a = answers && typeof answers === 'object' ? (answers as Record<string, unknown>).choice : undefined;
  const choice = a && typeof a === 'object' ? (a as { choice?: unknown }).choice : undefined;
  const confidence = a && typeof a === 'object' ? (a as { confidence?: unknown }).confidence : undefined;
  if (typeof choice !== 'string' || typeof confidence !== 'number' || Number.isNaN(confidence)) {
    return { available: false, reason: 'unparseable_answers' };
  }
  const sure = confidence >= LAYA_DECISION_MIN_CONFIDENCE;
  if (choice === 'actionable' && sure) {
    return {
      available: true,
      choice: 'actionable',
      confidence,
      pass: true,
      feedback: 'The proposed answer is a concrete next step.',
    };
  }
  if (choice === 'vague' && sure) {
    return {
      available: true,
      choice: 'vague',
      confidence,
      pass: false,
      feedback:
        'The proposed answer is too vague to act on: name the file, command, setting or value ' +
        'the next step applies to.',
    };
  }
  // A margin under the floor, or an option we did not offer. Measured 2026-11-01: this is
  // where a vague proposal lands (0.07) AND where a concrete proposal resting on an
  // unverified claim lands (0.16) — laya's uncertainty is itself the signal, so it does not
  // pass either. The feedback asks for the same thing in both cases.
  return {
    available: true,
    choice: 'vague',
    confidence,
    pass: false,
    feedback:
      'The judge could not tell whether the proposed answer is actionable: make the next step ' +
      'concrete and name the file, command, setting or value it applies to.',
  };
}

/**
 * What the CALLER does with a score. Pure; exported for the tests.
 *
 * The three arms are the whole gate: an unavailable judge and a passing proposal both
 * proceed (the difference is only whether a score is recorded), and only a non-passing
 * score refuses. Keeping this out of the route is what lets the branching be pinned
 * without a test double, while the transport stays remote and is verified live.
 */
export type ProposalGateDecision =
  | { action: 'proceed'; recorded: { choice: 'actionable'; confidence: number } | null }
  | { action: 'refuse'; feedback: string };

export function decideProposalGate(score: ProposalScore): ProposalGateDecision {
  if (!score.available) return { action: 'proceed', recorded: null };
  if (score.pass) return { action: 'proceed', recorded: { choice: 'actionable', confidence: score.confidence } };
  return { action: 'refuse', feedback: score.feedback };
}

/**
 * Ask laya to score a proposed answer. Never throws.
 *
 * One POST, the tenant's own `laya` licence (never one of fr's own — licences are tenant×app
 * only, George 2026-10-15), the shared 8 s timeout and the shared confidence floor.
 */
export async function scoreProposal(input: {
  tenantId: string;
  question: string;
  proposal: string;
  timeoutMs?: number;
}): Promise<ProposalScore> {
  const proposal = input.proposal.trim();
  if (!proposal) return { available: false, reason: 'no_proposal' };
  let token: string | undefined;
  try {
    token = await getBundleTokenMinter('laya')?.token(input.tenantId);
  } catch {
    token = undefined;
  }
  if (!token) return { available: false, reason: 'no_laya_licence' };

  let res: Response;
  try {
    res = await fetch(process.env[LAYA_SYSTEMONE_URL_ENV]?.trim() || DEFAULT_LAYA_SYSTEMONE_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
      body: JSON.stringify(buildProposalScoreRequest({ question: input.question, proposal })),
      signal: AbortSignal.timeout(input.timeoutMs ?? LAYA_TIMEOUT_MS),
    });
  } catch (err) {
    return { available: false, reason: err instanceof Error ? err.name : 'transport_error' };
  }
  if (res.status === 401) getBundleTokenMinter('laya')?.invalidate(input.tenantId, token);
  if (res.status !== 200) return { available: false, reason: `http_${res.status}` };

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return { available: false, reason: 'unparseable_body' };
  }
  const answers = (body as { answers?: unknown } | null)?.answers;
  if (!answers || typeof answers !== 'object') return { available: false, reason: 'no_answers' };

  const out = readProposalScore(answers);
  // One line per call, never the texts, never the token.
  console.info(
    `${PROPOSAL_SCORE_LOG_TAG} tenant=${input.tenantId} outcome=${
      out.available ? `${out.choice}:${out.confidence.toFixed(3)} pass=${out.pass}` : `unavailable:${out.reason}`
    }`,
  );
  return out;
}
