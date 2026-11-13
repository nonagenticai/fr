// src/lib/approval-rationale.ts
//
// The approver-facing rationale fields — `approvals.change_summary` and
// `approvals.impact_analysis` — and the ONE rule that governs both:
//
//   ⛔ fr NEVER writes a rationale it was not given, and NEVER hides the fact
//      that it was not given one.
//
// ── THE MEASUREMENT ───────────────────────────────────────────────────────────
// RE-MEASURED 2026-09-03 06:52 UTC against prod `fr` (bare-metal postgres on
// worker4). Every figure is a COUNT with its denominator, taken at that instant.
//
// ⚠️ It replaces an earlier set of numbers that stood in this header and were
// WRONG in three specific ways. The corrections are spelled out below rather
// than quietly overwritten, because each wrong number made a different claim
// look stronger than the evidence supported.
//
// Pending queue by kind:
//
//   kind                      total   change_summary empty   impact_analysis empty
//   generic                     971            970                    971
//   execution.ready_signoff     242             46                     43
//   improvement.design           22             21                     22
//
// Whole pending queue: 1,235 rows, of which 1,037 carry no `change_summary` and
// 1,032 carry neither field. That — not "818 of 918" — is the population that
// reads to an approver as though the question were fully posed.
//
// The cohorts have DIFFERENT causes and needed different fixes:
//
//  (1) `generic` — **970 of 971**, NOT 961 of 961. The one row that breaks the
//      universal is the row that disproves it: `aa11a001-0000-7aa1-8aa1-
//      000000000a01` is `source='web'`, minted by the human self-service path in
//      `routes/approvals.ts`, and it carries real prose. The other 970 are
//      `source='n8n'` from `POST /api/webhooks/n8n/card-approval`, whose zod
//      schema is a closed `z.object()` that never listed these two keys and
//      whose insert never wrote them: the fields were **NEVER WRITTEN**, so a
//      producer that DID send a rationale got a 201 and fr silently dropped it
//      (`z.object()` strips unknown keys). Fixed by accepting + persisting them
//      there. Stating it as 961/961 turned "one route is broken" into "no other
//      route can even be involved", which is false and is exactly the kind of
//      universal that stops anyone looking for the counter-example.
//
//  (2) `execution.ready_signoff` — that route has accepted and persisted both
//      fields since the #262-of-262 fix, and where its producer sends prose it
//      works. But the earlier claim "273 of 275 `evidence_gap` rows in the last
//      72h carry real prose" was wrong twice over. Re-measured over the same
//      72h window: **402 `evidence_gap` rows, 292 with prose — 110 carry none,
//      not 2.**
//
//      And it is a **CUTOVER, NOT A RATE**. By day (`evidence_gap` rows with
//      prose / total):
//
//        2026-08-30   0 / 58
//        2026-08-31   0 / 121
//        2026-09-01  54 / 71
//        2026-09-02 169 / 170
//        2026-09-03  69 / 70     (partial day, to 06:52 UTC)
//
//      A single 72h average smears a producer that started emitting rationales
//      on 2026-09-01 into a steady 96%-healthy state that never existed. Nothing
//      of ANY kind carried a `change_summary` on 2026-08-31 (0 of 299 rows), so
//      the "it works" half of this claim is 2 days old, not a standing property.
//      Do not quote a rate here; quote the cutover.
//
//      The empty ones are **WRITTEN EMPTY** because their producer sends nothing.
//      The `decision_authoring_gap` link is real but the earlier "69 of 72" was
//      measured on a **contaminated denominator**: 40 of those 72 rows are from
//      2026-08-31, a day on which 0 of 299 rows of any kind and any gate term
//      carried a `change_summary` — so on 40 of the 72 the gate term explains
//      nothing, the cutover does.
//
//      Isolated to 2026-09-01, the first day the producer emitted anything, the
//      effect survives and is large:
//
//        decision_authoring_gap rows          3 of 32 with prose   (9%)
//        evidence_gap WITHOUT that term      54 of 67 with prose  (81%)
//
//      So the claim stands and the evidence is now the right evidence: on those
//      cards the decisions author produced ZERO decisions, so there IS no worker
//      rationale upstream to carry. It is not a transport bug.
//
// ── WHY A SENTINEL AND NOT NULL ───────────────────────────────────────────────
// The previous rule was `?? null`, argued (correctly) against `?? ''`: the
// frontend renders these on a truthiness check
// (`approvals/[id]/+page.svelte:161`, `projects/[id]/approve/[approvalId]`,
// `NeedsYouQueue.svelte:332`), so `''` draws an EMPTY heading — a proposition
// that looks answered and says nothing.
//
// But NULL picks the other failure. It renders NOTHING AT ALL, so the approver
// cannot distinguish "the producer supplied no reasoning" from "this kind of
// approval has no reasoning section". On a governance surface those are not the
// same fact, and only one of them should make a human refuse to decide. An
// invisible absence is why 1,032 of the 1,235 pending rows read as though the
// question were fully posed (measured 2026-09-03 06:52 UTC; an earlier "818 of
// 918" in this file was a stale snapshot quoted without its timestamp).
//
// So: a non-empty, non-fabricated statement of absence that NAMES THE PRODUCER.
// It keeps the `''`-is-forbidden property (never a blank heading), it makes the
// gap visible to the approver, and it makes the gap greppable so the producer
// can be chased. It asserts exactly one thing, which is true: nothing was sent.
//
// ⛔ WHAT THIS MODULE MUST NEVER DO: derive a rationale from the description,
// the gate terms, the risk factors, or anything else lying around. A summary
// synthesised from adjacent material would let an approver believe they have
// the worker's reasoning when they have fr's paraphrase of a defect narrative.
// That is worse than the empty field it replaces. If the producer sent nothing,
// the honest output is "nothing was sent" — and the fix belongs in the producer.

/** The two approver-facing rationale columns. `action_name` is not rendered. */
export type RationaleField = 'change_summary' | 'impact_analysis';

const FIELD_LABEL: Record<RationaleField, string> = {
  change_summary: 'change summary',
  impact_analysis: 'impact analysis',
};

/**
 * Stable, greppable marker. Every honest-absence value starts with it, so
 * "how many approvals carry no producer rationale?" is one `LIKE` away and can
 * never be confused with a real summary that happens to mention absence.
 */
export const NO_RATIONALE_MARKER = '[no-rationale-supplied]';

/**
 * The inverse of the marker, and the reason it needs one.
 *
 * `isNoRationaleSupplied()` is a `startsWith` test, so ANY producer text that
 * itself begins with `NO_RATIONALE_MARKER` would be stored verbatim and then
 * read back by every consumer as ABSENCE. That is not hypothetical: a re-raise
 * that carries a prior approval's stored fields forward hands fr its own
 * absence value back as "producer content", and a producer echoing an earlier
 * row does the same. The result is the exact inversion of this module's
 * purpose — real producer content replaced by "No summary supplied" and the
 * review prompt suppressed.
 *
 * So on the WRITE path a colliding value is neutralised rather than stored
 * as-is: every producer byte is kept, verbatim, after this prefix. The stored
 * value therefore no longer starts with the absence marker, and round-trips as
 * CONTENT — which is what it is.
 *
 * ⛔ Neutralise, do NOT reject. Rejecting at the boundary would 4xx a producer
 * for sending real prose and drop the whole approval, which is a worse failure
 * than a prefixed heading. And do NOT strip the marker: a value that is exactly
 * the marker would strip to `''`, i.e. content in / absence out — the very
 * inversion this exists to close.
 */
export const PRODUCER_VERBATIM_MARKER = '[producer-verbatim]';

/**
 * True when a producer-supplied value would be indistinguishable from fr's own
 * statement of absence once stored. Exported so the write path and its tests
 * name the same predicate.
 */
export function collidesWithAbsenceMarker(value: string): boolean {
  return value.startsWith(NO_RATIONALE_MARKER);
}

/** The producer identifiers fr can truthfully attest to — the mint route. */
export const RATIONALE_PRODUCERS = {
  /** routes/webhooks.ts :: handleN8nCardApproval */
  cardApproval: 'the n8n card-approval producer (POST /api/webhooks/n8n/card-approval)',
  /** routes/execution-approvals.ts :: handleCreateExecutionApproval */
  readySignoff: 'the n8n ready-signoff producer (POST /api/execution/approvals)',
} as const;

/**
 * The value written when a producer supplies no rationale for `field`.
 *
 * Deliberately says only what fr knows: that nothing arrived, and from whom.
 * It does not guess why, and it does not stand in for the missing reasoning.
 */
export function noRationaleSupplied(field: RationaleField, producer: string): string {
  return (
    `${NO_RATIONALE_MARKER} No ${FIELD_LABEL[field]} was supplied by ${producer}. ` +
    'fr records the producer\'s own words and synthesises nothing, so this approval ' +
    'carries no worker rationale for this field — decide from the description and the ' +
    'linked card, or send it back to the producer.'
  );
}

/**
 * The single write-path gate for both rationale columns.
 *
 * A supplied value is passed through VERBATIM (trimmed only). Anything absent —
 * `undefined`, `null`, `''` or whitespace-only — becomes the honest-absence
 * value. Never returns `null` and never returns `''`.
 *
 * The ONE case where the stored bytes are not exactly the producer's: a value
 * that would collide with `NO_RATIONALE_MARKER` at position 0 is prefixed with
 * `PRODUCER_VERBATIM_MARKER` so it reads back as content. Nothing is dropped,
 * reordered or paraphrased — the producer's text follows the prefix unchanged.
 * A marker occurring anywhere but the start is harmless and left alone.
 */
export function rationaleOrAbsence(
  supplied: string | null | undefined,
  field: RationaleField,
  producer: string,
): string {
  const trimmed = typeof supplied === 'string' ? supplied.trim() : '';
  if (trimmed.length === 0) return noRationaleSupplied(field, producer);
  return collidesWithAbsenceMarker(trimmed)
    ? `${PRODUCER_VERBATIM_MARKER} ${trimmed}`
    : trimmed;
}

/**
 * True when a stored value is fr's honest-absence marker rather than producer
 * content. Readers (dashboards, the triage ladder, a producer-gap report) must
 * branch on this instead of on emptiness, which no longer occurs going forward.
 *
 * ⚠️ Exact only for rows written through `rationaleOrAbsence` AFTER the
 * collision guard above landed. Rows written before it could, in principle,
 * hold producer text starting with the marker; those rows are indistinguishable
 * and are deliberately NOT rewritten (no backfill, no migration).
 */
export function isNoRationaleSupplied(value: string | null | undefined): boolean {
  return typeof value === 'string' && value.startsWith(NO_RATIONALE_MARKER);
}

// ---------------------------------------------------------------------------
// UNDECIDABLE REASONS — issues #888 and #890
// ---------------------------------------------------------------------------
//
// `rationaleOrAbsence` above handles a MISSING rationale. This handles the
// harder case: a reason that is PRESENT, non-empty, and still impossible to
// decide on. Two producers were measured doing it, and both rows reached a
// human looking like content:
//
//   #888  "BLOCK REASON [unknown_no_reason_persisted, source=placeholder-no-evidence]:
//          No reason provided"
//         — 8 of 10 pending rows carried this verbatim. The row asks "Approve to
//         execute the proposed action" WITHOUT saying why the card blocked.
//         341 approvals expired unanswered (up from 218).
//
//   #890  'Author worker error: 500 INTERNAL_ERROR "Connection error."'
//         — 6 pending rows, identical text. A crashed worker laundered into a
//         human-facing question. "The worker crashed" is not a proposition a
//         human can approve or reject.
//
// Both consume approver attention and TTL while being structurally
// unanswerable. This route ALREADY refuses to mint an approval nobody can be
// TOLD about ("a 24-hour timer, not a gate" — 316 of 362 named no one). An
// approval nobody can ANSWER is the same defect seen from the other end, so it
// gets the same treatment: a loud 422 to the producer, which is recoverable,
// instead of a silent timer that strands the card.
//
// ⚠️ DELIBERATELY CONSERVATIVE. A false positive here refuses a REAL gate and
// strands a card — strictly worse than the problem being solved. So:
//   * placeholder detection keys on MACHINE TOKENS the producer emits
//     (`placeholder-no-evidence`, `unknown_no_reason_persisted`), which cannot
//     occur in prose, plus a small set of whole-value "no content" phrases;
//   * error detection only fires when the reason STARTS as an error report.
//     A legitimate reason that merely MENTIONS an error ("the build hit 500
//     INTERNAL_ERROR, approve to retry") is decidable and must pass.
// When in doubt this returns null and the approval is minted.

export type UndecidableReasonClass = 'empty' | 'placeholder' | 'upstream_error';

/** Machine tokens a producer emits when it had nothing to say. Not prose. */
const PLACEHOLDER_TOKENS = [
  'placeholder-no-evidence',
  'unknown_no_reason_persisted',
] as const;

/** Whole-value phrases that carry no information, after prefix stripping. */
const EMPTY_PHRASES =
  /^(no reason (?:provided|given|persisted)|not provided|unknown|none|n\/?a|null|undefined|[-–—]+)\.?$/i;

/** `BLOCK REASON [...]:` and friends — a wrapper, not content. */
const REASON_PREFIX = /^\s*[A-Z][A-Z _-]{2,}\s*(?:\[[^\]]*\])?\s*:\s*/;

/**
 * Fires only when the value IS an error report, not when it mentions one.
 *
 * ⚠️ The label must be followed by a COLON. An earlier form matched any leading
 * `<word> error`, which classified "Connection error handling was removed in
 * this diff — is that intended?" as an upstream failure. That is a decidable
 * question about a real diff, and refusing it would have stranded the card —
 * the false-positive direction, which is worse than the bug being fixed. Caught
 * by the "a real gate is NEVER refused" cases, which exist for exactly this.
 */
const STARTS_AS_ERROR =
  /^\s*(?:[\w-]+\s+){0,3}?(?:error|exception|traceback|stack\s*trace)\s*[:\-–—]|^\s*[45]\d{2}\s+[A-Z][A-Z_]{3,}\b/i;

/**
 * Why this reason cannot be decided on, or null when it can be.
 *
 * Callers refuse the mint and name the class back to the producer, so the
 * defect surfaces where it originates instead of in a human's queue.
 */
export function classifyUndecidableReason(
  value: string | null | undefined,
): UndecidableReasonClass | null {
  const trimmed = typeof value === 'string' ? value.trim() : '';
  if (trimmed.length === 0) return 'empty';

  const lower = trimmed.toLowerCase();
  if (PLACEHOLDER_TOKENS.some((t) => lower.includes(t))) return 'placeholder';

  // Strip one wrapper prefix before asking whether anything remains.
  const body = trimmed.replace(REASON_PREFIX, '').trim();
  if (body.length === 0) return 'placeholder';
  if (EMPTY_PHRASES.test(body)) return 'placeholder';

  if (STARTS_AS_ERROR.test(body)) return 'upstream_error';

  return null;
}
