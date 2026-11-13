// Frontend mirror of the backend `backend/src/lib/approval-rationale.ts` — the
// ONE thing a renderer needs to know about `approvals.change_summary` /
// `approvals.impact_analysis`:
//
//   ⛔ NON-EMPTY IS NO LONGER THE SAME AS "THE PRODUCER SAID SOMETHING".
//
// Since 2026-09-03 the backend never writes NULL or '' to those two columns. A
// producer that supplied nothing gets fr's marked, producer-naming statement of
// absence instead, so the approver can SEE that no rationale was sent rather
// than seeing a section that silently isn't there. That was the whole point:
// an invisible absence is why 1,032 of the 1,235 pending approvals read as
// though the question were fully posed (prod, measured 2026-09-03 06:52 UTC).
//
// The cost is that every `{#if approval.impact_analysis}` in this app became
// ALWAYS TRUE. Read literally, that turns a disclosure into a lie:
// `approvals/[id]/+page.svelte` told every approver "✦ Review the impact
// analysis below before deciding" about an impact analysis whose entire content
// is fr saying there isn't one, and padded the headline with ~333 characters of
// boilerplate. Worse than the empty field it replaced.
//
// So a reader branches on `isNoRationaleSupplied()`, never on truthiness —
// which is exactly what the backend module's own comment already required and
// nothing implemented. Three shapes exist and they are NOT interchangeable:
//
//   producer content  → render it; it is the worker's reasoning.
//   absence marker    → SAY nothing was supplied; never treat it as content,
//                       never count it as "there is something to review".
//   null / '' / absent→ legacy rows written before the backend change, plus
//                       every route still on `?? null`. Render nothing, as
//                       before. This case does not go away and must not be
//                       assumed extinct.
//
// ⚠️ MIRRORED CONSTANT. `NO_RATIONALE_MARKER` must stay byte-identical to
// `backend/src/lib/approval-rationale.ts :: NO_RATIONALE_MARKER`. It is a
// stable, deliberately un-prose-like sentinel precisely so that it can be
// matched from another runtime without shipping the backend module here; the
// backend pins it.

/**
 * Stable, greppable marker. Every honest-absence value the backend writes
 * starts with it. Kept in lockstep with the backend constant of the same name.
 */
export const NO_RATIONALE_MARKER = '[no-rationale-supplied]';

/**
 * True when a stored rationale is fr's marked absence rather than something a
 * producer actually wrote.
 */
export function isNoRationaleSupplied(value: string | null | undefined): boolean {
	return typeof value === 'string' && value.startsWith(NO_RATIONALE_MARKER);
}

/**
 * The producer's own words, or `null` when there are none — whether that is the
 * absence marker, a legacy NULL, or an empty/whitespace-only legacy value.
 *
 * This is the truthiness test every renderer wanted all along: `if
 * (producerRationale(x))` means "a human wrote something here", which is the
 * question a "review the impact analysis" prompt or a headline suffix is really
 * asking. It is NOT a visibility test — a surface that shows the absence to the
 * approver must use `isNoRationaleSupplied` for that, on the same value.
 */
export function producerRationale(value: string | null | undefined): string | null {
	if (typeof value !== 'string') return null;
	if (isNoRationaleSupplied(value)) return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? value : null;
}

/**
 * Compact absence label, for surfaces with no room for the marker's full
 * sentence (queue rows, gate chips). The full text — which names the producer
 * so the gap can be chased — stays on the detail views that have the space.
 *
 * Deliberately says WHO did not supply it rather than just "none": "—" or a
 * blank is the invisible absence this whole change exists to remove.
 */
export const NO_RATIONALE_SHORT = 'No summary supplied by the producer';

// ---------------------------------------------------------------------------
// UNREADABLE PRODUCER OUTPUT — the second way a stored string says nothing
// ---------------------------------------------------------------------------
//
// The absence above is the case where the producer sent NOTHING. This is the case
// where it sent something and that something is a stringified bug: `[object Object]`
// (a template literal interpolating an object) and `step undefined` (a template
// literal interpolating a missing index), often in runs —
// "step undefined, step undefined, step undefined".
//
// ⚠️ THE PRODUCER WAS FIXED AT SOURCE; THESE ROWS WERE NOT. Stored strings do not
// heal, and 184 PENDING rows still carry `[object Object]` today. A renderer that
// waits for the data to age out is a renderer that shows a defect token to every
// decider in the meantime.
//
// ⛔ AND THE FIX IS NOT TO HIDE IT. fr stores producer output VERBATIM on purpose —
// `question.ts :: parseProposition` carries the rule in capitals ("REAL DESCRIPTIONS
// CARRY A PRODUCER BUG AND THIS PARSER MUST NOT HIDE IT") — because the rendered
// string is the only place a reader can see that the upstream is emitting garbage.
// So the three forbidden repairs are:
//
//   silent blank      → re-creates the invisible absence this whole module exists
//                       to remove, and additionally erases the evidence.
//   a guess           → "step 3" for "step undefined" invents a fact nobody measured.
//   strip and move on → the worst of the three: the surrounding prose then reads as
//                       COMPLETE, so the decider believes they have the whole
//                       sentence and never learns a value was lost.
//
// What is done instead: each unreadable token — and ONLY the unreadable token — is
// replaced by a marker that SAYS a producer value was unreadable. One marker per lost
// value, so six unreadable list items render as six markers and the reader can still
// count them. Every legible character around them is preserved, including the
// separators between them, and a string with no defect is returned byte for byte, so
// this is a no-op on the healthy population.

/**
 * What the decider sees in place of ONE unreadable producer token — one marker per
 * value lost, never one per run.
 *
 * Square-bracketed and producer-naming, in the same register as
 * {@link NO_RATIONALE_SHORT}: it is obviously an editorial insertion rather than the
 * worker's own words, and it states WHOSE output failed so the gap can be chased.
 */
export const UNREADABLE_OUTPUT_MARKER = '[unreadable output emitted by the producer]';

/**
 * One unreadable token.
 *
 * ⛔ THE HARD CONSTRAINT IS THE FALSE POSITIVE, NOT THE FALSE NEGATIVE. A token
 * this formatter misses still renders exactly as it did before this module existed —
 * ugly, honest, and visible to the decider. A token it invents DELETES a sentence
 * the worker actually wrote and replaces it with an accusation that the producer
 * emitted garbage, which is the same class of harm as the "strip and move on" repair
 * forbidden above, pointing the other way. The header promises this is "a no-op on
 * the healthy population" and returns clean input "byte for byte"; both halves below
 * are narrowed until that promise is true. `rationale.test.ts` § E1b is the control.
 *
 * ⚠️ CASE-SENSITIVE THROUGHOUT. An earlier cut compiled the whole pattern with `/i`
 * and mangled three measured strings of ordinary approval prose:
 * `"This documents step undefined behaviour in the C parser."`,
 * `"we use [object storage] for blobs"` and `"JavaScript [Object Notation]"`. Case
 * is not incidental here — it is the discriminator, in both alternatives.
 */

/**
 * `[object Tag]` — `String(someObject)`, i.e. `Object.prototype.toString`.
 *
 * That method emits a FIXED SHAPE: the literal lower-case word `object`, one space,
 * then a capitalised tag. The tags seen in practice from this call site are
 *
 *   Object · Undefined · Null · Array · String · Number · Boolean · Function ·
 *   Symbol · BigInt · Date · RegExp · Error · Promise · Map · Set · WeakMap ·
 *   WeakSet · ArrayBuffer · DataView · Arguments · Math · JSON ·
 *   GeneratorFunction · AsyncFunction · Generator · Window · HTMLDocument · Module
 *
 * — all pinned by name in `rationale.test.ts` § E3b, which is where an enumeration
 * can actually go red. The pattern itself deliberately accepts ANY capitalised tag
 * rather than only those 29:
 *
 *   • a `Symbol.toStringTag` value, and any host object the list never heard of
 *     (`[object Response]`, `[object HTMLDivElement]`), is the SAME defect from the
 *     SAME call site, so a closed list rots into a silent false negative — the tag
 *     nobody listed prints raw to the decider and nothing goes red;
 *   • and widening to any capitalised tag costs nothing against real prose, because
 *     the thing that protects prose is NOT the tag. It is the lower-case literal
 *     `object`. Check it against the two measured near-misses: `[object storage]`
 *     has the literal but a lower-case tag, and `[Object Notation]` has a
 *     PascalCase tag — indistinguishable from a real one — but a capital `O` on
 *     `Object`. Neither can match, and the second is why a naive "PascalCase tag"
 *     rule is not enough on its own.
 *
 * An all-lower-case `[object object]` is likewise NOT matched: `toString` always
 * capitalises the tag, so that spelling is a human writing about the bug.
 */
const OBJECT_COERCION = String.raw`\[object [A-Z][A-Za-z0-9_$]*\]`;

/**
 * `step undefined` — `` `step ${idx}` `` with a missing index.
 *
 * ⚠️ THE BARE PHRASE IS NOT A DEFECT SIGNAL. "step undefined" is a grammatical
 * English fragment and appears inside legible sentences about undefined behaviour,
 * about skipping a step, and about this very bug. So the PRODUCER CONTEXT is
 * required rather than the words:
 *
 *   the coercion ENDS a value or a clause — it is the whole stored string, the end
 *   of a line or list item, or is followed by punctuation or by a run separator
 *   leading to ANOTHER unreadable token ("step undefined, step undefined").
 *   Legible prose does the opposite: it runs on into a further WORD
 *   ("step undefined behaviour", "step undefined case", "step undefined-ly").
 *
 * So the discriminator is a TRAILING boundary, expressed as a lookahead. Leading
 * prose is normal and deliberately not constrained — "Retry failed at step
 * undefined" is a real stored value and must still be marked.
 *
 * ⚖️ WHAT THIS DELIBERATELY DOES NOT DECIDE. "This documents step undefined." —
 * prose before, a full stop after — is shaped exactly like the genuine
 * "Retry failed at step undefined." and no local rule can separate them. It is
 * matched, i.e. the residual ambiguity is resolved towards marking. That is the
 * narrowest case left and it is stated here rather than hidden: the sentence in the
 * auditor's report ("…step undefined behaviour in the C parser.") does NOT end
 * there and so does not match.
 *
 * `[Ss]tep` rather than a `/i` flag: the only real case variation is
 * sentence-initial capitalisation, and `String(undefined)` is always the lower-case
 * `undefined`, so spelling the variation out keeps `[object …]` case-sensitive.
 * `\b`-anchored at both ends so it cannot bite into `Sidestep undefined` or
 * `step undefinedly`.
 */
const STEP_UNDEFINED = String.raw`[Ss]tep[ \t]+undefined`;

/**
 * `step ?` — the SAME `` `step ${idx}` `` template with the same missing index, in a
 * producer that renders the absent value as `?` rather than as the string `undefined`.
 *
 * ⭐ MEASURED, not anticipated. Fleet-wide over the 1,349 pending rows (worker4
 * `fr`.`public`, 2026-09-15): six rows carry a raw `step ?` — five in tenant `…0003`,
 * one in `…0001` — all in `description`, all `kind=generic` / `source=n8n` with a live
 * `PROPOSED_ACTION: RETRY`. In every one the token sits inside the FIRST 200
 * CHARACTERS, so it prints raw in the QUEUE PREVIEW, not merely on a detail page a
 * decider chose to open.
 *
 * It is one lost value, exactly as `step undefined` is, so it takes the SAME marker.
 * A second marker spelling would tell the decider the two rows differ in something
 * that matters, and they do not: both say a producer value could not be read.
 *
 * ⚖️ THE RESIDUAL AMBIGUITY, STATED RATHER THAN HIDDEN — the same disclosure
 * {@link STEP_UNDEFINED} makes for "This documents step undefined.". A French-spaced
 * interrogative ("at which step ?") is shaped identically to the producer token and is
 * resolved TOWARDS marking. The cost is bounded by the required `[ \t]+`: English
 * approval prose writes "step?" closed up, which does not match at all.
 *
 * ⛔ A FOURTH SHAPE IS DELIBERATELY NOT COVERED: two rows
 * (`1ab3837d-61f3-4efa-9418-8c26c03fdeb3`, `635d5710-4a91-4cf4-a824-fb889ad99f8d`)
 * end their token list in a bare, truncated `st`. It is left raw on purpose. A bare
 * two-letter fragment carries no case rule, no bracket, no fixed shape — the ONLY
 * thing marking it as a defect is its position, and position is not a discriminator
 * the way the lower-case literal `object` and the trailing boundary are. Worse, the
 * marker would assert a fact nobody measured: a token cut short by a length limit is
 * a TRUNCATION, and printing "unreadable output emitted by the producer" over it
 * names the wrong cause. Two rows are not worth putting the 184 `[object Object]`
 * and 56 `step undefined` rows at false-positive risk; raw and honest is the
 * documented fallback for an uncovered token.
 */
const STEP_QUESTION = String.raw`[Ss]tep[ \t]+\?`;

/**
 * Either spelling of a missing step index, as one token.
 *
 * ⚠️ THE TRAILING `\b` LIVES ON THE BRANCH, NOT AROUND THE GROUP, AND THAT IS
 * LOAD-BEARING. `\b` asserts a word/non-word transition, so `undefined\b` correctly
 * refuses `step undefinedly` — while a `\b` placed after `?` would demand that a WORD
 * character follow the token, i.e. it would match only the strings this pattern most
 * needs to exclude. Callers therefore wrap this in a LEADING `\b` only (which guards
 * `Sidestep ?` for both branches) and let each branch close itself.
 */
const STEP_MISSING_INDEX = String.raw`(?:${STEP_UNDEFINED}\b|${STEP_QUESTION})`;

/** End of value, end of line, or clause punctuation — never another word. */
// \u2013 / \u2014 are the en and em dash, written as escapes rather than as literal
// characters so the class cannot be misread as a range in a proportional font.
//
// ⭐ `|` IS IN THIS CLASS, AND ITS ABSENCE WAS THE DEFECT. The producers that emit
// these rows format a block reason as PIPE-DELIMITED FIELDS —
// `… | failed step(s): step undefined | reasoning issues: …` — so `|` terminates a
// value here exactly as `,` and `;` do. Measured live on `approvals`
// (worker4 `fr`.`public`, 2026-09-15): with `|` missing, `249c846b-…` was the LAST
// row in the whole estate still rendering a raw token, on both its `description` and
// its `change_summary`. It costs nothing against prose for the same reason the rest
// of the class does: `|` is not a word, and the thing this lookahead exists to
// exclude is a token that runs on INTO a word.
const STEP_BOUNDARY = String.raw`[ \t]*(?:$|[\r\n.,;:!?)\]}"'|\u2013\u2014])`;

/**
 * The two run separators that are NOT clause punctuation: `and`, the one separator
 * made of letters, and bare whitespace. Neither is a boundary on its own, so each
 * only counts when A FURTHER UNREADABLE TOKEN follows it. That lookahead is the
 * whole safety argument — it is what keeps "step undefined and the retry never
 * fired" out, because `the` is not a token.
 *
 * ⚠️ `and` is OPTIONAL rather than required, which is a deliberate widening over the
 * first cut. With it mandatory, `step undefined\tstep undefined` could not OPEN a run:
 * the first token is followed by a tab and then a word, so the strict boundary failed,
 * and the regex went on to match the SECOND token alone at end-of-value. That printed
 * `step undefined<TAB>[marker]` — a raw token standing beside a marker, which is the
 * precise harm § E3c forbids. Bare adjacency is weak evidence by itself; adjacency
 * PLUS a following unreadable token is the same evidence `and` already carried.
 */
const STEP_RUN_AHEAD = String.raw`[ \t]*(?:and[ \t]*)?(?:${STEP_MISSING_INDEX}|\[object [A-Z])`;

const STEP_COERCION = String.raw`\b${STEP_MISSING_INDEX}(?=${STEP_BOUNDARY}|${STEP_RUN_AHEAD})`;

const UNREADABLE_TOKEN = `(?:${OBJECT_COERCION}|${STEP_COERCION})`;

/**
 * The same token, with the TRAILING-boundary requirement dropped.
 *
 * ⛔ USED IN EXACTLY ONE PLACE: the INNER marking pass of
 * {@link markUnreadableProducerOutput}, over a span the outer pattern has ALREADY
 * proven to contain nothing but unreadable tokens and the separators between them.
 * It is not part of {@link UNREADABLE_RUN_SOURCE} and must not be put back into it.
 *
 * ⚠️ IT WAS IN THE RUN PATTERN, ON THE `,` / `;` BRANCH, AND THAT WAS A FALSE-POSITIVE
 * SOURCE WITH NOTHING TO SHOW FOR IT. The argument for it was that a token preceded by
 * `…, ` inside a run already has producer context from the left, so it need not also
 * end at a boundary. The argument is coherent, and it is the SAME argument that was
 * rejected for `and` one branch down — `,` is simply punctuation a human also writes.
 * What settles it is not the argument but the measurement, in two halves:
 *
 *   • COST, constructed: `[object Object], step undefined semantics are documented
 *     upstream` had its second clause deleted and replaced with an accusation that the
 *     producer emitted garbage. That is the § E1b harm exactly, and § E1b is the
 *     control this module says it will not fail.
 *   • BENEFIT, measured: ZERO. Over all 1,961 live tokens (worker4 `fr`.`public`,
 *     2026-09-15) the relaxed and the strict branch mark the IDENTICAL 1,961 tokens.
 *     Not one live token needs it.
 *
 * The reason the benefit is zero is the fix above: the only token the relaxation ever
 * rescued was the one whose trailing character was `|`, and `|` is now a boundary in
 * its own right. The relaxation was a workaround for the missing separator, and once
 * the separator is named the workaround is pure false-positive surface.
 */
const UNREADABLE_TOKEN_IN_RUN = String.raw`(?:${OBJECT_COERCION}|\b${STEP_MISSING_INDEX})`;

/**
 * A RUN of them: consecutive tokens separated by nothing but spaces/tabs and at most
 * one `,` / `;` / `and`.
 *
 * ⛔ A RUN IS NOT COLLAPSED TO ONE MARKER, AND THE EARLIER REQUIREMENT THAT IT SHOULD
 * BE WAS WRONG. Measured live on `/approvals/b2ddf71e-…` (2026-09-15): a stored
 * `failed step(s): step undefined ×6` rendered as `failed step(s): [marker]`. Six
 * values became one, the sentence read as COMPLETE, and nothing on the screen said
 * anything had been lost. That is the third forbidden repair in the header —
 * "strip and move on" — reached by a different road: the reader believes they have
 * the whole list. "Three markers in a row is noise" was a legibility argument, and it
 * was allowed to outrank the module's governing rule, which is that the marker must
 * never make damaged output read as intact. Repetition is honest; a lost count is not.
 *
 * So the run is still DETECTED — it is what supplies the producer context above — and
 * every token inside it is marked WHERE IT STOOD, separators and all. Six unreadable
 * items render as six markers in a six-item list, so the reader can count them.
 *
 * ⛔ EVERY BRANCH USES THE STRICT TOKEN — there is no relaxed branch and there must
 * not be one. Each token of a run ends at a separator (`,` `;` `|`) or at the end of
 * the value, so each one satisfies the trailing boundary on its own and the run needs
 * no help. A branch that dropped the requirement would buy no live token (measured: 0
 * of 1,961) and would let "[object Object], step undefined semantics are documented
 * upstream" delete a clause a human wrote — the false positive § E1b exists to forbid.
 * See {@link UNREADABLE_TOKEN_IN_RUN} for the measurement that removed it.
 *
 * ⚠️ Deliberately does NOT cross a newline: two unreadable values on two different
 * lines are two separate losses and are marked separately.
 */
const UNREADABLE_RUN_SOURCE =
	`${UNREADABLE_TOKEN}(?:` +
	`[ \\t]*[,;][ \\t]*${UNREADABLE_TOKEN}` +
	`|[ \\t]*and[ \\t]*${UNREADABLE_TOKEN}` +
	`|[ \\t]*${UNREADABLE_TOKEN}` +
	`)*`;

// Two compiled copies on purpose: a `/g` regex carries `lastIndex` across calls, so a
// shared instance used for both `.test()` and `.replace()` silently skips matches on
// alternate invocations.
//
// ⛔ NEITHER CARRIES `/i`, AND THAT IS THE FIX, NOT AN OVERSIGHT. Both alternatives
// above encode their own case rules — the lower-case literal `object` plus a
// capitalised tag, and `[Ss]tep` — so re-adding the flag would re-break all three
// prose strings § E1b pins.
const UNREADABLE_RUN_ONCE = new RegExp(UNREADABLE_RUN_SOURCE);
const UNREADABLE_RUN_ALL = new RegExp(UNREADABLE_RUN_SOURCE, 'g');

/**
 * Every token INSIDE an already-matched run. Safe to use relaxed and global here and
 * nowhere else: the span it is applied to has just been proven to be nothing but
 * unreadable tokens and the separators between them, so there is no prose in it to
 * mis-hit.
 */
const UNREADABLE_TOKEN_IN_RUN_ALL = new RegExp(UNREADABLE_TOKEN_IN_RUN, 'g');

/**
 * The string as it should be shown to a decider: every unreadable TOKEN replaced by
 * {@link UNREADABLE_OUTPUT_MARKER}, everything else — including the separators
 * between the tokens of a run — untouched.
 *
 * ⛔ ONE MARKER PER LOST VALUE. Not one per run: a reader must be able to COUNT how
 * many values were unreadable, and a count that is silently dropped is worse than the
 * repetition it saves. See {@link UNREADABLE_RUN_SOURCE}.
 *
 * ⛔ A FORMATTER, NOT A CLASSIFIER. It answers "how do I print this", never "is there
 * content here" — `producerRationale` owns that question and must still be asked
 * first on the two rationale columns. A non-string returns `''` (what Svelte renders
 * for `null` anyway); it does NOT return `null`, so it can never be mistaken for the
 * absence contract above.
 */
export function markUnreadableProducerOutput(value: string | null | undefined): string {
	if (typeof value !== 'string') return '';
	// The negative control, in the implementation: nothing to mark ⇒ the original
	// reference, unmodified, byte for byte.
	if (!UNREADABLE_RUN_ONCE.test(value)) return value;
	// Outer pass finds the run (producer context); inner pass marks each token inside
	// it in place, so the list keeps its length and its separators.
	return value.replace(UNREADABLE_RUN_ALL, (run) =>
		run.replace(UNREADABLE_TOKEN_IN_RUN_ALL, UNREADABLE_OUTPUT_MARKER),
	);
}
