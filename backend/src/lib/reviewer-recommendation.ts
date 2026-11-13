// src/lib/reviewer-recommendation.ts
//
// What a BARE approve ("1", "Approve", "1 - Approve") means on a row that owes an answer.
//
// ⭐ WHY THIS EXISTS. Measured on prod 2026-10-01: approval 2bdc6219 (deblock_action
// QUESTION) asked, as its FIRST open question, `The reviewer recommends "BLOCKED". Approve
// with "yes" to accept that, or state what to do instead.` The product owner replied "1",
// "1 - Approve" and "Approve" — i.e. exactly what the question invited — and every chat
// seat refuses a bare approve on a QUESTION row (`answerlessApproveDemand`). The ruling
// (2026-10-01): on such a row a bare approve ACCEPTS the reviewer's recommendation.
//
// The producer is n8n `workflows/patterns/blocked-escalate.json` › Build Proposition,
// `QUESTIONS_BY_CLASS.open_questions`. It writes the sentence below verbatim; there is no
// structured field yet, so this parses the producer's exact wording and FAILS CLOSED: any
// other shape returns null and the seat asks for the answer instead of guessing one.
//
// ⛔ WHAT "ACCEPT" MEANS DEPENDS ON THE RECOMMENDATION, AND THE PRODUCER'S WORDING IS WRONG
// FOR THE COMMONEST ONE. The receiver (`approval-callback.json` › Resolve Target List)
// treats QUESTION + approved + answer text as "answered" and RE-DRIVES the card to TODO.
// Approving "yes" to a recommendation of BLOCKED would therefore do the OPPOSITE of what
// the human accepted. The producer's own ON REJECT line says the card stays in BLOCKED,
// so accepting BLOCKED is recorded as a REJECT. Any other recommendation cannot be carried
// out by a decision at all (see `acceptRecommendationDecision`), so the seat asks instead.

import { statedOpenQuestions } from '../domain/engagement/deblock-actions';

const RECOMMENDATION_SENTENCE =
  /^The reviewer recommends "(.+)"\. Approve with "yes" to accept that, or state what to do instead\.$/s;

/** The recommendation stated in the producer's prose sentence, verbatim, or null. */
function proseRecommendation(metadata: unknown): string | null {
  const first = statedOpenQuestions(metadata)[0];
  if (!first) return null;
  const m = first.match(RECOMMENDATION_SENTENCE);
  const rec = m?.[1]?.trim();
  return rec ? rec : null;
}

/**
 * The reviewer's recommendation, or null when the row states none — or states two
 * that disagree.
 *
 * Source order: the STRUCTURED `metadata.reviewer_recommendation` (a string; trimmed and
 * upper-cased, so `blocked` and `BLOCKED` are one value) first, the prose sentence above as
 * the fallback for rows minted before the producer wrote the field. ⛔ FAILS CLOSED in two
 * places: a structured value that is present but not a non-empty string is not "absent"
 * (that would silently promote the prose), and a structured value that disagrees with the
 * prose (case-insensitively) means the row contradicts itself — null either way, so the
 * seat asks the human instead of acting on one of two answers.
 */
export function extractReviewerRecommendation(metadata: unknown): string | null {
  const raw = metadata !== null && typeof metadata === 'object'
    ? (metadata as Record<string, unknown>).reviewer_recommendation
    : undefined;
  const prose = proseRecommendation(metadata);
  if (raw === undefined || raw === null) return prose;
  const structured = typeof raw === 'string' ? raw.trim().toUpperCase() : '';
  if (structured.length === 0) return null;
  if (prose !== null && prose.trim().toUpperCase() !== structured) return null;
  return structured;
}

/** True when accepting the recommendation means "leave the card where it is". */
export function recommendationKeepsCardBlocked(recommendation: string): boolean {
  return /^blocked$/i.test(recommendation.trim());
}

/**
 * The decision a bare approve becomes once the human has accepted `recommendation`, or
 * null when this seat CANNOT carry that recommendation out.
 *
 * ⛔ ONLY BLOCKED IS ACCEPTABLE HERE. Verified 2026-10-01 against n8n origin/main: the
 * recommendation is raw worker output (`Merge Procedure Hint` › `reasoning.recommendation`,
 * no shape contract — literals seen: BLOCKED ×31, DONE ×5, approve ×2, plus JSON objects
 * and 150-char truncations), and the receiver's QUESTION branch moves ANY approved answer
 * to TODO without reading it (`approval-callback.json` › Resolve Target List,
 * `questionAnswered` → `target_list_kind = 'TODO'`). So "accepting DONE" would RE-DRIVE the
 * card — the opposite of what was accepted. BLOCKED is the one recommendation a decision
 * can honour exactly: a reject, whose receiver arm leaves the card in BLOCKED. Every other
 * recommendation returns null and the seat asks the human what to do instead.
 */
export function acceptRecommendationDecision(
  recommendation: string,
  seat: string,
): { decision: 'rejected'; comment: string } | null {
  if (!recommendationKeepsCardBlocked(recommendation)) return null;
  return {
    decision: 'rejected',
    comment: `Accepted reviewer recommendation: BLOCKED (bare approve via ${seat})`,
  };
}
