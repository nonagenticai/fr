// Shared QUESTION-approval helpers for the UI.
//
// A `QUESTION` is the one `deblock_action` whose payload is not the action — it
// is the ANSWER, carried in the decision's `comment` (or `reason`). The backend
// refuses an approved QUESTION whose answer text is empty
// (`backend/src/routes/approvals.ts:1512-1527`, a 422 with no override), and the
// n8n consumer it mirrors (`patterns/approval-callback.json :: Resolve Target
// List`, quoted at `backend/src/routes/approvals.ts:152-160`) releases the card
// only when that text is non-empty. Approving without it does not release the
// card — it holds it in BLOCKED with `block_reason approval_answer_missing`
// while the approval row is spent, so no second decision can undo it.
//
// Three surfaces need the SAME rules — the NEEDS YOU queue's bulk-approve, the
// row-level Approve control, and the dedicated review page — so they live here
// once rather than being re-derived three times and drifting. Single source of
// truth — unit-tested.
//
// ⚠️ THESE ARE MIRRORS, NOT THE RULE. The server is the gate; this module only
// lets the UI refuse before spending a decision, and word the refusal in the
// operator's own terms. Every predicate below names the server file:line it
// mirrors — when one moves, this file is wrong and the mirror must be re-read.

import type { Approval } from '$lib/types/api';

/**
 * Gate terms that mean the gate itself is BROKEN — the evidence a decider would
 * need was never produced upstream, so approving asserts something nobody
 * measured. Mirrors `BROKEN_GATE_TERMS_BUILTIN` at
 * `backend/src/routes/approvals.ts:105-118`.
 *
 * ⚠️ The server UNIONs `process.env.APPROVAL_BROKEN_GATE_TERMS` into its set,
 * which the browser cannot see. So this set is a SUBSET of the server's: a row
 * the UI reads as clean can still be refused. Never present the absence of a
 * term here as "the server will accept this".
 */
export const BROKEN_GATE_TERMS: ReadonlySet<string> = new Set<string>([
  'evidence_gap',
  'brief_write_failed',
  'authoring_gap',
  'decision_authoring_gap',
  'no_procedure',
]);

/**
 * Minimum `reason` length a super-admin must supply to override a broken-gate
 * refusal. Mirrors `backend/src/routes/approvals.ts:128`.
 *
 * ⛔ There is NO equivalent for the missing-answer rule below, and that is
 * deliberate (`backend/src/routes/approvals.ts` :: the essay on #1066): an
 * override for THAT rule would be an override for supplying one field the
 * decider already holds.
 *
 * ⚠️ CORRECTED 2026-09-13. This used to end "the override field and the
 * compliance field would be the same field" as a statement of fact. It was the
 * accurate description of a HOLE, not of a safeguard: on a row that is both a
 * broken gate and an answer demand, a >=30-char override argument satisfied the
 * answer guard and was forwarded to n8n AS THE ANSWER. The server now subtracts
 * a reason consumed as a broken-gate override from the persisted comment, so the
 * two fields are no longer the same field and the sentence no longer holds.
 * Measured at the time of the fix: of 974 pending rows, 174 broken-gate and 132
 * answer-demanding, intersection 0 — latent, not live.
 */
export const BROKEN_GATE_OVERRIDE_MIN_REASON = 30;

/**
 * The contract the UI must STATE ITSELF next to the answer box.
 *
 * ⚠️ It cannot be lifted off the approval. Two description formats are live and
 * only the NEWER one carries `ON APPROVE:` / `ON REJECT:` lines; the older one
 * ends with a generic "Approve to execute the proposed action." that is wrong
 * for a QUESTION — approving executes nothing, it delivers text. A surface that
 * only renders what the row happens to carry tells half the queue the wrong
 * thing, so the sentence is owned here and shown unconditionally.
 */
export const ANSWER_CONTRACT =
  'Approving supplies your comment as the ANSWER and returns the card to TODO to be re-driven ' +
  'with it. Approving with an empty answer supplies no answer and leaves the card BLOCKED.';

/**
 * The machine-proposed way out of a BLOCKED card, as stored on
 * `metadata.deblock_action`. Lifted verbatim from
 * `frontend/src/routes/approvals/+page.svelte:79-85` so the badge on the queue
 * and the gate on the answer box cannot disagree about what the row proposes.
 *
 * `metadata` is untyped jsonb written by n8n: anything that is not a non-empty
 * string reads as `null` (absent, `null`, a number, an object, `''`, `'   '`).
 *
 * ⚠️ NOT narrowed to the closed enum. The server narrows through
 * `asDeblockAction` (`backend/src/domain/engagement/deblock-actions.ts:23-49`),
 * so an unrecognised string is DROPPED there while it survives here. That
 * divergence is harmless for `isQuestion` — `'QUESTION'` is in the enum — but it
 * means this function answers "what does the row SAY?", never "what will the
 * callback DO?".
 *
 * ⚠️ It reads the STORED action only. The server gates on the EFFECTIVE action,
 * `supplied ?? stored` (`effectiveDeblockAction`,
 * `backend/src/routes/approvals.ts:210-215`), because a decider may override the
 * action on the PUT. No fr surface sends an override alongside an answer today;
 * if one ever does, it must gate on the value it is about to send, not on this.
 */
export function deblockActionOf(a: Pick<Approval, 'metadata'>): string | null {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.deblock_action;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * True iff the row proposes `QUESTION` — the one action that parks the card and
 * asks the human something. Mirrors the server's `=== 'QUESTION'` comparison at
 * `backend/src/routes/approvals.ts:1514`; case-insensitive here because the
 * badge already treats the stored field as free-form.
 *
 * ⛔ SCOPED TO QUESTION AND NOTHING ELSE. `RETRY`, `SPLIT`, `INFRASTRUCTURE`,
 * `DEPENDENCY`, `DROP`, `MERGE` and action-less rows are NOT questions: they
 * carry their payload in the action itself and the server never demands answer
 * text for them. Widening this predicate would demand an answer from most of the
 * queue and disable bulk approve for rows that are perfectly approvable.
 */
export function isQuestion(a: Pick<Approval, 'metadata'>): boolean {
  return deblockActionOf(a)?.toUpperCase() === 'QUESTION';
}

/** Mirrors the server's `PROPOSED_ANSWER_MAX_CHARS`. */
export const PROPOSED_ANSWER_MAX_CHARS = 2000;

/**
 * The asker's proposed answer (`metadata.proposed_answer`), trimmed and capped, or null.
 * Mirrors the server's `proposedAnswer` (`backend/src/domain/engagement/deblock-actions.ts`):
 * a bare approve on any seat accepts it; the web sends the text explicitly ("Accept proposed
 * answer"), and a typed answer replaces it.
 *
 * ⛔ QUESTION rows ONLY ({@link isQuestion}). An INFRASTRUCTURE / DEPENDENCY row owes a
 * statement of what was fixed, and an action-less row owes nothing: on either a stray
 * `proposed_answer` is ignored, so it can never hide the fix-assertion contract.
 */
export function proposedAnswerOf(a: Pick<Approval, 'metadata'>): string | null {
  if (!isQuestion(a)) return null;
  const raw = ((a.metadata ?? {}) as Record<string, unknown>).proposed_answer;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim().slice(0, PROPOSED_ANSWER_MAX_CHARS).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The producer's ACTUAL question text(s), read from `metadata.open_questions`.
 *
 * ⛔ WHY THIS EXISTS — THE SHAPE, WHICH IS THE LOAD-BEARING CLAIM, NOT A COUNT.
 * `deblock_action = 'QUESTION'` (what makes fr DEMAND an answer, and what the
 * server hard-422s an empty approve on, `backend/src/routes/approvals.ts:1512-1528`)
 * and `open_questions` (the only field that holds question TEXT) are INDEPENDENT:
 * neither implies the other, in either direction. A row can demand an answer and
 * state nothing, state a question and demand nothing, do both, or do neither, and
 * this accessor answers only the second question.
 *
 * ⚠️ CORRECTED 2026-09-14 — this block used to claim the two have an **EMPTY
 * INTERSECTION** on this estate ("no row typed QUESTION states a question"),
 * backed by two independent instruments on 2026-09-10 that disagreed on every
 * population count and agreed exactly there. It was a true reading then and is
 * FALSE now: 117 of 179 pending QUESTION rows carry question text, so the
 * intersection is the majority of them. The paragraph directly below already
 * warned "DO NOT WRITE A BARE COUNT INTO THIS FILE… the counts rot within days",
 * and the emptiness claim was a count wearing the clothes of a shape. Nothing in
 * the code depended on it, which is why nothing broke and nothing noticed.
 *
 * ⚠️ DO NOT WRITE A BARE COUNT INTO THIS FILE. The counts rot within days and the
 * two instruments do not agree on them (e.g. 1027 vs 845 pending on the same day).
 * A number here must carry its instrument and its date, e.g. "0 of 98 pending
 * QUESTION rows carried open_questions (approvals API, 2026-09-10)" — and the SHAPE
 * is what the code and the tests are written against.
 *
 * Before this function, NOTHING on the approvals surface read `open_questions` at
 * all (`git grep` hit only tests, the comment at :274 below, and
 * `cards/sections/ReadiedBriefSection.svelte`). So fr demanded an answer on
 * exactly the rows that state no question, and marked as un-answerable the only
 * rows that state one.
 *
 * Defensive by construction, because `metadata` is producer-written jsonb: an
 * array of strings is read verbatim (trimmed, blanks dropped); a bare non-empty
 * string is read as a single question; everything else yields `[]`.
 *
 * ⚠️ IT IS AN ARRAY, AND EVERY MEMBER IS A REAL QUESTION. A measured value is a
 * long, genuinely answerable English sentence — a caller that renders `[0]` and
 * stops silently drops questions a human was asked. Render them all.
 *
 * ⚠️ A NON-STRING MEMBER IS DROPPED, NOT STRINGIFIED. `String(obj)` would render
 * the literal `[object Object]` as if it were the producer's question — the exact
 * defect `parseProposition` refuses to hide one field over. A caller that needs to
 * distinguish "the producer supplied nothing" from "the producer supplied
 * something unreadable" must use {@link questionPresentation}, which reports the
 * difference rather than letting an unreadable value read as an absence.
 */
export function openQuestionsOf(a: Pick<Approval, 'metadata'>): string[] {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.open_questions;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((q): q is string => typeof q === 'string')
    .map((q) => q.trim())
    .filter((q) => q.length > 0);
}

/** True iff the row states a question a human can actually read and answer. */
export function hasStatedQuestion(a: Pick<Approval, 'metadata'>): boolean {
  return openQuestionsOf(a).length > 0;
}

/**
 * How a surface should present this row's question, if it has one.
 *
 * ⛔ THIS IS DELIBERATELY NOT `isQuestion`, AND MUST NOT BE FOLDED INTO IT.
 * `isQuestion` states what the RECEIVER keys on: `approval-callback.json ::
 * Resolve Target List` computes `questionAnswered = action === 'QUESTION' &&
 * decision === 'approved' && answerText.length > 0` and never reads
 * `open_questions`. So a typed QUESTION strands its card on an empty answer
 * whether or not a question was ever stated — which is why the demand on those
 * rows is protective and stays. This predicate answers a different question —
 * "is there a question here a human can read?" — and the two are INDEPENDENT.
 *
 * ⚠️ CORRECTED 2026-09-14 — this used to close with "and the two are measurably
 * disjoint: intersection EMPTY at every scope measured". That was a 2026-09-10
 * reading, it is false now (117 of 179 pending QUESTION rows carry question
 * text, i.e. the intersection is the MAJORITY of them), and the wording made a
 * dated count read as a structural property. Nothing about the predicates
 * changed: they were always independent, and the emptiness was a fact about the
 * producer's output on one day, not about this code. ⛔ Do not re-derive
 * "disjoint" from a future zero either — the right statement is that neither
 * predicate implies the other, in either direction.
 *
 * ⚠️ CORRECTED. This block used to say widening `answerRequired` "would demand
 * an answer from most of the queue and disable bulk approve for rows that are
 * perfectly approvable". That was never measured, and it is wrong: on prod
 * today, 15 of 1040 pending rows state a question — **1.4%**, all of them
 * `deblock_action` NULL and therefore previously approvable with no answer at
 * all, which was the defect. It also cited `approvals.ts:1514`; the guard now
 * lives at `:1665` (`:1642` is that block's own comment — cite the CALL, not the
 * prose above it; an audit caught me doing exactly that here) and gates on
 * `classifyAnswerDemand`, not on a literal
 * `=== 'QUESTION'`. A stale citation that still reads plausibly is worse than
 * no citation, because it is the line a later reader will trust.
 */
export type QuestionState =
  /** Neither a QUESTION action nor any stated question. Render nothing new. */
  | 'none'
  /**
   * Typed QUESTION *and* states its question — the answerable happy path.
   *
   * ⚠️ CORRECTED 2026-09-14. This said "the one shape NO measured row has ever
   * had", from a 2026-09-10 measurement, and the file kept asserting it after it
   * stopped being true: 117 of 179 pending QUESTION rows now carry question text,
   * so `stated` is the MAJORITY shape, not the hypothetical one. The comment was
   * written to justify implementing a branch nothing exercised — "a surface that
   * only handled the broken shapes would break the day the producer was fixed" —
   * and that day has been and gone. ⛔ The lesson is the comment, not the count:
   * a population figure inside a doc comment is a MEASUREMENT WITH A DATE, never
   * a standing property, and this one had rotted into the strongest-sounding
   * sentence in the block. Re-measure before quoting it again.
   */
  | 'stated'
  /**
   * Typed QUESTION, states no readable question. Was EVERY measured QUESTION row
   * on 2026-09-10; as of 2026-09-14 it is the minority — 117 of 179 pending
   * QUESTION rows carry question text, and the rest land here.
   */
  | 'unstated'
  /** States a question, `deblock_action` not QUESTION. Every measured carrier. */
  | 'unrouted';

export interface QuestionPresentation {
  state: QuestionState;
  /** The producer's question text(s), verbatim. Empty unless `stated`/`unrouted`. */
  questions: string[];
  /**
   * True iff the SERVER will refuse an approve carrying no answer text — i.e.
   * exactly {@link isQuestion}. Never widened by the presence of a question.
   */
  answerDemanded: boolean;
  /**
   * The sentence a surface must state ITSELF for this row, or `null` when the
   * row needs no caveat. Owned here, never lifted off the approval, for the same
   * reason as {@link ANSWER_CONTRACT}: the row does not carry it.
   */
  notice: string | null;
}

/**
 * The notice for a row fr demands an answer from that asks nothing.
 *
 * ⛔ It must NOT hide the row and must NOT decide it. The row is real, the
 * server's refusal is real, and a human may still be able to answer from the
 * block context — what is missing is the producer's question, and saying so is
 * the only honest thing this surface can do. Presenting an instrument report
 * (`watchdog_stall_unspecified` is the one seen most often) under an "answer
 * this" heading is the defect.
 */
export const UNSTATED_QUESTION_NOTICE =
  'This row is typed QUESTION — the server refuses an approve that carries no answer — but ' +
  'the producer supplied no question: metadata.open_questions is empty. What the description ' +
  'carries is the instrument report that raised the block, not something anyone was asked. ' +
  'Nothing here is answerable on its face. Reject it with a reason (never blocked), or answer ' +
  'only if the block context below tells you what was actually being asked.';

/** Same, for a row whose `open_questions` key holds something with no readable text. */
export const UNREADABLE_QUESTION_NOTICE =
  'This row is typed QUESTION and carries an open_questions value, but none of it is readable ' +
  'question text. It is NOT being rendered rather than shown as `[object Object]`: that string ' +
  'is the only visible evidence of the producer defect. Treat this row as unanswerable and ' +
  'reject it with a reason, which is never blocked.';

/**
 * The caveat for a row that STATES a question while proposing no action.
 *
 * ⭐ MEASURED AGAINST THE SERVER, NOT ASSUMED. `persistedComment = comment ||
 * reason` (`backend/src/routes/approvals.ts:1510`) is written into
 * `approval_decisions.comment` unconditionally at `:1580` — there is no branch on
 * `deblock_action` — and `buildCallbackPayload` forwards it unconditionally as
 * `comment` (`backend/src/services/n8n-callback.ts:193`). So the text IS persisted
 * and IS delivered. What does NOT happen is the card move: with no
 * `deblock_action`, `asDeblockAction` yields `undefined`
 * (`n8n-callback.ts:179`), the callback's `Resolve Target List` switch matches
 * nothing, and the card is not re-driven the way an answered QUESTION is. A UI
 * that promised the re-drive here would be promising something the wire cannot
 * carry.
 */
export const UNROUTED_QUESTION_NOTICE =
  'This row states a question but proposes no deblock action. Your text is recorded on the ' +
  'decision and forwarded to the n8n callback as `comment`, so the asker receives it — but ' +
  'with no proposed action the callback has no card move to run, so answering here does not ' +
  'itself return the card to TODO the way an answered QUESTION does.';

export function questionPresentation(a: Pick<Approval, 'metadata'>): QuestionPresentation {
  const questions = openQuestionsOf(a);
  const answerDemanded = isQuestion(a);
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  // "Unreadable" is not "present": `open_questions: []` and `open_questions: ''`
  // are the producer supplying NOTHING, and must read as the plain absence they
  // are. Only a value that holds something no reader can render — a number, an
  // object, an array whose members are not strings — earns the other notice.
  const rawOpenQuestions = metadata.open_questions;
  const unreadable =
    rawOpenQuestions !== undefined &&
    rawOpenQuestions !== null &&
    !(Array.isArray(rawOpenQuestions) && rawOpenQuestions.length === 0) &&
    !(typeof rawOpenQuestions === 'string' && rawOpenQuestions.trim().length === 0);

  if (questions.length > 0) {
    if (answerDemanded) return { state: 'stated', questions, answerDemanded, notice: null };
    // ⛔ A FIX-ASSERTION ROW DOES PROPOSE AN ACTION, AND ITS APPROVE DOES MOVE THE CARD.
    // `UNROUTED_QUESTION_NOTICE` says both are untrue, so on an INFRASTRUCTURE /
    // DEPENDENCY row that also states a question it would contradict
    // `FIX_ASSERTION_CONTRACT` a few lines away. The questions are still shown; the
    // caveat is withheld because the fix contract is the true sentence for this row.
    return {
      state: 'unrouted',
      questions,
      answerDemanded,
      notice: isFixAssertion(a) ? null : UNROUTED_QUESTION_NOTICE,
    };
  }
  if (answerDemanded) {
    return {
      state: 'unstated',
      questions,
      answerDemanded,
      notice: unreadable ? UNREADABLE_QUESTION_NOTICE : UNSTATED_QUESTION_NOTICE,
    };
  }
  return { state: 'none', questions, answerDemanded, notice: null };
}

/**
 * What APPROVING this row does to the card, keyed by proposition.
 *
 * ⭐ THIS IS A MIRROR OF THE RECEIVER, NOT A UI INVENTION. The authority is
 * `n8n_custom_nodes workflows/patterns/approval-callback.json ::
 * Resolve Target List`, whose `ACTION_TARGET` is the map that actually moves the
 * Planka card. QUESTION is absent there deliberately — it HOLDS until answered,
 * and its release is the `questionAnswered` branch of the same node — and MERGE
 * is absent because it is not a plain move: it attempts a pull-request merge
 * first and only then advances the card, so it must never be described to a
 * human as "moves the card to DONE".
 *
 * ⭐ CHANGED 2026-09-14 — INFRASTRUCTURE and DEPENDENCY NOW MOVE, AND THE COMMENT
 * THAT STOOD HERE SAID THE OPPOSITE. It read "QUESTION, INFRASTRUCTURE and
 * DEPENDENCY are absent there deliberately — they HOLD", which was true of the
 * receiver until the same day and is false now. The product owner's decision:
 * approving one of these rows means "I have fixed it, try again", so the card is
 * re-driven through TODO exactly as RETRY is, and the pickability gate decides
 * when it becomes READY. The reason is measured: the old hold was TERMINAL —
 * nothing in the estate evaluated `approval_hold:INFRASTRUCTURE|DEPENDENCY`, so
 * approve and reject were byte-identical outcomes on 214 pending rows and the
 * operator's click did nothing at all.
 *
 * ⛔ APPROVE MOVES; LAPSE AND REJECT DO NOT — AND THAT ASYMMETRY IS LOAD-BEARING.
 * An EXPIRED infrastructure approval must still HOLD: an expiry is a deadline
 * passing, not a human saying "I fixed it", and a rejection is a human saying the
 * opposite. Every helper in this file that reads these maps is scoped to APPROVE
 * (`cardMoveOnApprove`, `approveMoveNotice`, `approveHoldNotice`,
 * `approveConsequenceNotice`, and `answerRequired`, which returns false for any
 * decision that is not `'approved'`), so none of them can speak for a lapse. The
 * receiver keeps the same asymmetry structurally, and no lapse or rejection ever
 * reaches `ACTION_TARGET`: an expired/voided row takes its own `isNonVerdict` block
 * (hold for `HOLDING_ACTIONS` and MERGE, otherwise re-queue to TODO), and a rejected
 * row takes the `ctx.decision !== 'approved'` hold inside `if (action)`.
 *
 * ⚠️ Keep in lockstep with that file. If the two ever disagree, the button says
 * one thing and the card does another, which is worse than an unlabelled button.
 * ⚠️ CORRECTED 2026-09-14 — this said the receiver change "removes them from
 * `HOLDING_ACTIONS`". It does the opposite: the receiver adds both keys to
 * `ACTION_TARGET`, KEEPS `HOLDING_ACTIONS = {QUESTION, INFRASTRUCTURE, DEPENDENCY}`
 * as the LAPSE set (so an expired one still holds), and adds a separate
 * `APPROVAL_HOLDING_ACTIONS = {QUESTION}` for the approved arm.
 */
const ACTION_CARD_MOVE: Readonly<Record<string, string>> = {
  // 2026-10-05 (liveness-DONE design row #2): a dropped card is NOT done work — it goes to the
  // NON-DONE terminal list DROPPED. Mirrors `APPROVED_ACTION_TARGET.DROP` in
  // backend/src/domain/engagement/deblock-actions.ts.
  DROP: 'DROPPED',
  SPLIT: 'READY',
  RETRY: 'TODO',
  INFRASTRUCTURE: 'TODO',
  DEPENDENCY: 'TODO',
  // REALIGN R5 — mirrors `APPROVED_ACTION_TARGET.RECLASSIFY` in
  // backend/src/domain/engagement/deblock-actions.ts.
  RECLASSIFY: 'TODO',
};

/**
 * What approving a row ASSERTS, for the actions where "approve" does not mean
 * plain agreement.
 *
 * ⛔ WHY THIS IS NOT DECORATION. On DROP / SPLIT / RETRY the destination alone
 * tells the human what they did. On INFRASTRUCTURE and DEPENDENCY it does not:
 * until 2026-09-14 those rows HELD, so a decider who learned the product under
 * the old behaviour reads Approve as "yes, that is indeed broken" — agreement
 * with a diagnosis. It now means the opposite kind of statement: a claim about
 * the WORLD ("the fault is fixed / the dependency is resolved") on which the card
 * is immediately re-driven. Shipping the move without saying so would hand every
 * existing user a button whose meaning silently changed under them.
 *
 * Empty for every action whose move needs no such claim; `approveMoveNotice`
 * falls back to the plain sentence there.
 */
const ACTION_APPROVE_CLAIM: Readonly<Record<string, string>> = {
  INFRASTRUCTURE:
    'Approving states that the named infrastructure fault is FIXED and the work can be retried',
  DEPENDENCY:
    'Approving states that the blocking dependency is RESOLVED and the work can be retried',
};

/**
 * The list approving this row moves the card to, or `null` when approving moves
 * no card at all.
 *
 * WHY THIS EXISTS. `/approvals` rendered ONE undifferentiated "Approve" for
 * every action except QUESTION, so a RETRY row — 410 of 840 pending — looked
 * exactly like a sign-off while approving it is A REAL CARD MOVE back to TODO.
 * fr#1080 opened 9 such rows and found 3 pointing at cards already
 * `finalized=true, verdict=pass, 13/13 steps`. A human cannot decide well from a
 * control that does not say what it does.
 */
export function cardMoveOnApprove(a: Pick<Approval, 'metadata'>): string | null {
  const action = deblockActionOf(a)?.toUpperCase();
  if (!action) return null;
  return ACTION_CARD_MOVE[action] ?? null;
}

/**
 * A sentence for the human, or `null` when approving moves no card.
 * Deliberately states the DESTINATION, because "approve" alone reads as
 * agreement and this is a state change.
 */
export function approveMoveNotice(a: Pick<Approval, 'metadata'>): string | null {
  const target = cardMoveOnApprove(a);
  if (!target) return null;
  const action = deblockActionOf(a)?.toUpperCase();
  if (action === 'RECLASSIFY') return reclassifyMoveNotice(null);
  const claim = action ? ACTION_APPROVE_CLAIM[action] : undefined;
  if (claim) {
    return (
      `${claim}: it moves the card to ${target} to be re-driven. It is a card move, ` +
      `not a sign-off — reject it instead if the fault is still open.`
    );
  }
  return `Approving this ${action} moves the card to ${target}. It is a card move, not a sign-off.`;
}

/**
 * The sentence for an approve that RECLASSIFIES the card (REALIGN R5), naming the
 * chosen type when there is one. RECLASSIFY is a move, not a hold: the receiver
 * writes the new card_type and moves the card to TODO, where it re-enters READY
 * under the new type's pattern. `null` → the type is not chosen yet.
 */
export function reclassifyMoveNotice(newCardType: string | null): string {
  const to = newCardType ? ` to ${newCardType}` : ' to the type you choose';
  return (
    `Approving this RECLASSIFY changes the card's type${to} and moves the card to TODO, ` +
    'where it is re-driven under the new type. It is a card move, not a sign-off.'
  );
}

/**
 * A sentence for a row whose approve moves NO card, or `null` when there is
 * nothing honest to say.
 *
 * WHY THIS EXISTS. `approveMoveNotice` returns `null` for every action absent
 * from {@link ACTION_CARD_MOVE}, and `null` renders as SILENCE — so the human
 * clicked Approve and the surface said nothing at all about what that did.
 * Measured 2026-09-13: of 458 human Approve clicks only 73 (16%) moved a card;
 * 161 INFRASTRUCTURE and 6 DEPENDENCY approvals were HELD, and the operator
 * reports this as "I clicked Approve and nothing happened". The remedy is to
 * state the hold, including the part that nothing drains it.
 *
 * ⭐ NARROWED 2026-09-14 — THE `INFRASTRUCTURE` AND `DEPENDENCY` CASES ARE GONE
 * FROM THE SWITCH, and their removal is not tidying. Those two actions now appear
 * in {@link ACTION_CARD_MOVE}, so `approveConsequenceNotice` would take the MOVE
 * sentence and never reach them — leaving two branches that state, in words, that
 * the card does NOT move, on rows where it now does. A dead branch that
 * contradicts the live one is the stale-comment defect with a `return` in it: the
 * next reader greps for "INFRASTRUCTURE", finds the hold copy, and believes it.
 * MERGE is the only surviving case, and it survives for the reason it was always
 * here — its move is conditional on a pull request actually landing, which is
 * resolved downstream and cannot be promised at decision time.
 *
 * ⛔ QUESTION IS DELIBERATELY SILENT HERE, AND MUST STAY SILENT. Its contract is
 * already stated next to the answer box by {@link ANSWER_CONTRACT} (and, per row,
 * by {@link questionPresentation}'s notice). Saying it a second time in different
 * words is exactly how two surfaces drift apart — the failure
 * {@link validateAnswer}'s `unrouted` branch was written to undo, after both
 * strings were measured on screen together.
 *
 * ⛔ AN UNMODELLED ACTION STAYS SILENT TOO. Unknown, absent and unrecognised
 * actions return `null` rather than a generic "this will not move the card":
 * `deblockActionOf` answers "what does the row SAY?", never "what will the
 * callback DO?", so asserting an outcome for behaviour this file has not mirrored
 * would be inventing the mirror rather than reading it.
 */
export function approveHoldNotice(a: Pick<Approval, 'metadata'>): string | null {
  const action = deblockActionOf(a)?.toUpperCase();
  switch (action) {
    case 'MERGE':
      return (
        'Approving this MERGE attempts the pull-request merge first; the card advances only if ' +
        'that merge lands.'
      );
    default:
      return null;
  }
}

/**
 * The ONE sentence a surface shows about what approving this row does — a move
 * notice when there is a move, otherwise a hold notice, otherwise nothing.
 *
 * ⛔ THIS IS THE FUNCTION THE UI CALLS. The three surfaces that decide — the
 * NEEDS YOU queue's bulk-approve, the row-level Approve control and the dedicated
 * review page — call this and nothing below it, for the same reason the rest of
 * this module exists: three surfaces that each pick their own combination of
 * {@link approveMoveNotice} and {@link approveHoldNotice} are three surfaces that
 * will disagree about the same row. The precedence is not a preference either —
 * a row that moves a card is described by its MOVE; the hold copy is only ever
 * reached when {@link cardMoveOnApprove} has already said there is no move.
 */
export function approveConsequenceNotice(a: Pick<Approval, 'metadata'>): string | null {
  return approveMoveNotice(a) ?? approveHoldNotice(a);
}

/**
 * The approve-path re-drive holds whose approval ASSERTS a fix.
 *
 * ⭐ A MIRROR OF `FIX_ASSERTION_ACTIONS` IN
 * `backend/src/domain/engagement/deblock-actions.ts`, SPELLED, NOT DERIVED. Since
 * 2026-09-14 approving an INFRASTRUCTURE or DEPENDENCY hold re-drives the card to
 * TODO ("I have fixed it, try again"), and the server refuses an EMPTY approve of
 * one (`classifyAnswerDemand` → `'fix_assertion'`): re-driving a hold on work that
 * may already be done can open a SECOND pull request for it, and a stated fix is
 * the agreed mitigation.
 *
 * ⛔ DO NOT REPLACE THIS WITH `ACTION_CARD_MOVE[a] === 'TODO'`. That expression
 * sweeps in RETRY — "run it again", which asserts no fix — and would demand text
 * from the largest decidable population in the queue. The backend refused that
 * derivation for the same reason. Adding a third member is a decision somebody
 * makes on purpose, on BOTH sides.
 */
export const FIX_ASSERTION_ACTIONS: ReadonlySet<string> = new Set<string>([
  'INFRASTRUCTURE',
  'DEPENDENCY',
]);

/**
 * WHY an approve of this row must carry text, or `null` when it need not. Mirrors
 * the backend's `AnswerDemand` / `classifyAnswerDemand`
 * (`backend/src/domain/engagement/deblock-actions.ts`), member for member.
 *
 * ⚠️ ORDER IS LOAD-BEARING AND IS THE SERVER'S: `question_action` >
 * `fix_assertion` > `stated_question`. A row typed QUESTION is a question whatever
 * else it carries; an INFRASTRUCTURE row that also states an `open_questions` entry
 * is a fix assertion, because its text is what re-drives the card, not merely what
 * is forwarded to an asker. The surface picks its WORDING from this value, so a
 * wrong order is a wrong message, not just a wrong gate.
 *
 * ⚠️ Case-insensitive on the action, like every other reader in this file
 * (`isQuestion`, `cardMoveOnApprove`); the server's `asDeblockAction` is exact.
 * The divergence only ever makes the UI STRICTER than the server (a lower-case
 * `infrastructure` would be demanded here and ignored there), never laxer.
 */
export type AnswerDemand = 'question_action' | 'fix_assertion' | 'stated_question' | null;

export function isFixAssertion(a: Pick<Approval, 'metadata'>): boolean {
  const action = deblockActionOf(a)?.toUpperCase();
  return action !== undefined && FIX_ASSERTION_ACTIONS.has(action);
}

export function answerDemandOf(
  a: Pick<Approval, 'metadata'>,
  decision: 'approved' | 'rejected' = 'approved',
  /**
   * REALIGN R5 — the action the decider is about to SEND when it differs from the
   * stored one (today: RECLASSIFY). The server keys the demand on the EFFECTIVE
   * action (`answerlessApproveDemand`: `suppliedAction ?? storedAction`), so a
   * QUESTION row switched to RECLASSIFY owes no answer — demanding one here would
   * refuse in the browser what the server accepts. A stated question still demands
   * text on any action, exactly as `classifyAnswerDemand` does.
   */
  chosenAction?: string,
): AnswerDemand {
  // Rejection is never gated, on any action — a hold can always be rejected.
  if (decision !== 'approved') return null;
  if (chosenAction !== undefined) {
    const effective = chosenAction.toUpperCase();
    if (effective === 'QUESTION') return 'question_action';
    if (FIX_ASSERTION_ACTIONS.has(effective)) return 'fix_assertion';
    return hasStatedQuestion(a) ? 'stated_question' : null;
  }
  if (isQuestion(a)) return 'question_action';
  if (isFixAssertion(a)) return 'fix_assertion';
  if (hasStatedQuestion(a)) return 'stated_question';
  return null;
}

/**
 * The label on the text box of a fix-assertion row.
 *
 * ⛔ NOT THE QUESTION WORDING, AND IT MUST NEVER FALL THROUGH TO IT. Nobody asked
 * this row a question; the approver is stating a fact about the world. "Your
 * answer" / "Write the answer…" on an INFRASTRUCTURE row is exactly the
 * wrong-message fall-through the backend's refusal arms were split to remove.
 */
export const FIX_ASSERTION_LABEL = 'What did you fix?';

export const FIX_ASSERTION_PLACEHOLDER =
  'State what was fixed or resolved — e.g. the service restored, the credential rotated, the ' +
  'blocking work that landed. Recorded on the decision and sent with it.';

/** Accessible name of the fix box. */
export const FIX_ASSERTION_ARIA_LABEL = 'Statement of what was fixed';

/** The queue row's control that opens the fix box. */
export const FIX_ASSERTION_TOGGLE = 'State what was fixed';

/** The queue row's submit button once the fix box is open. */
export const FIX_ASSERTION_SUBMIT = 'Approve — fixed, move to TODO';

/**
 * The contract shown beside the fix box — the fix-assertion counterpart of
 * {@link ANSWER_CONTRACT}, owned here for the same reason: the row does not carry it.
 * Same claims as the backend's `FIX_ASSERTION_REFUSAL_LEAD` / `_EXIT`, stated before
 * the click instead of after it.
 */
export const FIX_ASSERTION_CONTRACT =
  'Approving asserts the named fault is fixed and re-drives this card to TODO. Re-driving ' +
  'work that is already done risks opening a duplicate pull request for it, so a statement ' +
  'of what was fixed is required — it is recorded on the decision and forwarded with it. ' +
  'Rejecting needs no text and is always allowed.';

/**
 * The empty-fix refusal. Mirrors the backend's `FIX_ASSERTION_REFUSAL_LEAD` +
 * `FIX_ASSERTION_REFUSAL_EXIT` (`backend/src/domain/engagement/deblock-actions.ts`)
 * minus the API-only "put it in `comment`" advice, which a box on screen makes moot.
 * ⛔ Never says "question" or `approval_answer_missing`: neither is true of this row.
 */
export const FIX_ASSERTION_REFUSAL =
  'This approval is an INFRASTRUCTURE or DEPENDENCY hold: approving it asserts the named ' +
  'fault is fixed and re-drives the card to TODO. Approving with no statement of what was ' +
  'fixed is refused — re-driving work that is already done risks opening a duplicate pull ' +
  'request for it. State what was fixed, or, if nothing has been fixed, reject it with a ' +
  'reason — rejecting is always allowed.';

/**
 * What an approve of this row must carry, in the backend's own terms. Mirrors
 * `demandedDecisionText` in `backend/src/domain/engagement/deblock-actions.ts`.
 */
export function demandedDecisionText(demand: Exclude<AnswerDemand, null>): string {
  switch (demand) {
    case 'question_action':
    case 'stated_question':
      return 'the answer';
    case 'fix_assertion':
      return 'a statement of what was fixed';
    default: {
      const exhaustive: never = demand;
      return exhaustive;
    }
  }
}

/**
 * The tooltip on a row-level Approve that is disabled because the row owes text.
 *
 * ⛔ AN EXHAUSTIVE SWITCH, NOT A TWO-WAY TERNARY — and that is the fix, not style.
 * This text used to live inline on `/approvals` as
 * `question.answerDemanded ? <QUESTION text> : <stated-question text>`, so the day
 * `answerRequired` learned `fix_assertion` every INFRASTRUCTURE / DEPENDENCY row fell
 * into "This row states an open question…". The backend had the identical two-way
 * shape in two places and replaced both with a `never`-checked switch; a new member
 * of {@link AnswerDemand} is now a type error here instead of a wrong sentence.
 */
export function answerlessApproveTitle(demand: Exclude<AnswerDemand, null>): string {
  switch (demand) {
    case 'question_action':
      return 'This is a QUESTION: the server refuses an approve that carries no written answer, and it is the answer text that returns the card to TODO. Use "Answer this question".';
    case 'fix_assertion':
      return `Approving this hold re-drives the card to TODO, and it is refused without ${demandedDecisionText(demand)}. Use "${FIX_ASSERTION_TOGGLE}".`;
    case 'stated_question':
      return 'This row states an open question and the server refuses an approve that carries no written answer. Use "Answer this question" — the text is recorded on the decision and forwarded to the asker.';
    default: {
      const exhaustive: never = demand;
      return exhaustive;
    }
  }
}

/**
 * True iff this decision must carry text before it may be sent — exactly
 * `answerDemandOf(a, decision) !== null`, the server's `classifyAnswerDemand`.
 *
 * ⭐ REJECTION IS EXEMPT, AND THAT IS THE SERVER'S RULE, NOT A RELAXATION HERE
 * (`backend/src/routes/approvals.ts` gates on `status === 'approved'`). Rejecting
 * a question you cannot answer is a legitimate terminal: the reject branch moves
 * the card and the producer learns the question was unanswerable. A rejection's
 * `reason` is itself the answer, and the card stays BLOCKED either way.
 *
 * ⭐ A UNION OF THREE INDEPENDENT REASONS (see {@link AnswerDemand}); it used to be
 * only the first, then the first two.
 *
 *   (1) `isQuestion` — the RECEIVER's rule. `approval-callback.json ::
 *       Resolve Target List` computes
 *       `questionAnswered = action === 'QUESTION' && decision === 'approved' &&
 *       answerText.length > 0`, and nothing in that node reads `open_questions`
 *       at all. An empty approve therefore takes the HOLDING branch, stamps
 *       `answer_missing` / `approval_answer_missing`, and the row is then SPENT.
 *   (2) `isFixAssertion` — added 2026-09-14. Approving an INFRASTRUCTURE or
 *       DEPENDENCY hold re-drives the card to TODO; the server refuses it empty
 *       because a re-drive can open a duplicate pull request. See
 *       {@link FIX_ASSERTION_ACTIONS}.
 *   (3) `hasStatedQuestion` — the ROW's own content. A human was asked something
 *       and the text is deliverable: `persistedComment = comment || reason` is
 *       written unconditionally and forwarded unconditionally to the callback as
 *       `comment`, so an approve that carries none delivers no answer to a
 *       question that was genuinely asked.
 *
 * ⛔ WITHOUT (2) THE UI REBUILDS THE ORIGINAL DEAD END. The server 422s an empty
 * approve of these rows; a surface that rendered no text box and a live Approve
 * would hand the operator a red toast and no input to comply with — the "Approve
 * seemed to fail" report, reintroduced by the fix that added the re-drive.
 *
 * ⛔ (1) IS NOT SUBTRACTED WHEN (3) IS ABSENT — DO NOT "FIX" THE UNSTATED ROWS BY
 * DROPPING THE DEMAND. The receiver branches on `deblock_action`, never on
 * `open_questions`, so an unstated QUESTION row approved empty is stranded in
 * BLOCKED exactly as a stated one would be. The honest remedy for those rows is
 * {@link UNSTATED_QUESTION_NOTICE}, which steers to reject — which is exempt.
 */
export function answerRequired(
  a: Pick<Approval, 'metadata'>,
  decision: 'approved' | 'rejected',
  /** The action actually being sent, when it overrides the stored one — see {@link answerDemandOf}. */
  chosenAction?: string,
): boolean {
  return answerDemandOf(a, decision, chosenAction) !== null;
}

/**
 * Whether the text a decider typed would count as an answer, and why not.
 *
 * Byte-for-byte the server's test: `(persistedComment ?? '').trim()` then
 * `answerText.length === 0` (`backend/src/routes/approvals.ts:1510-1516`). The
 * `.trim()` is not decoration — the n8n consumer trims too
 * (`backend/src/routes/approvals.ts:155`), so a whitespace-only comment is an
 * EMPTY answer downstream and must be one here.
 *
 * ⚠️ The caller must pass the value it will actually PERSIST. The server writes
 * `comment || reason` — note `||`, not `??`, so an explicitly-empty `comment`
 * falls through to `reason`. A surface with both fields must apply that same
 * fallback BEFORE calling this, or it will refuse a decision whose answer text
 * is in fact non-empty.
 */
export function validateAnswer(
  text: string | null | undefined,
  state?: QuestionState,
  /**
   * The row's {@link answerDemandOf}. Optional so every pre-existing caller keeps
   * its wording; ⛔ a caller that can reach an INFRASTRUCTURE / DEPENDENCY row MUST
   * pass it, or that row is refused in QUESTION words ("This approval is a
   * QUESTION … approval_answer_missing") about a mechanism it never reaches.
   */
  demand?: AnswerDemand,
): {
  ok: boolean;
  reason: string | null;
} {
  if ((text ?? '').trim().length !== 0) return { ok: true, reason: null };

  // ⛔ BEFORE `state`, because `state` cannot tell a fix row from anything else:
  // an INFRASTRUCTURE row reads `none` (or `unrouted` if it also states a question),
  // and both of those arms describe a question. The server's order puts
  // `fix_assertion` above `stated_question`; `question_action` never reaches here
  // with this value, because `answerDemandOf` returns it first.
  if (demand === 'fix_assertion') return { ok: false, reason: FIX_ASSERTION_REFUSAL };

  // ⛔ THE REFUSAL MUST DESCRIBE *THIS* ROW. This message used to be one hard-coded
  // string opening "This approval is a QUESTION". That was true while the answer box
  // rendered only on `deblock_action === 'QUESTION'`. #1083 widened the box to rows
  // that STATE a question but propose no action — and the string came along, so the
  // page then asserted two incompatible things a few lines apart:
  //
  //   questionInfo.notice   "This row states a question but proposes no deblock
  //                          action ... answering here does not itself return the
  //                          card to TODO the way an answered QUESTION does."
  //   validateAnswer        "This approval is a QUESTION ... the card stays BLOCKED
  //                          with block_reason approval_answer_missing, and no second
  //                          decision is accepted from you."
  //
  // Both were on screen together on `/approvals/37afafb5-…`, measured live after the
  // deploy. That is the same self-contradiction class this branch exists to remove,
  // reintroduced by the fix for it — and the `approval_answer_missing` mechanism it
  // named is the n8n QUESTION branch, which an unrouted row never reaches.
  if (state === 'unrouted') {
    return {
      ok: false,
      reason:
        'This row states a question, so an approval that carries no answer delivers ' +
        'nothing to the asker. Your text is what travels: it is recorded on the ' +
        'decision and forwarded to the callback. Type the answer, or reject with a ' +
        'reason — rejecting is never blocked.',
    };
  }

  return {
    ok: false,
    reason:
      'This approval is a QUESTION, and the answer is the whole content of the decision. ' +
      'Approving with an empty answer spends the approval without delivering one: the card ' +
      'stays BLOCKED with block_reason approval_answer_missing, and no second decision is ' +
      'accepted from you, so nothing can release it afterwards. Type the answer, or reject ' +
      'the approval with a reason — rejecting a question you cannot answer is never blocked.',
  };
}

/**
 * The declared gate terms that mean the gate is broken — the intersection of
 * `metadata.gate_terms` with {@link BROKEN_GATE_TERMS}. Mirrors
 * `declaredGateTerms` (`backend/src/routes/approvals.ts:142-146`) and the
 * filter that consumes it (`:1340-1342`).
 *
 * Defensive by construction, because `metadata` is producer-written jsonb: a
 * `gate_terms` that is absent, `null`, a bare string, or an array with
 * non-string members yields `[]` rather than throwing or coercing. Order and
 * duplicates are preserved as declared — this reports what the row SAYS.
 */
export function brokenGateTermsOf(a: Pick<Approval, 'metadata'>): string[] {
  const metadata = (a.metadata ?? {}) as Record<string, unknown>;
  const raw = metadata.gate_terms;
  if (!Array.isArray(raw)) return [];
  return raw.filter((t): t is string => typeof t === 'string' && BROKEN_GATE_TERMS.has(t));
}

/**
 * Whether a super-admin's broken-gate override argument would be ACCEPTED, and
 * why not. Mirrors the server's test exactly: `isSuperAdmin(user) &&
 * reason.trim().length >= BROKEN_GATE_OVERRIDE_MIN_REASON`
 * (`backend/src/routes/approvals.ts`, the #1064 guard).
 *
 * ⛔ `canOverride` IS PART OF THE PREDICATE, NOT A CALLER'S CONCERN. A non
 * super-admin looking at a broken-gate row has no accepting input at all — the
 * server refuses every approve on it — so a surface that validated only the text
 * would show a satisfied-looking control that 422s on click. That is the exact
 * shape this whole change exists to remove: the previous UI told the reader an
 * override existed and linked them to a page that had no field for it.
 *
 * ⚠️ A `true` here is NOT a promise the server will accept. `BROKEN_GATE_TERMS`
 * is a SUBSET of the server's set (it unions `APPROVAL_BROKEN_GATE_TERMS` from
 * its env, which the browser cannot read), and super-admin is re-checked
 * server-side against the signed token. This gates the CONTROL, never the
 * outcome.
 */
export function validateOverrideReason(
  text: string | null | undefined,
  canOverride: boolean,
): { ok: boolean; reason: string | null } {
  if (!canOverride) {
    return {
      ok: false,
      reason:
        'This row\u2019s gate terms describe a defect in the process that raised it, not a ' +
        'decision anyone can take, so approving it is refused. Rejecting it with a reason is ' +
        'the correct terminal and is never blocked. Only a super-admin can override, and ' +
        'that override is recorded on the approval.',
    };
  }
  const trimmed = (text ?? '').trim();
  if (trimmed.length >= BROKEN_GATE_OVERRIDE_MIN_REASON) return { ok: true, reason: null };
  return {
    ok: false,
    reason:
      `An override must state, in at least ${BROKEN_GATE_OVERRIDE_MIN_REASON} characters, why ` +
      'you are signing off on a gate that could not be constructed. It is recorded on the ' +
      `approval against your name. ${trimmed.length}/${BROKEN_GATE_OVERRIDE_MIN_REASON}.`,
  };
}

/**
 * The machine's proposition, as far as it can be recovered from the free-form
 * `approvals.description`.
 *
 * Every field is nullable and `issues` may be empty: a missing section is an
 * ABSENCE, never a guess. `raw` is always the input verbatim so a caller can
 * render it when {@link Proposition.parsed} is false.
 */
export interface Proposition {
  title: string | null;
  blockReason: string | null;
  verdict: string | null;
  issues: string[];
  procedure: string | null;
  learning: string | null;
  proposedAction: string | null;
  onApprove: string | null;
  onReject: string | null;
  /**
   * Content that followed the legacy trailer and belongs to NO label — reported
   * verbatim rather than discarded or attributed to a section that did not
   * claim it. `null` when nothing unlabelled followed (the common case: the
   * trailer is the last line).
   *
   * ⚠️ It does NOT include the trailer sentence itself, and it does NOT include
   * a labelled section that came after the trailer — a `ON REJECT:` line after
   * the trailer opens `onReject` exactly as it would anywhere else.
   */
  trailing: string | null;
  /** The description exactly as received. Never edited, never repaired. */
  raw: string;
  /** True iff at least one labelled section matched. False ⇒ render `raw`. */
  parsed: boolean;
}

/** Separator between the proposition's title and its header. */
const TITLE_SEPARATOR = ': PROPOSITION for card';

/**
 * The labelled sections, each anchored at the start of a line.
 *
 * `BLOCK REASON` carries a bracketed provenance tag before its colon
 * (`BLOCK REASON [open_questions, source=derived-from-block-reason-field]:`), so
 * the bracket is part of the label, not of the body. Both the spaced and
 * underscored spellings of the two-word labels are accepted: the producer has
 * emitted `PROPOSED_ACTION:` and `ON APPROVE:` in the same description.
 */
/** The `string | null` sections — every field a label can fill except `issues`. */
type TextSection =
  | 'blockReason'
  | 'verdict'
  | 'procedure'
  | 'learning'
  | 'proposedAction'
  | 'onApprove'
  | 'onReject';

const SECTION_PATTERNS: ReadonlyArray<[TextSection | 'issues', RegExp]> = [
  ['blockReason', /^BLOCK[ _]REASON\s*(?:\[[^\]]*\])?\s*:\s*/i],
  ['verdict', /^VERDICT\s*:\s*/i],
  ['issues', /^ISSUES\s*:\s*/i],
  ['procedure', /^PROCEDURE\s*:\s*/i],
  ['learning', /^LEARNING\s*:\s*/i],
  ['proposedAction', /^PROPOSED[ _]ACTION\s*:\s*/i],
  ['onApprove', /^ON[ _]APPROVE\s*:\s*/i],
  ['onReject', /^ON[ _]REJECT\s*:\s*/i],
];

/**
 * The OLDER format's trailer, which replaces `ON APPROVE:` / `ON REJECT:`
 * entirely.
 *
 * ⚠️ IT IS A BOUNDARY, NOT CONTENT. It carries no label, so a line-based parser
 * that only breaks on labels appends it to whatever section happened to come
 * last — putting "Approve to execute the proposed action" inside `learning` or
 * `procedure`, where a renderer would show it as the producer's words. It is
 * also WRONG for a QUESTION (approving executes nothing, it delivers text),
 * which is why {@link ANSWER_CONTRACT} exists. Recognised and dropped; the row
 * still parses, and `onApprove` / `onReject` stay `null` for that format.
 *
 * ⛔ IT CLOSES THE OPEN SECTION — IT DOES NOT END THE DOCUMENT. Recognising the
 * boundary used to set the cursor to `null`, which SILENTLY DISCARDED every
 * line after it, in either format, with `parsed` still `true` and no signal to
 * the caller. That is a guess that trailing content is worthless, and this
 * module's contract is that a missing section is an ABSENCE, never a guess.
 * Post-trailer lines now go to {@link Proposition.trailing} (labelled ones
 * still open their own section), so nothing is dropped and nothing is
 * misattributed to the section that happened to precede the boundary.
 */
const LEGACY_TRAILER = /^Approve to execute the proposed action\./i;

/** Split an ISSUES body on ` ; ` / `;`, dropping whitespace-only members. */
function splitIssues(body: string): string[] {
  return body
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Parse a proposition description. Tolerant BY CONSTRUCTION: sections may be
 * absent, may arrive in any order, and may wrap over several lines.
 *
 * ⚠️ REAL DESCRIPTIONS CARRY A PRODUCER BUG AND THIS PARSER MUST NOT HIDE IT.
 * The literal text `[object Object]` appears mid-sentence where the producer
 * stringified a structure, and some descriptions are truncated mid-word
 * (`| failed step(s): step und`). Both pass through VERBATIM: they are the only
 * visible evidence of a defect upstream, and a parser that tidied them away
 * would delete the signal while leaving the cards stranded.
 */
export function parseProposition(description: string | null | undefined): Proposition {
  const raw = typeof description === 'string' ? description : '';
  const result: Proposition = {
    title: null,
    blockReason: null,
    verdict: null,
    issues: [],
    procedure: null,
    learning: null,
    proposedAction: null,
    onApprove: null,
    onReject: null,
    trailing: null,
    raw,
    parsed: false,
  };
  if (raw.trim().length === 0) return result;

  const lines = raw.split(/\r?\n/);

  // Title: the text before the first `: PROPOSITION for card`, else the first
  // non-empty line. `indexOf` on the whole string, not per line, because the
  // header is one line by construction but the marker is what identifies it.
  const separatorAt = raw.indexOf(TITLE_SEPARATOR);
  if (separatorAt >= 0) {
    const candidate = raw.slice(0, separatorAt).trim();
    result.title = candidate.length > 0 ? candidate : null;
  } else {
    const firstLine = lines.find((l) => l.trim().length > 0)?.trim();
    result.title = firstLine && firstLine.length > 0 ? firstLine : null;
  }

  // Line-based accumulation: a label opens a section, the next label (or the
  // legacy trailer) closes it, and everything between belongs to the open one.
  const bodies = new Map<TextSection | 'issues', string[]>();
  // Kept OUT of `bodies` deliberately: `parsed` keys on `bodies.size`, and
  // unlabelled trailing prose must not make an unlabelled description report
  // itself as a parsed proposition.
  const trailingParts: string[] = [];
  let current: TextSection | 'issues' | 'trailing' | null = null;

  for (const line of lines) {
    let matched = false;
    for (const [key, pattern] of SECTION_PATTERNS) {
      const m = pattern.exec(line);
      if (!m) continue;
      current = key;
      bodies.set(key, [line.slice(m[0].length)]);
      matched = true;
      break;
    }
    if (matched) continue;
    if (LEGACY_TRAILER.test(line.trim())) {
      // The trailer line itself is a boundary, not content: it is never
      // appended to the section it closes. What follows it still is content.
      current = 'trailing';
      continue;
    }
    if (current === 'trailing') {
      trailingParts.push(line);
      continue;
    }
    if (current) bodies.get(current)!.push(line);
  }

  for (const [key, parts] of bodies) {
    const body = parts.join('\n').trim();
    if (key === 'issues') {
      result.issues = splitIssues(body);
      continue;
    }
    // An empty body is a section the producer opened and said nothing in —
    // reported as absence, exactly like a section that never appeared.
    result[key] = body.length > 0 ? body : null;
  }

  const trailing = trailingParts.join('\n').trim();
  result.trailing = trailing.length > 0 ? trailing : null;

  // `parsed` keys on a LABELLED section, never on the title: the title falls
  // back to the first line, so it matches on any string at all and would report
  // arbitrary prose as a parsed proposition.
  result.parsed = bodies.size > 0;
  return result;
}
