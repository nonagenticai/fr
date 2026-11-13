/**
 * The closed set of BLOCKED-exit actions — ONE definition, imported by every site that needs it.
 *
 * ⛔ WHY THIS FILE EXISTS. Before it, this set was spelled out FIVE times across four files:
 *   routes/webhooks.ts        the mint-time zod enum
 *   routes/approvals.ts       the decider-override zod enum
 *   services/n8n.ts           the outbound payload TYPE union
 *   services/n8n-callback.ts  the outbound allowlist array
 *   services/n8n-callback.ts  ...and again as a cast, immediately below it
 *
 * The code already knew this was dangerous and said so, in `services/n8n-callback.ts`: "This
 * allowlist is closed: a key absent here is DROPPED, which is why `deblock_action` has to be named
 * in both this builder and N8nCardApprovalSchema." A value added to four of the five is not a
 * compile error and not a runtime error — the action is minted, stored, decided by a human, and
 * then silently dropped on the way back to n8n, so the card never moves and nothing anywhere says
 * why. That is the failure mode the whole BLOCKED lane has been paying down: an approval a human
 * answered that moved no card.
 *
 * Deriving the type from the array makes the five copies structurally impossible: add a value here
 * and every consumer widens with it; misspell one and `tsc` fails at the use site.
 */

import { isProofSubsetCardType } from './proof-subset';

export const DEBLOCK_ACTIONS = [
  'RETRY',
  'SPLIT',
  'QUESTION',
  'INFRASTRUCTURE',
  'DEPENDENCY',
  'DROP',
  /**
   * MERGE (2026-08-31) — the deliverable landed, so let the card finish.
   *
   * Measured: of the 31 pull requests the AA conveyor has ever produced, 28 backed a card that
   * reached DONE and exactly two had ever merged. DONE meant "a PR was opened", so work was
   * marked complete on evidence that it had been PROPOSED. The landing gate
   * (`qa-evaluate :: Apply Exit Rule`) now holds such a card in BLOCKED with
   * `block_reason: awaiting_merge`, which makes "should this pull request be merged?" a genuine
   * human-input question — exactly what BLOCKED is for.
   *
   * ⚠️ IT IS A MOVE WITH A PRECONDITION, NOT A PLAIN MOVE. The other actions answer "which list
   * does this card go to"; MERGE first performs a side effect that can REFUSE. n8n's callback
   * calls the coding node's `mergePullRequest`, whose refusals are machine-readable by design
   * (`checks_pending`, `checks_failed`, `already_merged`, `conflicts`). Only `merged: true` and
   * `already_merged` may advance the card to DONE; every other reason leaves it in BLOCKED with
   * that reason recorded verbatim. Approving the proposition authorises the attempt — it does not
   * assert the outcome, and the callback must never treat it as if it did.
   */
  'MERGE',
  /**
   * RECLASSIFY (2026-10-01, REALIGN R5) — the card is the wrong TYPE, so no retry under its
   * current pattern can succeed. The decider picks a new card_type (`new_card_type`, required
   * on approve and validated against the roster `ALL_CARD_TYPES`); the n8n receiver writes it
   * to the card's Planka `card_type` field and moves the card BLOCKED -> TODO, so it re-enters
   * READY under the new type's pattern. fr only carries the choice; it writes no card field.
   */
  'RECLASSIFY',
  /**
   * COVERAGE (2026-10-01, George BDD ruling) — a CODING card whose acceptance criteria lack an
   * executed passing BDD scenario. The minter stores R3's `coverage_request` (criteria[]) in
   * `approvals.metadata`; the decider signs each criterion off: approve = covered, reject = a
   * gap, per criterion via `rejected_criterion_ids`. fr resolves and stores
   * `metadata.coverage_decision` ({@link resolveCoverageDecision}) and forwards it to n8n. Web
   * seat or any seat that sends `rejected_criterion_ids` (the shared decide path validates it).
   */
  'COVERAGE',
] as const;

export type DeblockAction = (typeof DEBLOCK_ACTIONS)[number];

/**
 * Narrow an untrusted value (an approval's free-form `metadata` jsonb) to the closed set.
 * Returns `undefined` rather than throwing: an unrecognised action must become absent on the way
 * out to n8n, never reach the callback's switch as a string it cannot match.
 */
export function asDeblockAction(value: unknown): DeblockAction | undefined {
  return typeof value === 'string' && (DEBLOCK_ACTIONS as readonly string[]).includes(value)
    ? (value as DeblockAction)
    : undefined;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// WHAT A DECISION ACTUALLY DOES TO THE CARD — fr's half of the receiver's routing table.
//
// ⛔ THE DEFECT THIS CLOSES. Until now fr held NO statement of which actions move a card
// and which hold it. The receiver's table lived in exactly one place fr could not see
// (`AA Pattern - Approval Callback :: Resolve Target List`), and fr's three consumers of
// that knowledge each kept a PRIVATE, HAND-COPIED fragment of it:
//
//   workers/deblock-callback-redelivery.ts  `RECEIVER_HOLDING_ACTIONS` — a literal Set
//   frontend/src/lib/approvals/question.ts  the UI's own idea of what approving does
//   this file                               nothing at all
//
// That is the FIVE-COPIES failure this file's header was written to end, reproduced one
// semantic level up: the header made the action NAMES a single definition and left the
// action MEANINGS spelled out wherever they were needed.
//
// ⭐ WHY IT MATTERS NOW, AND NOT AS TIDINESS. INFRASTRUCTURE and DEPENDENCY are changing
// from a permanent hold into a real card move ("I have fixed it, try again" -> TODO), in
// the receiver and here, in lockstep. Measured: 214 pending rows carry one of the two, and
// today approving one and rejecting one produce BYTE-IDENTICAL outcomes — the card stays
// in BLOCKED either way. A gate whose branches agree is not a gate. Changing that on one
// side only is how the estate got the last four of these defects, so fr now states the
// table it is mirroring, and a test pins the value rather than the prose.
//
// ⛔⛔ THIS IS A PREDICTION OF THE RECEIVER, NEVER AN OBSERVATION OF THE BOARD. Nothing in
// fr moves a Planka card. `approvals.callback_delivered_at` — written ONLY by
// workers/deblock-callback-redelivery.ts after it re-reads Planka — is the sole statement
// that a card actually moved. Every name below says "planned"/"target", deliberately, and
// widening any of them into a claim about the board rebuilds migration 113's defect.
// ═══════════════════════════════════════════════════════════════════════════════════════

/** The Planka list kinds the receiver's `normalize()` resolves a board's lists into. */
/**
 * ⭐ `DROPPED` (2026-10-05, liveness-DONE design row #2): the NON-DONE terminal a DROP lands in.
 * A dropped card is not done work. See domain/engagement/proof-subset.ts DROPPED_LIST_NAME.
 */
export type DeblockTargetList = 'TODO' | 'READY' | 'DOING' | 'QA' | 'DONE' | 'BLOCKED' | 'DROPPED';

/**
 * Where the receiver sends an APPROVED proposition. `null` = the card is HELD.
 *
 * ⚠️ A `Record<DeblockAction, …>`, NOT a partial map, and that is the point: adding a
 * value to `DEBLOCK_ACTIONS` without deciding what approving it DOES is now a `tsc`
 * error rather than a silent hold. The receiver's own `ACTION_TARGET` is a plain object
 * literal with three keys, so a new action there falls through to "no move" invisibly —
 * that asymmetry is deliberate on this side.
 *
 * Verbatim from `AA Pattern - Approval Callback :: Resolve Target List` (read 2026-09-14):
 *   DROP  -> DONE   a card may die "given sufficient proof"; moved, never deleted.
 *   SPLIT -> READY  re-enters the split judge, which is authored at READY.
 *   RETRY -> TODO   the pickability gate decides when it becomes READY.
 *
 * ⭐ INFRASTRUCTURE -> TODO and DEPENDENCY -> TODO are the CHANGE (product owner,
 * 2026-09-14): approving one of these means "I have fixed it, try again", which is a
 * re-drive through TODO exactly as RETRY and an answered QUESTION already are.
 *
 * ⛔ THE RECEIVER-SIDE CHANGE IS NOT "ADD TWO KEYS TO `ACTION_TARGET`". Measured by
 * reading the node: its branch order is
 *
 *     if (decision !== 'approved')        -> hold
 *     else if (questionAnswered)          -> TODO
 *     else if (HOLDING_ACTIONS.has(action))-> hold      <-- INFRASTRUCTURE/DEPENDENCY land HERE
 *     else if (SIDE_EFFECT_ACTIONS[action])-> merge path
 *     else if (ACTION_TARGET[action])     -> move
 *
 * so `ACTION_TARGET` is consulted AFTER `HOLDING_ACTIONS` and two new keys there are
 * INERT. The release has to happen in the `HOLDING_ACTIONS` arm — and that arm's set is
 * ALSO what the lapse path reads. See {@link LAPSE_HOLDS_ACTIONS}.
 *
 * ⚠️ `QUESTION` is `null` here and is NOT a plain hold: it is released by answer text, a
 * condition no table lookup can express. {@link plannedCardMove} tests it before reaching
 * this map, mirroring the receiver's `questionAnswered` branch sitting above its
 * `HOLDING_ACTIONS` test.
 *
 * ⛔ `MERGE` MUST STAY `null`. The receiver's own comment: "MERGE MUST NEVER JOIN
 * `ACTION_TARGET`. That map answers 'which list' UNCONDITIONALLY, so `MERGE: 'DONE'`
 * would move the card whether or not the pull request actually merged." Approving
 * authorises the attempt; it does not assert the outcome.
 */
export const APPROVED_ACTION_TARGET: Readonly<Record<DeblockAction, DeblockTargetList | null>> = {
  RETRY: 'TODO',
  SPLIT: 'READY',
  QUESTION: null,
  INFRASTRUCTURE: 'TODO',
  DEPENDENCY: 'TODO',
  // ⛔ NEVER DONE (2026-10-05, coordinator movies-73 ruling on design row #2): a dropped card is
  // not done work, so DROP goes to the NON-DONE terminal list, never to DONE with a field on it.
  DROP: 'DROPPED',
  MERGE: null,
  // Re-drive through TODO under the decider-chosen type; the pickability gate decides READY.
  RECLASSIFY: 'TODO',
  // ⚠️ NOT A TABLE LOOKUP: COVERAGE's destination is COMPUTED from the stored coverage_decision
  // and the card type — see {@link plannedCardMove} step (1b) and {@link coverageTarget}. null
  // here only means "never answered by this map".
  COVERAGE: null,
};

/**
 * ⛔⛔ THE ASYMMETRY. READ THIS TWICE BEFORE CHANGING EITHER TABLE.
 *
 * An approval can end WITHOUT a human verdict — `expired` (the 15-minute reaper) or
 * `voided` (withdrawn as unanswerable). In the receiver those take the `lapseHolds`
 * path, `lapseHolds = isNonVerdict && (HOLDING_ACTIONS.has(action) || !!SIDE_EFFECT_ACTIONS[action])`.
 *
 * ⭐ AN EXPIRY IS NOT A HUMAN SAYING "I FIXED IT". The whole content of the Phase-4 change
 * is that a PERSON asserting the fault is cleared earns the re-drive. A reaper tick
 * asserts nothing. So INFRASTRUCTURE and DEPENDENCY gain a target on the APPROVED path
 * while KEEPING their hold on the lapse path — the two tables move in OPPOSITE directions
 * in the same change, which is exactly the shape a "simplification" destroys.
 *
 * ⛔ Getting this wrong silently re-drives EVERY expired hold. fr's approval-expiry worker
 * deliberately manufactures no decision (its header refuses auto-approve AND auto-reject
 * because either "would manufacture a decision nobody made"); routing an expired
 * INFRASTRUCTURE row to TODO would manufacture precisely the approval it refuses to make,
 * for the whole expired population at once.
 *
 * ⚠️ MERGE IS IN THIS SET AND IS *NOT* IN `HOLDING_ACTIONS`. It arrives via the receiver's
 * second disjunct (`SIDE_EFFECT_ACTIONS`), because a lapsed MERGE must not merge anything.
 * So this set is the UNION of the receiver's two, not a copy of its first —
 * `workers/deblock-callback-redelivery.ts :: RECEIVER_HOLDING_ACTIONS` is a copy of the
 * FIRST one only, and deliberately excludes MERGE for a different reason (retry budget).
 * Two sets, two purposes; do not reconcile them by making them equal.
 *
 * ⭐ RECLASSIFY IS IN THIS SET (REALIGN R5) although its APPROVED path is a move. It joins
 * for the INFRASTRUCTURE/DEPENDENCY reason, one step stronger: a lapsed RECLASSIFY means no
 * human chose a `new_card_type`, so a re-queue to TODO would re-drive the card under its OLD
 * type — the very type the proposition says is wrong — with nobody having asserted anything.
 * The card stays BLOCKED for a human. ⚠️ The receiver must hold it on the lapse path WITHOUT
 * adding it to its `HOLDING_ACTIONS` (that set is also the APPROVED-path hold, and would
 * strand every approved RECLASSIFY); `RECEIVER_HOLDING_ACTIONS` stays without it likewise.
 */
export const LAPSE_HOLDS_ACTIONS: ReadonlySet<DeblockAction> = new Set<DeblockAction>([
  'QUESTION',
  'INFRASTRUCTURE',
  'DEPENDENCY',
  'MERGE',
  'RECLASSIFY',
  // An expired/voided coverage approval means nobody signed any criterion off: neither
  // "covered" nor "gap" was asserted, so the card must stay BLOCKED for a human.
  'COVERAGE',
]);

/**
 * Does a NON-VERDICT outcome (expired / voided) leave this card held?
 *
 * Total over `unknown` because the caller's source is free-form jsonb. An unrecognised
 * action answers `false` — it has no hold to keep, and `buildCallbackPayload` will have
 * dropped it from the payload anyway.
 */
export function lapseHolds(action: unknown): boolean {
  const narrowed = asDeblockAction(action);
  return narrowed !== undefined && LAPSE_HOLDS_ACTIONS.has(narrowed);
}

/**
 * What each hold is waiting for — the sentence a decider is owed instead of an unnamed
 * sink. Mirrors the receiver's `HOLD_RELEASE_CONDITION`, with the two Phase-4 entries
 * rewritten because their release condition is what changed.
 */
export const HOLD_RELEASE_CONDITION: Readonly<Partial<Record<DeblockAction, string>>> = {
  QUESTION: 'a decider approves the proposition WITH an answer in the decision comment',
  INFRASTRUCTURE:
    'a decider approves the proposition, asserting the named infrastructure fault is fixed',
  DEPENDENCY:
    'a decider approves the proposition, asserting the blocking dependency is resolved',
  MERGE: 'the pull request actually merges (mergePullRequest returns merged or already_merged)',
};

/** Why a decision leaves the card where it is. */
export type CardHoldReason =
  /** A human said no. Rejecting a proposition must NEVER move the card. */
  | 'rejected_proposition'
  /** Expired or voided — nobody answered, so nothing is asserted. See LAPSE_HOLDS_ACTIONS. */
  | 'lapsed_proposition'
  /** Approved QUESTION carrying no answer text. The ask is still open. */
  | 'answer_missing'
  /** Approved MERGE. The move is conditional on an outcome that does not exist yet. */
  | 'merge_pending'
  /** Approved, but this action is not a move. */
  | 'hold_by_design'
  /** COVERAGE with no usable stored coverage_decision — the receiver refuses it and holds. */
  | 'coverage_decision_missing';

export type CardMovePlan =
  /**
   * No `deblock_action`: the receiver falls back to its legacy decision->list mapping,
   * which depends on board lists fr does not resolve. `moves: null` means NOT KNOWN —
   * it is not a synonym for `false`, and rendering it as one would be the "empty
   * evidence block read as measured" failure.
   */
  | { route: 'legacy'; moves: null; target: null; held: null; holdReleaseCondition?: undefined }
  | {
      route: 'proposition';
      moves: true;
      target: DeblockTargetList;
      held: null;
      holdReleaseCondition?: undefined;
    }
  | {
      route: 'proposition';
      moves: false;
      target: null;
      held: CardHoldReason;
      holdReleaseCondition?: string;
    };

/**
 * What this decision will do to the card, derived from the receiver's own tables.
 *
 * ⛔ THE BRANCH ORDER IS A MIRROR, NOT A STYLE CHOICE. It follows
 * `Resolve Target List` statement for statement (see {@link APPROVED_ACTION_TARGET}).
 * Consulting {@link APPROVED_ACTION_TARGET} FIRST would move a rejected INFRASTRUCTURE
 * card and re-drive every expired one — the two outcomes the Phase-4 change most has to
 * avoid — while still passing any test that only checks the approved path.
 *
 * `answerText` must be the value that will actually be PERSISTED and forwarded
 * (`comment || reason` on the API route), for the same reason
 * {@link answerlessApproveDemand} says so: a re-derivation at the call site is how a
 * predicate goes vacuous without a test noticing. The receiver trims, so this trims.
 */
export function plannedCardMove(input: {
  decision: string;
  action: unknown;
  answerText?: string | null | undefined;
  /** The card's type (approval `metadata.card_type`). Read only by COVERAGE. */
  cardType?: unknown;
  /**
   * COVERAGE only: how many criteria the STORED `coverage_decision` rejects. `null`/absent =
   * no usable decision, which the receiver refuses (held). Pass the value fr PERSISTED.
   */
  coverageRejectedCount?: number | null;
}): CardMovePlan {
  const action = asDeblockAction(input.action);
  if (!action) return { route: 'legacy', moves: null, target: null, held: null };

  const hold = (held: CardHoldReason): CardMovePlan => ({
    route: 'proposition',
    moves: false,
    target: null,
    held,
    ...(HOLD_RELEASE_CONDITION[action] ? { holdReleaseCondition: HOLD_RELEASE_CONDITION[action] } : {}),
  });

  // (1) A LAPSE (expired / voided) IS ROUTED SEPARATELY FROM A REJECTION, AND IT IS NOT
  //     ALWAYS A HOLD. ⚠️ CORRECTED 2026-09-14 — this block used to say the receiver's first
  //     test is `decision !== 'approved'` and that rejection and lapse route "identically,
  //     and must stay identical". Both halves were false. The receiver's `Resolve Target
  //     List` tests `isNonVerdict` (`expired`/`voided`) in its OWN block ABOVE `if (action)`:
  //
  //       lapseHolds -> hold                     (QUESTION, INFRASTRUCTURE, DEPENDENCY, MERGE,
  //                                               RECLASSIFY)
  //       otherwise  -> TODO, NEVER ACTION_TARGET (RETRY, SPLIT, DROP — a re-queue that
  //                                               RE-RAISES the ask; DROP->DONE or SPLIT->READY
  //                                               would execute a proposition nobody sanctioned)
  //
  //     and only a REJECTION (or any other non-approved value) reaches the proposition arm's
  //     `decision !== 'approved'` hold. So an expired RETRY re-queues to TODO while a rejected
  //     RETRY holds — the old single branch reported `held` for both, and disagreed with
  //     fr's own `lapseHolds('RETRY') === false`.
  if (input.decision === 'expired' || input.decision === 'voided') {
    return lapseHolds(action)
      ? hold('lapsed_proposition')
      : { route: 'proposition', moves: true, target: 'TODO', held: null };
  }
  // (1b) COVERAGE IS ROUTED ABOVE THE REJECTED ARM, mirroring the receiver (`if (action ===
  //      'COVERAGE')` precedes `ctx.decision !== 'approved'`): a REJECTED coverage is a GAP, and
  //      a gap is a re-split through TODO, not a hold. See {@link coverageTarget}.
  if (action === 'COVERAGE' && (input.decision === 'approved' || input.decision === 'rejected')) {
    const target = coverageTarget({
      rejectedCount: input.coverageRejectedCount,
      cardType: input.cardType,
    });
    return target
      ? { route: 'proposition', moves: true, target, held: null }
      : hold('coverage_decision_missing');
  }
  if (input.decision !== 'approved') {
    return hold(input.decision === 'rejected' ? 'rejected_proposition' : 'lapsed_proposition');
  }

  // (2) An answered QUESTION re-drives through TODO exactly as RETRY does. Tested ABOVE
  //     the table because the release is conditional on text, not on the action.
  if (action === 'QUESTION') {
    return (input.answerText ?? '').trim().length > 0
      ? { route: 'proposition', moves: true, target: 'TODO', held: null }
      : hold('answer_missing');
  }

  // (3) A side effect that can REFUSE. No move now, whatever the table says.
  if (action === 'MERGE') return hold('merge_pending');

  const target = APPROVED_ACTION_TARGET[action];
  if (target) return { route: 'proposition', moves: true, target, held: null };

  // The slot a hold-only action lands in (no action reaches it today; COVERAGE is routed
  // in (1b) above). Kept so a future null-target action is a labelled hold, not a crash.
  return hold('hold_by_design');
}

/**
 * Where an approved or rejected COVERAGE sends the card — THE SINGLE TRUTH that ncn's receiver
 * mirrors (contract fixture: domain/engagement/spec/deblock-target-contract.json).
 *
 *   no usable decision         -> null (held: the receiver refuses a missing coverage_decision)
 *   any criterion rejected     -> TODO  (a gap -> re-split with split_request; unchanged)
 *   nothing rejected, PROOF    -> QA    ⭐ the COMPUTED RECHECK (design row #3, 2026-10-05). A
 *       human sign-off over criteria that never ran is attestation, not computation, so for
 *       the proof subset an approved coverage NEVER reaches DONE: it re-queues the computed QA
 *       (QA, not TODO — the work is not redone, only re-evaluated; QA Evaluate is where
 *       AA_CQ_GUARD and the bug-gate recheck run). Until the proof bug-gate grid is armed,
 *       bug_analysis/security_analysis come back BLOCKED `no_computed_check:` — the honest
 *       consequence of the ruling.
 *   nothing rejected, other    -> DONE  (unchanged for non-proof types this unit)
 */
export function coverageTarget(input: {
  rejectedCount: number | null | undefined;
  cardType: unknown;
}): DeblockTargetList | null {
  const n = input.rejectedCount;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0) return null;
  if (n > 0) return 'TODO';
  return isProofSubsetCardType(input.cardType) ? 'QA' : 'DONE';
}

// ─────────────────────────────────────────────────────────────────────────────────────
// RECLASSIFY carries a payload: the decider-chosen `new_card_type`.
//
// It travels decision body -> `approvals.metadata.new_card_type` -> `buildCallbackPayload`
// -> the n8n receiver, which writes it to the card and moves BLOCKED -> TODO. Both ends of
// that path are CLOSED field lists, so a RECLASSIFY that reached n8n without a type would
// move the card under its OLD type: a re-drive of the pattern the decider just said is wrong.
// So it is refused here, before anything is written, rather than discovered on the board.
// ─────────────────────────────────────────────────────────────────────────────────────

export type ReclassifyRefusal =
  /** Approved RECLASSIFY with no (or blank) `new_card_type`. */
  | 'new_card_type_required'
  /** `new_card_type` is not on the card-type roster. */
  | 'new_card_type_unknown'
  /**
   * `new_card_type` is on the roster but ncn REFUSES it as a RECLASSIFY target (fr#1441):
   * its QA can never pass for a re-typed card, so ncn would keep the card BLOCKED with
   * `reclassify_target_refused:<type>`. Refused here so the decider is told up front.
   */
  | 'new_card_type_qa_dead_end'
  /** `new_card_type` equals the card's current type — reclassifying to itself is a RETRY. */
  | 'new_card_type_unchanged'
  /** `new_card_type` supplied on a decision that is not an approved RECLASSIFY. */
  | 'new_card_type_not_applicable';

/**
 * Validate the `new_card_type` a decision carries against the effective action.
 *
 * Pure: the roster check is injected (`isKnownCardType`) so the domain module does not import
 * the vendored roster; the API route passes `ALL_CARD_TYPES`. The QA-dead-end check is
 * injected the same way (`isRefusedTarget`); the route passes ncn's vendored
 * `RECLASSIFY_TARGET_REFUSED`. ncn's own refusal stays authoritative — this only tells the
 * decider at decision time instead of leaving the card BLOCKED downstream.
 *
 * Order: required → unknown → qa_dead_end → unchanged. An unknown type is reported as
 * unknown even if it were also on the refused list. `currentCardType` is the
 * approval's stored `metadata.card_type`; when it is absent the "unchanged" check is skipped
 * (there is nothing to compare against), never treated as a match.
 *
 * ⚠️ Required only on APPROVE. A rejected RECLASSIFY changes nothing and must stay decidable
 * without a type — a rule that demanded one on reject would leave no honest exit.
 */
export function classifyReclassifyDecision(input: {
  decision: string;
  effectiveAction: unknown;
  newCardType: string | null | undefined;
  currentCardType: unknown;
  isKnownCardType: (cardType: string) => boolean;
  isRefusedTarget: (cardType: string) => boolean;
}): ReclassifyRefusal | null {
  const supplied = typeof input.newCardType === 'string' ? input.newCardType.trim() : '';
  const isApprovedReclassify =
    input.decision === 'approved' && asDeblockAction(input.effectiveAction) === 'RECLASSIFY';
  if (!isApprovedReclassify) {
    // A type on any other decision would be stored and echoed to n8n with no action to use it.
    return input.newCardType === undefined || input.newCardType === null
      ? null
      : 'new_card_type_not_applicable';
  }
  if (supplied.length === 0) return 'new_card_type_required';
  if (!input.isKnownCardType(supplied)) return 'new_card_type_unknown';
  if (input.isRefusedTarget(supplied)) return 'new_card_type_qa_dead_end';
  if (typeof input.currentCardType === 'string' && input.currentCardType === supplied) {
    return 'new_card_type_unchanged';
  }
  return null;
}

/** The decider-facing sentence for each refusal. Exhaustive: a new refusal is a tsc error. */
export function reclassifyRefusalMessage(
  refusal: ReclassifyRefusal,
  ctx: { newCardType?: string | null; currentCardType?: unknown },
): string {
  switch (refusal) {
    case 'new_card_type_required':
      return (
        'RECLASSIFY requires new_card_type: the card is moved to TODO under the type you ' +
        'choose, and without one it would re-run under the type you just said is wrong'
      );
    case 'new_card_type_unknown':
      return (
        `new_card_type "${String(ctx.newCardType ?? '')}" is not a known card type ` +
        '(see GET /api/card-types for the roster)'
      );
    case 'new_card_type_qa_dead_end':
      return (
        `new_card_type "${String(ctx.newCardType ?? '')}" cannot be a RECLASSIFY target: its ` +
        'QA can never pass for a re-typed card, so n8n would refuse it and keep the card ' +
        'BLOCKED. Choose a different card type'
      );
    case 'new_card_type_unchanged':
      return (
        `new_card_type "${String(ctx.newCardType ?? '')}" is the card's current type ` +
        `(${String(ctx.currentCardType)}); reclassifying a card to its own type is a RETRY`
      );
    case 'new_card_type_not_applicable':
      return (
        'new_card_type may only be supplied when approving with deblock_action=RECLASSIFY'
      );
  }
}

/**
 * The actions whose REJECTION the receiver HOLDS in BLOCKED — `DEBLOCK_ACTIONS` minus
 * COVERAGE. A COVERAGE reject is NOT a hold: n8n routes it to TODO with a split_request for
 * the gaps, so a failed first send must be retried like any other move. Every other
 * rejected proposition stays excluded by the redelivery worker's `notARejectedHold`.
 */
export const REJECTED_HOLD_ACTIONS: readonly string[] = DEBLOCK_ACTIONS.filter(
  (action) => action !== 'COVERAGE',
);

/** The error code a chat seat returns when it refuses an approved RECLASSIFY. */
/**
 * True when the n8n receiver answered an approved RECLASSIFY by REFUSING its
 * new_card_type (unknown to ncn's catalogue) and holding the card. Lives here so
 * the redelivery worker never spells the action set out again. The marker text is
 * a cross-repo contract pinned by ncn's test-approval-callback-reclassify.mjs.
 */
export function isReceiverRefusedReclassify(action: unknown, diagnostic: string): boolean {
  return action === 'RECLASSIFY' && /RECLASSIFY REFUSED/i.test(diagnostic);
}

// ─────────────────────────────────────────────────────────────────────────────────────
// COVERAGE carries a per-criterion verdict (George BDD ruling 2026-10-01).
//
// The criteria come from the row's `metadata.coverage_request.criteria[].criterion_id`, stored
// by the minter. The decision body may name `rejected_criterion_ids`; fr resolves the full
// split and stores it as `metadata.coverage_decision` in the same UPDATE that completes the
// approval. Invariant: covered ∪ rejected = all criteria, and the two are disjoint.
// ─────────────────────────────────────────────────────────────────────────────────────

export type CoverageRefusal =
  /** The row is COVERAGE but carries no usable `coverage_request.criteria` — nothing to sign. */
  | 'coverage_request_missing'
  /** A `rejected_criterion_ids` entry is not one of the row's criteria. */
  | 'rejected_criterion_unknown'
  /** The same criterion id was named twice. */
  | 'rejected_criterion_duplicate'
  /** `rejected_criterion_ids` sent on a row that is not COVERAGE. */
  | 'rejected_criterion_ids_not_applicable'
  /** A decider override would turn a COVERAGE row into another action, or another into COVERAGE. */
  | 'coverage_override_refused';

export interface CoverageDecision {
  decision: 'approve' | 'reject';
  rejected_criterion_ids: string[];
  covered_criterion_ids: string[];
  criteria_total: number;
  /**
   * AA-TRACE §3 decided trace id, stored HERE — in `metadata.coverage_decision.decided_trace_id`
   * on the approval row — not in an `approvals.decided_trace_id` column (there is none): the
   * deciding request's `X-AA-Trace-Id`, or the UUIDv7 fr minted for it (`traceIdOrMint`). Set
   * by the decide route on the stored verdict only — the pure resolver never sets it.
   */
  decided_trace_id?: string;
}

/**
 * The criterion ids of a row's `metadata.coverage_request`, de-duplicated in order, or `null`
 * when there is no usable request (absent, not an object, no criteria, or no string ids).
 */
export function coverageCriterionIds(metadata: unknown): string[] | null {
  const md = (metadata ?? {}) as Record<string, unknown>;
  const req = md.coverage_request;
  if (!req || typeof req !== 'object' || Array.isArray(req)) return null;
  const criteria = (req as Record<string, unknown>).criteria;
  if (!Array.isArray(criteria)) return null;
  const ids: string[] = [];
  for (const c of criteria) {
    const id = c && typeof c === 'object' ? (c as Record<string, unknown>).criterion_id : undefined;
    if (typeof id === 'string' && id.trim().length > 0 && !ids.includes(id)) ids.push(id);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Resolve a coverage verdict over the full criterion set. Pure; the caller has already
 * validated `rejected` ⊆ `criterionIds` with no duplicates ({@link classifyCoverageDecision}).
 *
 *   approve, none named  → rejected = [],    covered = all
 *   approve, some named  → rejected = named, covered = rest   (a partial approve)
 *   reject,  none named  → rejected = all,   covered = []
 *   reject,  some named  → rejected = named, covered = rest
 */
export function resolveCoverageDecision(input: {
  decision: 'approve' | 'reject';
  criterionIds: readonly string[];
  rejected: readonly string[] | undefined;
}): CoverageDecision {
  const named = input.rejected ?? [];
  const rejectedSet = new Set(
    named.length === 0 ? (input.decision === 'reject' ? input.criterionIds : []) : named,
  );
  return {
    decision: input.decision,
    rejected_criterion_ids: input.criterionIds.filter((id) => rejectedSet.has(id)),
    covered_criterion_ids: input.criterionIds.filter((id) => !rejectedSet.has(id)),
    criteria_total: input.criterionIds.length,
  };
}

/**
 * Validate a decision on a possibly-COVERAGE row and resolve its verdict.
 *
 * Returns `null` when the row is not COVERAGE and nothing coverage-shaped was sent (the
 * common case); a refusal (400, written before anything is persisted); or the resolved
 * {@link CoverageDecision} to store. Keyed on the STORED action — the criteria live on the
 * stored row — and an override into or out of COVERAGE is refused, so the stored and the
 * effective action always agree on a COVERAGE row.
 */
export function classifyCoverageDecision(input: {
  decision: string;
  storedAction: unknown;
  overrideAction: unknown;
  metadata: unknown;
  rejectedCriterionIds: readonly string[] | undefined;
}):
  | null
  | { refusal: CoverageRefusal; detail?: string }
  | { coverage: CoverageDecision } {
  const stored = asDeblockAction(input.storedAction) === 'COVERAGE';
  const override = asDeblockAction(input.overrideAction);
  if (override !== undefined && (override === 'COVERAGE') !== stored) {
    return { refusal: 'coverage_override_refused' };
  }
  if (!stored) {
    return input.rejectedCriterionIds === undefined
      ? null
      : { refusal: 'rejected_criterion_ids_not_applicable' };
  }
  if (input.decision !== 'approved' && input.decision !== 'rejected') return null;
  const criterionIds = coverageCriterionIds(input.metadata);
  if (criterionIds === null) return { refusal: 'coverage_request_missing' };
  const named = input.rejectedCriterionIds ?? [];
  const seen = new Set<string>();
  for (const id of named) {
    if (seen.has(id)) return { refusal: 'rejected_criterion_duplicate', detail: id };
    seen.add(id);
  }
  const unknown = named.filter((id) => !criterionIds.includes(id));
  if (unknown.length > 0) {
    return { refusal: 'rejected_criterion_unknown', detail: unknown.join(', ') };
  }
  return {
    coverage: resolveCoverageDecision({
      decision: input.decision === 'approved' ? 'approve' : 'reject',
      criterionIds,
      rejected: named,
    }),
  };
}

/** The decider-facing sentence for each coverage refusal. Exhaustive over the union. */
export function coverageRefusalMessage(refusal: CoverageRefusal, detail?: string): string {
  switch (refusal) {
    case 'coverage_request_missing':
      return (
        'this COVERAGE approval carries no coverage_request.criteria, so there is nothing to ' +
        'sign off; it cannot be approved or rejected — have it re-minted with its criteria'
      );
    case 'rejected_criterion_unknown':
      return `rejected_criterion_ids names criteria this approval does not list: ${detail ?? ''}`;
    case 'rejected_criterion_duplicate':
      return `rejected_criterion_ids names the same criterion twice: ${detail ?? ''}`;
    case 'rejected_criterion_ids_not_applicable':
      return 'rejected_criterion_ids may only be sent on a COVERAGE approval';
    case 'coverage_override_refused':
      return (
        'a COVERAGE approval cannot be overridden to another deblock_action, and no other ' +
        'approval can be overridden to COVERAGE (its criteria are minted, not chosen)'
      );
  }
}

/**
 * Metadata keys whose ONLY writer is the decide path (`PUT /api/approvals/:id` ->
 * `buildDecisionMetadata`): the RECLASSIFY target and the per-criterion COVERAGE verdict.
 * A minter supplying either would pre-load a verdict nobody gave, which
 * `buildCallbackPayload` would then forward as if decided — so every mint strips them
 * ({@link stripDecideOwnedMetadata}, applied inside `mintOneOpenGate`).
 */
export const DECIDE_OWNED_METADATA_KEYS = ['coverage_decision', 'new_card_type'] as const;

/** Return `metadata` without the decide-owned keys; non-objects pass through unchanged. */
export function stripDecideOwnedMetadata<T>(metadata: T): T {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return metadata;
  const md = metadata as Record<string, unknown>;
  if (!DECIDE_OWNED_METADATA_KEYS.some((k) => k in md)) return metadata;
  const out: Record<string, unknown> = { ...md };
  for (const k of DECIDE_OWNED_METADATA_KEYS) delete out[k];
  return out as T;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// WEB-ONLY APPROVALS — ONE predicate, ONE kind list, called by every chat seat (Telegram,
// Teams) before any decision insert, and by the Telegram footer to drop the menu.
//
// ⛔ THE GAP THIS CLOSES. The chat seats refused by deblock_action (RECLASSIFY, COVERAGE) but
// never looked at `approvals.kind` or the bug-fix authorization marker, so a feature-design
// approval, a coverage sign-off or the live bug-fix gate could be approved or rejected by a
// bare chat reply. This is the ONLY definition: the Telegram adapter and webhook import it
// (a second list there is what reded CI after fr#1342 — a single-definition guard test now
// greps for it).
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * True when the row carries the bug-fix authorization marker: `metadata.approval_kind ===
 * 'bug_fix_authorization'`, on ANY `kind`. The ONLY definition of the marker.
 *
 * Coordinator ruling (movies-13, 2026-10-01): ONLY an APPROVED, marked
 * `execution.ready_signoff` row authorises bug fixes, one per bug; every generic deblock
 * action (RETRY included) authorises nothing, and generic DROP means rejected-all. This
 * predicate grants nothing. A marked row is web-only for reject / partial (rejected_bug_ids) /
 * question on every chat seat; USER RULING 2026-10-02: the Telegram seat alone may APPROVE-ALL
 * it via {@link chatSeatMayApproveAll} when the row is an `execution.ready_signoff` (a marked generic
 * row stays web-only for every decision; Teams still refuses every decision).
 */
export function isBugFixAuthorizationRow(row: { metadata?: unknown }): boolean {
  const md = row.metadata;
  if (!md || typeof md !== 'object' || Array.isArray(md)) return false;
  return (md as Record<string, unknown>).approval_kind === 'bug_fix_authorization';
}

/** Stored deblock actions whose decision a chat seat cannot carry (type / per-criterion ids). */
export const WEB_ONLY_DEBLOCK_ACTIONS: ReadonlySet<DeblockAction> = new Set<DeblockAction>([
  'RECLASSIFY',
  'COVERAGE',
]);

/**
 * USER RULING 2026-10-02: Telegram may APPROVE-ALL two web-only rows — a bug-fix authorization
 * (the {@link isBugFixAuthorizationRow} marker on an `execution.ready_signoff` row ONLY: approving
 * means fix ALL cited bugs, no rejected_bug_ids) and an `execution.feature_design_approval` (approve the whole design) — via
 * this predicate plus `buildChatApproveAllG12Body` (services/approvals/u3-gates.ts), which
 * builds the same structured G-12 body the web sends. Reject / partial / question stay web-only.
 *
 * ⛔ A marked `generic` row is NOT eligible. Coordinator ruling (a), 2026-10-01: only an APPROVED,
 * marked ready_signoff authorises fixes; approving a marked generic deblock row authorises NOTHING
 * (`BUG_FIX_PROCEED_DEBLOCK_ACTIONS` is empty), so the gate reads it as reject-all and demands a
 * reject code a chat reply cannot carry. Offering "1 - Approve" there would promise a fix the
 * gate then refuses. Those rows stay web-only.
 *
 * Never true for a row that needs fields a bare `1` cannot carry for ANOTHER reason: a stored deblock_action in
 * {@link WEB_ONLY_DEBLOCK_ACTIONS} (RECLASSIFY needs a new_card_type, COVERAGE is
 * per-criterion — even on a marked row), or kind `qa.coverage_signoff`. Reads the stored
 * deblock_action from `metadata.deblock_action`; a
 * top-level `deblock_action` on the row, if the caller passes one, is checked too (fail closed).
 */
export function chatSeatMayApproveAll(row: { kind?: unknown; metadata?: unknown; deblock_action?: unknown }): boolean {
  const eligible =
    (isBugFixAuthorizationRow(row) && row.kind === 'execution.ready_signoff') ||
    row.kind === 'execution.feature_design_approval';
  if (!eligible) return false;
  // ⛔ A row whose bare approve OWES AN ANSWER (stored QUESTION / INFRASTRUCTURE action,
  // stated open_questions …) is not approve-all: the web refuses that same empty approve
  // (APPROVAL_ANSWER_REQUIRED) and n8n would receive an approved QUESTION with no answer —
  // a permanent answer_missing retirement (seventh fresh validator, r5). Same predicate the
  // web uses, so the two seats cannot drift.
  if (answerlessApproveDemand({ decision: 'approved', comment: '', metadata: row.metadata }) !== null) return false;
  // qa.coverage_signoff needs no line of its own: eligibility above is an ALLOWLIST of
  // ready_signoff + feature_design, so a coverage row (marked or not) never reaches here.
  const md = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {}) as Record<string, unknown>;
  for (const raw of [md.deblock_action, row.deblock_action]) {
    const action = asDeblockAction(raw);
    if (action !== undefined && WEB_ONLY_DEBLOCK_ACTIONS.has(action)) return false;
    // A string that does not parse as a known action is NOT treated as benign.
    if (raw !== undefined && raw !== null && action === undefined) return false;
  }
  return true;
}

/**
 * What a Telegram approve-ALL shows the human before they reply `1` (ruling 2026-10-02):
 * the cited bug ids of a bug-fix authorization, or the titled scenarios of a feature
 * design. null when the row is not approve-all-from-chat ({@link chatSeatMayApproveAll}) OR
 * when there is nothing to show (empty `bug_ids`, no titled `metadata.scenarios`).
 *
 * ⛔ THE ONE RULE FOR BOTH SIDES (round 7). The adapter's footer offers "Reply 1 to approve
 * ALL" only when this is non-null and otherwise renders the link-only "decide it in fr"; the
 * webhook records an approve-all only when this is non-null. Before, the webhook asked
 * {@link chatSeatMayApproveAll} alone, so a design with no scenarios (or a ready_signoff with
 * empty bug_ids) got a link-only footer yet `1` still recorded an approve-all on the
 * design_hash alone — approving an "all" the human was never shown.
 */
export type ChatApproveAllContent =
  | { kind: 'bugs'; bugIds: string[] }
  | { kind: 'scenarios'; scenarios: Array<{ title: string; criterion_id: string | null }> };

export function chatApproveAllContent(row: {
  kind?: unknown;
  metadata?: unknown;
  deblock_action?: unknown;
}): ChatApproveAllContent | null {
  if (!chatSeatMayApproveAll(row)) return null;
  const md = (row.metadata && typeof row.metadata === 'object' && !Array.isArray(row.metadata)
    ? row.metadata
    : {}) as Record<string, unknown>;
  if (isBugFixAuthorizationRow(row)) {
    const bugIds = Array.isArray(md.bug_ids) ? md.bug_ids.filter((x): x is string => typeof x === 'string') : [];
    return bugIds.length > 0 ? { kind: 'bugs', bugIds } : null;
  }
  const scenarios = (Array.isArray(md.scenarios) ? md.scenarios : [])
    .filter((sc): sc is Record<string, unknown> => Boolean(sc) && typeof sc === 'object' && !Array.isArray(sc))
    .filter((sc) => typeof sc.title === 'string' && sc.title.trim() !== '')
    .map((sc) => ({
      title: (sc.title as string).trim(),
      criterion_id: typeof sc.criterion_id === 'string' && sc.criterion_id ? sc.criterion_id : null,
    }));
  return scenarios.length > 0 ? { kind: 'scenarios', scenarios } : null;
}

// ─────────────────────────────────────────────────────────────────────────────────────
// WHICH APPROVALS MUST CARRY ONE — the guard that makes an absent key loud.
//
// ⛔ THE DEFECT. `asDeblockAction` above returns `undefined` for an absent key,
// `buildCallbackPayload` then omits the field, the n8n callback's switch matches nothing,
// and the card stays in BLOCKED. Every step is individually correct and defensive;
// together they are a silent drop — the human answered, fr recorded `approved`,
// `callback_delivered_at` was stamped, and the card did not move.
//
// ⚠️⚠️ RE-DERIVED ON THE GATED ROUTE, 2026-09-07 — AND THE FOUNDING NUMBER WAS FROM A
// DIFFERENT ROUTE. An earlier revision of this file, and the pull request that
// introduced it, justified this guard with "97 cards behind 137 such approvals, 119 with
// a callback delivered". That measurement was NOT taken on the route this guard gates.
// Measured directly on prod `fr` (worker4), bucketed by `callback_path`, every bucket
// summed against `count(*)` = 2,855 so the census is a census and not a filter that
// silently dropped rows:
//
//   callback_path                      rows   carries deblock_action
//   kanban/approval-callback          2,005   1,730 of 2,005   <-- THIS guard's route
//   execution-ready-signoff-callback    844       0 of 844     <-- where the 137 lives
//
// The `137` is the DELIVERED-callback count among the 456 approved
// `execution.ready_signoff` rows that carry no action — a rail minted by
// `routes/execution-approvals.ts`, which this guard does not touch and never sees.
// On the route it DOES gate, the number of approved approvals in all of history with no
// `deblock_action` is THREE, and none of them was ever delivered.
//
// ⭐ The guard is still correct, but it is forward-looking, not remedial: it protects the
// 243 rows on this route that carry no action from the day the producer starts naming
// real Planka lists. It closes no measured backlog. Saying otherwise cost this change a
// review cycle, and a right verdict reached on the wrong route's data still routes the
// fix to the wrong place.
//
// ⚠️ NOT EVERY CARD APPROVAL NEEDS ONE, and refusing them all would break live lanes.
// A card approval has a BLOCKED-exit that only `deblock_action` can drive UNLESS it has
// another exit:
//
//   • `advance_phase_on_approve` — a contract gate. Approving USED to advance the
//     project's macro-phase (that advance was DELETED in fr#1481; the lane is retained
//     for stored rows); the list move is not the point.
//   • an improvement `kind` — the improvement cockpit routes these
//     (`resolveCardApprovalImprovementContext`), not the deblock switch.
//   • `execution.ready_signoff` — a whole SEPARATE RAIL. See the ordering note below.
//   • no `doingListId` AND no `todoListId` — the producer named no Planka list, so there
//     is no card move to drive and `deblock_action` would have nothing to act on.
//
// ── ⛔ THE ORDER OF THESE TESTS IS LOAD-BEARING. READ BEFORE REORDERING. ─────────────
//
// This function used to test `no_list_target` BEFORE it tested whether a usable action
// was present. That ordering made the guard UNREACHABLE, and its safety was an accident
// of a data shape rather than a property of the code:
//
//   • 2,004 of the 2,005 rows on this route carry `doingListId: ""` and
//     `todoListId: ""` — PRESENT, and EMPTY. `isString` requires `length > 0`, so
//     `no_list_target` fired on all of them and the action test was never reached.
//   • Consequence: `required` was true for ZERO rows in the entire history of this
//     route. The 422 could not fire, and the `mint` counter recorded nothing at all.
//   • ⭐ And the exemption's own premise was refuted by its own population: 1,730 of
//     those rows carry a perfectly good `deblock_action`. A producer that sends
//     `QUESTION` plainly intends a card move, so "no list named, therefore no move to
//     drive" is false on 1,730 rows. The empty string is the producer failing to
//     populate a field, not the producer declining to move a card.
//   • ⚠️ "Currently zero blast radius" was therefore not a safety property. It depended
//     on a field being empty. The 243 rows on this route with no action would have begun
//     422-ing the moment the producer sent real list ids — SILENTLY, because
//     `blocked-escalate :: Call FR` runs `continueOnFail: true`.
//
// So a USABLE ACTION IS NOW POSITIVE EVIDENCE that this is a BLOCKED-exit proposition,
// and it is tested BEFORE `no_list_target`. `no_list_target` now only exempts rows that
// have no usable action — which is the only case where its premise ("there is nothing to
// act on") is actually supported by the row.
//
// ⭐ MEASURED, BOTH ORDERINGS, over all 2,855 rows (buckets summed to 2,855 each time):
//
//   bucket                     old order   new order
//   exempt_phase_advance               0           0
//   exempt_improvement_gate           34          34
//   exempt_signoff_rail                -         844
//   required_USABLE                    0       1,730
//   exempt_no_list_target          1,977         247
//   required -> 422                    0           0   <-- unchanged. No new refusals.
//
// The reorder refuses nothing that was not refused before; it makes the counter true.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why an approval does NOT need a `deblock_action`. Each is a real, live lane.
 *
 * An ARRAY, not a bare type union, for the reason this file's header gives about
 * `DEBLOCK_ACTIONS`: `lib/deblock-action-metrics.ts` now exposes one dual-exit series per
 * lane, and a set spelled twice is a set that drifts. Derive the type from the array and a
 * new lane widens both at once.
 */
export const DEBLOCK_EXEMPTIONS = [
  'phase_advance',
  'improvement_gate',
  'signoff_rail',
  'no_list_target',
] as const;

export type DeblockExemption = (typeof DEBLOCK_EXEMPTIONS)[number];

/**
 * A lane carve-out fired on a row that ALSO carries a usable action — the row asserts
 * TWO exits for ONE human decision. See the DUAL-EXIT block below for why this is
 * reported rather than resolved by precedence.
 */
export type DeblockLaneConflict = {
  /** The carve-out that fired, i.e. the exit the row claims INSTEAD of a card move. */
  exemption: DeblockExemption;
  /** The usable action the carve-out discards, and that `buildCallbackPayload` would send. */
  discarded: DeblockAction;
};

export type DeblockExit =
  /**
   * Not a BLOCKED-exit proposition — `deblock_action` is not required and not expected.
   * `conflict` is set when the row carried a usable action anyway: still not required,
   * but no longer silently so.
   */
  | {
      required: false;
      exemption: DeblockExemption;
      conflict?: DeblockLaneConflict;
      action: undefined;
      rawWasPresent: boolean;
    }
  /** A BLOCKED-exit proposition carrying an action the closed set recognises. */
  | { required: true; usable: true; action: DeblockAction; rawWasPresent: true }
  /** A BLOCKED-exit proposition whose action is absent, or present and dropped. */
  | { required: true; usable: false; action: undefined; rawWasPresent: boolean };

/**
 * The approval kind that is its own rail, exempt wholesale.
 *
 * ⛔ WHY A WHOLE-KIND CARVE-OUT AND NOT A COUNTER THAT FIRES. `execution.ready_signoff`
 * approvals are minted by `routes/execution-approvals.ts`, a route that has never written
 * `deblock_action` and is not supposed to: measured 0 of 844 rows carry one. But every one
 * of those 844 rows carries a NON-EMPTY `doingListId` and `todoListId`, so `no_list_target`
 * does not exempt them either — they land on the `required` arm and read as `absent`.
 *
 * ⭐ That is a counter that is 844/844 FALSE POSITIVE: it reports "this approval cannot
 * move its card" about a rail whose exits are driven by something else entirely, on 100%
 * of its healthy traffic. A signal that fires on healthy traffic gets silenced, and a
 * silenced signal is worse than no signal because it still looks like coverage. So the
 * rail is exempt, and `fr_deblock_actions_total{action="absent"}` keeps its meaning: a row
 * that genuinely should have carried an action and did not.
 */
const SIGNOFF_RAIL_KIND = 'execution.ready_signoff';

/**
 * Does a lane carve-out firing on THIS row mean the row asserts a SECOND exit?
 *
 * ⭐ THE NARROWING, 2026-09-14. Until now the answer was "yes, always" — a carve-out plus a
 * usable action WAS the conflict — and for two of the three lanes that is still exactly
 * right, because the carve-out's own premise NAMES the competing exit:
 *
 *   phase_advance      "approving this advances the macro-phase". The second exit is the
 *                      premise. Any row on this lane genuinely asserts two.
 *   improvement_gate   "the improvement cockpit routes these". Same shape. (Not in the
 *                      refused set for a separate, measured reason — 32 of 34 rows.)
 *
 * ⛔ `signoff_rail` IS DIFFERENT, AND CONFLATING IT WITH THE OTHER TWO WAS THE DEFECT.
 * Read {@link SIGNOFF_RAIL_KIND}'s comment: that carve-out exists so
 * `fr_deblock_actions_total{action="absent"}` is not 844/844 false positive on a rail whose
 * producer never wrote the key. It is a statement about a COUNTER, not a claim that the row
 * has another exit. The DUAL-EXIT block's own justification for refusing the lane says as
 * much without noticing: "refused because their conflict rate is MEASURED ZERO … so it is
 * pure headroom". Headroom is not a premise. The moment the producer started writing
 * `deblock_action` into signoff metadata (n8n `execution-ready-signoff-callback` now routes
 * on it), that headroom became a withhold on 100% of the new traffic — fr logging "the card
 * will NOT move" about rows whose ONLY exit is the card move.
 *
 * ⭐ SO WHAT DOES A SIGNOFF ROW'S SECOND EXIT ACTUALLY LOOK LIKE? Since fr#1481: NONE.
 * The decision path (`services/n8n-callback.ts :: deliverDecisionCallback`) used to advance
 * the project's macro phase off a signoff row's `card_type = 'decision_development'`; that
 * fallback was DELETED with U-PS-PHASEEXIT (n8n is the only phase writer, via PATCH
 * /phase; fr never auto-advances a project). So a signoff row's action is its
 * ONLY exit and always travels. A row carrying the `advance_phase_on_approve` marker is
 * classified `phase_advance` before this is reached and stays refused (retained lane).
 */
function laneAssertsCompetingExit(exemption: DeblockExemption): boolean {
  return exemption !== 'signoff_rail';
}

/**
 * Classify one card approval's exit. Pure — no db, no request — so it can be driven
 * from a unit test and from BOTH seams that need the same answer:
 *
 *   mint    (`routes/webhooks.ts`)  on the inbound payload, to refuse before writing;
 *   decide  (`routes/approvals.ts`) on the stored `metadata` jsonb, to count what the
 *           callback is about to drop on a row minted before the refusal existed.
 *
 * `action` is deliberately `unknown`: at the decide seam the source is free-form jsonb,
 * so the narrowing must happen here rather than being assumed by the caller.
 *
 * `approvalKind` is the row's `kind` column. The mint seam may leave it undefined —
 * `handleN8nCardApproval` cannot produce an `execution.ready_signoff` row, so there is
 * nothing for the rail exemption to catch there. The decide seam is generic over every
 * kind and MUST pass it.
 *
 * (fr#1481: the `cardType` input — read only to detect a signoff row whose
 * `decision_development` card type ALSO advanced the macro phase — was removed with that
 * phase advance. A signoff row's action is now its only exit.)
 */
export function classifyDeblockExit(input: {
  action: unknown;
  doingListId?: unknown;
  todoListId?: unknown;
  advancePhase?: unknown;
  improvementKind?: unknown;
  approvalKind?: unknown;
}): DeblockExit {
  const narrowed = asDeblockAction(input.action);
  const rawWasPresent = input.action !== undefined && input.action !== null && input.action !== '';
  const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;

  // (1) Whole-lane carve-outs: this approval's exit is driven by another mechanism, so
  //     the question "which list does the card go to" is not the question being asked.
  const laneExemption: DeblockExemption | undefined = isString(input.advancePhase)
    ? 'phase_advance'
    : isString(input.improvementKind)
      ? 'improvement_gate'
      : input.approvalKind === SIGNOFF_RAIL_KIND
        ? 'signoff_rail'
        : undefined;
  if (laneExemption) {
    // The carve-out still wins — see the DUAL-EXIT block below for why precedence is NOT
    // the fix here. But if the row ALSO carries a usable action AND the lane genuinely
    // asserts a second exit on this row, say so instead of returning `action: undefined`
    // as though the row had never had one. That silent discard is what let the classifier
    // and `buildCallbackPayload` reach opposite conclusions about the same row.
    //
    // ⚠️ TWO CONDITIONS, NOT ONE, AS OF 2026-09-14. `narrowed` alone was the old test; see
    // `laneAssertsCompetingExit` for why that is right on `phase_advance` and
    // `improvement_gate` and WRONG on `signoff_rail`. On a signoff row with no competing
    // phase advance there is nothing to reconcile, so there is no conflict to report — the
    // action is the row's only exit and it travels.
    const asserted = narrowed && laneAssertsCompetingExit(laneExemption);
    return {
      required: false,
      exemption: laneExemption,
      action: undefined,
      rawWasPresent,
      ...(asserted && narrowed ? { conflict: { exemption: laneExemption, discarded: narrowed } } : {}),
    };
  }

  // (2) A usable action is POSITIVE EVIDENCE of a BLOCKED-exit proposition. This must stay
  //     ABOVE `no_list_target`: 1,730 live rows carry an action alongside empty list ids,
  //     and testing the lists first exempted every one of them and left the guard inert.
  if (narrowed) return { required: true, usable: true, action: narrowed, rawWasPresent: true };

  // (3) Only now: no usable action AND no list named => there is genuinely nothing to act
  //     on. Reaching this point is what makes the exemption's premise true.
  if (!isString(input.doingListId) && !isString(input.todoListId)) {
    return { required: false, exemption: 'no_list_target', action: undefined, rawWasPresent };
  }

  return { required: true, usable: false, action: undefined, rawWasPresent };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// DUAL EXIT — one approval that asserts TWO exits. Added 2026-09-07, one seam over
// from #1008 and the same defect class.
//
// ⛔ THE DEFECT. An approval could carry BOTH `advance_phase_on_approve` and a usable
// `deblock_action`, and nothing reconciled them. Three code paths read that one row and
// reached three different answers:
//
//   classifyDeblockExit      lane carve-out fires FIRST -> `exemption: 'phase_advance',
//                            required: false, action: undefined`. The action is DISCARDED,
//                            and the `decide` counter (gated on `deblockExit.required`)
//                            records nothing at all.
//   buildCallbackPayload     never consulted the classifier. Called `asDeblockAction`
//                            directly and put the action on the outbound payload ANYWAY,
//                            so n8n moved the card.
//   the approval-completion phase advance (deleted, fr#1481) advanced the project's
//                            macro-phase off the same metadata —
//                            on EITHER `advance_phase_on_approve` OR
//                            `card_type='decision_development'`. ⚠️ Only the first is
//                            reconciled below; see "INCOMPLETE BY CHOICE" at the guard.
//
// ⚠️ HISTORICAL (fr#1481): the third reader below (the approval-completion phase
// advance) was DELETED; the `phase_advance` lane and its dual-exit refusal are RETAINED
// for stored rows carrying the marker (refusing stays the conservative direction).
//
// ⭐ So ONE human decision produced TWO effects — an internal phase advance AND a card
// move — with nothing anywhere reconciling them, and a classifier that reported the
// action did not exist while the payload was sending it.
//
// ── ⛔ WHY PRECEDENCE IS NOT THE FIX, i.e. why this differs from #1008 ────────────────
//
// #1008 fixed the sibling ordering by making a usable action test FIRST, above
// `no_list_target`. The obvious move here is to copy that answer. It is the wrong one,
// and the difference is worth stating precisely:
//
//   • `no_list_target`'s premise is "the producer named no list, so there is nothing to
//     act on". A usable action REFUTES that premise — 1,730 rows proved it false. The two
//     were never in conflict; one of them was simply untrue, so ordering settled it.
//   • `phase_advance`'s premise is "approving this advances the macro-phase". A usable
//     `deblock_action` does NOT refute that. Both statements are true at once: the
//     producer really did ask for a phase advance and really did name a card action.
//
// Nothing here is false, so there is nothing for an ordering to discover. Any precedence
// rule — action-first or lane-first — SILENTLY PICKS A WINNER for a question the producer
// never answered, and the losing half is discarded with no record. That is the same
// silent-drop shape this entire file exists to close, just chosen deliberately instead of
// by accident. So the conflict is REPORTED and REFUSED, not resolved.
//
// ── ⭐ IS THERE A DUAL-EXIT ROW IN PRODUCTION? MEASURED, WITH A CONTROL ───────────────
//
// Measured on prod `fr` (worker4), 2026-09-07, SELECT-only. The control matters more than
// the answer: a zero from an empty table or a mis-named column is not a finding.
//
//   approvals total                                          2,856   <-- not empty
//   min/max created_at              2026-05-01 .. 2026-09-07          <-- not truncated
//   rows carrying `deblock_action`                           1,763   <-- key is live
//   rows carrying `advance_phase_on_approve`                     0
//   rows carrying BOTH                                           0   <-- the answer
//
// The zero is driven entirely by the phase marker: an ILIKE sweep for '%advance%' and
// '%phase%' over every key in every row returns NOTHING, so `advance_phase_on_approve`
// has never been written by any producer, under any spelling or nesting.
//
// ⭐ SO THIS GUARD IS FORWARD-LOOKING, NOT REMEDIAL — exactly as #1008's turned out to be.
// It closes no measured backlog. The (since deleted, fr#1481) approval-completion phase
// advance called this marker "the precise keystone marker a FUTURE n8n workflow may set",
// and the guard exists for the day that workflow ships.
//
// ⚠️ AND A ZERO THAT HOLDS ONLY BECAUSE NOBODY CURRENTLY DOES X IS NOT SAFETY. It is zero
// because one producer has not been written yet, not because the shape is impossible —
// `routes/webhooks.ts` accepts `advance_phase_on_approve` and `deblock_action` in the SAME
// zod schema and spread BOTH into the same jsonb. The row was always constructible; only
// the producer was missing. The identical framing is already in `routes/approvals.ts` for
// `decided_action_source`, and it is why that guard shipped before its traffic did.
//
// ── ⛔ WHICH LANES THIS REFUSES, AND WHY THE SET IS NOT ALL OF THEM ───────────────────
//
// Symmetry is not evidence. Measured conflict rate per carve-out, same census:
//
//   lane               kind                        rows   ALSO carry a usable action
//   phase_advance      (any)                          0   0        <-- refused
//   signoff_rail       execution.ready_signoff      844   0/844    <-- refused
//   improvement_gate   improvement.design            34   32/34    <-- ⛔ NOT refused
//   no_list_target     (any)                          -   0 by construction
//
// `phase_advance` and `signoff_rail` are refused because their conflict rate is MEASURED
// ZERO: the refusal cannot reject a row that exists today, so it is pure headroom.
//
// ⛔ `improvement_gate` IS DELIBERATELY EXCLUDED, and this is the load-bearing decision in
// this change. 32 of its 34 rows carry a usable action. Refusing that pair would 422 the
// normal shape of a live lane — and INVISIBLY, because `blocked-escalate :: Call FR` runs
// `continueOnFail: true`. Withholding the action from the callback would instead stop 32
// rows' cards from moving. Both are a bigger, unmeasured behaviour change than the defect
// being fixed.
//
// ⚠️ THAT 32/34 IS ITSELF AN OPEN FINDING, RECORDED HERE RATHER THAN ACTED ON. The
// improvement exemption's stated premise is "the improvement cockpit routes these, not the
// deblock switch" — and 94% of its own population carries a deblock action that
// `buildCallbackPayload` sends to that switch. That is the same premise-refuted-by-its-own-
// population shape #1008 found in `no_list_target` (1,730 rows). It is NOT fixed here
// because the fix requires measuring what `resolveCardApprovalImprovementContext` and the
// kanban callback each actually do with those 32 rows, which this change did not do.
// The counter below makes it a standing number instead of a note in a pull request.
//
// `no_list_target` cannot conflict at all: step (3) is reached only after step (2) has
// established there is no usable action. Its absence from the set is structural, not a
// judgement call.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The carve-outs whose collision with a usable action is refused at the mint and withheld
 * at the callback. Membership is decided by the MEASURED conflict rate above, not by
 * symmetry with the other lanes — see the `improvement_gate` paragraph.
 */
/*
 * ⚠️ CORRECTED 2026-09-14 — `signoff_rail`'s MEMBERSHIP IS UNCHANGED, BUT WHAT REACHES IT
 * IS NARROWER, AND THE BLOCK ABOVE ARGUED FOR THE OLD BEHAVIOUR. Read this before quoting
 * "phase_advance and signoff_rail are refused because their conflict rate is MEASURED ZERO
 * … pure headroom".
 *
 * That sentence is the whole justification for the lane being here, and it is an argument
 * from COST, not from premise: refusing cost nothing while 0 of 844 rows carried an action.
 * n8n's `execution-ready-signoff-callback` now routes on `deblock_action` + a non-empty
 * answer, and `routes/execution-approvals.ts`'s `metadata` is `.passthrough()`, so the
 * producer writes the key and the rate is no longer zero. An argument from cost expires the
 * moment the cost arrives — and the expiry is silent, because the refusal keeps firing and
 * logging "The card will NOT move" about rows whose only exit IS the card move.
 *
 * ⭐ THE FIX IS UPSTREAM OF THIS SET, DELIBERATELY. Removing `signoff_rail` from it would
 * ALSO un-refuse a signoff row that carried `card_type='decision_development'` — a row that
 * then really did exit twice (fr#1481 deleted that phase advance; it no longer does) — so
 * the set keeps both members and `laneAssertsCompetingExit` decides which signoff rows ever
 * produce a conflict to refuse (since fr#1481: none).
 * The refusal that survives is the one with a true premise; the one that survived only on
 * its price is gone.
 */
const DUAL_EXIT_REFUSED_LANES: ReadonlySet<DeblockExemption> = new Set([
  'phase_advance',
  'signoff_rail',
]);

/**
 * ⭐ THE ONE ANSWER ALL THREE SEAMS ASK FOR. Two code paths reading the same row and
 * reaching different conclusions IS the defect, so the mint (`routes/webhooks.ts`), the
 * decide seam (`routes/approvals.ts`) and the outbound payload
 * (`services/n8n-callback.ts :: buildCallbackPayload`) all call THIS — they cannot drift
 * apart without changing this function, which is the property that was missing.
 *
 * Returns the conflict when the row must not be acted on as a BLOCKED-exit proposition
 * despite carrying a usable action; `undefined` when there is nothing to reconcile.
 */
/**
 * ⚠️ HISTORICAL (fr#1481): the approval-completion phase advance described below was
 * DELETED with U-PS-PHASEEXIT, so the `decision_development` hole it documents no longer
 * exists — no approval advances a phase from its metadata any more.
 *
 * ⛔ INCOMPLETE BY CHOICE — ⚠️ CORRECTED 2026-09-07, this file previously described
 * the approval-completion phase advance (deleted, fr#1481) as advancing on ONE signal. It advances on TWO, and this
 * predicate can only see one of them.
 *
 * `classifyDeblockExit` is passed `advancePhase` but is NEVER passed `card_type`, so a row
 * whose phase advance comes from `card_type='decision_development'` (-> `deep_analysis`,
 * the card-type phase fallback (deleted, fr#1481)) produces NO carve-out, this function returns `undefined`,
 * and the row exits BOTH ways: fr advances the phase, n8n moves the card.
 *
 * ⭐ Measured prod `fr` (worker4) 2026-09-07, SELECT-only, buckets summing to a 2,856-row
 * denominator with negative + positive controls: 249 rows carry that card_type, 3 of those
 * also carry a usable `deblock_action`, and 0 of the 3 can fire today — all 3 are
 * `status='pending'` with `project_id IS NULL`, while the advance needs `approved` + a
 * `project_id`.
 *
 * ⚠️ That zero is a CO-OCCURRENCE GAP, not a safety property — the objection this file
 * makes about its own zero applies here unchanged. Both preconditions already hold
 * separately in prod: 175 of the 249 are `approved`, and 6 carry a `project_id`. The
 * accepted risk is explicit: if one of the 3 is decided once a `project_id` resolves onto
 * it, one decision yields two effects and nothing here reports it.
 *
 * Deferred to a follow-up rather than fixed alongside: feeding `card_type` in changes what
 * this classifier RECEIVES and so what it REFUSES, over a 249-row population instead of
 * the 0-row one these refusals touch. That is its own behaviour change needing its own
 * verification.
 */
export function irreconcilableDualExit(exit: DeblockExit): DeblockLaneConflict | undefined {
  if (exit.required) return undefined;
  const conflict = exit.conflict;
  if (!conflict) return undefined;
  return DUAL_EXIT_REFUSED_LANES.has(conflict.exemption) ? conflict : undefined;
}

/** Why a decider may not supply a `deblock_action` on this row — or that they may. */
export type DeciderOverrideVerdict =
  | { allowed: true }
  /** The row asserts two exits; an override would add a third claim to a contradiction. */
  | { allowed: false; reason: 'dual_exit'; conflict: DeblockLaneConflict }
  /** Not a BLOCKED-exit proposition at all, and no action was ever proposed on it. */
  | { allowed: false; reason: 'not_a_blocked_exit' }
  /**
   * An `execution.ready_signoff` row. Its stored action travels; a decider-supplied one
   * would not be executed as named by the signoff receiver. See {@link classifyDeciderOverride}.
   */
  | { allowed: false; reason: 'signoff_rail' };

/**
 * May a decider supply/override `deblock_action` on this row?
 *
 * ⛔ PURE, AND THAT IS THE POINT — IT WAS A SOURCE ASSERTION AND THE MUTANT SURVIVED.
 * This logic lived inline in `routes/approvals.ts`, behind a database, an auth check and
 * a 300-line handler, so the only thing testing it was a grep over the file. A mutation
 * run disabling the refusal outright (`if (false && dualExit)`) left the source strings
 * exactly where the grep expected them, and all 67 tests still passed. A presence check
 * cannot fail for a behaviour change, so the guard it "covered" was unguarded.
 *
 * ⚠️ THE ORDER OF THESE TWO TESTS IS *NOT* LOAD-BEARING, AND THIS COMMENT SAID THE
 * OPPOSITE UNTIL A MUTANT REFUTED IT. An earlier revision claimed that testing the
 * recovery door first would return `allowed: true` and render the dual-exit refusal
 * unreachable — the same shape as the ordering bug in `classifyDeblockExit`. Measured: a
 * mutant that performs exactly that reorder SURVIVES, 71/71 green, and it survives because
 * it changes nothing.
 *
 * The two refusals are MUTUALLY EXCLUSIVE by construction. A conflict can only exist if
 * the classifier narrowed a usable action out of `exit`, and at this seam the value it
 * narrowed IS `storedAction` — so a conflict implies `typeof storedAction === 'string'`,
 * which is precisely the case the recovery-door test declines to refuse. Neither branch
 * can shadow the other whichever way round they sit. The recovery-door test also returns a
 * REFUSAL, never `allowed: true`, so it cannot short-circuit anything.
 *
 * ⚠️ A THIRD REFUSAL, `signoff_rail`, WAS ADDED 2026-09-14 AND ITS POSITION *IS* LOAD-BEARING —
 * for the MESSAGE, not for whether the row is refused. Hoisted above `dual_exit` it would
 * answer a genuine dual-exit signoff row with the wrong reason; hoisted above the recovery
 * door it would answer an action-less signoff row with the wrong reason. Both are pinned.
 *
 * ⛔ THE ORDER-INDEPENDENCE IS A PROPERTY OF THE CALLER, NOT OF THIS FUNCTION. It holds
 * only while the decide seam passes the same value as both `exit`'s action and
 * `storedAction`. A future caller that classified one value and passed another would break
 * the implication above and make ordering load-bearing again — so pass the same value, or
 * revisit this.
 */
export function classifyDeciderOverride(
  exit: DeblockExit,
  storedAction: unknown,
): DeciderOverrideVerdict {
  const conflict = irreconcilableDualExit(exit);
  if (conflict) return { allowed: false, reason: 'dual_exit', conflict };
  // THE RECOVERY DOOR. Deliberately permissive: a stored action OR a required exit is
  // enough. See `routes/approvals.ts` for why refusing without one was unrepairable.
  if (typeof storedAction !== 'string' && !exit.required) {
    return { allowed: false, reason: 'not_a_blocked_exit' };
  }
  // ⛔ THE SIGNOFF RAIL TAKES NO OVERRIDE — RESTORED 2026-09-14 AFTER THE NARROWING REOPENED IT.
  // Until `laneAssertsCompetingExit` narrowed the signoff lane, EVERY signoff row carrying a
  // usable action produced a conflict, so it was refused above as `dual_exit`. The narrowing
  // was right to stop WITHHOLDING the stored action on a single-exit signoff row (that action
  // is the row's only exit, and `buildCallbackPayload` now sends it). It was not meant to also
  // let a decider REPLACE that action, and it silently did: no conflict -> no `dual_exit` ->
  // a string `storedAction` -> `allowed: true`.
  //
  // Why an override there is a contract lie and not a feature: the signoff receiver
  // (`execution-ready-signoff-callback`) does not execute `deblock_action` the way
  // `approval-callback` does. It branches on QUESTION alone (`is_question` in its
  // Idempotency check) and sends every other approved row down the plain approved path to
  // DOING. So `deblock_action=INFRASTRUCTURE` supplied on a signoff row makes fr answer
  // `card_move: TODO` while the receiver moves the card to DOING.
  //
  // ⭐ THE DISCRIMINATOR IS THE LANE, NOT THE CONFLICT, and it sits BELOW the two refusals
  // above on purpose: a genuine dual-exit signoff row (contract-gate `card_type`) still gets
  // the `dual_exit` message that names both exits, and a signoff row with no stored action
  // still gets `not_a_blocked_exit`, both exactly as before. Only the population the
  // narrowing un-refused — a single-exit signoff row with a stored string — lands here.
  // `approval-callback` rows never carry `exemption: 'signoff_rail'`, so their recovery door
  // is untouched.
  if (!exit.required && exit.exemption === 'signoff_rail') {
    return { allowed: false, reason: 'signoff_rail' };
  }
  return { allowed: true };
}

/**
 * The dual-exit refusal message. Like `deblockActionRequiredMessage` it is addressed to
 * the PRODUCER, because the producer is the only thing that can resolve the ambiguity —
 * so it names both fields it found, quotes the action, and states the choice rather than
 * saying "invalid".
 */
export function deblockDualExitMessage(cardId: string, conflict: DeblockLaneConflict): string {
  return (
    `Card ${cardId} raised an approval that asserts TWO exits at once: the ` +
    `${conflict.exemption} lane AND deblock_action=${conflict.discarded}. ` +
    `One human decision cannot mean both — approving it would advance the exit this lane ` +
    `drives AND tell n8n to move the card, from a single answer, with nothing reconciling ` +
    `the two. fr does not pick a winner for you: whichever half is dropped would be dropped ` +
    `silently, which is the failure mode this guard exists to prevent. ` +
    `Send exactly one: omit deblock_action if this is a ${conflict.exemption} gate, or drop ` +
    `the lane marker if this is a BLOCKED-exit proposition that should move the card.`
  );
}

/**
 * The refusal message. A single sentence naming the closed set, because the producer
 * reading it (the `blocked-escalate` workflow's `Build Proposition` node) is the only
 * thing that can fix the omission, and a message that does not list the legal values
 * sends its author back to the source to find them.
 */
export function deblockActionRequiredMessage(cardId: string): string {
  return (
    `Card ${cardId} raised a BLOCKED-exit approval with no usable deblock_action. ` +
    `Approving it would mint a gate that moves no card: buildCallbackPayload narrows this ` +
    `field through a CLOSED allowlist, so an absent or unrecognised value is DROPPED and the ` +
    `card stays in BLOCKED after a human has answered. ` +
    `Send one of: ${DEBLOCK_ACTIONS.join(', ')}. ` +
    `If this approval is not a BLOCKED-exit proposition, send advance_phase_on_approve ` +
    `(contract gate), raise it on an improvement-stream board, or omit doingListId/todoListId.`
  );
}

/**
 * The producer's ACTUAL question text(s), read from an approval's `metadata.open_questions`.
 *
 * Defensive by construction, because `metadata` is untyped jsonb written by n8n: an array of
 * strings is read verbatim (trimmed, blanks dropped); a bare non-empty string is read as a
 * single question; everything else — absent, null, a number, an object, an array whose members
 * are not strings — yields `[]`. A non-string member is DROPPED, never `String()`-ed, so the
 * producer defect that writes `[object Object]` cannot masquerade as a question.
 *
 * ⚠️ MUST STAY BEHAVIOURALLY IDENTICAL to `openQuestionsOf` in
 * `frontend/src/lib/approvals/question.ts`. The two decide the same thing on the same row on
 * either side of the wire; if they disagree, the UI offers an answer box the server refuses,
 * or stays silent where the server demands one.
 */
export function statedOpenQuestions(metadata: unknown): string[] {
  const raw = (metadata as Record<string, unknown> | null | undefined)?.open_questions;
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

/**
 * WHY an approve of this row must carry answer text, or `null` when it need not.
 *
 * ⛔ TWO INDEPENDENT REASONS, AND THE GUARD USED TO KNOW ONLY THE FIRST.
 *
 *   `question_action` — the RECEIVER's rule. `approval-callback.json :: Resolve Target List`
 *       computes `questionAnswered = action === 'QUESTION' && decision === 'approved' &&
 *       answerText.length > 0`. Nothing in that node reads `open_questions` at all, so an
 *       empty approve takes the HOLDING branch, stamps `answer_missing` and
 *       `block_reason approval_answer_missing`, and the row is then SPENT — no second
 *       decision is accepted, so nothing can ever release the card.
 *   `stated_question` — the ROW's own content. `metadata.open_questions` is the only field
 *       that holds question TEXT, and an approve carrying none delivers no answer to a
 *       question a human was genuinely asked, while `persistedComment = comment || reason`
 *       is written and forwarded to the callback unconditionally.
 *
 * ⛔ MEASURED 2026-09-10 ON PROD, AND THE TWO SETS WERE DISJOINT. Of 1040 pending rows, 137
 * were typed QUESTION carrying ZERO `open_questions`, and the only 15 rows carrying a
 * readable question all had `deblock_action` NULL. So `question_action` alone demanded an
 * answer on exactly the rows that state nothing and demanded none on the only rows that ask
 * something — and the UI mirrors this predicate, so the box was rendered and withheld the
 * same way round.
 *
 * ⛔ `question_action` IS NOT SUBTRACTED WHEN NO QUESTION IS STATED. Those 137 rows state
 * nothing, so demanding an answer looks like the same inversion read backwards — it is not.
 * The receiver branches on the ACTION, never on `open_questions`, so an unstated QUESTION row
 * approved empty strands its card exactly as a stated one would. Dropping the demand there
 * would convert a refusal into a one-click permanent strand on the largest population this
 * guard protects. Rejection is exempt and remains the honest terminal for them.
 *
 * ⚠️ ORDER IS LOAD-BEARING, unlike `classifyDeciderOverride`'s. A row that is BOTH typed
 * QUESTION and states its question must report `question_action`: only that arm's refusal
 * message is true about the card move, and a `stated_question` message on such a row would
 * tell the decider their answer does not re-drive the card when it does.
 * ⭐ A THIRD REASON, ADDED 2026-09-14 WITH THE PHASE-4 RE-DRIVE — `fix_assertion`.
 *
 * Until this round, approving an INFRASTRUCTURE or DEPENDENCY proposition and rejecting it
 * produced BYTE-IDENTICAL outcomes: the card stayed in BLOCKED either way (see
 * {@link APPROVED_ACTION_TARGET}'s comment, 214 pending rows measured). Both now target
 * TODO on approve — "I have fixed it, try again" — which turns a harmless empty click into
 * a re-drive.
 *
 * ⛔ AND A RE-DRIVE OF A HOLD IS NOT A FREE ACTION. The objection is written into the
 * receiver itself: re-driving one of these opens a SECOND pull request for work already
 * done, which is the duplicate-PR defect the delivery gate exists to end. The product
 * owner's decision (2026-09-14) is that the re-drive ships AND the approver must state what
 * was fixed — which is the agreed mitigation, and is also the only record the next reader
 * gets of why a card left a hold.
 *
 * ⭐ IT IS THE SAME PREDICATE, NOT A PARALLEL REFUSAL, AND THAT IS THE WHOLE POINT. THREE
 * paths write `approval_decisions` and all three already call {@link answerlessApproveDemand}
 * (`routes/approvals.ts`, `telegram-webhook.ts`, `teams-webhook.ts`).
 * A second `if` on one of them is how the guard this machinery replaced came to be enforced
 * on exactly one seat. Extending the enum covers every seat, and every site that
 * words a refusal per kind is a `switch` with a `never` default, so `tsc` makes a message arm
 * mandatory rather than optional. (⚠️ This sentence was written before that was true: the
 * first cut left a two-way ternary that sent `fix_assertion` to the stated-question text.)
 *
 * ⚠️ `rejected` STAYS UNGATED HERE TOO, on every path. {@link answerlessApproveDemand}
 * returns `null` for any non-approve BEFORE this classifier is reached, so a hold can always
 * be rejected — the same exemption QUESTION already has, for the same reason: a rule with no
 * exit is a strand, not a gate. `LAPSE_HOLDS_ACTIONS` keeps expiry/void holding as well, so
 * nothing here can manufacture a re-drive nobody asked for.
 *
 * ⚠️ ORDER: `question_action` > `fix_assertion` > `stated_question`, and it is load-bearing
 * for the same reason the first entry was. The arms whose message names the CARD MOVE must
 * win, because a `stated_question` message on an INFRASTRUCTURE row would tell the decider
 * their text is merely forwarded to the asker when it is in fact the thing that re-drives
 * the card. A row that is both refuses either way; only the sentence differs.
 */
export type AnswerDemand = 'question_action' | 'fix_assertion' | 'stated_question' | null;

/**
 * The approved-path re-drive holds: approving one asserts the named fault is CLEARED.
 *
 * ⚠️ DERIVED FROM NOTHING, AND DELIBERATELY NOT `APPROVED_ACTION_TARGET[a] === 'TODO'`.
 * That expression would silently sweep in `RETRY`, whose 442 pending rows assert no fault
 * has been cleared — a RETRY is "run it again", not "I fixed it" — and halt the largest
 * decidable population in the queue. The membership test is the HOLD, not the target: these
 * two are the actions whose {@link HOLD_RELEASE_CONDITION} reads "asserting the named …
 * fault is fixed / dependency is resolved". Spell them, and let adding a third be a
 * decision somebody makes on purpose.
 */
export const FIX_ASSERTION_ACTIONS: ReadonlySet<DeblockAction> = new Set<DeblockAction>([
  'INFRASTRUCTURE',
  'DEPENDENCY',
]);

export function classifyAnswerDemand(
  effectiveAction: string | undefined,
  metadata: unknown,
): AnswerDemand {
  if (effectiveAction === 'QUESTION') return 'question_action';
  const narrowed = asDeblockAction(effectiveAction);
  if (narrowed && FIX_ASSERTION_ACTIONS.has(narrowed)) return 'fix_assertion';
  if (statedOpenQuestions(metadata).length > 0) return 'stated_question';
  return null;
}

/**
 * Does THIS decision spend an approval that owes an answer while carrying none? The
 * whole refusal condition, in one place, for every path that writes `approval_decisions`.
 *
 * ⛔ WHY IT IS A SHARED FUNCTION AND NOT A SECOND COPY OF THE `if`. THREE paths insert an
 * `approval_decisions` row — `routes/approvals.ts`, `routes/telegram-webhook.ts`,
 * `routes/teams-webhook.ts` — and until now exactly ONE of
 * them (the API PUT, #1066) enforced this. On the chat seats the unguarded shape was
 * not an edge case but the DEFAULT one: `parseDecision` answers the bare `1` / `approve`
 * / `yes` / `ok` reply with `{ decision: 'approved' }` and NO comment field at all.
 *
 * ⛔ WHAT AN UNGUARDED EMPTY APPROVE COSTS, AND WHY IT IS PERMANENT.
 * `workers/deblock-callback-redelivery.ts:1463` re-derives the receiver's own rule —
 * `action === 'QUESTION' && field('decision') === 'approved'` with no answer text is
 * `answer_missing` — and retires the row `hold_acknowledged`. `candidateWhereBase`
 * requires `callback_resolution IS NULL`, so a retired row can never be a candidate
 * again; fr accepts no second decision on a decided approval; and the card stays BLOCKED
 * with `block_reason approval_answer_missing` FOR EVER. Refusing the write is the last
 * moment at which that is still recoverable — after it, nothing in fr can undo it.
 *
 * ⭐ PASS THE VALUE THAT WILL BE PERSISTED, NOT A RE-DERIVATION OF IT. `comment` must be
 * the exact expression the caller's `approval_decisions` INSERT writes — for the API
 * route that is `validated.comment || validated.reason` (`||`, not `??`, so an explicitly
 * empty `comment` falls through to `reason`, and a guard reading `comment` alone would
 * refuse a decision whose answer text is in fact non-empty). Re-deriving it at the call
 * site is exactly how this guard goes vacuous without a test noticing. The `.trim()` is
 * not decoration either: the n8n receiver trims, so a whitespace-only comment is an EMPTY
 * answer there and must be one here too.
 *
 * `suppliedAction` is the decider's override, which only the API PUT has; on every other
 * path the stored `metadata.deblock_action` IS the effective action. Both directions
 * matter: stored QUESTION + an override to DROP/RETRY is NOT a question any more (gating
 * on the stored field would refuse the recovery door #982 deliberately reopened), and
 * stored RETRY + a supplied QUESTION IS one. `asDeblockAction` is the same narrowing
 * `buildCallbackPayload` applies, so this predicate and the payload cannot disagree about
 * what the action is.
 *
 * ⚠️ `rejected` is NEVER refused, on any path. Rejecting a question is the honest
 * terminal: the callback's reject branch moves the card and the producer learns the
 * question was unanswerable. A rule that blocked it would leave no exit at all.
 */
export function answerlessApproveDemand(input: {
  decision: string;
  comment: string | null | undefined;
  metadata: unknown;
  suppliedAction?: string | undefined;
}): AnswerDemand {
  if (input.decision !== 'approved') return null;
  if ((input.comment ?? '').trim().length > 0) return null;
  const storedAction = (input.metadata as Record<string, unknown> | null | undefined)
    ?.deblock_action;
  return classifyAnswerDemand(
    asDeblockAction(input.suppliedAction ?? storedAction),
    input.metadata,
  );
}

/** The longest proposed answer fr carries; the n8n create schema refuses longer, and so does this. */
export const PROPOSED_ANSWER_MAX_CHARS = 2000;

/**
 * The row's proposed answer (`metadata.proposed_answer`): a concrete instruction the asker
 * (n8n `sub.ask_fr`) offers so the approver can accept it instead of composing one.
 *
 * QUESTION rows ONLY: null unless the action (`suppliedAction` — the API decider's override —
 * else the stored `metadata.deblock_action`) is `QUESTION`. Every other row (INFRASTRUCTURE /
 * DEPENDENCY, which owe a statement of what was fixed; no action at all) ignores the key
 * entirely, so a stray proposal can never stand in for a fix assertion. Null too unless it
 * is a non-empty string; capped at {@link PROPOSED_ANSWER_MAX_CHARS}.
 */
export function proposedAnswer(metadata: unknown, suppliedAction?: string): string | null {
  const md = metadata as Record<string, unknown> | null | undefined;
  if (asDeblockAction(suppliedAction ?? md?.deblock_action) !== 'QUESTION') return null;
  const v = md?.proposed_answer;
  if (typeof v !== 'string') return null;
  const trimmed = v.trim().slice(0, PROPOSED_ANSWER_MAX_CHARS).trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** The one line every outbound seat shows next to a proposed answer. */
export const PROPOSED_ANSWER_NOTE =
  'A plain approve (no comment) accepts the proposed answer; a comment replaces it.';

/**
 * The comment an approve records: a BARE (empty/whitespace) approve on a row with a
 * {@link proposedAnswer} ACCEPTS that proposal — it is recorded as the decision comment
 * exactly as if the approver had typed it. A typed comment always wins; a reject is
 * returned unchanged. Every seat that writes `approval_decisions` calls this BEFORE
 * {@link answerlessApproveDemand}, so a bare approve means the same on every channel.
 *
 * ⛔ `fromFreeText`: the approve was READ from the human's own words (Telegram's laya read),
 * not typed as the bare grammar. `toChatDecision` drops those words on a row that owes an
 * answer, so the comment arrives empty — but the human did write something ("approve, but use
 * the main repo"), and filling the proposal would record the opposite of it. Such an approve
 * is never filled: the seat asks for the answer, exactly as before proposals existed.
 */
export function withProposedAnswer<C extends string | null | undefined>(input: {
  decision: string;
  comment: C;
  metadata: unknown;
  suppliedAction?: string;
  fromFreeText?: boolean;
}): C | string {
  if (input.decision !== 'approved' || input.fromFreeText) return input.comment;
  if ((input.comment ?? '').trim().length > 0) return input.comment;
  return proposedAnswer(input.metadata, input.suppliedAction) ?? input.comment;
}

/** The error code every non-API channel returns for this refusal. */
export const ANSWER_REQUIRED_CODE = 'APPROVAL_ANSWER_REQUIRED';

/**
 * What text a refused approve must carry, as a noun phrase — the ONE demand-specific word
 * each seat's channel sentence needs ("approve it in fr with ___ in the comment").
 *
 * ⛔ EXHAUSTIVE BY CONSTRUCTION, NOT BY CONVENTION. The previous revision of this file
 * claimed "`tsc` makes a message arm mandatory" while {@link answerRequiredMessage} was a
 * two-way ternary: a `fix_assertion` refusal fell through to the stated-question arm and
 * told the approver of an INFRASTRUCTURE hold that the row "states an open question" —
 * with `tsc` exit 0. Every function that distinguishes demand kinds is now a `switch` with
 * a `never` default, so a fourth kind is a compile error at every such site.
 */
export function demandedDecisionText(demand: Exclude<AnswerDemand, null>): string {
  switch (demand) {
    case 'question_action':
    case 'stated_question':
      return 'the answer';
    case 'fix_assertion':
      return 'a statement of what was fixed';
    default: {
      const _exhaustive: never = demand;
      return _exhaustive;
    }
  }
}

/**
 * The refusal text for a channel that does not have `routes/approvals.ts`'s bespoke
 * wording. `howToSupply` is the one channel-specific sentence — how, on THIS seat, the
 * demanded text can actually be supplied — because that differs and lying about it is
 * worse than saying nothing: the Telegram approve branch is an exact-match
 * equality test (`t === '1' || 'approve' || 'yes' || 'ok'`) that cannot carry text at
 * all, and is deliberately NOT being loosened here, so on that seat the honest
 * instruction is "do it in fr", not "reply `1 <text>`".
 *
 * It is a FUNCTION of {@link demandedDecisionText}, not a fixed string, because what the
 * seat must be told to write differs by demand: "the answer" is false on a
 * `fix_assertion` refusal, where nobody asked a question.
 *
 * Every arm names the consequence rather than just the rule, and every arm names the exit
 * that is never blocked, so a refused decider is never left without a legitimate move.
 */
export function answerRequiredMessage(
  demand: Exclude<AnswerDemand, null>,
  howToSupply: (demanded: string) => string,
): string {
  const howTo = howToSupply(demandedDecisionText(demand));
  switch (demand) {
    case 'question_action':
      return (
        'This approval is a QUESTION, and approving it is how the answer is delivered: the ' +
        'n8n callback releases the card only when the decision carries non-empty answer ' +
        'text. Approving with no answer does not release it — it holds the card in BLOCKED ' +
        'with block_reason approval_answer_missing, permanently, because this row is then ' +
        'spent and no second decision is accepted from you. ' +
        howTo +
        ' If you cannot answer it, REJECT it with a reason — rejecting a question is a ' +
        'legitimate terminal and is never blocked by this rule.'
      );
    case 'fix_assertion':
      return FIX_ASSERTION_REFUSAL_LEAD + howTo + ' ' + FIX_ASSERTION_REFUSAL_EXIT;
    case 'stated_question':
      return (
        'This approval states an open question (metadata.open_questions), and approving it ' +
        'is how the answer is delivered: the text is recorded on the decision and ' +
        'forwarded to the n8n callback, and it is the only thing the asker receives. ' +
        'Approving with no answer answers nothing while spending the approval — no second ' +
        'decision is accepted from you, so the question can never be answered through this ' +
        'row afterwards. ' +
        howTo +
        ' Or REJECT it with a reason, which is never blocked by this rule.'
      );
    default: {
      const _exhaustive: never = demand;
      return _exhaustive;
    }
  }
}

/**
 * The `fix_assertion` refusal, shared verbatim by every seat including the API route's
 * bespoke message, so the four seats cannot disagree about what approving a hold does.
 * Split in two only so each seat can put its own "how to supply it" sentence between.
 *
 * ⚠️ The duplicate-PR sentence is not colour. It is the REASON the rule exists (see the
 * `fix_assertion` essay above {@link AnswerDemand}): drop it and the refusal reads as
 * bureaucracy, and a decider who types "fixed" to get past it has learned nothing.
 */
export const FIX_ASSERTION_REFUSAL_LEAD =
  'This approval is an INFRASTRUCTURE or DEPENDENCY hold, and approving it asserts that the ' +
  'named fault is fixed: the n8n callback re-drives the card to TODO. Approving with no ' +
  'statement of what was fixed re-drives it on nobody\'s word — and re-driving work that ' +
  'is already done risks opening a DUPLICATE PULL REQUEST for it. State what was fixed: ' +
  'it is recorded on the decision, forwarded to the callback, and is the only record of ' +
  'why the card left the hold. ';

export const FIX_ASSERTION_REFUSAL_EXIT =
  'If nothing has been fixed, REJECT it with a reason — rejecting is always allowed and is ' +
  'never blocked by this rule.';

// ─────────────────────────────────────────────────────────────────────────────────────
// WHY A ROW EXHAUSTED ITS SENDS — the discriminator the redelivery worker was missing.
//
// ⛔ THE DEFECT THIS CLOSES. `workers/deblock-callback-redelivery.ts` retires a row as
// `send_exhausted` after MAX_SEND_ATTEMPTS acked sends and logged ONE unconditional
// sentence about it: "n8n is accepting and not moving". That sentence names a CAUSE, and
// the worker had no evidence for it — its candidate SELECT did not read `deblock_action`,
// `doingListId`, `todoListId`, `advance_phase_on_approve` or `kind` at all, so it could
// not tell a receiver that ignores a real instruction from a callback that carried no
// instruction to ignore.
//
// ⭐ MEASURED ON PROD `fr` (worker4) 2026-09-07T14:01Z, bucketed so the parts sum to the
// whole (108 = 108) and with `moved` as a negative control:
//
//   arm (classifyDeblockExit, precedence mirrored in SQL)      rows   raw key present
//   required + USABLE          -> receiver blame is EARNED       15               15
//   exempt: no_list_target     -> nothing to move it TO          93                0
//   required + UNUSABLE (mint gap)                                0                0
//   exempt: phase_advance / improvement_gate / signoff_rail       0                0
//                                                             -----
//                                                               108
//
// So the blame line was WRONG on 93 of 108 rows (86%). Those rows carry no usable action
// AND an EMPTY `doingListId`/`todoListId` — measured as `''`, not absent — so the callback
// fr sent contained nothing n8n could move the card with. The fix for them is upstream in
// fr's mint, and the old message sent the reader to n8n.
//
// ⚠️ THE CLAIM IS ABOUT THE PAYLOAD, NOT ABOUT THE CARD, AND THAT IS DELIBERATE. An
// earlier framing of this defect said such a card "CANNOT move". Measured, that is too
// strong. The population is keyed by `callback_path='kanban/approval-callback'` — ⛔ NOT
// by `kind`, because there is no `kind='kanban'`: the `approval_kind` enum's labels are
// generic / improvement.design / improvement.release / execution.ready_signoff /
// improvement.canary_action and none of them is `kanban`. Re-measured 2026-09-07T14:51:01Z
// that population is **2032** rows, and an earlier note here said "all 2,030 have empty
// list ids", which was wrong on the count AND collapsed two states this very PR exists to
// keep apart: **2031** carry `doingListId`/`todoListId` as EMPTY STRINGS and **1** does not
// carry the keys AT ALL. An empty string is a field the mint wrote and left blank; an
// absent key is a field the mint never wrote. `->>` maps them to `''` and SQL NULL, and
// `classifyDeblockExit` treats both as "no list target" — deliberately, since neither
// gives a receiver anywhere to move a card to — but the two say different things about
// where upstream to look.
//
// The 25 rows that reached `moved` are inside that population and share the shape. So a
// card in this shape demonstrably can still leave BLOCKED by some other hand. What is
// provable is the narrower statement, and it is the one these messages make: THE CALLBACK
// CARRIED NO ACTIONABLE EXIT, so the card's failure to move cannot be attributed to n8n's
// receiver.
//
// ⭐ AND THAT NARROWER FRAME IS NOW THE POSITIVELY CORRECT ONE, NOT MERELY THE SAFER ONE.
// Re-measured 2026-09-07T14:51:18Z, the metadata KEY SETS of the 25 `moved` and the 93
// `no_actionable_exit` rows are IDENTICAL — one key set, `boardId,
// default_expiry_backfill_107, doingListId, recipient, restored_by_migration_106,
// todoListId`, covering 25 + 93 rows with ZERO rows differing in EITHER direction (the
// remaining 15 exhausted rows are the `deblock_action`-bearing receiver_unresponsive arm;
// 93 + 10 + 5 = 108 ✅). Send attempts do not discriminate either: 13 of the 25 `moved`
// rows ALSO reached the 5-attempt ceiling that retired the other 108.
//
// ⛔ `callback_delivered_at` is NOT the independent discriminator it looks like: since
// migration 113 it is stamped ONLY on the `moved` branch of `resolveRow`, so "moved 25/25,
// send_exhausted 0/108" is fr's own record of the outcome and is tautological with
// `callback_resolution`. It cannot explain anything.
//
// ⇒ Nothing fr put in the payload separates a card that moved from one that did not.
// Whatever moved those 25 cards therefore did NOT read its target from this metadata: the
// target list is resolved DOWNSTREAM of the callback. That is why blaming the receiver for
// the 93 is wrong — it was given the same nothing in both populations.
//
// ⛔ THE FOUR EXIT-DERIVED CAUSES ARE NOT COLLAPSIBLE TO TWO. Folding `no_list_target` into "the action
// went missing" is the same conflation the SIGNOFF_RAIL_KIND block above refuses: a lane
// whose exit is driven by something else is not a lane with a defect, and a counter that
// says otherwise about healthy traffic is the counter that gets silenced.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * Why a `send_exhausted` row exhausted. One value per arm of `classifyDeblockExit`, so
 * the two seams cannot drift: this is a pure re-labelling of that classifier's output for
 * an operator, NOT a second predicate.
 */
export const SEND_EXHAUSTION_CAUSES = [
  /**
   * ⭐ NO receiver ever acked this row, so nothing downstream can be blamed for anything.
   *
   * NOT derived from `classifyDeblockExit` — this is the SECOND, independent discriminator,
   * established by #1023: since `VOIDED_CALLBACK_PATHS` (services/n8n-callback.ts) fr
   * WITHHOLDS a `voided` decision from receivers not measured to route it, a row can reach
   * the send ceiling having never contacted n8n at all. It is ordered FIRST because it
   * dominates: what the payload contained is moot if nothing ever accepted the payload.
   */
  'never_acked',
  /** A usable action WAS sent and acked, and the card did not move. The receiver owns this. */
  'receiver_unresponsive',
  /** No usable action and no list target: the callback carried nothing to move the card with. */
  'no_actionable_exit',
  /** A list target exists but the action was absent or unrecognised — it went missing at mint. */
  'mint_gap',
  /** A lane carve-out fired: this row's exit was never a card move in the first place. */
  'exempt_lane',
] as const;

export type SendExhaustionCause = (typeof SEND_EXHAUSTION_CAUSES)[number];

/**
 * Why the receiver said it was holding a card in BLOCKED on purpose.
 *
 * ⚠️ MOVED HERE FROM `workers/deblock-callback-redelivery.ts` (#1115), WHICH STILL
 * RE-EXPORTS IT — the values, their doc comments and their order are unchanged, and
 * the worker remains where `classifyReceiverHold` derives them.
 *
 * ⛔ THE MOVE IS FORCED, NOT TIDYING. `lib/deblock-action-metrics.ts` needs this list
 * to pre-zero and render `fr_deblock_redelivery_hold_total`, and that file's own
 * header says why it may not simply import the worker: it lives in `lib/` precisely
 * so `routes/metrics.ts` cannot transitively pull in `db/client` on a hot path. The
 * worker imports `db/client`. So the list has to sit where `SEND_EXHAUSTION_CAUSES`
 * already sits — which is also the precedent the hold cause is meant to mirror
 * "exactly", the whole point being that the two are shaped the same way.
 */
export const HOLD_CAUSES = [
  /**
   * An approved `QUESTION` whose decision comment carried no answer text. The ask
   * is still open; the row is SPENT (fr accepts no second decision on a decided
   * approval), so no answer can ever ride on it and no re-send can change that.
   */
  'answer_missing',
  /**
   * A holding action other than the answer-missing case (`INFRASTRUCTURE`,
   * `DEPENDENCY`): approved, and the approval was never the thing that moves the
   * card. Separate from `answer_missing` because the fixes differ — one needs a
   * human to type an answer, the other needs a fault to clear or a card to reach
   * DONE — and one label for both would send every reader to the wrong one half
   * the time.
   */
  'hold_by_design',
] as const;

export type HoldCause = (typeof HOLD_CAUSES)[number];

/**
 * ⭐ #1104 — WHICH READ KEPT FAILING, for a row retired as `read_degraded`.
 *
 * ⛔ THIS IS NOT A FAILURE-CLASS WIDENING AND IT DECIDES NOTHING. Exactly like
 * `SendExhaustionCause` and `HoldCause`, it is a LOG AND PROMETHEUS LABEL derived
 * AFTER the row has already satisfied the retirement rule — it changes which
 * sentence a reader is sent to, never whether or when a row retires. It is not a
 * column and not a jsonb key, for the reason `HoldCause`'s block above gives.
 *
 * ⚠️ IT LIVES HERE, BESIDE ITS TWO SIBLINGS, FOR THE SAME FORCED REASON: `lib/
 * deblock-action-metrics.ts` must pre-zero and render the family, and that file may
 * not import the worker (it lives in `lib/` so `routes/metrics.ts` cannot
 * transitively pull `db/client`).
 *
 * ⛔ THE THREE ARE NOT COLLAPSIBLE TO ONE. They are measured at different rates and
 * have different fixes — `list_read` was 18 of 18 of the population #1104 was
 * re-opened on (an archived Planka list whose `/api/lists/:id` 404s while the card
 * read 200s), `card_read` is the class the issue was FILED on, and `empty_read` is a
 * 200 that answered nothing. One label would send two thirds of readers to the wrong
 * place.
 */
export const READ_DEGRADED_CAUSES = [
  /** `GET /api/cards/:id` never produced a usable answer — 5xx, 429, timeout, network. */
  'card_read',
  /**
   * The CARD read returned 200 with a listId and `GET /api/lists/:id` then failed.
   * ⚠️ Planka has affirmatively told us the card EXISTS, so this is never evidence
   * about the card — which is precisely why it may not strike `card_unreadable`, and
   * why it needed a bound of its own instead.
   */
  'list_read',
  /** A 200 that answered nothing: a card with no `listId`, or a list with no `name`. */
  'empty_read',
] as const;

export type ReadDegradedCause = (typeof READ_DEGRADED_CAUSES)[number];

/**
 * Map one classified exit onto the cause an operator needs. Pure and total over
 * `DeblockExit`, so a new arm on the classifier is a `tsc` error here rather than a row
 * that silently lands on the wrong blame.
 *
 * ⛔ NEVER RETURNS `never_acked`. That cause is not a property of the exit — it is a
 * property of the DELIVERY, and the caller tests it before reaching here.
 */
export function causeOfSendExhaustion(exit: DeblockExit): SendExhaustionCause {
  if (exit.required) return exit.usable ? 'receiver_unresponsive' : 'mint_gap';
  return exit.exemption === 'no_list_target' ? 'no_actionable_exit' : 'exempt_lane';
}
