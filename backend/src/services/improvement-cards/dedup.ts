// Open-card dedup for the observability/detector improvement-card path.
//
// Why: the improvability governor is event-driven (n8n fires a scoped
// measurement after every QA exec_quality write). An asset that keeps
// passing QA while its analysis card still sits open in TODO would emit a
// duplicate card on every pass — there is no idempotency anywhere else
// (the orchestrator and the DB both create unconditionally). Card creation
// is fr-backend's responsibility, so the dedup lives here, at the owner.
//
// The check is narrow on purpose (see DEDUP_CARD_TYPES): only the
// detector/sweep *_analysis card types are deduped, so a human authoring a
// principle/requirement/decision (or any asset-authoring card) is never
// suppressed.
//
// Mechanism: one `GET /api/boards/:id` (via getBoardCustomFields, which
// already surfaces cards + customFieldValues) → resolve the Metadata group's
// `asset_id` customField id → find any card carrying this asset_id whose list
// is still OPEN (anything except DONE). A card only in DONE does NOT suppress
// — once the improvement landed, a fresh degradation is allowed to re-emit.
// Nor does a card that has sat in BLOCKED past DEFAULT_BLOCKED_SUPPRESSION_TTL
// — see the TTL essay below for the 16 assets that were sealed by that gap.

import type { PlankaClient } from '../planka';
import { IMPROVEMENT_CARD_FIELD_GROUP_NAME } from '../planka/custom-fields';
import { isBlocked } from '../../lib/phase';

/**
 * card_types that carry an asset binding and are auto-emitted by the
 * observability sweep / detectors. Only these are deduped. Kept in sync with
 * the sweep's `Fan Out Asset Kinds` card_type config in
 * `n8n_custom_nodes/workflows/observability/observability-sweep.json`.
 */
export const DEDUP_CARD_TYPES: ReadonlySet<string> = new Set([
  'workflow_statistics_analysis',
  'prompt_performance_statistics_analysis',
  'procedure_performance_statistics_analysis',
  // Scoring half — governor-emitted asset library statistics (dedup by asset_id
  // so a re-running sweep never piles duplicate analysis cards on one asset).
  'principle_statistics_analysis',
  'requirement_statistics_analysis',
  'decision_statistics_analysis',
]);

/**
 * WS3-C — AA-intake parent-approval card_types deduped by a SYNTHETIC,
 * stable asset_id the AA-intake orchestrator stamps on each approval-card
 * create body (`<parentCardId>:<approval_kind>:<title>`). Kept in a SEPARATE
 * set from DEDUP_CARD_TYPES on purpose: these are the SAME card_types a HUMAN
 * uses to manually author a principle/requirement/decision, and this module's
 * header promise (asset-authoring cards are never suppressed) must hold.
 *
 * ⚠️ SAFETY INVARIANT — do NOT relax without re-checking: the create route's
 * guard requires `parsed.asset_id && …` before consulting this set, so a card
 * is only ever deduped when it carries an asset_id. Manual/human-authored
 * `*_development` cards NEVER carry an asset_id (verified WS3-C 2026-07:
 * `agent.create_asset` mints the base card WITHOUT asset_id;
 * `agent.update_asset` carries an asset_id but on the `change_*_development`
 * card_types, which are deliberately EXCLUDED from this set;
 * `streams.open_improvement_card` bypasses this route entirely). Only the
 * AA-intake orchestrator's synthetic asset_id reaches this guard on a base
 * `*_development` card — so a human authoring card is never touched. The
 * synthetic id namespace (colon-delimited) is also disjoint from real asset
 * UUIDs, a second line of defence against accidental collapse. Note the
 * `change_*_development` variants are intentionally absent.
 */
export const PARENT_APPROVAL_DEDUP_CARD_TYPES: ReadonlySet<string> = new Set([
  'decision_development',
  'principle_development',
  'requirement_development',
]);

/**
 * Detector-signature dedup — the blocked-escalate learning path.
 *
 * `n8n_custom_nodes/workflows/patterns/blocked-escalate.json` mints a learning
 * card on EVERY card transition into BLOCKED, and its `Build Proposition` node
 * already computes a stable synthetic key for exactly this purpose:
 *
 *     learning_signature = [block_reason_class, card_type, subject]
 *                            .map(slugPart).join('::')
 *
 * which `Build Learning Request` passes through as `asset_id`, with an inline
 * comment naming THIS module as the thing that would collapse the repeats
 * ("480 blocked cards must not become 480 improvement cards"). That half of the
 * contract shipped; this half never did — the two card_types it emits
 * (`workflow_development` / `prompt_improvement`) were in neither set above, so
 * `improvement.ts`'s guard computed the key and never consulted it.
 *
 * MEASURED 2026-08-26: 125 cards named "A card reached BLOCKED with
 * block_reason_class=…" carrying only 14 distinct signatures, ALL minted in the
 * preceding 2 days, two of them 10 seconds apart. Deduping collapses ~89% of
 * them onto one open card per distinct signature.
 *
 * Kept as a THIRD set rather than folded into either existing one so both of
 * their documented invariants stay literally true: these are neither
 * detector/sweep `*_analysis` cards keyed by a real asset UUID
 * (DEDUP_CARD_TYPES) nor AA-intake parent-approval cards keyed by
 * `<parentCardId>:<kind>:<title>` (PARENT_APPROVAL_DEDUP_CARD_TYPES).
 *
 * ⚠️ SAFETY INVARIANT — same as the set above, and it holds for the same
 * reason: the create route gates on `parsed.asset_id &&` before consulting any
 * set, and a human authoring a `workflow_development` / `prompt_improvement`
 * card carries no asset_id. The `::`-delimited signature namespace is also
 * disjoint from real asset UUIDs, so a signature can never collide with one.
 */
export const DETECTOR_SIGNATURE_DEDUP_CARD_TYPES: ReadonlySet<string> = new Set([
  'workflow_development',
  'prompt_improvement',
  // ⭐ 2026-09-15 — THE SAME DEFECT, A SECOND TIME, FOR A NEW REASON. The two
  // entries above were added 2026-08-26 because the set had never listed what
  // the workflow emitted. On 2026-09-15 `blocked-escalate.json :: Build
  // Learning Request` COLLAPSED its three shapes into one and started emitting
  // `procedure_improvement` instead (its comment: "the prompt/workflow
  // branching this node used to carry is DELETED, not disabled" — neither
  // could land). The emitted card_type changed; this allowlist did not, so
  // `isDedupedCardType` went back to answering false and the route resumed
  // creating unconditionally.
  //
  // MEASURED, the cost of the ~7h it ran: `procedure_improvement` cards minted
  // per hour 10:00→5, 11:00→21, 12:00→41, 13:00→48, 14:00→63, 15:00→80 — 281
  // cards in total, 258 of them inside 24h against 0 the prior 24h. fr
  // `approvals` rows tracked it 1:1 (9/22/42/47/60/81 per hour) because every
  // BLOCKED transition also raises a gate, taking pending from ~855 to 1293.
  // BLOCKED went 1762 → 1999 in seven hours, and READY+DOING+QA became 18
  // cards of which 18 were `procedure_improvement`: the conveyor had no
  // capacity left for development work.
  //
  // ⭐ WIDTH AND DEPTH ARE TWO DIFFERENT BOUNDS, AND ONLY ONE OF THEM IS HERE.
  // `blocked-escalate.json :: Build Proposition` states the division explicitly:
  // "fr's `findOpenCardForAsset` dedupe is NOT a recursion bound... That dedupe
  // bounds WIDTH; this rung bounds DEPTH, and only this rung bounds depth."
  // n8n PR #1435 (merged 2026-09-15 16:07Z, live 16:09:10Z) shipped the DEPTH
  // rung — a chain bound on `/_improvement$/` subjects. This entry is the WIDTH
  // half, and the measurement proves the two are independent rather than
  // redundant: at 16:13Z there were 306 `procedure_improvement` cards carrying
  // only **13 distinct subjects**, 197 of them the single subject
  // `procedure_improvement.doing.action`. Width dedupe should have collapsed
  // those 197 to one open card. It could not: `isDedupedCardType` answered
  // false, so `findOpenCardForAsset` was never called at all.
  //
  // ⚠️ THE SHAPE OF THE BUG IS NOT "someone forgot". This constant is a SECOND
  // SPELLING of a fact whose first spelling lives in another repository
  // (`n8n_custom_nodes/workflows/patterns/blocked-escalate.json`), and nothing
  // compares them. `blocked-escalate.json`'s own comment asserts "DEDUPE IS
  // SERVER-SIDE AND IS WHAT MAKES THIS SAFE AT SCALE" and names this module —
  // so the workflow author correctly believed the guard was armed. A guard
  // whose trigger the caller can silently stop producing is a guard that has
  // never been asked. If a third card_type is ever emitted here, this set is
  // where it has to be said again.
  'procedure_improvement',
]);

/**
 * Single predicate over the three sets above, so the create route asks one
 * named question instead of OR-ing three sets — and so the "is this card_type
 * deduped" contract is testable without standing up the route.
 *
 * NOTE: this answers only the card_type half. The caller MUST still gate on a
 * present `asset_id` (see the SAFETY INVARIANTs above); this function
 * deliberately does not know about asset_id, so it can never be mistaken for
 * the whole guard.
 */
export function isDedupedCardType(cardType: string): boolean {
  return (
    DEDUP_CARD_TYPES.has(cardType) ||
    PARENT_APPROVAL_DEDUP_CARD_TYPES.has(cardType) ||
    DETECTOR_SIGNATURE_DEDUP_CARD_TYPES.has(cardType)
  );
}

/**
 * ── BLOCKED-SUPPRESSION TTL ────────────────────────────────────────────────
 *
 * ⛔ WHAT THIS FIXES: the open-list rule above ("every list except DONE")
 * anticipated DONE and did not anticipate BLOCKED-FOREVER. A card parked in
 * BLOCKED is, to this module, indistinguishable from a card someone is
 * actively working — so it suppresses every future card for its asset, for
 * ever. MEASURED 2026-09-11: of 19 `workflow_statistics_analysis` cards, 18
 * were BLOCKED, covering 16 distinct asset_ids, several of which were still
 * producing telemetry that day. The newest such card was 2026-07-12. For
 * those 16 assets the FIRST failure was the LAST signal that would ever be
 * emitted: the detector kept measuring and this function kept swallowing it.
 *
 * A card in BLOCKED therefore stops suppressing once it is older than this
 * TTL. TODO / READY / DOING / QA are untouched — re-minting a duplicate of
 * work someone is doing RIGHT NOW is a worse failure than the one above —
 * and DONE keeps its existing behaviour of never suppressing at all.
 *
 * ── WHY 14 DAYS, AND WHY IT IS NOT A CHOSEN NUMBER ─────────────────────────
 *
 * A BLOCKED card on this estate is held by a PENDING APPROVAL: that is the
 * measured mechanism (`domain/approvals/one-open-gate.ts`, and
 * `blocked-escalate.json` which mints a gate on every transition into
 * BLOCKED). So the honest question is not "how long is a card allowed to sit
 * in BLOCKED" but "how long is a HUMAN still expected to act on the thing
 * holding it". That horizon already exists and was set by an explicit
 * operator decision — `lib/approval-deadline.ts :: DEFAULT_TTL_DAYS = 14`,
 * the deadline stamped on an approval that requests none.
 *
 * Deriving from it rather than inventing a number gives the two properties
 * that matter:
 *   * BEFORE the approval's own deadline, a human is still on the hook, so
 *     suppression is protecting live work — exactly the case the warning
 *     above says must not regress.
 *   * AFTER it, the approval itself is past due and nobody is coming. From
 *     that instant suppression is not protecting anything; it is sealing the
 *     asset. Re-emitting is the only thing that can surface it again.
 * If that operator decision is ever revisited, revisit this with it.
 *
 * It is also far longer than any plausible in-progress window, so the
 * duplicate-of-live-work hazard is not merely bounded, it is nowhere near.
 * And it is much SHORTER than the ~2 months the measured cards had been
 * sealed, so shipping it re-opens all 16 assets rather than only some.
 */
export const DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS = 14;

const MS_PER_DAY = 86_400_000;

/**
 * Resolve the TTL. Override: `FR_BLOCKED_SUPPRESSION_TTL_DAYS` (days, may be
 * fractional).
 *
 * ⚠️ `0` IS HONOURED HERE, unlike the sibling `resolveRetentionDays`
 * (`workers/scheduled-trigger-run-prune.ts`) which refuses anything below 1.
 * The difference is the direction of the risk, and it is worth stating rather
 * than copying the stricter rule by reflex: there, a `0` DELETES rows newer
 * than now() and empties an audit log. Here, a `0` only means "a BLOCKED card
 * never suppresses" — it can at worst mint a duplicate card, never destroy or
 * strand anything, so it is a legitimate operator setting (full disable) and
 * refusing it would be false caution. A NEGATIVE or unparseable value has no
 * meaning at all and IS refused back to the default.
 */
export function resolveBlockedSuppressionTtlMs(
  raw: string | undefined = process.env.FR_BLOCKED_SUPPRESSION_TTL_DAYS,
): number {
  if (raw === undefined || raw === '') {
    return DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS * MS_PER_DAY;
  }
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    console.warn(
      `[improvement-card dedup] FR_BLOCKED_SUPPRESSION_TTL_DAYS=${raw} is not a ` +
        `finite non-negative number; falling back to ` +
        `${DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS} days`,
    );
    return DEFAULT_BLOCKED_SUPPRESSION_TTL_DAYS * MS_PER_DAY;
  }
  return n * MS_PER_DAY;
}

/**
 * The three timestamps Planka puts on a card, structurally — so the age
 * predicate below is testable with a literal and does not drag the generated
 * openapi `Card` type (or a PlankaClient) into a unit test.
 */
export interface CardTimestamps {
  listChangedAt?: string | null;
  updatedAt?: string | null;
  createdAt?: string | null;
}

/**
 * How long the card has sat in its CURRENT list, in ms, or null when the card
 * carries no usable timestamp at all.
 *
 * The `listChangedAt ?? updatedAt ?? createdAt` chain is not invented here —
 * it is the existing house rule for exactly this question
 * (`services/cockpit/project-cockpit.ts :: cardPhaseAge`). Both fallbacks also
 * happen to fail in the safe direction for THIS caller:
 *   * `updatedAt` >= `listChangedAt` (any edit refreshes it), so a card whose
 *     move time is unknown reads YOUNGER → suppresses LONGER → status quo.
 *   * `createdAt` <= `listChangedAt`, so it can only read older; it is last in
 *     the chain and is reached only when the other two are absent, which for a
 *     card created directly into BLOCKED is the correct answer anyway.
 */
export function msInCurrentList(
  card: CardTimestamps,
  now: number,
): number | null {
  const iso = card.listChangedAt ?? card.updatedAt ?? card.createdAt;
  if (!iso) return null;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, now - t);
}

/**
 * Does a card sitting in BLOCKED still suppress a new card for its asset?
 *
 * ⚠️ An UNKNOWN age answers TRUE (keep suppressing). That is deliberate: the
 * unknown case must resolve to the behaviour this module had before the TTL
 * existed, so a missing timestamp can never be the thing that mints a
 * duplicate of live work.
 */
export function blockedCardStillSuppresses(
  card: CardTimestamps,
  ttlMs: number,
  now: number,
): boolean {
  const age = msInCurrentList(card, now);
  if (age === null) return true;
  return age < ttlMs;
}

export interface FindOpenCardInput {
  boardId: string;
  /** The asset the new card would be bound to (Metadata.asset_id). */
  assetId: string;
  /**
   * List ids considered OPEN (not closed). The caller passes every list on
   * the board except DONE, so DONE/archive/trash cards never suppress and a
   * resolved improvement can re-emit on a fresh degradation.
   */
  openListIds: ReadonlySet<string>;
  /**
   * The subset of `openListIds` that are BLOCKED lists. A card in one of
   * these suppresses only until `resolveBlockedSuppressionTtlMs()` has passed since it
   * landed there — see the TTL essay above.
   *
   * OPTIONAL, and an omitted/empty set means "no list is BLOCKED", i.e. the
   * pre-TTL behaviour verbatim. A caller that does not know which of its
   * lists is BLOCKED must not have its cards silently un-suppressed.
   */
  blockedListIds?: ReadonlySet<string>;
}

/**
 * C1-58 ruling 4 — the first asset_id prefix whose dedupe also counts cards in
 * DONE. A `deliv:<project_deliverables.id>` card is the single card for an
 * approved deliverable (POST /api/decompositions/commit); once it is DONE the
 * deliverable is delivered, so a re-drive or a second decomposition must get
 * the existing card back, never a fresh one. Every other asset (a finding
 * fingerprint) keeps "DONE does not suppress": a finding that recurs after its
 * fix card closed is a NEW occurrence and deserves a new card.
 */
export const DELIVERABLE_ASSET_PREFIX = 'deliv:';

/**
 * ncn#1960 — the second (and only other) DONE-deduping prefix: a
 * `split:<decomposition_id>:<i>` card is child `i` of ONE Readying split
 * (POST /api/decompositions/split). Same argument as `deliv:`: the child is the
 * single card for that slot of that family, so once it is DONE a replay or a
 * re-drive of the split must get the existing card back, never a fresh one.
 */
export const SPLIT_ASSET_PREFIX = 'split:';

/**
 * P2.3 — the third DONE-deduping prefix: a unit card minted from a decided A3
 * handoff contract. FORMAT (emitted by the ncn wiring, POST /api/cards/project
 * asset_id): `a3:<design_approval_id>:<unit_key>` — the id of the A3 approval
 * (`execution.feature_design_approval`) whose metadata.handoff_contract holds the
 * unit, then that unit's `unit_key`. Same argument as `deliv:` / `split:`: the
 * card is the single card for that unit of that approved contract, so once it
 * is DONE a re-drive must get the existing card back, never mint a second one.
 */
export const A3_UNIT_ASSET_PREFIX = 'a3:';

/**
 * True only for a `deliv:`-, `split:`- or `a3:`-prefixed asset id — see
 * DELIVERABLE_ASSET_PREFIX, SPLIT_ASSET_PREFIX and A3_UNIT_ASSET_PREFIX.
 */
export function assetDedupesAcrossDone(assetId: string): boolean {
  return (
    assetId.startsWith(DELIVERABLE_ASSET_PREFIX) ||
    assetId.startsWith(SPLIT_ASSET_PREFIX) ||
    assetId.startsWith(A3_UNIT_ASSET_PREFIX)
  );
}

/**
 * Split a board's lists into the two sets `findOpenCardForAsset` needs.
 *
 * Exists so the two questions — "which lists are open" and "which of those is
 * BLOCKED" — are answered in ONE named, tested place. `includeDone` (C1-58
 * ruling 4) counts DONE as "open" for the `deliv:` prefix ONLY; callers decide
 * it with `assetDedupesAcrossDone`, never by hand. Two inline filter
 * expressions in a route is how the second spelling of "the blocked list"
 * drifts away from the first.
 *
 * ⚠️ THE TWO MATCHERS ARE DELIBERATELY ASYMMETRIC, and neither was chosen here:
 * the DONE rule is EXACT (`name !== 'DONE'`) and is carried over verbatim from
 * the route that has always used it — widening it would silently stop
 * suppressing on any list whose name merely contains "DONE". The BLOCKED rule
 * is `lib/phase.ts :: isBlocked`, the board's existing matcher, which is
 * substring-based. Do not "tidy" either into the other.
 */
export function partitionBoardLists(
  lists: ReadonlyArray<{ id: string; name?: string | null }>,
  opts: { includeDone?: boolean } = {},
): { openListIds: Set<string>; blockedListIds: Set<string> } {
  const openListIds = new Set<string>();
  const blockedListIds = new Set<string>();
  for (const l of lists) {
    if (l.name === 'DONE' && !opts.includeDone) continue;
    // DROPPED is terminal and NOT done work: never open, under either rule (a dropped card
    // must not suppress a fresh card for the same asset).
    if (l.name === 'DROPPED') continue;
    openListIds.add(l.id);
    if (isBlocked(l.name ?? null)) blockedListIds.add(l.id);
  }
  return { openListIds, blockedListIds };
}

/**
 * Every `Metadata.card_type` stamped on a card of the board that carries
 * `Metadata.asset_id === assetId`, in ANY list (DONE included — a closed
 * security card still classifies its finding). Same board read and the same
 * group/field resolution as `findOpenCardForAsset` below. A board without the
 * Metadata group or its asset_id field yields [] (no card can carry the key).
 *
 * Used by PUT /api/findings/suppressions to classify a fingerprint from the
 * cards minted for it rather than from the caller's declaration.
 */
export async function findCardTypesForAsset(
  planka: PlankaClient,
  input: { boardId: string; assetId: string },
): Promise<string[]> {
  if (!input.assetId) return [];

  const view = await planka.customFields.getBoardCustomFields(input.boardId);

  const group = view.customFieldGroups.find(
    (g) =>
      g.name === IMPROVEMENT_CARD_FIELD_GROUP_NAME &&
      g.boardId === input.boardId,
  );
  if (!group) return [];

  const fieldId = (name: string): string | undefined =>
    view.customFields.find(
      (f) => f.customFieldGroupId === group.id && f.name === name,
    )?.id;
  const assetFieldId = fieldId('asset_id');
  const cardTypeFieldId = fieldId('card_type');
  if (!assetFieldId) return [];

  const liveCardIds = new Set(view.cards.map((c) => c.id));
  const boundCardIds = new Set<string>();
  for (const v of view.customFieldValues) {
    if (v.customFieldId !== assetFieldId) continue;
    if (String(v.content) !== String(input.assetId)) continue;
    if (!liveCardIds.has(v.cardId)) continue; // archived/removed card
    boundCardIds.add(v.cardId);
  }
  if (boundCardIds.size === 0) return [];

  const types: string[] = [];
  for (const v of view.customFieldValues) {
    if (v.customFieldId !== cardTypeFieldId) continue;
    if (!boundCardIds.has(v.cardId)) continue;
    types.push(String(v.content));
  }
  return types;
}

/**
 * Returns the id of an existing OPEN card bound to `assetId` on the board, or
 * null if none exists (→ caller proceeds to create). Skips gracefully (null)
 * when the board isn't provisioned with the Metadata/asset_id field — the
 * create path fail-loud handles that case.
 */
export async function findOpenCardForAsset(
  planka: PlankaClient,
  input: FindOpenCardInput,
): Promise<string | null> {
  if (!input.assetId) return null;

  const view = await planka.customFields.getBoardCustomFields(input.boardId);

  const group = view.customFieldGroups.find(
    (g) =>
      g.name === IMPROVEMENT_CARD_FIELD_GROUP_NAME &&
      g.boardId === input.boardId,
  );
  if (!group) return null;

  const assetField = view.customFields.find(
    (f) => f.customFieldGroupId === group.id && f.name === 'asset_id',
  );
  if (!assetField) return null;

  const cardById = new Map(view.cards.map((c) => [c.id, c]));

  const blockedListIds = input.blockedListIds ?? new Set<string>();
  const ttlMs = resolveBlockedSuppressionTtlMs();
  const now = Date.now();

  for (const v of view.customFieldValues) {
    if (v.customFieldId !== assetField.id) continue;
    if (String(v.content) !== String(input.assetId)) continue;
    const card = cardById.get(v.cardId);
    if (!card) continue; // value for an archived/removed card
    if (!input.openListIds.has(card.listId)) continue; // DONE / archive → not open
    // BLOCKED, and stale enough that nobody is coming back for it → it has
    // stopped being a reason to swallow a fresh signal. Every other open list
    // (TODO/READY/DOING/QA) suppresses unconditionally, as before.
    if (
      blockedListIds.has(card.listId) &&
      !blockedCardStillSuppresses(card, ttlMs, now)
    ) {
      continue;
    }
    return card.id;
  }
  return null;
}

// ---------------------------------------------------------------------------
// THE UN-ASSETED POPULATION — issue: duplicate improvement cards with no
// asset_id to dedupe on.
// ---------------------------------------------------------------------------
//
// ⚠️ THE ASSET ARM ABOVE DOES NOT COVER EVERY CREATE, AND THE GAP IS EXACTLY
// WHERE THE DUPLICATES WERE MEASURED. `routes/cards/improvement.ts` enters the
// dedup + lease path only when `parsed.asset_id && isDedupedCardType(...)`.
// Both halves of that condition exclude real traffic:
//
//   * a card with NO `asset_id` — every human/manual asset card, and any
//     producer that simply does not stamp one;
//   * a card whose `card_type` is in none of the three dedup sets.
//
// For that population the route does a bare create with no read, no lease and
// no unique constraint anywhere — the check-then-act is not merely racy, there
// is no check at all. MEASURED (7d to 2026-09-26): 7 duplicate pairs on
// `POST /api/cards/improvement`, each pair the SAME board with an IDENTICAL
// card name, created within 780s of each other.
//
// ⛔ THE KEY IS THE CARD NAME, AND IT IS A DELIBERATELY WEAKER KEY THAN
// asset_id. `asset_id` is a stable identity the producer chose; a name is
// whatever `problem_statement.slice(0, 200)` happened to produce. Two
// genuinely distinct problems that phrase themselves identically on one board
// WILL collapse onto one card here. That is accepted, and it is the right
// direction of error for this path: the alternative on a board with no
// identity key at all is the measured duplicate, and a duplicate improvement
// card is a second human asked to do work that is already being done.
//
// ⚠️ EXACT match, after trimming. Not case-insensitive, not fuzzy, not a
// prefix — the measured pairs are byte-identical, so nothing looser is needed,
// and anything looser widens the collapse described above without evidence.
// Trim only, because the route itself slices the title and a trailing space is
// not a different problem.
//
// Same board read, same OPEN/BLOCKED semantics and the same TTL as
// `findOpenCardForAsset`, so the two arms cannot disagree about which list is
// open or when a BLOCKED card stops suppressing.

export interface FindOpenCardByNameInput {
  boardId: string;
  /** The card title the create would use (`problem_statement`, sliced). */
  name: string;
  openListIds: ReadonlySet<string>;
  blockedListIds?: ReadonlySet<string>;
}

/**
 * The id of an existing OPEN card on the board carrying this exact name, or
 * null.
 *
 * Reads the board through `getBoardCustomFields` — the SAME call
 * `findOpenCardForAsset` makes — rather than a cards listing, so a route that
 * takes one arm or the other pays for exactly one board read either way, and
 * both arms see the same snapshot of `cards` and `listId`.
 *
 * ⛔ FAILS OPEN, AND THAT IS THE DIFFERENCE FROM THE ASSET ARM. `findOpenCardForAsset`
 * is only ever reached for `asset_id && isDedupedCardType(...)` — a narrow,
 * always-provisioned population — so a throwing board read there is a genuine
 * fault on a path that already depended on the read. THIS arm is new over a
 * population that previously made NO board read at all, so letting the read's
 * failure propagate would turn a Planka hiccup into a 500 on creates that used
 * to succeed. MEASURED while writing this: it did exactly that — nine
 * `*_development` / `*_statistics_analysis` creates went from 201 to a
 * TypeError, because that path had never needed a `customFields` surface.
 *
 * So a failed read degrades to "no open card found" and the caller proceeds to
 * the lease. ⭐ THE RACE IS STILL CLOSED WHEN THAT HAPPENS: the lease, not this
 * read, is what serialises concurrent creates — the read only saves the work in
 * the common case, exactly as `one-open-gate.ts` says of its own pre-check. What
 * is lost is the cheap suppression of a RE-EMIT against an already-open card,
 * which is the pre-existing behaviour for this population, not a new gap.
 *
 * ⚠️ LOUD, not silent. The line names the board, because a read that fails every
 * time is a real defect and a dedup that quietly stops deduping is how this
 * class of bug survives.
 */
export async function findOpenCardByName(
  planka: PlankaClient,
  input: FindOpenCardByNameInput,
): Promise<string | null> {
  const wanted = input.name.trim();
  if (!wanted) return null;

  let view: Awaited<ReturnType<PlankaClient['customFields']['getBoardCustomFields']>>;
  try {
    view = await planka.customFields.getBoardCustomFields(input.boardId);
  } catch (err) {
    console.warn(
      `[improvement-cards] name-keyed open-card read FAILED for board ${input.boardId} ` +
        `(create proceeds under the lease, un-deduped): ` +
        (err instanceof Error ? err.message : String(err)),
    );
    return null;
  }

  const blockedListIds = input.blockedListIds ?? new Set<string>();
  const ttlMs = resolveBlockedSuppressionTtlMs();
  const now = Date.now();

  for (const card of view.cards) {
    if ((card.name ?? '').trim() !== wanted) continue;
    if (!input.openListIds.has(card.listId)) continue; // DONE / archive → not open
    // Identical rule to the asset arm: a card parked in BLOCKED past the TTL
    // has stopped being a reason to swallow a fresh signal.
    if (
      blockedListIds.has(card.listId) &&
      !blockedCardStillSuppresses(card, ttlMs, now)
    ) {
      continue;
    }
    return card.id;
  }
  return null;
}

/**
 * Lease key for the name-scoped arm.
 *
 * ⛔ A DIFFERENT PREFIX FROM `createLeaseKey`, on purpose. The two arms answer
 * different questions over the same board, and a shared key would let a
 * name-keyed claim block an asset-keyed create (and vice versa) for a full
 * TTL — one arm silently suppressing the other's card is a worse failure than
 * the duplicate either exists to prevent. Declared here, next to the read it
 * guards, for the same reason `createLeaseKey` sits next to its own.
 */
export function createByNameLeaseKey(plankaBoardId: string, name: string): string {
  return `improvement-card:create-by-name:${plankaBoardId}:${name.trim()}`;
}
