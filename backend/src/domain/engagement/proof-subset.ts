/**
 * LIVENESS NEVER COUNTS TOWARD DONE — the PROOF SUBSET and the COMPUTED-GATED set.
 *
 * George, 2026-10-01: liveness never counts toward DONE; coding QA must be computed; the
 * oracle, judge and tournament never count. Design (approved by movies-73):
 * ~/.claude/plans/program/20-designs/liveness-done-paths-proof-subset-2026-10-05.md;
 * measured table with file:line refs: ncn#2087.
 *
 * ONE definition of each set, imported by every fr site that needs it:
 *   - the DONE-move guard (services/done-guard.ts),
 *   - the approval decide path's RECLASSIFY refusal (routes/approvals.ts),
 *   - fr's prediction of the receiver ({@link plannedCardMove}) and the contract fixture
 *     ncn tests against (spec/deblock-target-contract.json).
 *
 * ⛔ ncn MUST MIRROR BOTH SETS (the ncn half of build-order steps 2/3 comes next). fr cannot
 * see ncn in CI; the contract fixture is the byte-level handshake.
 */

/**
 * The card types whose DONE must be backed by a COMPUTED pass (card_computed_checks), never
 * by liveness, an LLM judge or a human sign-off alone.
 *
 *   bug_analysis, security_analysis — QA chain is seeker-only, so no computed QA runs at all;
 *       they cannot reach DONE until the proof bug-gate grid (q4f/qv + R10) is armed.
 *   code_quality_analysis           — QA is the LLM judge (not computed).
 *   development_bug_fix             — legacy; the only type that passes AA_CQ_GUARD today.
 */
export const PROOF_SUBSET_CARD_TYPES: readonly string[] = Object.freeze([
  'bug_analysis',
  'code_quality_analysis',
  'security_analysis',
  'development_bug_fix',
]);

/**
 * U-PS-KIND (PSD §7): the two project-START card types join the proof subset, so their DONE
 * needs a `start_plan_checks` computed pass instead of liveness/judge QA.
 *
 * ⛔ BEHIND A DEFAULT-OFF FLAG, `PROJECT_START_COMPUTED_CHECKS` (exactly 'true', case-
 * insensitive, enables). Joining is NOT behaviour-neutral for live cards — every live start
 * card would change on all four consumers of {@link isProofSubsetCardType}:
 *   1. DONE guard (services/done-guard.ts) — a start card could no longer reach DONE without
 *      a start_plan_checks pass, and NOTHING writes that kind yet (writer = U-PS-TOKEN);
 *   2. deblock (deblock-actions.ts coverageTarget) — an approved COVERAGE with 0 rejections
 *      goes to QA (to earn the pass) instead of straight to DONE;
 *   3. break-glass DONE (routes/kanban/break-glass-done.ts) — start cards become eligible
 *      (override row, counted by CAP E2) instead of 400 not_proof_subset;
 *   4. create-into-DONE (routes/cards/improvement.ts) — a start card can no longer be minted
 *      straight into a DONE-family list (409 done_without_computed_check).
 * Turn it on only when (a) the U-PS-TOKEN writer is armed and (b) ncn's approval-callback
 * mirrors the QA deblock target. A dedicated flag, NOT PROJECT_START_TEMPLATE_REQUIRED: the
 * entry gate and the computed DONE gate arm on different preconditions.
 *
 * {@link PROOF_SUBSET_CARD_TYPES} stays the flag-OFF set: it is what the ncn contract fixture
 * (spec/deblock-target-contract.json) is generated from, so the fixture is unchanged.
 */
export const PROJECT_START_COMPUTED_CHECKS_ENV = 'PROJECT_START_COMPUTED_CHECKS';
export const PROJECT_START_CARD_TYPES: readonly string[] = Object.freeze([
  'project_start_request_analysis',
  'feature_start_request_analysis',
]);
export function projectStartComputedChecksEnabled(): boolean {
  return (process.env[PROJECT_START_COMPUTED_CHECKS_ENV] ?? '').trim().toLowerCase() === 'true';
}

/** The proof subset IN FORCE now: the base set, plus the start types when the flag is on. */
export function effectiveProofSubsetCardTypes(): readonly string[] {
  return projectStartComputedChecksEnabled()
    ? [...PROOF_SUBSET_CARD_TYPES, ...PROJECT_START_CARD_TYPES]
    : PROOF_SUBSET_CARD_TYPES;
}

export function isProofSubsetCardType(cardType: unknown): boolean {
  return typeof cardType === 'string' && effectiveProofSubsetCardTypes().includes(cardType.trim());
}

/**
 * The card types whose QA exit has a COMPUTED gate are the TENANT's RM card types carrying
 * one of the computed-gate rules (`repo_write` / `container_read_exec` / `setup`,
 * services/catalogue/card-type-rules.ts — was ncn's vendored `coding_card_types.json`). For
 * these ncn's `AA_CQ_GUARD` is authoritative and the judge/liveness have NO effect.
 *
 * A RECLASSIFY from a proof-subset type to a type NOT computed-gated would let the card reach
 * DONE through a judge or liveness QA — refused with `reclassify_escapes_computed_gate`.
 */
export const RECLASSIFY_ESCAPES_COMPUTED_GATE = 'reclassify_escapes_computed_gate' as const;

/**
 * Does approving this RECLASSIFY move a proof-subset card OUT of the computed gate?
 * Pure. `sourceCardType` is the approval's stored `metadata.card_type`; an absent or
 * non-proof source is never refused here (the rule is about the PROOF subset).
 */
export function reclassifyEscapesComputedGate(input: {
  sourceCardType: unknown;
  newCardType: unknown;
  /** The tenant catalogue's computed-gate predicate (card-type-rules.ts isComputedGatedCardType). */
  isComputedGated: (cardType: unknown) => boolean;
}): boolean {
  if (!isProofSubsetCardType(input.sourceCardType)) return false;
  return !input.isComputedGated(input.newCardType);
}

// The DONE family of Planka list names is NOT defined here: it is the shared predicate
// `isDoneEquivalentListName` (lib/done-equivalent.ts), which every DONE consumer imports.

/**
 * The NON-DONE terminal list a DROP lands in. Measured 2026-10-05 (kanban DB on worker4,
 * BEGIN READ ONLY): every live board has exactly TODO/READY/DOING/QA/BLOCKED/DONE active lists
 * plus Planka's nameless system `archive`/`trash` lists; no ARCHIVE/DROPPED/CANCELLED/WONTFIX
 * active list exists. Planka's `archive` list was rejected as the target: it is nameless
 * (the receiver's `normalize()` cannot resolve it), fr's kanban reads hide it, and
 * `GET /api/lists/:id` 404s on it (workers/deblock-callback-redelivery.ts DEGRADED_STRIKES),
 * so neither side could see or verify a dropped card. A dedicated active list is added to
 * the board template (RM default board template — services/catalogue/board-template.ts) instead.
 */
export const DROPPED_LIST_NAME = 'DROPPED' as const;
