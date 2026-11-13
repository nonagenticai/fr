// One-time, OPERATOR-PACED data repair: clear the LEGACY `callback_delivered_at`
// stamp from the approvals that migration 113 deliberately left behind.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHY THIS EXISTS — AND WHY IT IS A SCRIPT AND NOT A MIGRATION
// ═══════════════════════════════════════════════════════════════════════════════
// `migrations/113_approval_callback_effect_marker.sql` fixed the SEMANTICS of
// `callback_delivered_at` forward: since 113 it means "the card actually left
// BLOCKED", and its ONLY writer is `resolveRow` in
// `src/workers/deblock-callback-redelivery.ts`, which stamps it in the SAME
// UPDATE that writes `callback_resolution = 'moved'`.
//
// Before 113 the same column was stamped on n8n's 2xx TRANSPORT ACK, by
// `services/n8n-callback.ts::deliverDecisionCallback`. Those rows carry a stamp
// that asserts an effect nobody ever observed.
//
// And `callback_delivered_at IS NULL` is half of the re-delivery worker's
// candidate predicate (`candidateWhereBase`, deblock-callback-redelivery.ts).
// So a pre-113 ack permanently retired its row from the ONLY repair path there
// is. Cards behind an already-decided approval sit in BLOCKED, invisible.
//
// ⭐ THE WORKER'S PREDICATE IS CORRECT AND THIS SCRIPT DOES NOT TOUCH IT. The
// defect is in the historical DATA, not in the query that reads it.
//
// ⛔ AND 113 REFUSED TO DO THIS ITSELF, IN AS MANY WORDS. Its header:
//
//     "AND IT DELIBERATELY DOES NOT CLEAR `callback_delivered_at`. Clearing it
//      would return all 373 rows to the worker's population in one tick — the
//      exact outbound burst at Planka that produced the 504s. The 216 stuck rows
//      are an OPERATOR-APPROVED, separately paced data repair."
//
// This file is that repair, and PACING IS ITS ENTIRE REASON FOR EXISTING. That
// is why `--limit` is MANDATORY with `--apply` and has NO DEFAULT: a repair that
// can be run without choosing a batch size is the migration 113 refused to write.
//
// ⛔ `--limit` IS PRIMARY PACING — AND THE EARLIER WORDING HERE, "`--limit` IS THE
// ONLY PACING THAT CAN BE RELIED ON", IS RETRACTED AS STALE. ⚠️ EVERY CLAIM BELOW
// CARRIES THE REF IT WAS MEASURED ON, BECAUSE THE TWO REFS DISAGREE:
//
//   * ON `origin/main` (18cf9986, measured 2026-09-10) THERE IS NO TWO-LANE SPLIT
//     AT ALL. The worker has ONE candidate scan: `MAX_READS_PER_RUN` = 40 rows a
//     tick over a page-aligned rotating `scanOffset`, a send budget of
//     `MAX_PER_RUN` = 10, and a tick deadline (`DEBLOCK_REDELIVERY_TICK_DEADLINE_MS`,
//     60_000 ms default). Grepping 18cf9986 for `FAST_LANE_READS`,
//     `FAST_LANE_DEADLINE_SHARE`, `selectFreshCandidates`, `selectBacklogCandidates`
//     and `FRESH_WINDOW_MS` returns NOTHING.
//
//   * ON `refs/pull/1083/head` (109f5fcb, measured 2026-09-10) the split exists AND
//     carries a TIME reserve: `FAST_LANE_DEADLINE_SHARE` = 0.5. The fast lane may
//     START a row only while `now < tickStart + 0.5 * budget`, so the backlog walk
//     ENTERS its loop with half the tick still unspent whatever a fresh read cost —
//     plus a floor that attempts the FIRST row of EACH lane unconditionally. With
//     that merged the backlog receives >= 1 repair per tick unconditionally, and
//     about half the budget in practice.
//     ⛔ BUT PR #1083 IS **OPEN, NOT MERGED** (checked 2026-09-10: state OPEN, head
//     branch `fix/ui-defect-wave`; `origin/main` is 18cf9986, which does not contain
//     it). A briefing that said it had merged is exactly why this paragraph names a
//     ref for every sentence. Re-check before relying on the reserve.
//
// ⭐ AND SAY THIS PLAINLY, BECAUSE THE NEXT READER WILL FIND THE SMALL NUMBER AND
// ASSUME IT PROTECTS THEM: THE FAST LANE'S **COUNT** RESERVE — `LIMIT
// FAST_LANE_READS`, 5, against `MAX_PER_RUN` 10 — WAS INERT UNDER LOAD AND IS NOT
// THE MECHANISM. `deliverAll` breaks on the TICK DEADLINE as well as on
// `MAX_PER_RUN`, so at the ~11 s per card read a degraded Planka actually costs,
// five fresh reads consume the entire 60 s tick and the backlog is never reached AT
// ALL. A reserve denominated in SEND SLOTS cannot bind a run that stops on TIME.
// #1083's own adversarial audit measured that and the deadline share is its fix.
//
// ⇒ SO `--limit` REMAINS PRIMARY, for a reason no worker change can take away: it
// is the only thing that bounds the POPULATION RELEASED. Every mechanism in the
// worker bounds what is DRAINED per tick; only `--limit` bounds how much is put in
// front of it. The batch size is LOAD-BEARING SAFETY, not a convenience.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE POPULATION — MEASURED, SELECT-ONLY, ON PROD (worker4 `fr`) 2026-09-10T12:25Z
// ═══════════════════════════════════════════════════════════════════════════════
// ⚠️ EVERY NUMBER BELOW CARRIES ITS TIMESTAMP AND ITS STATUS FILTER, because a
// count of this population means nothing without both. Do NOT compare it to a
// figure measured over `approved` alone.
//
//   rows matching the signature .............. 500   statuses: approved + voided
//   distinct cards behind them ............... 341
//   rows with no card_id ....................... 0
//     by status:  approved 429 rows / 273 cards
//                 voided    71 rows /  69 cards
//                 rejected   0 rows            <-- see the notARejectedHold note
//   oldest / newest `callback_delivered_at` .. 2026-09-05T11:58:21Z /
//                                              2026-09-06T14:51:29Z
//   oldest / newest `completed_at` ........... 2026-08-25T11:43:55 /
//                                              2026-09-06T05:10:06
//
// ⛔ 500 RESTS ON THAT ONE CENSUS AND NOTHING ELSE. IT IS NOT CORROBORATED. AN
// EARLIER VERSION OF THIS HEADER CLAIMED IT WAS, AND THAT CLAIM IS RETRACTED HERE.
//
// The retracted claim: migration 113's receipt on this database reads
// `{"backfilled_rows": 500}` (`_migration_effects`, recorded 2026-09-06T15:12:09Z),
// and the exact match was read as two independent measurements taken from opposite
// ends agreeing. ⛔ IT IS NOT A SECOND MEASUREMENT. 113's receipt counts the rows
// its own backfill CTE touched:
//
//     UPDATE approvals SET callback_acked_at = callback_delivered_at
//      WHERE callback_delivered_at IS NOT NULL AND callback_acked_at IS NULL
//
// and 113 **ADDED** `callback_acked_at` — and `callback_resolution` — IN THAT SAME
// FILE (`ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, ~60 lines above the backfill).
// Both columns were therefore NULL on EVERY row in the table at the instant the
// receipt was computed, so `AND callback_acked_at IS NULL` excluded nothing and the
// receipt is a bare count of `callback_delivered_at IS NOT NULL` — which is this
// file's signature with a term that could not yet discriminate. IT IS THE SAME ROWS
// BY A DIFFERENTLY-WORDED PREDICATE. The agreement was guaranteed to be exact
// BEFORE anyone ran either query, and would have been just as exact had the census
// been wrong. That is CONSTRUCTION, not confirmation, and a construction dressed as
// a control is worse than no control.
//
// ⚠️ AND 113'S OWN HEADER QUOTES 373 AND 216 (both in the block quoted above; its
// lines 19-20 read "of 373 callbacks delivered in the last 30h, 373 of 373 (253
// distinct cards) are STILL IN BLOCKED. 216 approved-but-..."). Those are a THIRD
// and a FOURTH figure for something close to this population, over a 30-hour window
// this file cannot restate the filters for. Add the inherited "287 blocked / 268
// unreachable" — measured a day earlier by a query that ALSO joined live Planka
// blockedness, which this census does not filter on at all — and there are FIVE
// unreconciled counts. NOTHING HERE RECONCILES THEM AND NOTHING HERE SHOULD:
// NEGATIVE CONTROL 2 measures blockedness separately, live, and reports it as its
// own number rather than folding it into the population. Anyone reconciling 500 to
// 268 must state which filter they added, not average them.
//
// ⇒ ⛔ THE OPERATOR RE-MEASURES BEFORE APPLYING, AND TRUSTS NO INHERITED NUMBER —
// INCLUDING THE 500 ON THIS PAGE. Run the DRY RUN first, read the census it prints,
// and derive `--max-population` from THAT, taken minutes earlier on the database
// being written. `--max-population` is MANDATORY with `--apply` precisely because
// the population figure now rests on a single census: the ceiling is the only guard
// left on it.
//
// ═══════════════════════════════════════════════════════════════════════════════
// WHAT THE REPAIRED ROWS DO NEXT — the worker lane they land in
// ═══════════════════════════════════════════════════════════════════════════════
// Measured against fr#1083 (`refs/pull/1083/head`, df027c96 — NOT on origin/main,
// which is 18cf9986; that PR carries a DO NOT MERGE from its own audit, so its
// head will move. Read for understanding; do not rebase onto it):
//
//   * `FRESH_WINDOW_MS` = `ACK_GRACE_MS + 2 * DEFAULT_INTERVAL_MS` = 45 minutes.
//     ⭐ ZERO of the 500 completed inside 24 hours (71 inside 7 days; newest
//     `completed_at` is 2026-09-06T05:10). EVERY REPAIRED ROW LANDS IN THE
//     BACKLOG LANE, and none can ever enter the fresh lane: `completed_at` is
//     immutable and already days old. The fast lane's `LIMIT 5` therefore does
//     not pace this repair — it COMPETES with it for the tick.
//   * `notARejectedHold` excludes `status = 'rejected'` rows that carry a
//     `metadata.deblock_action` — a rejected BLOCKED-exit PROPOSITION, held in
//     BLOCKED by design. ⭐ MEASURED: **0 of the 500 are `rejected` at all**, so
//     that clause excludes NONE of them. (292 of the 429 approved rows do carry
//     a `deblock_action`; the clause does not fire on `approved`, only on
//     `rejected`, so they are unaffected.)
//   * With the stamp cleared, all 500 satisfy #1083's `candidateWhereBase`
//     (status in the set, `callback_resolution IS NULL`, `card_id IS NOT NULL`,
//     `callback_path IS NOT NULL`, ack grace elapsed) — verified by running that
//     predicate against the live table: 500 of 500 would become selectable.
//
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE SIGNATURE — AND WHY IT CANNOT FALSE-POSITIVE A POST-113 ROW
// ═══════════════════════════════════════════════════════════════════════════════
//
//     callback_delivered_at IS NOT NULL AND callback_resolution IS NULL
//
// Post-113, `resolveRow` is the only writer of `callback_delivered_at` and it
// writes `callback_resolution` in the SAME statement. A row can therefore hold a
// post-113 stamp only WITH a resolution. A stamp with NO resolution is, by
// construction, a stamp written by code that predates 113.
//
// ⚠️ THAT ARGUMENT IS A PROOF ABOUT THE CODE, NOT A MEASUREMENT OF THE DATA, and
// the two are different claims. `NEGATIVE CONTROL 1` below measures it — see the
// long comment there for why the obvious phrasing of that control is a TAUTOLOGY
// and what this file measures instead.
//
// ⛔ THE SIGNATURE IS NOT WIDENED AND IT IS NOT NARROWED. It is not narrowed to
// the worker's other candidate terms (`status IN ('approved','voided')`,
// `callback_path IS NOT NULL`) because clearing a legacy stamp on a row the
// worker would not select anyway is a no-op, while a narrowing here would be a
// second, unmeasured population definition for a future reader to reconcile.
//
// ═══════════════════════════════════════════════════════════════════════════════
// ⭐ THE TIME TERM — AND WHY THE SIGNATURE ALONE IS NOT A LICENCE TO WRITE
// ═══════════════════════════════════════════════════════════════════════════════
// THE SIGNATURE SELECTS THE ROWS WITH A LEGACY STAMP. IT DOES NOT SELECT THE ROWS
// IT IS SAFE TO REPAIR, and the gap between those two sets is roughly half.
// Measured on prod 2026-09-11:
//
//   signature only ........................... 496 approvals / 338 cards
//   signature AND decided AFTER the block .... 262 approvals / 260 cards
//   the difference ........................... 234 approvals / 165 cards
//
// Those 234 completed BEFORE their card's CURRENT block began. The card is in
// BLOCKED for something NEWER; the old decision has nothing to say about it.
//
// ⛔ AND RE-DELIVERY IS NOT A PURE UNBLOCK, which is why this is a GATE and not a
// warning. `workers/deblock-callback-redelivery.ts:11-24` records that the n8n
// receiver is NOT IDEMPOTENT — `Parse Decision` computes `shouldMoveCard` without
// reading the card's current list, and `Move Card` is an unconditional
// `card.update{listId}`. The worker's ONLY protection is that it sends solely for a
// card CURRENTLY IN BLOCKED (`:31`), which a wrongly-re-blocked card satisfies. So
// repairing those 234 would move LIVE cards out of BLOCKED and re-send a stale
// decision body against work nobody decided.
//
// So every frozen candidate must clear `approvals.completed_at > blocked_since(card)`
// before the UPDATE may address it. `blocked_since` is the most recent `moveCard`
// into BLOCKED — see `gateByBlockStart` for the term, `blockedSince` for the read.
//
// ⚠️ IT IS NOT A SQL TERM AND CANNOT BE ONE. `blocked_since` lives in the KANBAN
// database — a different database on worker4 with no dblink and no FDW installed —
// and fr holds exactly one drizzle client. The same paragraph that makes NEGATIVE
// CONTROL 2 a JS loop applies verbatim: the only place blockedness exists is Planka,
// so the term is evaluated over the FROZEN BATCH through Planka's own
// `/api/cards/:id/actions`, like every other Planka read in this file.
//
// ⛔ IT FAILS CLOSED, LOUDLY. If the term cannot be evaluated the run REFUSES
// (`block-gate-unavailable`, exit 1) and writes nothing. A silent fallback to the
// signature alone would be STRICTLY WORSE than today, because it would look safe.
//
// ═══════════════════════════════════════════════════════════════════════════════
// THE ID FREEZE
// ═══════════════════════════════════════════════════════════════════════════════
// ⛔ THIS SCRIPT NEVER ISSUES `UPDATE ... WHERE <the signature>`. The signature is
// over a MUTABLE field: the live re-delivery worker writes `callback_resolution`
// on every tick, and `deliverDecisionCallback` writes `callback_acked_at`. A row
// can enter or leave the signature between the SELECT that measured it and the
// UPDATE that repairs it. So the ids are SELECTed into an explicit list first and
// the UPDATE addresses that list by primary key and nothing else.
//
// The cost of the freeze is stated rather than hidden: a row that LEFT the
// signature between the freeze and the write still gets its `callback_delivered_at`
// cleared. That is bounded and self-cancelling — the only way to leave the
// signature is to acquire a `callback_resolution`, and `callback_resolution IS NULL`
// is also a term of the worker's own predicate, so a resolved row does not
// re-enter the worker's population regardless of its stamp.
//
// ═══════════════════════════════════════════════════════════════════════════════
// USAGE
// ═══════════════════════════════════════════════════════════════════════════════
//   # DRY RUN (the default) — measures, prints the ids, writes NOTHING:
//   bun run scripts/repair-legacy-deblock-delivered-stamp.ts
//
//   # ARM IT — `--limit` AND `--max-population` are BOTH MANDATORY here, and
//   # neither has a default:
//   bun run scripts/repair-legacy-deblock-delivered-stamp.ts \
//       --apply --limit 25 --max-population 520 --operator georgedekker
//
//   # WALK PAST A STUCK HEAD — `--after` AND `--after-id` TOGETHER (neither is
//   # optional) start the FREEZE past a slice the time term can never repair. The
//   # report of the previous run prints the exact pair, under "NEXT BATCH":
//   bun run scripts/repair-legacy-deblock-delivered-stamp.ts \
//       --apply --limit 25 --max-population 520 --operator georgedekker \
//       --after 2026-09-06T05:10:06.025665Z --after-id 1f0e…c3a2
//
// ⛔ COPY THAT PAIR VERBATIM. THE MICROSECONDS ARE LOAD-BEARING. `completed_at` is
// `timestamp` (microseconds) and the bulk writers stamp N rows with ONE SQL `now()`
// — measured on prod, 71 of 500 signature rows share `2026-09-06 05:10:06.025665`,
// 71 > MAX_LIMIT, and they sort LAST. A bound retyped to millisecond precision
// (`…06.025Z`) is STRICTLY LESS than every one of them, so the freeze re-selects
// the whole cluster and no batch can ever clear it: the walk ran to pass 30 freezing
// an identical 25 rows. Neither the report nor the CLI rounds any more — see
// `COMPLETED_AT_CURSOR_SQL` and `cursorFlag` — but a human retyping it can.
//
// ⛔ `--after` IS THE ONLY WAY THIS REPAIR FINISHES, AND IT IS DELIBERATELY MANUAL.
// The freeze reads the SIGNATURE; the UPDATE writes only rows that cleared the TIME
// TERM. A gate-excluded row is therefore never written, never leaves the signature,
// and — oldest-first — permanently occupies the head of the queue: 234 of the
// measured 500 can never become eligible. Without a bound past them every later run
// re-freezes the same batch and prints what a FINISHED repair prints. `--after` is
// a BOUND, not a scan ceiling, not an internal pager and not a stored cursor: all
// three would let ONE invocation touch a slice the operator did not choose, which
// is the property `--limit` exists to hold. See `freezeIdsSql`.
//
// Run it inside the fr-backend pod, which carries DATABASE_URL and the Planka
// credentials NEGATIVE CONTROL 2 reads.
//
// ⚠️ A DRY RUN WITH NO `--limit` FREEZES THE WHOLE POPULATION, AND NEGATIVE CONTROL
// 2 READS ONE PLANKA CARD PER FROZEN CARD. At the ~11 s/card a degraded Planka
// costs, a 341-card preview is ~1 hour of sequential reads against the very service
// whose 504s are this file's reason for existing. Pass `--limit` to a DRY RUN too
// when Planka is slow: the preview then costs exactly what the apply run will.
//
// EXIT CODES — "ran", "was refused" and "did something" are three different
// questions and get three different answers:
//   0  a dry run that measured cleanly, or an --apply run that cleared >= 1 stamp
//   1  REFUSED, or the run itself failed. Nothing was written. Covers: --apply
//      without --limit, --apply without --max-population, a bad --limit, a --limit
//      above MAX_LIMIT, the population over --max-population, NEGATIVE CONTROL 1
//      non-zero, NEGATIVE CONTROL 1 UNMEASURABLE, NEGATIVE CONTROL 1 VACUOUS
//      (a zero denominator), and THE TIME TERM UNAVAILABLE (`block-gate-unavailable`
//      — no Planka reader, or every gateable row in the batch came back with an
//      unreadable block start).
//   3  an --apply run whose batch had ELIGIBLE ids and cleared NOTHING.
//      ⚠️ ELIGIBLE, not frozen: a batch the TIME TERM emptied cleared nothing BY
//      DESIGN and exits 0.

import { sql } from 'drizzle-orm';

import { closeConnection, db as defaultDb } from '../src/db/client';
import { plankaClient } from '../src/services/planka';
import {
  BLOCK_ACTION_TYPE,
  MAX_ACTION_PAGES,
  plankaReaderFrom,
  type PlankaReader,
} from '../src/services/planka-card-state';
import { isBlockedList } from '../src/services/toc-hooks';

// ---------------------------------------------------------------------------
// Bounds and constants
// ---------------------------------------------------------------------------

/**
 * THE LEGACY SIGNATURE. Written ONCE, interpolated into every query that uses it.
 *
 * ⛔ A SECOND HAND-TYPED COPY IS THE DEFECT THIS CONSTANT EXISTS TO PREVENT. The
 * census, the negative controls and the id freeze must all be over the SAME
 * population; if the freeze silently widened (say, by losing the
 * `callback_resolution IS NULL` term) the census header would still print the
 * right number while the UPDATE cleared post-113 stamps.
 */
export const LEGACY_SIGNATURE = sql`callback_delivered_at IS NOT NULL
       AND callback_resolution IS NULL`;

/**
 * The migration whose receipt dates the semantic change.
 *
 * ⭐ Its `_migration_effects.recorded_at` is the CLOCK negative control 1 is
 * measured against. Not a hardcoded date: the instant 113's data effect actually
 * ran on THIS database, written by 113's own data-modifying CTE.
 */
export const MIGRATION_113 = '113_approval_callback_effect_marker.sql';

/** The only `callback_resolution` value that also stamps `callback_delivered_at`. */
export const POST_113_STAMPING_RESOLUTION = 'moved';

/**
 * Receipt key prefix in `_migration_effects`.
 *
 * ⚠️ `_migration_effects.migration` is a TEXT PRIMARY KEY, so one key = one row.
 * A PACED repair runs MANY times and each run is a separate effect with its own
 * id list, so the key carries the run instant. A bare prefix would let run 2's
 * receipt collide with run 1's — and 113/114/117 all use `ON CONFLICT DO NOTHING`,
 * which would silently DISCARD it. This file deliberately does NOT use
 * `ON CONFLICT DO NOTHING`: a colliding receipt must abort the statement (and with
 * it the UPDATE, in the same CTE) rather than write rows with no record of who
 * wrote them.
 */
export const RECEIPT_KEY_PREFIX = 'repair-legacy-deblock-delivered-stamp.ts';

/**
 * THE HARD CEILING ON ONE BATCH. `--limit` above this is REFUSED, not clamped.
 *
 * ⛔ AN UNBOUNDED `--limit` MAKES `--limit` A FORMALITY. `--apply --limit 500`
 * satisfies "you must choose a batch size" while releasing the ENTIRE measured
 * population in one go, with no warning — which is precisely the outbound burst
 * migration 113 refused to write and this file exists to avoid. A mandatory flag
 * whose legal values include "all of it" is not pacing, it is a typing exercise.
 *
 * ⭐ 50 IS TWO OF THE DOCUMENTED BATCH (25), NOT A ROUND NUMBER. The usage block
 * shows `--limit 25`; a ceiling at exactly the documented batch would refuse the
 * first operator who reasonably doubled it, and a ceiling ten times it would not
 * bound anything. 50 releases at most 10% of the measured 500-row population per
 * run and still needs >= 10 runs to finish, so the repair stays PACED by
 * construction rather than by the operator remembering to pace it.
 *
 * ⛔ REFUSED, NEVER CLAMPED. Silently lowering 500 to 50 would let an operator
 * believe they had released 500 and read the report as if they had; the number
 * they typed and the number that ran must be the same number or the run stops.
 */
export const MAX_LIMIT = 50;

// ---------------------------------------------------------------------------
// Queries. All four are exported so a test can read their emitted text.
// ---------------------------------------------------------------------------

/** Total rows carrying the legacy signature, and the cards behind them. */
export function censusSql() {
  return sql`
    SELECT count(*)::int                                        AS signature_rows,
           count(DISTINCT card_id)::int                         AS signature_cards,
           count(*) FILTER (WHERE card_id IS NULL)::int         AS signature_rows_without_card
      FROM approvals
     WHERE ${LEGACY_SIGNATURE}
  `;
}

/**
 * NEGATIVE CONTROL 1 — can the signature reach a row POST-113 code wrote?
 *
 * ⚠️ THE OBVIOUS PHRASING OF THIS CONTROL IS A TAUTOLOGY AND MUST NOT BE SHIPPED
 * AS EVIDENCE. "Count post-113 rows (`callback_resolution = 'moved'`) that the
 * signature matches" is `callback_resolution = 'moved' AND callback_resolution IS
 * NULL` — unsatisfiable in SQL, so it returns 0 on EVERY database, including one
 * where the signature is completely wrong. A control that cannot fail is not a
 * control; it is a green light wired to nothing.
 *
 * ⭐ SO THE CONTROL IS MEASURED ON A CLOCK INSTEAD, WHICH CAN FAIL. Post-113 the
 * only writer of `callback_delivered_at` is `resolveRow`, which always writes a
 * resolution alongside it. Therefore NO row may carry the signature with a stamp
 * dated at or after the instant 113's effect ran. If any does, the premise is
 * false — some other writer exists, or 113's rename did not do what its header
 * claims — and this script must not write.
 *
 * ⭐ AND IT SHIPS WITH ITS OWN DENOMINATOR. `post_113_stamped_rows` counts rows in
 * the POST-113 SHAPE (`callback_resolution = 'moved'` with a stamp). If that is
 * itself 0 the control above had no population to discriminate against and its
 * zero proves nothing — the report says so rather than reporting a clean pass.
 *
 * ⭐ MEASURED ON PROD 2026-09-10T12:25Z, AND IT IS NOT VACUOUS: the denominator
 * (`post_113_stamped_rows`) is **79**, so there is a real post-113 population to
 * discriminate against, and `signature_rows_stamped_post_113` is **0**. The margin
 * is not a rounding artefact either — the newest legacy stamp is
 * 2026-09-06T14:51:29Z and 113's effect ran at 2026-09-06T15:12:09Z, ~21 minutes
 * later, with nothing in between.
 *
 * ⛔ `migration_113_recorded_at` IS NULLABLE AND A NULL IS A REFUSAL, NOT A PASS.
 * With no receipt row the `>=` comparison is NULL for every row, the count is 0,
 * and an unmeasurable control would read exactly like a clean one. `runRepair`
 * refuses on the NULL.
 */
export function negativeControlOneSql() {
  return sql`
    SELECT (SELECT recorded_at FROM _migration_effects
             WHERE migration = ${MIGRATION_113})                AS migration_113_recorded_at,
           (SELECT count(*)::int FROM approvals
             WHERE callback_resolution = ${POST_113_STAMPING_RESOLUTION}
               AND callback_delivered_at IS NOT NULL)           AS post_113_stamped_rows,
           (SELECT count(*)::int FROM approvals
             WHERE ${LEGACY_SIGNATURE}
               AND callback_delivered_at >= (SELECT recorded_at FROM _migration_effects
                                              WHERE migration = ${MIGRATION_113}))
                                                                AS signature_rows_stamped_post_113
  `;
}

/**
 * The card ids behind the signature — the input to NEGATIVE CONTROL 2.
 *
 * DISTINCT because the control counts CARDS: several stranded approvals routinely
 * share one card, and reading the same card once per row would inflate every
 * bucket by the duplication factor.
 *
 * ⛔ IT ADDRESSES THE FROZEN ID LIST, NOT THE SIGNATURE, AND THAT IS THE WHOLE
 * POINT. This query used to be `WHERE <the signature>` with NO LIMIT, which meant
 * NEGATIVE CONTROL 2 walked all 341 cards of the population sequentially, on EVERY
 * run, dry or apply — at the ~11 s/card this file's own header cites, ~1 hour of
 * sequential reads against the very Planka whose 504s are this file's reason for
 * existing, per run, ×20 paced runs. The control is REPORTING; it must cost what
 * the batch costs, not what the population costs. Bounding it to the frozen ids
 * bounds it by `--limit` for free, and there is nothing left to say about the rows
 * this run will not touch.
 *
 * ⚠️ NO SIGNATURE TERM HERE, DELIBERATELY. The freeze already applied it; a second
 * copy would be a second thing to drift, and re-applying a MUTABLE predicate to a
 * frozen id list could report a different card set than the one being repaired.
 */
/**
 * The id list, spelled so drizzle actually binds it.
 *
 * ⛔ `ANY(${ids}::uuid[])` DOES NOT WORK and does not fail loudly enough to be
 * noticed. `PgDialect.sqlToQuery` expands a bound JS array into a ROW
 * CONSTRUCTOR, so that spelling renders as `ANY(($1, $2)::uuid[])` and Postgres
 * refuses it outright. Measured on prod `fr` 2026-09-10, with its own control:
 *
 *   ANY(('1111…','2222…')::uuid[])        -> ERROR: cannot cast type record to uuid[]
 *   IN ('1111…'::uuid, '2222…'::uuid)     -> 1
 *
 * `backend/scripts/check-any-bound-array.ts` now fails CI on the broken
 * spelling, which is how these two call sites were found — after this file had
 * already merged green, because that guard did not exist on main yet.
 *
 * The empty case is explicit: `IN ()` is a syntax error, so an empty id list
 * becomes `FALSE`. Every caller already treats an empty batch as a no-op, and
 * making it a runtime crash instead would be a worse answer than matching
 * nothing.
 */
function idsAsUuidList(ids: string[]) {
  if (ids.length === 0) return sql`FALSE`;
  return sql`id IN (${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export function signatureCardIdsSql(frozenIds: string[]) {
  return sql`
    SELECT DISTINCT card_id
      FROM approvals
     WHERE ${idsAsUuidList(frozenIds)}
       AND card_id IS NOT NULL
     ORDER BY card_id
  `;
}

/**
 * THE ID FREEZE. Oldest stranding first, so a partial repair reaches the
 * longest-stuck rows and the next run continues from where this one stopped.
 *
 * `limit` is the ONE bound value. `null` means "the whole population", which is
 * only ever reachable in a DRY RUN — `main` refuses `--apply` without `--limit`.
 */
/**
 * ⚠️ IT SELECTS `card_id` AND `completed_at` TOO, AND THEY ARE NOT DECORATION.
 * They are the two operands of THE TIME TERM (`gateByBlockStart`), which cannot be
 * a SQL term because its other operand lives in Planka — see `gateByBlockStart`.
 * A freeze that returned bare ids would force a second SELECT to re-read them,
 * i.e. re-reading a MUTABLE row after the freeze, which is the race the freeze
 * exists to remove.
 *
 * ⛔ `AT TIME ZONE 'UTC'` IS THE GATE'S CORRECTNESS, NOT TIDINESS, AND NO TEST IN
 * THIS REPO CAN CATCH ITS REMOVAL. `approvals.completed_at` is `timestamp WITHOUT
 * time zone` (`src/db/schema.ts`), i.e. oid 1114, and postgres.js parses EVERY date
 * oid with a bare `new Date(x)` (`node_modules/postgres/src/types.js`). A naive
 * `2026-08-25 11:43:55.123` handed to `new Date` is read as **LOCAL** time, while
 * the other operand — Planka's `action.createdAt` — is ISO-Z, i.e. true UTC. So the
 * gate silently compares a local-shifted instant against a UTC one: measured in
 * `bun -e`, the same naive string reads 09:43:55Z under TZ=Europe/Amsterdam. West
 * of UTC the shift moves `completed_at` LATER, which makes `completed_at >
 * blockStart` more likely true — it fails OPEN, the direction this whole file is
 * arranged against.
 *
 * ⚠️ AND IT IS INVISIBLE TO THE SUITE: `bun test` forces `TZ=UTC`, so every unit
 * test in this file passes with or without the cast. The pod happens to be UTC too
 * (`oven/bun:1.3.13`), which is luck, not a guarantee — it is one `TZ=` env away.
 * Casting in SQL makes the driver hand back oid 1184 with an explicit offset, so
 * the instant is right in every zone and does not depend on where this runs. The
 * only guard left is the static assertion on this statement's text in the unit
 * tests; do not delete it.
 *
 * ⭐ THE ORDER BY IS UNAFFECTED. The output alias shadows the column name, so it
 * sorts the cast value — and `timestamp AT TIME ZONE 'UTC'` is strictly monotonic
 * and maps NULL to NULL, so both the order and `NULLS LAST` are identical.
 */
/**
 * ⭐ `after` — THE OPERATOR-SUPPLIED CURSOR, AND THE ONLY WAY THIS REPAIR EVER
 * FINISHES.
 *
 * ⛔ WITHOUT IT THE SCRIPT DEADLOCKS ON ITS OWN EXCLUSIONS, and the report used to
 * say so and stop there. The freeze selects from the SIGNATURE ALONE; `repairSql`
 * only ever writes rows that cleared `gateByBlockStart`. A gate-excluded row is
 * therefore never written, never leaves the signature, and — being decided long
 * ago, in a freeze ordered OLDEST FIRST — sits permanently at the head of the
 * queue. Measured on prod 2026-09-10: 500 signature rows over 341 cards, of which
 * 234 can NEVER become eligible (`completed_at` is fixed and a block start only
 * moves forward). Once `MAX_LIMIT` of them fill the head, every future run freezes
 * the SAME batch, reports `0 eligible`, writes nothing and exits 0 — the report of
 * a finished repair, printed by a repair that can never start.
 *
 * ⭐ AND IT IS A BOUND, NOT A SCAN, NOT A PAGER, AND NOT A STORED CURSOR. The three
 * obvious alternatives were considered and are REFUSED, all three for the same
 * reason: the property at the top of this file that `--limit` is "the only thing
 * that bounds the POPULATION RELEASED".
 *   `--scan N` (look at N, release up to `--limit`) — the operator then chooses a
 *      release cap over a slice they did not choose, and N is a second, unbounded
 *      pacing dial wearing the word "scan".
 *   an internal paging loop — one invocation walks until it finds `--limit`
 *      eligible rows, so `--limit` stops bounding the SLICE EXAMINED and the run
 *      can reach the far end of the population in a single tick.
 *   a persisted auto-advancing cursor — the next run's slice is then chosen by the
 *      previous run's state, not by a human, and a wrong advance is invisible.
 * `--after` keeps BOTH numbers on the command line: the operator names the slice
 * AND its size, reads the report, and names the next one. `--limit` still caps the
 * frozen batch (test: `--after` never raises the frozen count above `--limit`).
 *
 * ⚠️ A NULL `completed_at` IS EXCLUDED BY ANY `--after`, AND THAT LOSES NOTHING
 * TODAY — but the mismatch that makes it true is REAL AND LATENT, so read this
 * before you make a NULL row repairable.
 *
 * ⛔ `NULLS LAST` and the keyset DISAGREE ABOUT WHERE A NULL SITS. The ORDER BY
 * sorts NULLs into the TAIL, i.e. *past* every cursor, while SQL row comparison
 * against NULL is NULL — not TRUE — so `(completed_at, id) > (bound, id)` filters
 * those same rows OUT of every cursored freeze. A NULL is therefore "after the
 * cursor" for ordering and "not after the cursor" for selection at the same time,
 * and a paced walk that only ever moves forward can never reach one. That is a
 * PERMANENT exclusion, not a skip the next bound recovers from.
 *
 * ⭐ IT COSTS NOTHING ONLY BECAUSE THOSE ROWS WERE NEVER REPAIRABLE ANYWAY.
 * `gateByBlockStart` has no decision instant to compare and buckets them
 * `noCompletedAt` → EXCLUDED (grep `census.noCompletedAt += 1` in
 * `gateByBlockStart` — ⚠️ NOT a line number: this file moves, and a stale `:886`
 * pointing into unrelated prose is how a reader concludes the claim is invented),
 * so the cursor excludes a set the gate
 * already excludes. Measured on prod 2026-09-10 over the exact signature:
 * `completed_at IS NULL` is **0 of 500 rows** — the intersection is empty today.
 * They remain reachable, as always, by an UNCURSORED run.
 *
 * ⚠️ SO THIS IS A COMMENT AND NOT MACHINERY, DELIBERATELY. A `NULLS FIRST` freeze,
 * a second NULL-only pass or a `completed_at IS NULL OR (…)` keyset would each add
 * a code path that repairs zero rows on today's data — untestable against prod and
 * unexercised in the walk. ⛔ IF THE GATE EVER LEARNS TO JUDGE A NULL
 * `completed_at`, THIS EXCLUSION STOPS BEING FREE and the cursor must grow a NULL
 * arm in the same change.
 *
 * ⭐ `id` IS MANDATORY, NOT A TIEBREAK. `completed_at` is not unique — the bulk
 * writers stamp N rows with ONE SQL `now()` (`src/workers/approval-expiry.ts:306`,
 * `src/lib/void-approvals.ts:190`), and the largest such cluster on prod is 71 rows
 * sharing `2026-09-06 05:10:06.025665`. A bare `--after <iso>` skips every row
 * sharing the bound instant, so it walks a paced repair straight past a cluster's
 * remainder; `>=` is no fix either, because a cluster larger than `--limit` can
 * then never be cleared and the walk re-freezes it forever. Only the
 * `(completed_at, id)` tuple — the same pair the ORDER BY sorts on — means
 * literally "the row after this one" and both skips nothing and always advances.
 * `cursorFlag` therefore REFUSES `--after` without `--after-id`.
 */
export interface FreezeCursor {
  /**
   * ⭐ AN OPAQUE INSTANT, CARRIED AS TEXT AND NEVER THROUGH A JS `Date`.
   *
   * ⛔ `approvals.completed_at` is `timestamp` — MICROSECONDS. A JS `Date` holds
   * MILLISECONDS by definition, so any round-trip through one (`toISOString()`,
   * `Date.parse`, `new Date(x)`) truncates `…:06.025665` to `…:06.025`, and
   * `.025 < .025665` is TRUE for every row in the cluster. The bound then re-selects
   * the very rows it was meant to advance past, and — since the cluster is bigger
   * than `MAX_LIMIT` — no batch can ever clear it. That is the SAME deadlock this
   * cursor exists to cure, one decimal place further down: measured on prod, 71 of
   * 500 signature rows sat behind exactly this and the documented operator walk did
   * not terminate (passes 18…30 froze an identical batch).
   *
   * So this field is whatever POSTGRES rendered (`freezeIdsSql`'s
   * `completed_at_cursor`) or whatever the operator typed, passed through
   * UNCHANGED and bound as `${…}::timestamptz`. Postgres parses it back at full
   * precision, which is the round-trip property: THE BOUND THE REPORT PRINTS, FED
   * STRAIGHT BACK IN, SELECTS STRICTLY PAST THE ROW IT NAMES.
   */
  completedAt: string;
  /** ⭐ MANDATORY. The second element of the keyset tuple. See the note above. */
  id: string;
}

/**
 * ⭐ THE CURSOR THE NEXT RUN IS HANDED, RENDERED BY POSTGRES AT MICROSECOND
 * PRECISION. The one output of the freeze that must NEVER pass through a `Date`.
 *
 * ⛔ THE SIBLING COLUMN `(completed_at AT TIME ZONE 'UTC') AS completed_at` CANNOT
 * SERVE AS THE CURSOR AND MUST NOT BE USED AS ONE. postgres.js decodes every date
 * oid with `new Date(x)` (`node_modules/postgres/src/types.js`), and a JS `Date`
 * is milliseconds — so that column arrives already truncated, before this file sees
 * it. It stays because the GATE needs a `Date` and truncation is harmless there:
 * `gateByBlockStart` compares `completed_at > blockStart` STRICTLY, and rounding an
 * instant DOWN can only make that comparison less likely to be true, i.e. it fails
 * CLOSED, the direction this whole file is arranged in. The cursor has no such
 * luxury — there, truncating down re-selects the row it names.
 *
 * ⚠️ `to_char`, NOT `::text`. `timestamptz::text` renders in the SESSION zone, so
 * the same row would print a different bound on a pod with a different `TZ` and the
 * printed walk would not be reproducible. `to_char` over the naive column emits the
 * stored digits and nothing else; the literal `Z` then DECLARES them UTC, which is
 * the same premise `AT TIME ZONE 'UTC'` one line up already rests on — the column
 * is `timestamp WITHOUT time zone` holding a UTC wall clock. `.US` is six digits,
 * zero-padded, which is exactly the column's resolution: `.MS` would silently
 * reintroduce the millisecond truncation in SQL instead of in JS.
 *
 * ⛔ AND THE OTHER HALF OF WHY THIS WORKS IS THE DRIVER, WHICH IS NOT VISIBLE HERE.
 * The six digits survive the round trip ONLY because drizzle binds the bound as a
 * plain parameter and bypasses postgres.js's cast-aware serializer. Measured live
 * on `postgres@3.4.7`, BOTH prepare modes:
 *
 *     raw postgres.js:  sql`SELECT ${'...025665Z'}::timestamptz`  ->  ...025+00
 *     the drizzle path: (what this file uses)                     ->  ...025665+00
 *
 * The driver truncates to milliseconds when IT owns the cast. So a refactor of
 * `freezeIdsSql` to a raw postgres.js template — an edit that looks like pure
 * tidying — silently restores the exact deadlock this cursor exists to cure: the
 * 71-row cluster at `2026-09-06 05:10:06.025665` becomes unreachable again and the
 * walk never terminates.
 *
 * ⚠️ NO TEST CAN CATCH THAT. The fake reads the bound as a plain string off the
 * statement, so it never exercises a driver serializer at all, and CI never runs
 * `.US` against a real Postgres — the only thing that has is a read-only replay
 * against prod. If you change how this query is issued, re-run that replay.
 */
const COMPLETED_AT_CURSOR_SQL = sql`to_char(completed_at, 'YYYY-MM-DD"T"HH24:MI:SS.US') || 'Z'`;

export function freezeIdsSql(limit: number | null, after: FreezeCursor | null = null) {
  // ⛔ THE KEYSET MUST BE WRITTEN AGAINST `(completed_at AT TIME ZONE 'UTC')`, NOT
  // AGAINST `completed_at`. The ORDER BY sorts the CAST value (the output alias
  // shadows the column), and a WHERE clause cannot see that alias — so a bare
  // `completed_at > $1` here would be a SECOND, UNCAST copy of the column, compared
  // against a timestamptz. Postgres would then coerce the bound instant back into
  // the SESSION zone to compare it, so the cursor would skip or re-freeze rows by
  // the session's UTC offset — silently, and never in a UTC test run. Same argument
  // as the cast itself, one clause down.
  //
  // ⛔ AND IT IS ALWAYS THE TUPLE. There is deliberately no bare-instant arm: see
  // `FreezeCursor.id`. Both operands stay uncoerced on the JS side, so the
  // comparison happens in Postgres at the column's own MICROSECOND resolution.
  const keyset =
    after === null
      ? sql``
      : sql`AND ((completed_at AT TIME ZONE 'UTC'), id)
             > (${after.completedAt}::timestamptz, ${after.id}::uuid)`;
  return sql`
    SELECT id, card_id, (completed_at AT TIME ZONE 'UTC') AS completed_at,
           ${COMPLETED_AT_CURSOR_SQL} AS completed_at_cursor
      FROM approvals
     WHERE ${LEGACY_SIGNATURE}
       ${keyset}
     ORDER BY completed_at NULLS LAST, id
     ${limit === null ? sql`` : sql`LIMIT ${limit}`}
  `;
}


/**
 * THE REPAIR AND ITS RECEIPT, IN ONE STATEMENT.
 *
 * ⭐ THE CTE IS LOAD-BEARING, for the reason 113, 114 and 117 all give: Postgres
 * runs a data-modifying WITH clause exactly once and always to completion, so the
 * receipt cannot land unless the UPDATE ran, and the UPDATE cannot land unless the
 * receipt did. Two statements would let a crash between them leave either an
 * unrecorded repair or a receipt for a repair that never happened.
 *
 * ⛔ THE UPDATE ADDRESSES A FROZEN ID LIST BY PRIMARY KEY. It carries NO copy of
 * the signature, deliberately: re-evaluating a mutable predicate at write time is
 * exactly the race the freeze exists to remove, and a second copy of the predicate
 * is a second thing to drift.
 *
 * ⚠️ `ids` IS RECORDED FROM `RETURNING`, NOT FROM THE INPUT. The receipt must say
 * what was CLEARED, not what was requested; the two differ if a row was deleted
 * between the freeze and the write. `requested_ids` keeps the input count so the
 * difference is visible rather than invisible.
 *
 * ⭐ AND THE STATEMENT RETURNS `cleared_rows` TO THE CALLER, READ BACK OUT OF THE
 * RECEIPT IT JUST WROTE. `runRepair` used to derive `cleared` in JS as
 * `census.signatureRows - remaining`, a SUBTRACTION over two censuses of a table
 * other writers are changing — the exact arithmetic claim the comment beside it
 * forbade. Nothing here locks, and 500/25 is 20 paced runs, so two overlapping runs
 * freeze the SAME ids (both `ORDER BY completed_at`): A's UPDATE clears 25, B's
 * clears rows already NULL, and B's own two censuses still read 500 then 475 — so B
 * reported `cleared: 25`, exited 0, and CREDITED ITSELF WITH A's WORK. The
 * `⛔ CLEARED NOTHING` alarm and exit 3 could not fire. Reading it back from the
 * receipt also makes the number this run PRINTS and the number it RECORDED the same
 * number, by construction rather than by two expressions agreeing.
 *
 * ⛔ AND THE UPDATE CARRIES `AND callback_delivered_at IS NOT NULL`, WITHOUT WHICH
 * THE COUNT IS STILL WRONG. `UPDATE ... WHERE id = ANY(...)` RETURNS every row that
 * EXISTS, including one whose stamp is already NULL — so B above would still count
 * 25. That term is NOT a re-evaluation of the signature (it is one of its two
 * conjuncts, and the narrower one): it can only ever EXCLUDE, never reach a row the
 * freeze did not, and what it excludes is exactly the no-op — a row on which this
 * statement clears nothing because there was nothing left to clear. The other
 * conjunct, `callback_resolution IS NULL`, stays OUT: a row that acquired a
 * resolution between the freeze and the write should still have its legacy stamp
 * cleared (the header's freeze section says why), and re-testing it here would
 * re-open the race the freeze exists to remove.
 */
export function repairSql(params: {
  /** ⛔ THE GATED SET (`eligibleIds`), never the frozen batch. See `gateByBlockStart`. */
  ids: string[];
  /** How many frozen candidates the gate examined to produce `ids`. */
  candidatesExamined: number;
  receiptKey: string;
  operator: string;
  runAtIso: string;
  populationAtRun: number;
  /**
   * ⭐ THE FREEZE CURSOR THIS RUN USED, as JSON, or `null` for an uncursored run.
   *
   * ⛔ WITHOUT IT THE RECEIPT CANNOT BE READ BACK AS A SEQUENCE. A paced repair is
   * ~20 receipts and `ids` alone does not say WHICH SLICE was offered — two runs
   * that cleared 0 look identical whether they re-froze the same stuck head or
   * walked past it. Recording the bound makes the walk auditable from
   * `_migration_effects` alone, which is the only record that survives the shell.
   *
   * ⚠️ IT GOES IN THE `jsonb_build_object` DETAIL AND NOWHERE ELSE. The UPDATE and
   * its CTE are untouched: the cursor bounds the FREEZE, and re-stating it at write
   * time would be a second copy of a predicate the freeze already applied — the
   * race the freeze exists to remove.
   */
  afterBoundJson: string | null;
}) {
  return sql`
    WITH repaired AS (
      UPDATE approvals
         SET callback_delivered_at = NULL
       WHERE ${idsAsUuidList(params.ids)}
         AND callback_delivered_at IS NOT NULL
      RETURNING id
    )
    INSERT INTO _migration_effects (migration, detail)
    SELECT ${params.receiptKey},
           jsonb_build_object(
             'script',           'backend/scripts/repair-legacy-deblock-delivered-stamp.ts',
             'operator',         ${params.operator}::text,
             'run_at',           ${params.runAtIso}::text,
             'signature',        'callback_delivered_at IS NOT NULL AND callback_resolution IS NULL',
             'gate',             'approvals.completed_at > blocked_since(card) [live Planka moveCard->BLOCKED]',
             'after_bound',      ${params.afterBoundJson}::jsonb,
             'population_at_run', ${params.populationAtRun}::int,
             'requested_ids',    ${params.ids.length}::int,
             'candidates_examined', ${params.candidatesExamined}::int,
             'cleared_rows',     (SELECT count(*) FROM repaired),
             'ids',              (SELECT coalesce(jsonb_agg(id ORDER BY id), '[]'::jsonb) FROM repaired)
           )
    RETURNING migration, (detail->>'cleared_rows')::int AS cleared_rows
  `;
}

// ---------------------------------------------------------------------------
// Planka reads — NEGATIVE CONTROL 2
// ---------------------------------------------------------------------------
//
// ⛔ `PlankaReader` / `plankaReaderFrom` AND THE FOUR HELPERS THEY NEED MOVED OUT
// OF THIS FILE, VERBATIM, TO `src/services/planka-card-state.ts`. Nothing about
// them changed; they are re-exported below, so this file's own call sites and
// every test that imports them from here keep working exactly as before.
//
// WHY THEY MOVED: `backend/scripts/` is not in the server build, so nothing
// running inside fr-backend could import this seam. `workers/approval-expiry.ts`
// now needs the same live "where is this card RIGHT NOW" read before it may
// re-send an expiry notice, and a second spelling of it would be the THIRD in
// this repo. See the header of the new file.
export { BLOCK_ACTION_TYPE, MAX_ACTION_PAGES, plankaReaderFrom, type PlankaReader };

/**
 * NEGATIVE CONTROL 2 — how many signature-matching CARDS are not currently BLOCKED?
 *
 * ⚠️ THIS IS NOT A SQL QUERY AND CANNOT BE ONE. fr's database holds no mirror of a
 * card's Planka list — `isBlockedList` is evaluated live against Planka, by the
 * re-delivery worker and by `scripts/backfill-expired-signoff-requeue.ts` alike.
 * The only place blockedness exists is Planka.
 *
 * ⭐ IT IS REPORTING, NOT A GATE, and clearing the stamp on a not-BLOCKED row is
 * deliberately still correct: the row re-enters the worker's population, the
 * worker's own live gate reads the card, sees it is not BLOCKED, and retires it
 * with `callback_resolution = 'not_blocked'` — which is the terminal state the row
 * should have had all along. So this number sizes the churn the repair hands the
 * worker; it does not veto it.
 *
 * ⛔ AN UNREADABLE CARD IS ITS OWN BUCKET AND IS NEVER FOLDED INTO EITHER ANSWER.
 * A 404, a 504 and an expired agent token all produce "we do not know", and
 * silently counting "do not know" as "not blocked" (or as "blocked") is how a
 * Planka outage becomes a confident census. `degraded` also never aborts the run:
 * a dry run must still be able to report the population when Planka is down.
 */
export interface CardListCensus {
  cards: number;
  blocked: number;
  notBlocked: number;
  unreadable: number;
  /** Distinct list names seen, with counts — so "not blocked" is legible, not a bare int. */
  byList: Record<string, number>;
}

export async function censusCardLists(
  cardIds: string[],
  planka: PlankaReader,
): Promise<CardListCensus> {
  const census: CardListCensus = {
    cards: cardIds.length,
    blocked: 0,
    notBlocked: 0,
    unreadable: 0,
    byList: {},
  };
  for (const cardId of cardIds) {
    let listName: string;
    try {
      listName = await planka.currentListName(cardId);
    } catch {
      census.unreadable += 1;
      continue;
    }
    census.byList[listName] = (census.byList[listName] ?? 0) + 1;
    if (isBlockedList(listName)) census.blocked += 1;
    else census.notBlocked += 1;
  }
  return census;
}

// ---------------------------------------------------------------------------
// THE TIME TERM — the repair may only reach a decision made AFTER the block began
// ---------------------------------------------------------------------------

/**
 * ⛔ THE SIGNATURE ALONE IS TOO WIDE, AND THE EXTRA ROWS ARE HARMFUL. Measured on
 * prod 2026-09-11:
 *
 *     signature only ........................... 496 approvals / 338 cards
 *     signature AND decided after the block .... 262 approvals / 260 cards
 *     the difference ........................... 234 approvals / 165 cards
 *
 * Those 234 were decided BEFORE their card's CURRENT block started. The card is in
 * BLOCKED because of something NEWER; the old decision has nothing to do with it.
 *
 * ⛔ AND RE-DELIVERY IS NOT A PURE UNBLOCK, WHICH IS WHY THIS IS A GATE AND NOT A
 * WARNING. Per `workers/deblock-callback-redelivery.ts:11-24`, the n8n receiver
 * ("AA Pattern - Approval Callback", `yG1N9K2hTswEZNTq`) is NOT IDEMPOTENT: its
 * `Parse Decision` computes `shouldMoveCard` without reading the card's current
 * list and its `Move Card` is an unconditional `card.update{listId}`. The worker's
 * ONLY protection is that it sends solely for a card currently in BLOCKED — which
 * a wrongly-RE-blocked card satisfies. So clearing the stamp on those 234 would
 * move live cards out of BLOCKED and re-send a stale decision body against work
 * nobody decided.
 *
 * ⚠️ THIS CANNOT BE A SQL TERM, AND THERE IS NO CROSS-DATABASE JOIN AVAILABLE TO
 * MAKE IT ONE. `blocked_since` is `max(action.created_at)` over the KANBAN database
 * — a different database on worker4, with no dblink and no FDW installed
 * (`pg_extension` there is plpgsql, pg_stat_statements, pg_trgm, pgcrypto,
 * uuid-ossp), and fr holds exactly one drizzle client. The same paragraph that
 * makes NEGATIVE CONTROL 2 a JS loop applies verbatim: the only place blockedness
 * exists is Planka. So the term is evaluated over the FROZEN BATCH, through
 * Planka's own `/api/cards/:id/actions`, exactly like every other Planka read here.
 *
 * ⛔ IT FAILS CLOSED, IN EVERY DIRECTION. A row is repaired ONLY when a block start
 * was MEASURED and the decision is strictly newer than it. Unreadable, un-paged,
 * no-block-start, no card, no decision time — each is its own bucket and every one
 * of them EXCLUDES. A silent fallback to the wide predicate when Planka cannot be
 * reached would be strictly worse than today's script, because it would look safe.
 */
export interface BlockGateCensus {
  /** Rows offered to the gate — the frozen batch. */
  candidates: number;
  /** ⭐ Decision strictly AFTER a MEASURED block start. The ONLY repairable bucket. */
  eligible: number;
  /** Decided BEFORE the current block began. The 234. Excluded. */
  decidedBeforeBlock: number;
  /** Planka served the whole history and it holds no move into BLOCKED. Excluded. */
  noBlockStart: number;
  /** The block start could not be read or could not be paged to. Excluded. */
  unreadable: number;
  /** No `card_id`: there is no card whose block could be dated. Excluded. */
  noCardId: number;
  /** No `completed_at`: there is no decision instant to compare. Excluded. */
  noCompletedAt: number;
}

/** One frozen row, carrying the two operands the gate compares. */
export interface FrozenCandidate {
  id: string;
  /** ⚠️ MILLISECONDS — the driver truncated it. For the GATE only, never the cursor. */
  completedAt: Date | null;
  cardId: string | null;
  /**
   * ⭐ THE SAME INSTANT AT MICROSECOND PRECISION, as Postgres rendered it.
   *
   * `null` only when `completed_at` is NULL. This — NOT `completedAt` — is what the
   * next run's `--after` bound is built from; see `COMPLETED_AT_CURSOR_SQL` for why
   * the two cannot be the same field.
   */
  completedAtCursor: string | null;
}

export function emptyBlockGateCensus(candidates: number): BlockGateCensus {
  return {
    candidates,
    eligible: 0,
    decidedBeforeBlock: 0,
    noBlockStart: 0,
    unreadable: 0,
    noCardId: 0,
    noCompletedAt: 0,
  };
}

/** Rows the gate could even attempt: the ones carrying BOTH operands. */
export function gateableCount(census: BlockGateCensus): number {
  return census.candidates - census.noCardId - census.noCompletedAt;
}

/**
 * THE GATE. Returns the ids that may be repaired, and the census that explains
 * every id that may not.
 *
 * ⛔ THE COMPARISON IS STRICT (`>`), not `>=`. Equality means the decision and the
 * move into BLOCKED carry the same instant, which is not evidence that the
 * decision came after the block — and a tie must not be resolved in favour of
 * writing.
 *
 * ⭐ ONE PLANKA READ PER CARD, NOT PER ROW. Several stranded approvals routinely
 * share one card (496 rows over 338 cards), and the memo also guarantees that two
 * rows on the same card are judged against the SAME block start rather than
 * against two reads taken seconds apart.
 */
export async function gateByBlockStart(
  candidates: FrozenCandidate[],
  planka: PlankaReader,
): Promise<{ eligibleIds: string[]; census: BlockGateCensus }> {
  const census = emptyBlockGateCensus(candidates.length);
  const eligibleIds: string[] = [];
  // ⛔ SUCCESSFUL AND FAILED READS ARE BOTH MEMOISED HERE, deliberately and unlike
  // `currentListName`'s cache: re-reading a card that just 504'd, once per row,
  // is how a batch turns a Planka blip into a read storm against the very Planka
  // whose 504s are this file's reason for existing.
  const blockStartByCard = new Map<string, Date | null | 'unreadable'>();

  for (const row of candidates) {
    if (row.cardId === null || row.cardId === '') {
      census.noCardId += 1;
      continue;
    }
    if (row.completedAt === null) {
      census.noCompletedAt += 1;
      continue;
    }
    let blockStart = blockStartByCard.get(row.cardId);
    if (blockStart === undefined) {
      try {
        blockStart = await planka.blockedSince(row.cardId);
      } catch {
        blockStart = 'unreadable';
      }
      blockStartByCard.set(row.cardId, blockStart);
    }
    if (blockStart === 'unreadable') {
      census.unreadable += 1;
      continue;
    }
    if (blockStart === null) {
      census.noBlockStart += 1;
      continue;
    }
    if (row.completedAt.getTime() > blockStart.getTime()) {
      census.eligible += 1;
      eligibleIds.push(row.id);
    } else {
      census.decidedBeforeBlock += 1;
    }
  }
  return { eligibleIds, census };
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export interface RepairCensus {
  signatureRows: number;
  signatureCards: number;
  signatureRowsWithoutCard: number;
}

/** Why an --apply run was refused. Each value names a DIFFERENT defect. */
export type RefusalReason =
  /** `--apply` without `--limit`. Pacing is the point; there is no default. */
  | 'no-limit'
  /** `--limit` above `MAX_LIMIT`. Refused, never clamped — see `MAX_LIMIT`. */
  | 'limit-over-max'
  /**
   * `--apply` without `--max-population`.
   *
   * ⭐ MANDATORY BECAUSE THE POPULATION FIGURE RESTS ON A SINGLE CENSUS. The
   * header's corroboration claim is retracted: 500 was never confirmed by a second
   * independent measurement, so the ceiling is the ONLY guard left on it. An
   * `--apply` run with no ceiling is a run in which a silently-widened signature
   * has nothing to trip over.
   */
  | 'no-max-population'
  /** The measured population exceeded `--max-population`. The signature may be wrong. */
  | 'over-max-population'
  /** NEGATIVE CONTROL 1 found signature rows stamped at or after 113 ran. */
  | 'negative-control-failed'
  /** NEGATIVE CONTROL 1 could not be evaluated: no `_migration_effects` row for 113. */
  | 'negative-control-unmeasurable'
  /**
   * NEGATIVE CONTROL 1 had a ZERO DENOMINATOR, so its zero proves nothing.
   *
   * ⛔ A VACUOUS CONTROL REFUSES; IT DOES NOT WARN. With `post_113_stamped_rows`
   * at 0 there is no post-113 population for the control to discriminate against,
   * and `signature_rows_stamped_post_113 = 0` is then the same 0 a completely
   * wrong signature returns. Printing a warning beside it and writing anyway is
   * the failure this whole file is arranged against: a control that cannot fail is
   * a green light wired to nothing, and reporting it as a warning lets the run
   * proceed on exactly the evidence that is missing.
   */
  | 'negative-control-vacuous'
  /**
   * THE TIME TERM COULD NOT BE EVALUATED AT ALL.
   *
   * ⛔ THE ONE REFUSAL THAT MUST NEVER DEGRADE INTO A WARNING. Every other Planka
   * read in this file is REPORTING and is allowed to come back "unmeasured";
   * `gateByBlockStart` is a GATE, and a gate that cannot be evaluated falls back to
   * the wide predicate — the 496-row one that re-delivers 234 stale decisions
   * against current blocks. A repair that silently widens when Planka is down is
   * strictly worse than one that stops, because it looks exactly like a healthy run.
   *
   * Raised when there is no Planka reader at all, or when EVERY gateable row in the
   * batch came back unreadable (a Planka outage, an expired agent token). A
   * PARTIAL failure does not raise it: those rows are individually excluded, which
   * is already the fail-closed answer, and the report names them.
   */
  | 'block-gate-unavailable';

export interface RepairResult {
  mode: 'dry-run' | 'apply';
  census: RepairCensus;
  control: {
    /** When 113's data effect ran on THIS database. `null` = unmeasurable. */
    migration113RecordedAt: string | null;
    /** The DENOMINATOR. A zero here makes `signatureRowsStampedPost113 === 0` vacuous. */
    post113StampedRows: number;
    /** ⭐ MUST BE 0. Non-zero refutes the premise and refuses the write. */
    signatureRowsStampedPost113: number;
    /** NEGATIVE CONTROL 2. `null` when no Planka reader was available at all. */
    cards: CardListCensus | null;
  };
  /**
   * The FROZEN CANDIDATES — what the SIGNATURE selected, before the time term.
   *
   * ⛔ THIS IS NO LONGER THE SET THE UPDATE ADDRESSES. `eligibleIds` is. Reading
   * this as "what will be cleared" is the pre-time-term reading and is wrong by
   * roughly half (496 vs 262 on prod).
   */
  frozenIds: string[];
  /** The `--after` bound this run froze past, echoed back. `null` = uncursored. */
  after: FreezeCursor | null;
  /**
   * ⭐ THE LAST ROW OF THE FROZEN BATCH IN FREEZE ORDER — i.e. the `--after` bound
   * for the NEXT run. `null` when nothing was frozen.
   *
   * ⚠️ `completedAt` IS NULLABLE and a `null` there is NOT a usable cursor: the
   * batch ended in the `NULLS LAST` tail, which no `--after` can address. The
   * report says so rather than printing a bound that would silently freeze nothing.
   */
  freezeTail: { completedAt: string | null; id: string } | null;
  /**
   * ⭐ THE SET THE UPDATE ACTUALLY ADDRESSES: frozen candidates that survived the
   * time term. Always a subset of `frozenIds`.
   */
  eligibleIds: string[];
  /** Why each frozen candidate is, or is not, in `eligibleIds`. */
  blockGate: BlockGateCensus;
  /**
   * Rows the UPDATE actually cleared, counted BY THE UPDATE (`count(*) FROM
   * repaired`) and read back from the receipt. 0 in a dry run, always.
   *
   * ⛔ NEVER A SUBTRACTION AND NEVER `frozenIds.length`. See `repairSql`.
   */
  cleared: number;
  /** Rows still carrying the signature after this run. */
  remaining: number;
  /** The `_migration_effects` key this run wrote, or `null` if it wrote nothing. */
  receiptKey: string | null;
  refusal: RefusalReason | null;
}

export interface RepairOptions {
  apply: boolean;
  /**
   * `null` = not given. MANDATORY with `apply`; there is no default, and it may
   * not exceed `MAX_LIMIT` — see there for why an unbounded limit is no limit.
   */
  limit: number | null;
  /**
   * `null` = no ceiling declared. MANDATORY with `apply`: the population figure
   * rests on a single census, so this is the only guard on it. On a dry run a
   * `null` is reported loudly rather than assumed safe.
   */
  maxPopulation: number | null;
  /**
   * ⭐ THE FREEZE CURSOR. `null` = start at the head of the population.
   *
   * OPTIONAL AND OPERATOR-SUPPLIED, in both modes. It bounds only the FREEZE: the
   * census, both negative controls and `--max-population` are measured over the
   * WHOLE population regardless, because a ceiling that moved with the cursor would
   * stop being a guard on the signature. See `freezeIdsSql`.
   */
  after: FreezeCursor | null;
  operator: string;
}

function firstRow<T>(rows: unknown): T | null {
  if (Array.isArray(rows) && rows.length > 0) return rows[0] as T;
  return null;
}

/**
 * A timestamp column as a `Date`, or `null` when there isn't one.
 *
 * ⛔ NEVER `new Date(value)` ON A POSSIBLY-NULL COLUMN. `new Date(null)` is epoch 0
 * — maximally OLD — so a NULL `completed_at` would compare as "decided in 1970",
 * i.e. before every block start, and would be EXCLUDED by luck rather than by
 * rule. `new Date(undefined)` is `Invalid Date`, whose every comparison is false,
 * so that one would exclude by a different accident. Both accidents happen to point
 * the safe way HERE and would stop doing so the moment the comparison is inverted.
 * The same argument `lib/approval-deadline.ts` makes for `expires_at`.
 */
function toDateOrNull(value: unknown): Date | null {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'string' || typeof value === 'number') {
    const d = new Date(value);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  return null;
}

export async function runRepair(
  opts: RepairOptions,
): Promise<RepairResult> {
  const db = defaultDb;
  const now = () => new Date();

  const censusRow = firstRow<{
    signature_rows: number;
    signature_cards: number;
    signature_rows_without_card: number;
  }>(await db.execute(censusSql()));
  const census: RepairCensus = {
    signatureRows: Number(censusRow?.signature_rows ?? 0),
    signatureCards: Number(censusRow?.signature_cards ?? 0),
    signatureRowsWithoutCard: Number(censusRow?.signature_rows_without_card ?? 0),
  };

  const controlRow = firstRow<{
    migration_113_recorded_at: unknown;
    post_113_stamped_rows: number;
    signature_rows_stamped_post_113: number;
  }>(await db.execute(negativeControlOneSql()));
  const recordedAtRaw = controlRow?.migration_113_recorded_at ?? null;
  const migration113RecordedAt =
    recordedAtRaw === null || recordedAtRaw === undefined
      ? null
      : recordedAtRaw instanceof Date
        ? recordedAtRaw.toISOString()
        : String(recordedAtRaw);

  const result: RepairResult = {
    mode: opts.apply ? 'apply' : 'dry-run',
    census,
    control: {
      migration113RecordedAt,
      post113StampedRows: Number(controlRow?.post_113_stamped_rows ?? 0),
      signatureRowsStampedPost113: Number(controlRow?.signature_rows_stamped_post_113 ?? 0),
      // ⛔ NEGATIVE CONTROL 2 IS NOT MEASURED YET, AND THE ORDER IS THE FIX. It
      // reads live Planka once per card; running it here — before the refusals —
      // made an `over-max-population` refusal pay ~1 hour of sequential reads IN
      // FULL before refusing. It now runs AFTER the refusal block and over the
      // FROZEN BATCH only, so a refused run costs nothing at Planka at all.
      cards: null,
    },
    frozenIds: [],
    after: opts.after,
    freezeTail: null,
    eligibleIds: [],
    blockGate: emptyBlockGateCensus(0),
    cleared: 0,
    remaining: census.signatureRows,
    receiptKey: null,
    refusal: null,
  };

  // ── REFUSALS. Every one of these leaves `frozenIds` empty and writes NOTHING.
  // ⛔ THEY ARE EVALUATED IN BOTH MODES. A dry run that discovers the signature is
  // wrong has made a FINDING, and reporting it with exit 0 would let the finding
  // scroll past as a healthy preview.
  if (migration113RecordedAt === null) {
    result.refusal = 'negative-control-unmeasurable';
    return result;
  }
  if (result.control.signatureRowsStampedPost113 > 0) {
    result.refusal = 'negative-control-failed';
    return result;
  }
  // ⛔ THE ZERO DENOMINATOR REFUSES. It used to only warn — which is the vacuous
  // control shipping as a pass. See `'negative-control-vacuous'`.
  if (result.control.post113StampedRows === 0) {
    result.refusal = 'negative-control-vacuous';
    return result;
  }
  if (opts.maxPopulation !== null && census.signatureRows > opts.maxPopulation) {
    result.refusal = 'over-max-population';
    return result;
  }
  if (opts.apply && opts.limit === null) {
    result.refusal = 'no-limit';
    return result;
  }
  if (opts.apply && opts.maxPopulation === null) {
    result.refusal = 'no-max-population';
    return result;
  }
  if (opts.limit !== null && opts.limit > MAX_LIMIT) {
    result.refusal = 'limit-over-max';
    return result;
  }

  // ── THE FREEZE. Ids first, always — in a dry run too, because the ids ARE the
  // dry run's output and a preview computed a different way is not a preview.
  const idRows = (await db.execute<{
    id: string;
    card_id: string | null;
    completed_at: unknown;
    completed_at_cursor: unknown;
  }>(freezeIdsSql(opts.limit, opts.after))) as unknown;
  // ⛔ `opts.after` BOUNDS THE FREEZE ONLY. It is deliberately NOT threaded into
  // `censusSql`, `negativeControlOneSql` or the `--max-population` check above: a
  // ceiling that shrank with the cursor could not notice a signature that widened
  // behind it, which is the one thing that ceiling exists to notice.
  const candidates: FrozenCandidate[] = (
    Array.isArray(idRows) ? (idRows as Array<Record<string, unknown>>) : []
  )
    .filter((r) => typeof r.id === 'string' && r.id !== '')
    .map((r) => ({
      id: r.id as string,
      cardId: typeof r.card_id === 'string' && r.card_id !== '' ? r.card_id : null,
      completedAt: toDateOrNull(r.completed_at),
      // ⛔ TAKEN FROM THE TEXT COLUMN AND NEVER RE-DERIVED. A `?? toDateOrNull(...)`
      // fallback here would silently restore the millisecond bound the moment the
      // SELECT list lost the column, which is the whole defect wearing a default.
      completedAtCursor:
        typeof r.completed_at_cursor === 'string' && r.completed_at_cursor !== ''
          ? r.completed_at_cursor
          : null,
    }));
  result.frozenIds = candidates.map((c) => c.id);
  // ⭐ THE TAIL IS TAKEN IN FREEZE ORDER, not by `Math.max`. The SQL already sorted
  // by the same `(completed_at, id)` tuple `--after` compares on, so the last row is
  // the cursor for the next batch by construction; recomputing it in JS would be a
  // second ordering to drift from the one the database used.
  //
  // ⛔ AND THE BOUND IS `completedAtCursor`, POSTGRES'S OWN TEXT — NOT
  // `completedAt.toISOString()`, which is what this line used to say and is the
  // defect that made the documented operator walk non-terminating on prod. A `Date`
  // is milliseconds; `approvals.completed_at` is microseconds; `…025 < …025665`, so
  // the bound re-selected the 71-row cluster it was supposed to step over, forever.
  // See `FreezeCursor.completedAt` and `COMPLETED_AT_CURSOR_SQL`.
  const tail = candidates[candidates.length - 1];
  result.freezeTail =
    tail === undefined ? null : { completedAt: tail.completedAtCursor, id: tail.id };

  // ── ⭐ THE TIME TERM. Runs BEFORE NEGATIVE CONTROL 2 (which is reporting and
  // costs a further two Planka reads per card) so a run this gate refuses pays for
  // the refusal only. ⛔ Its output, `eligibleIds`, is what the UPDATE addresses —
  // `frozenIds` is now only what the SIGNATURE selected.
  // `safeDefaultReader()` returns null when no Planka reader can be built; that
  // is the condition that raises `block-gate-unavailable`.
  const planka = safeDefaultReader();
  if (candidates.length > 0) {
    if (planka === null) {
      // ⛔ NO READER = NO GATE = NO WRITE. Never "gate unmeasured, proceed".
      result.blockGate = emptyBlockGateCensus(candidates.length);
      result.refusal = 'block-gate-unavailable';
      return result;
    }
    const gated = await gateByBlockStart(candidates, planka);
    result.blockGate = gated.census;
    result.eligibleIds = gated.eligibleIds;
    // ⛔ A TOTAL OUTAGE REFUSES; A PARTIAL ONE EXCLUDES. If every row that carried
    // both operands came back unreadable, nothing about this batch was measured and
    // the run must stop loudly rather than report a clean "0 eligible", which is the
    // same 0 a healthy batch of already-repaired rows returns.
    const gateable = gateableCount(gated.census);
    if (gateable > 0 && gated.census.unreadable === gateable) {
      result.eligibleIds = [];
      result.refusal = 'block-gate-unavailable';
      return result;
    }
  }

  // ── NEGATIVE CONTROL 2, over the FROZEN BATCH ONLY and AFTER every refusal.
  // Reads only; a Planka that is down degrades the control, it never aborts the
  // run. ⛔ An empty batch reads NO cards — `censusCardLists([])` is 0 of
  // everything, which is the truth, not an outage.
  if (planka && result.frozenIds.length > 0) {
    try {
      const cardRows = (await db.execute<{ card_id: string }>(
        signatureCardIdsSql(result.frozenIds),
      )) as unknown;
      const cardIds = Array.isArray(cardRows)
        ? (cardRows as Array<{ card_id: string }>).map((r) => r.card_id).filter(Boolean)
        : [];
      result.control.cards = await censusCardLists(cardIds, planka);
    } catch {
      result.control.cards = null;
    }
  }

  if (!opts.apply) {
    // Dry run: `cleared` stays 0 and `remaining` stays the whole population,
    // because nothing was cleared. ⛔ It must NOT report the counterfactual
    // remainder as if the run had happened.
    return result;
  }

  const runAt = now();
  const receiptKey = `${RECEIPT_KEY_PREFIX}@${runAt.toISOString()}`;

  // ⛔ `eligibleIds`, NOT `frozenIds`. A batch whose every candidate was decided
  // before its current block began repairs NOTHING and writes NO receipt — that is
  // the gate working, not an empty batch.
  if (result.eligibleIds.length === 0) {
    // Nothing to repair. ⛔ No receipt: `_migration_effects` records EFFECTS, and a
    // row asserting an empty repair is a receipt for nothing.
    return result;
  }

  const receipt = (await db.execute<{ migration: string; cleared_rows: number }>(
    repairSql({
      ids: result.eligibleIds,
      candidatesExamined: result.frozenIds.length,
      receiptKey,
      operator: opts.operator,
      runAtIso: runAt.toISOString(),
      populationAtRun: census.signatureRows,
      afterBoundJson:
        opts.after === null
          ? null
          : JSON.stringify({ completed_at: opts.after.completedAt, id: opts.after.id }),
    }),
  )) as unknown;
  const receiptRow = firstRow<{ migration: string; cleared_rows: unknown }>(receipt);
  result.receiptKey = receiptRow?.migration ?? receiptKey;

  // ⭐ `cleared` IS THE COUNT THE STATEMENT ITSELF RETURNED, read back out of the
  // receipt it wrote — `count(*) FROM repaired`, i.e. the rows this UPDATE's own
  // `RETURNING` produced. ⛔ IT IS NEVER DERIVED IN JS. Neither
  // `census.signatureRows - result.remaining` (a subtraction over two censuses of a
  // table other writers are changing, which credits this run with a concurrent
  // run's work) nor `result.frozenIds.length` (which is what was REQUESTED, and
  // counts rows that were deleted or already cleared) is an answer to "what did
  // THIS statement change". See `repairSql`.
  result.cleared = Number(receiptRow?.cleared_rows ?? 0);

  // Re-measure the REMAINDER rather than subtract. ⛔ `signatureRows - cleared`
  // would be an ARITHMETIC CLAIM about a table other writers are changing under us;
  // the whole reason the ids are frozen is that this population moves. ⚠️ And note
  // `remaining` and `cleared` are now INDEPENDENT measurements — `remaining -
  // cleared` need not equal the before-census, and a gap between them is a
  // concurrent writer, which is information rather than an inconsistency.
  const afterRow = firstRow<{ signature_rows: number }>(await db.execute(censusSql()));
  result.remaining = Number(afterRow?.signature_rows ?? 0);

  return result;
}

/**
 * The default Planka reader, or `null` if one cannot be constructed.
 *
 * ⛔ NEVER THROWS. NEGATIVE CONTROL 2 is reporting; a missing Planka credential
 * must degrade it to "unmeasured", not take the census down with it.
 *
 * ⚠️ BUT A `null` IS NO LONGER HARMLESS. The TIME TERM needs this same reader and
 * is a GATE: `runRepair` turns a `null` here into the `block-gate-unavailable`
 * REFUSAL whenever the batch is non-empty. The "degrade quietly" contract above
 * applies to control 2 only.
 */
function safeDefaultReader(): PlankaReader | null {
  try {
    return plankaReaderFrom(plankaClient);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Reporting
// ---------------------------------------------------------------------------

const REFUSAL_TEXT: Record<RefusalReason, string> = {
  'no-limit':
    '--apply requires --limit N. There is NO default: migration 113 left these rows ' +
    'for a SEPARATELY PACED repair precisely because returning them all at once is ' +
    'the outbound burst that produced the Planka 504s. Choose a batch size.',
  'limit-over-max':
    `--limit may not exceed ${MAX_LIMIT}, and it is REFUSED rather than clamped. An ` +
    'unbounded --limit makes the flag a formality: --apply --limit 500 satisfies ' +
    '"choose a batch size" while releasing the WHOLE measured population in one go, ' +
    'which is the outbound burst migration 113 declined to write. Use more batches.',
  'no-max-population':
    '--apply requires --max-population N. The population figure rests on a SINGLE ' +
    "census — the corroboration this script once claimed from migration 113's receipt " +
    'is RETRACTED (113 added `callback_acked_at` in the same file, so that receipt ' +
    'counts the same rows by a differently-worded predicate) — so the ceiling is the ' +
    'ONLY guard left on it. Dry-run first, then pass a ceiling derived from THAT census.',
  'negative-control-vacuous':
    'NEGATIVE CONTROL 1 IS VACUOUS: `post_113_stamped_rows` is 0, so the control had ' +
    'no post-113 population to discriminate against and its 0 is the same 0 a ' +
    'completely wrong signature returns. A ZERO DENOMINATOR IS A REFUSAL, not a ' +
    'warning printed next to a write.',
  'over-max-population':
    'the measured population EXCEEDS --max-population. Either the signature is wider ' +
    'than the one that was measured, or the population grew — both mean somebody must ' +
    'look before anything is written.',
  'negative-control-failed':
    'NEGATIVE CONTROL 1 FAILED: rows carry the legacy signature with a ' +
    '`callback_delivered_at` dated at or after migration 113 ran. Post-113 the only ' +
    'writer stamps `callback_resolution` in the same statement, so this cannot happen ' +
    'unless the premise is wrong. The signature may be catching live rows.',
  'block-gate-unavailable':
    'THE TIME TERM COULD NOT BE EVALUATED: there is no Planka reader, or every ' +
    'gateable row in this batch came back with an UNREADABLE block start. The gate ' +
    '(`approvals.completed_at > blocked_since(card)`) is the ONLY thing standing ' +
    'between this repair and the ~234 prod approvals that were decided BEFORE their ' +
    "card's CURRENT block — re-delivering those moves live cards out of BLOCKED and " +
    're-sends a stale decision, because the n8n receiver is not idempotent. Falling ' +
    'back to the signature alone when the gate cannot be evaluated would be STRICTLY ' +
    'WORSE than not running, because it would look like a healthy run. Fix Planka ' +
    'access, then re-run.',
  'negative-control-unmeasurable':
    'NEGATIVE CONTROL 1 IS UNMEASURABLE: `_migration_effects` holds no row for ' +
    `${MIGRATION_113}, so there is no instant to date the stamps against. An ` +
    'unmeasurable control returns 0 and would read exactly like a clean one.',
};

/**
 * ⛔ THE MEASURED-POPULATION HEADER COMES FIRST, BEFORE ANY VERDICT. A repair whose
 * summary leads with what it did, and buries what it measured, is how a signature
 * that drifted ships as a successful run.
 */
export function formatReport(result: RepairResult): string {
  const L: string[] = [];
  L.push('');
  L.push('═'.repeat(78));
  L.push(`  legacy de-block delivered-stamp repair — ${result.mode.toUpperCase()}`);
  L.push('═'.repeat(78));
  L.push('  MEASURED POPULATION (signature: callback_delivered_at IS NOT NULL');
  L.push('                                  AND callback_resolution IS NULL)');
  L.push(`    total matching rows      : ${result.census.signatureRows}`);
  L.push(`    distinct cards behind    : ${result.census.signatureCards}`);
  L.push(`    rows with no card_id     : ${result.census.signatureRowsWithoutCard}`);
  // ⭐ THE CURSOR IS PRINTED WITH THE POPULATION, NOT WITH THE VERDICT. `frozen as
  // CANDIDATES: 25` means two completely different things depending on whether the
  // freeze started at the head of the queue or somewhere in the middle of it, and a
  // report that omits which is a report whose central number cannot be read.
  L.push(
    `    --after bound            : ${
      result.after === null
        ? '(none — freeze starts at the OLDEST row of the population)'
        : `${result.after.completedAt}  (id ${result.after.id})`
    }`,
  );
  L.push(`    frozen as CANDIDATES     : ${result.frozenIds.length}  (signature only — NOT what gets cleared)`);
  L.push(`    this run will touch      : ${result.eligibleIds.length}  (after the time term below)`);
  L.push(
    `    remaining after this run : ${
      result.mode === 'apply'
        ? result.remaining
        : `${result.census.signatureRows} (nothing was cleared — this is a dry run)`
    }`,
  );
  L.push('');
  L.push('  NEGATIVE CONTROL 1 — can the signature reach a row post-113 code wrote?');
  L.push(`    migration 113 effect ran : ${result.control.migration113RecordedAt ?? '⛔ NO RECEIPT — UNMEASURABLE'}`);
  L.push(
    `    post-113 stamped rows    : ${result.control.post113StampedRows}` +
      (result.control.post113StampedRows === 0
        ? '  ⛔ ZERO DENOMINATOR — the control below had nothing to discriminate ' +
          'against, so its 0 proves NOTHING. This REFUSES the run.'
        : '  (the denominator)'),
  );
  L.push(
    `    signature rows stamped   : ${result.control.signatureRowsStampedPost113}` +
      (result.control.signatureRowsStampedPost113 === 0 ? '  ✓ must be 0' : '  ⛔ MUST BE 0'),
  );
  L.push('      at/after 113 ran');
  L.push('');
  const g = result.blockGate;
  L.push('  ⭐ THE TIME TERM — was the approval decided AFTER the card\'s CURRENT block began?');
  L.push('     (approvals.completed_at > blocked_since(card); blocked_since = the most recent');
  L.push('      moveCard into BLOCKED, read live from Planka. A GATE, not a report.)');
  L.push(`    candidates examined      : ${g.candidates}`);
  L.push(`    ⭐ ELIGIBLE (will clear) : ${g.eligible}`);
  L.push(`    decided BEFORE the block : ${g.decidedBeforeBlock}  ⛔ EXCLUDED — re-blocked by NEWER work`);
  L.push(`    no block start in history: ${g.noBlockStart}  ⛔ EXCLUDED`);
  L.push(`    block start UNREADABLE   : ${g.unreadable}  ⛔ EXCLUDED — not "not blocked"`);
  L.push(`    no card_id               : ${g.noCardId}  ⛔ EXCLUDED`);
  L.push(`    no completed_at          : ${g.noCompletedAt}  ⛔ EXCLUDED`);
  const gateSum =
    g.eligible + g.decidedBeforeBlock + g.noBlockStart + g.unreadable + g.noCardId + g.noCompletedAt;
  L.push(
    `    ── buckets sum = ${gateSum}, candidates = ${g.candidates}` +
      (gateSum === g.candidates ? ' ✓' : ' ✗ MISMATCH — a row escaped accounting'),
  );
  const permanentlyExcluded = g.decidedBeforeBlock + g.noBlockStart;
  if (permanentlyExcluded > 0 || g.unreadable > 0) {
    L.push('    ⚠️ EXCLUDED ROWS ARE NOT REPAIRED AND STAY IN THE POPULATION. A row decided');
    L.push('       before its block can NEVER become eligible (completed_at is fixed and a');
    L.push('       block start only moves forward), and the freeze is oldest-first, so those');
    L.push('       rows re-appear at the head of EVERY later batch unless the next run is');
    L.push('       given an --after bound past them. See the header.');
  }
  // ⭐ THE NEXT BOUND, PRINTED WHENEVER ANYTHING WAS FROZEN. Without it the operator
  // has to go and query for the tail by hand between every one of ~20 paced runs,
  // and a hand-typed cursor is how a slice gets skipped.
  if (result.freezeTail !== null) {
    L.push('');
    if (result.freezeTail.completedAt === null) {
      L.push('    ⚠️ NO NEXT --after BOUND. This batch ended on a row with a NULL completed_at');
      L.push('       (the `NULLS LAST` tail), which no --after can address. Those rows are');
      L.push('       never repairable anyway — the time term buckets them `no completed_at`.');
    } else {
      L.push('    ⭐ NEXT BATCH — the bound past everything this run froze:');
      L.push(
        `         --after ${result.freezeTail.completedAt} --after-id ${result.freezeTail.id}`,
      );
      // ⭐ SAY WHY THE DIGITS MATTER, BESIDE THE DIGITS. This line is printed to be
      // copied, and the one way left to reintroduce the deadlock is a human
      // shortening it: `…025665Z` retyped as `…025Z` sorts BEFORE 71 prod rows that
      // share that microsecond, so the next freeze re-selects the cluster it was
      // meant to step over. Postgres rendered these six digits; do not round them.
      L.push('       ⛔ COPY IT VERBATIM — the MICROSECONDS are load-bearing. `completed_at` is');
      L.push('          microsecond-resolution and the bulk writers stamp whole batches at ONE');
      L.push('          instant (71 prod rows share one). A bound rounded to milliseconds sorts');
      L.push('          BEFORE every row in such a cluster and re-freezes it forever.');
      L.push('       ⚠️ IT SKIPS THE EXCLUDED ROWS TOO, WHICH IS THE POINT AND ALSO THE COST:');
      L.push('          nothing brings them back but an UNCURSORED run. They are already');
      L.push('          unrepairable; the census above is what tells you the population fell.');
    }
  }
  if (g.eligible === 0 && permanentlyExcluded > 0) {
    // ⛔ THE ONE READING OF THIS REPORT THAT IS ALWAYS WRONG. `0 eligible` and
    // `cleared: 0` is what a FINISHED repair prints and it is ALSO what a repair
    // that can never start prints, and nothing else in this report separates them.
    // The freeze is `ORDER BY completed_at NULLS LAST` (oldest first), the 234
    // ineligible rows skew OLD, and `--limit` is capped at MAX_LIMIT — so if the
    // oldest MAX_LIMIT rows are all permanently excluded, EVERY run from now to
    // forever freezes the same head of the queue, reports 0 eligible, writes
    // nothing, and exits 0. That is a STUCK repair wearing the report of a
    // completed one.
    L.push('');
    L.push(`    ⛔ 0 ELIGIBLE IS **NOT** "DONE". ${permanentlyExcluded} of the ${g.candidates} rows frozen by this`);
    L.push('       run can NEVER become eligible, and the freeze is oldest-first with no');
    L.push(`       cursor past them (--limit is capped at ${MAX_LIMIT}). If they fill the head of the`);
    L.push('       queue, every future run freezes this SAME batch and repairs nothing, while');
    L.push('       printing exactly what a finished repair prints. ⛔ DO NOT read a run of');
    L.push('       0-eligible reports as the population being drained: check it against the');
    L.push('       signature census above, which is the only number that actually falls when');
    L.push('       rows are repaired.');
    L.push('    ⭐ THE WAY PAST IT IS THE `--after` BOUND ON THE FREEZE, printed above as');
    L.push('       "NEXT BATCH". Re-run with it and the freeze starts past this stuck head.');
  }
  L.push('');
  L.push('  NEGATIVE CONTROL 2 — cards of THIS BATCH not currently in BLOCKED (live Planka)');
  L.push('    ⚠️ scoped to the FROZEN ids only, and read AFTER the refusals — it does not');
  L.push('       describe the whole population, and a refused run reads no cards at all.');
  if (result.control.cards === null) {
    L.push('    ⚠️ UNMEASURED — no Planka reader, or the batch was empty, or the read');
    L.push('       failed. This is NOT "zero".');
  } else {
    const c = result.control.cards;
    L.push(`    cards read               : ${c.cards}`);
    L.push(`    in BLOCKED               : ${c.blocked}`);
    L.push(`    NOT in BLOCKED           : ${c.notBlocked}`);
    L.push(`    unreadable               : ${c.unreadable}  ⚠️ neither blocked nor not-blocked`);
    const sum = c.blocked + c.notBlocked + c.unreadable;
    L.push(
      `    ── blocked+not+unreadable = ${sum}, cards read = ${c.cards}` +
        (sum === c.cards ? ' ✓' : ' ✗ MISMATCH — a card escaped accounting'),
    );
    for (const [name, n] of Object.entries(c.byList).sort((a, b) => b[1] - a[1])) {
      L.push(`        ${name.padEnd(22)} ${n}`);
    }
  }
  L.push('');

  if (result.refusal !== null) {
    L.push(`  ⛔ REFUSED (${result.refusal}). NOTHING WAS WRITTEN.`);
    L.push(`     ${REFUSAL_TEXT[result.refusal]}`);
    L.push('');
    return L.join('\n');
  }

  if (result.mode === 'apply') {
    L.push(`  cleared                  : ${result.cleared}`);
    L.push(`  receipt                  : ${result.receiptKey ?? '(none — nothing to repair)'}`);
    // ⛔ KEYED ON `eligibleIds`, NOT `frozenIds`. A batch the TIME TERM emptied
    // cleared nothing BY DESIGN; raising the alarm on that would train the operator
    // to ignore it, and the alarm is about a repair that should have moved rows and
    // did not — a concurrent run, or a write that silently matched nothing.
    if (result.eligibleIds.length > 0 && result.cleared === 0) {
      L.push('');
      L.push(
        `  ⛔ CLEARED NOTHING. ${result.eligibleIds.length} id(s) passed the time term and the ` +
          'population did not move.',
      );
      L.push('     This run did NOT repair anything. Do not re-run until somebody has looked.');
    }
  } else {
    L.push('  Nothing was written. Re-run with --apply --limit N to arm.');
  }
  L.push('');
  const excluded = result.frozenIds.filter((id) => !result.eligibleIds.includes(id));
  for (const id of result.eligibleIds) {
    L.push(`  [${result.mode === 'apply' ? 'CLEARED' : 'WOULD CLEAR'}] approval ${id}`);
  }
  for (const id of excluded) {
    L.push(`  [EXCLUDED BY THE TIME TERM] approval ${id}`);
  }
  L.push('');
  return L.join('\n');
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function numericFlag(argv: string[], flag: string): number | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const raw = Number(argv[i + 1]);
  if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
    throw new Error(
      `${flag} needs a positive whole number, got "${argv[i + 1] ?? '(nothing)'}"`,
    );
  }
  return raw;
}

function stringFlag(argv: string[], flag: string): string | null {
  const i = argv.indexOf(flag);
  if (i === -1) return null;
  const raw = (argv[i + 1] ?? '').trim();
  return raw === '' || raw.startsWith('--') ? null : raw;
}

/**
 * ⭐ THE OPERATOR-TYPED BOUND, VALIDATED WITHOUT BEING NORMALISED.
 *
 * ⛔ THE EXPLICIT OFFSET IS PART OF THE GRAMMAR, NOT PEDANTRY. The bound is bound
 * as `$1::timestamptz`; a value with no `Z`/`±HH:MM` is parsed by Postgres in the
 * SESSION zone, so the same command line would name a different instant on a pod
 * with a different `TZ`. `2026-08-26` alone is refused for the same reason (and
 * because a bare date is almost always a mistyped instant, not a deliberate
 * midnight).
 *
 * ⛔ AT MOST SIX FRACTIONAL DIGITS. Postgres ROUNDS a 7th, and rounding a bound UP
 * skips the row it names — the opposite failure to the one this file just fixed,
 * and just as silent. Refuse instead.
 */
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/**
 * ⚠️ A SHAPE CHECK, NOT A UUID CHECK, AND DELIBERATELY SO. Postgres is the
 * authority on what `::uuid` accepts and it rejects a malformed one loudly; this
 * only catches the shell-level mistakes that would otherwise reach the bind — a
 * quoted pair, a stray comma, an empty string. The unit fixtures use short opaque
 * ids (`s3`), so a strict UUID regex here would test the harness, not the input.
 */
const AFTER_ID_SHAPE = /^[0-9a-zA-Z_-]{1,64}$/;

/**
 * `--after <iso>` AND `--after-id <uuid>` → the freeze cursor. Both, or neither.
 *
 * ⛔ IT THROWS RATHER THAN DEGRADING. A malformed instant silently coerced to
 * `null` would run the UNCURSORED freeze — i.e. re-freeze the stuck head — while
 * the operator believed they had moved past it, and the report would look exactly
 * like a healthy cursored run.
 *
 * ⛔ AND IT THROWS ON EITHER HALF ALONE, IN BOTH DIRECTIONS.
 *   `--after-id` with no `--after`: the id bounds nothing on its own, because the
 *      ordering it breaks ties within is `completed_at`.
 *   `--after` with no `--after-id`: the bare-instant arm was REACHABLE and it
 *      SKIPS a duplicate cluster's remainder — measured in the harness, it froze
 *      `[z9]` where the tuple form froze `[d2, d3, z9]`. It used to be merely
 *      WARNED about in the report, which is a footnote against silent data loss.
 *      ⚠️ AND `>=` IS NOT THE ALTERNATIVE FIX: a cluster larger than `--limit`
 *      then re-freezes forever, which is this PR's own bug. Only the pair both
 *      skips nothing AND always advances.
 *
 * ⛔ NOT NORMALISED THROUGH `Date`, AND THAT REVERSES WHAT THIS FUNCTION USED TO
 * SAY. It used to return `new Date(rawAfter).toISOString()` so the report echoed a
 * canonical instant — which quietly truncated a microsecond bound copied out of the
 * previous run's report (`…06.025665Z` → `…06.025Z`) and handed the operator a
 * cursor that lands BEFORE the row it names. `Date` is used here as a VALIDATOR
 * only; the value carried forward is the operator's own text. `stringFlag` already
 * refuses a value that is another flag, so a bare `--after --limit 25` is a missing
 * value, not a cursor of "--limit".
 */
function cursorFlag(argv: string[]): FreezeCursor | null {
  const rawAfter = stringFlag(argv, '--after');
  const rawId = stringFlag(argv, '--after-id');
  if (rawAfter === null) {
    if (rawId !== null) {
      throw new Error(
        '--after-id was given without --after. The tiebreak id bounds nothing on its ' +
          'own: it breaks ties WITHIN the completed_at ordering, so without an instant ' +
          'the freeze would silently start at the head of the population again.',
      );
    }
    return null;
  }
  if (!ISO_INSTANT.test(rawAfter) || Number.isNaN(new Date(rawAfter).getTime())) {
    throw new Error(
      `--after needs an ISO-8601 instant with an explicit UTC offset and at most 6 ` +
        `fractional digits (e.g. 2026-09-06T05:10:06.025665Z), got "${rawAfter}". It is ` +
        'REFUSED rather than ignored: an ignored cursor runs the UNCURSORED freeze, ' +
        'which re-freezes the same stuck head while printing a report that looks ' +
        'cursored. Copy the "NEXT BATCH" line out of the previous run\'s report ' +
        'VERBATIM — it is already microsecond-exact, and retyping it to millisecond ' +
        'precision walks the cursor back into the cluster it was meant to clear.',
    );
  }
  if (rawId === null) {
    throw new Error(
      '--after was given without --after-id. The pair is MANDATORY. `completed_at` is ' +
        'not unique — the bulk writers stamp N rows with one SQL now(), and the largest ' +
        'such cluster on prod is 71 rows sharing one microsecond — so a bare instant ' +
        'bound SKIPS every row sharing it, silently, and a paced walk loses the ' +
        "remainder of every cluster it lands on. Use the report's NEXT BATCH line, " +
        'which prints both halves.',
    );
  }
  if (!AFTER_ID_SHAPE.test(rawId)) {
    throw new Error(
      `--after-id must be an approval id, got "${rawId}". It is bound as ::uuid and a ` +
        'malformed value would fail deep inside the freeze rather than here.',
    );
  }
  return { completedAt: rawAfter, id: rawId };
}

/**
 * Who is accountable for this run. Recorded in the receipt.
 *
 * ⛔ An `--apply` run with no resolvable operator is REFUSED by `main`, not
 * recorded as "unknown". A receipt naming nobody is a receipt a future reader
 * cannot act on.
 */
export function resolveOperator(argv: string[], env: Record<string, string | undefined>): string {
  return (
    stringFlag(argv, '--operator') ??
    (env.REPAIR_OPERATOR ?? '').trim() ??
    ''
  ) || (env.USER ?? '').trim();
}

/**
 * @returns the process exit code. 0 = measured cleanly (dry run) or cleared >= 1;
 *          1 = REFUSED, nothing written; 3 = an apply run that froze ids and
 *          cleared nothing. A thrown error is mapped to 1 by the entrypoint.
 */
export async function main(argv: string[]): Promise<number> {
  const log = (m: string) => console.log(m);
  const err = (m: string) => console.error(m);
  const run = runRepair;
  const close = closeConnection;
  const env = process.env as Record<string, string | undefined>;

  const apply = argv.includes('--apply');
  const limit = numericFlag(argv, '--limit');
  const maxPopulation = numericFlag(argv, '--max-population');
  const after = cursorFlag(argv);
  const operator = resolveOperator(argv, env);

  // ⛔ REFUSED BEFORE THE CONNECTION IS OPENED. These need no database, and a
  // refusal that first opens a pool is a refusal that can fail for the wrong reason.
  if (apply && limit === null) {
    err(`⛔ REFUSED: ${REFUSAL_TEXT['no-limit']}`);
    return 1;
  }
  if (apply && maxPopulation === null) {
    err(`⛔ REFUSED: ${REFUSAL_TEXT['no-max-population']}`);
    return 1;
  }
  if (limit !== null && limit > MAX_LIMIT) {
    err(`⛔ REFUSED: ${REFUSAL_TEXT['limit-over-max']}`);
    return 1;
  }
  if (apply && operator === '') {
    err(
      '⛔ REFUSED: --apply needs an operator. Pass --operator <name>, or set ' +
        'REPAIR_OPERATOR. The receipt in _migration_effects records who ran the repair ' +
        'and a receipt naming nobody cannot be acted on.',
    );
    return 1;
  }

  log(
    `[repair] mode: ${apply ? 'APPLY (WILL clear callback_delivered_at)' : 'DRY-RUN (reports only, writes nothing)'}` +
      `, limit ${limit ?? '(none)'}` +
      `, max-population ${maxPopulation ?? '(NONE DECLARED)'}` +
      `, after ${after === null ? '(none — from the OLDEST row)' : `${after.completedAt} / ${after.id}`}` +
      `, operator ${operator === '' ? '(none)' : operator}`,
  );
  if (maxPopulation === null) {
    // Only reachable on a DRY RUN — `--apply` without a ceiling was refused above.
    log(
      '[repair] ⚠️ NO --max-population CEILING WAS DECLARED. The signature is therefore ' +
        'unguarded this run: if it has silently widened, nothing here will notice. That ' +
        'is tolerable in a DRY RUN, which writes nothing, and is REFUSED with --apply.',
    );
  }
  if (!apply) log('[repair] re-run with --apply --limit N to arm. Nothing below is written.');

  try {
    const result = await run({ apply, limit, maxPopulation, after, operator });
    log(formatReport(result));
    if (result.refusal !== null) return 1;
    // ⛔ `eligibleIds`, NOT `frozenIds` — see the matching note in `formatReport`.
    if (apply && result.eligibleIds.length > 0 && result.cleared === 0) return 3;
    return 0;
  } finally {
    await close();
  }
}

if (import.meta.main) {
  main(process.argv.slice(2))
    .then((code) => {
      if (code !== 0) process.exit(code);
    })
    .catch((error) => {
      console.error('[repair] run failed:', error);
      process.exit(1);
    });
}
