// src/lib/computed-kind-table.ts
//
// THE kind ↔ card-type TABLE for the computed-pass store (card_computed_checks). ONE table,
// enforced at BOTH ends (coordinator ruling, ARM blocker; design
// ~/.claude/plans/program/20-designs/bhs-completeness-record-2026-10-06.md, "kind↔card-type"):
//
//   RECEIVER  routes/internal-computed-checks.ts refuses a write whose card's card_type does not
//             allow the kind: 422 { error: 'kind_not_allowed_for_card_type', card_type, check_kind }.
//   DONE GUARD services/computed-checks.ts latestComputedChecksPerKind reads, for EACH KIND
//             ALLOWED FOR THE CARD'S TYPE, that kind's own latest verdict; a pass of ANY allowed
//             kind counts. A kind not allowed for the type neither satisfies the guard nor
//             shadows a right-kind verdict, and within a multi-kind row one kind's later
//             verdict never shadows another kind's pass (per-kind rule, 2026-10-06).
//
// STRUCTURE: card_type → SET of allowed kinds. CONTENT (decided r17, 2026-10-06): exactly the
// kinds each type's LIVE writers produce. An allowed kind with no live writer is a standing
// permission — so a kind is added to a row only by the unit that arms its writer (e.g. "enable
// grid DONE" adds grid_qa_computed and decides replace-vs-add). Because the guard judges each
// kind by its own latest verdict, a multi-kind row would not reopen the latest-of-any-kind hole.
// (The old-layer hunt-sweep row and its two kinds are REMOVED: that card type is not in RM's
// v3 vocabulary.)
//
// An EMPTY set, or a card type ABSENT from this table, means no computed pass can ever count:
// the DONE guard refuses (fail closed) and the receiver refuses every write.
//
// Measured evidence for the conditional rows (2026-10-06, ncn origin/main eb4790ef3):
//   - code_smell_refactoring, development_security_patch: in AA_CODING_CARD_TYPES
//     (AA_IMPLEMENTATION/coding_card_types.json repo_write ⇒ fr COMPUTED_GATED_CARD_TYPES) AND
//     legacy verify-coding plans hard computed ops for them
//     (AA_IMPLEMENTATION/coding_qa_hard_ops.json hard_ops.<type>) ⇒ {verify_coding}.
//     Neither is in fr's PROOF subset, so the DONE guard never reads this row for them; the row
//     only governs what the receiver accepts.
//   - security_analysis: in AA_CODING_CARD_TYPES (container_read_exec) but
//     coding_qa_hard_ops.json lists it under signoff_only ("verify-coding plans no verifier") ⇒
//     legacy verify-coding produces no computed verdict for it ⇒ {}.
//
// The (now archived) R10 grader vendors this table: {@link computedKindTableJson} is its JSON-serialisable shape.

// ⛔ NO COMMENTS INSIDE THE `COMPUTED_CHECK_KINDS` LITERAL. The (archived) asset-evaluator R10 grader's
// re-vendor parser (src/services/project_run/verdict/kind_table.py parse_fr_table) splits that literal's body on
// commas and refuses any element that is not a plain single-quoted kind, so a comment there made the re-vendor
// (`check_kind_table_drift --fr-ref origin/main --write`) fail to parse — measured. Keep the shape stable: the
// archived copy is still the record of how the table is consumed.
// Comment lines ARE allowed inside the ALLOWED_KINDS_BY_CARD_TYPE block below; rows must keep the
// exact `  <type>: Object.freeze([...] as const),` shape (no conditional / spread rows).
//
// `start_plan_checks` — U-PS-KIND (PSD §7): the project-start plan checks, re-run by the start
// card's DOING.

/** Every check_kind the receiver accepts. The receiver's body enum IS this list. */
export const COMPUTED_CHECK_KINDS = [
  'verify_coding',
  'r10_proof_core',
  'grid_qa_computed',
  'start_plan_checks',
] as const;
export type ComputedCheckKind = (typeof COMPUTED_CHECK_KINDS)[number];

/** card_type → the kinds whose verdict counts for it. Frozen; never mutated at runtime. */
export const ALLOWED_KINDS_BY_CARD_TYPE: Readonly<Record<string, readonly ComputedCheckKind[]>> = Object.freeze({
  development_bug_fix: Object.freeze(['verify_coding'] as const),
  code_smell_refactoring: Object.freeze(['verify_coding'] as const),
  development_security_patch: Object.freeze(['verify_coding'] as const),
  // quality-rebuild (owner): grid_qa_computed only, added when its writer lands; r10_proof_core NOT allowed.
  bug_analysis: Object.freeze([] as const),
  // legacy QA is judge-only and never counts.
  code_quality_analysis: Object.freeze([] as const),
  // verify-coding is sign-off only for it (measured, see header).
  security_analysis: Object.freeze([] as const),
  // U-PS-KIND (PSD §7). INERT until armed: the DONE guard reads these rows only for
  // proof-subset types, and the start types join that subset only under the default-OFF flag
  // PROJECT_START_COMPUTED_CHECKS (domain/engagement/proof-subset.ts); the receiver accepts the
  // kind only from FR_COMPUTED_CHECK_START_TOKEN (unset ⇒ nobody), and refuses a `pass` until
  // U-PS-TOKEN defines its evidence rule.
  project_start_request_analysis: Object.freeze(['start_plan_checks'] as const),
  feature_start_request_analysis: Object.freeze(['start_plan_checks'] as const),
});

/**
 * Kinds the receiver accepts that appear in NO row today, each with the reason. A kind must be
 * in a row OR here (the extension point).
 */
export const KINDS_WITHOUT_A_ROW: Readonly<Partial<Record<ComputedCheckKind, string>>> = Object.freeze({
  grid_qa_computed: 'no live writer yet; the "enable grid DONE" unit adds it per card type',
  r10_proof_core: 'no live writer (the asset-evaluator R10 grader is retired); not allowed for bug_analysis (quality-rebuild owner ruling)',
});

/** The kinds that count for `cardType` (empty for an unknown / absent type — fail closed). */
export function allowedKindsForCardType(cardType: string | null | undefined): readonly ComputedCheckKind[] {
  if (typeof cardType !== 'string') return [];
  const key = cardType.trim();
  return Object.prototype.hasOwnProperty.call(ALLOWED_KINDS_BY_CARD_TYPE, key) ? ALLOWED_KINDS_BY_CARD_TYPE[key]! : [];
}

export function isKindAllowedForCardType(cardType: string | null | undefined, kind: string): boolean {
  return (allowedKindsForCardType(cardType) as readonly string[]).includes(kind);
}

/** The vendorable shape (plain JSON): what the R10 grader copies, with a drift check on its side. */
export function computedKindTableJson(): {
  kinds: string[];
  allowed_kinds_by_card_type: Record<string, string[]>;
} {
  const rows: Record<string, string[]> = {};
  for (const t of Object.keys(ALLOWED_KINDS_BY_CARD_TYPE).sort()) rows[t] = [...ALLOWED_KINDS_BY_CARD_TYPE[t]!];
  return { kinds: [...COMPUTED_CHECK_KINDS], allowed_kinds_by_card_type: rows };
}
