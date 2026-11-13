// src/workers/deblock-callback-redelivery.ts
//
// Re-delivers the n8n DE-BLOCK callback for approvals that were decided but
// whose callback never landed, so the Planka card stayed in BLOCKED.
//
// ⛔ READ THIS BEFORE CHANGING ANYTHING HERE. main REFUSED this worker twice.
// =========================================================================
// `server.ts` carried a block titled "NO DE-BLOCK CALLBACK RE-DELIVERY WORKER
// IS REGISTERED HERE, DELIBERATELY", and it was right on both counts:
//
//   1. THE RECEIVER IS NOT IDEMPOTENT. Read off the live active version of
//      "AA Pattern - Approval Callback" (n8n id yG1N9K2hTswEZNTq): `Parse
//      Decision` computes shouldMoveCard without ever consulting the card's
//      current list, and `Move Card` is an unconditional card.update{listId}.
//      Only the MERGE action has an `already_merged` branch. A re-sent
//      `approved` does NOT no-op on a card that already moved — it moves it
//      again.
//   2. NULL DID NOT MEAN "FAILED". Every row was NULL because
//      `callback_delivered_at` (migration 109) DID NOT EXIST, which is
//      indistinguishable from a failed send. Joining those card_ids against
//      live Planka found 424 in BLOCKED but also 110 in DONE, 45 in TODO and
//      8 deleted. A naive re-delivery would have dragged 110 DONE cards back
//      into DOING — cards that are DONE precisely because their callback
//      SUCCEEDED.
//
// That refusal named its own exit condition: a re-delivery becomes safe with
// "either an idempotent receiver or a live card-state join before it may send
// anything". This worker takes the second option, and the gate is the entire
// reason it is allowed to exist:
//
//   ⭐ IT SENDS ONLY FOR A CARD THAT IS CURRENTLY IN THE BLOCKED LIST.
//
// That is not a heuristic, it is what makes objection (2) irrelevant rather
// than merely unlikely. A DONE card is not in BLOCKED, so it is never a
// candidate — no matter how ambiguous its NULL is. The ambiguity that made the
// refusal correct is dissolved by asking Planka instead of asking the column.
// It also makes objection (1) harmless in the direction that matters: moving a
// card that IS in BLOCKED to DOING is the repair being requested.
//
// ⚠️ The residual race is one card: a card can leave BLOCKED between the read
// and the POST. It is bounded to a single row per tick per card, needs a human
// to move that exact card inside a ~5s window, and its worst outcome is one
// card moved to DOING that someone had just moved elsewhere — recoverable, and
// orders of magnitude smaller than the 110-card class it replaces. Stated
// rather than hidden: this worker cannot make the move atomic, because Planka
// has no compare-and-set on listId.
//
// WHAT THIS FIXES
// ---------------
// Measured on prod 2026-09-05: 1,541 cards sit in the kanban BLOCKED list; 510
// of them have at least one `approved` approval; 282 of those have NO pending
// approval at all — nothing is coming to release them — and all 282 carry
// `callback_delivered_at IS NULL` on every approved row. Zero were ever
// delivered. `routes/approvals.ts` fires the callback un-awaited and reports a
// failure only to `console.error`, so nothing retried and nothing recorded it.
//
// ⚠️ AND THE REPO ALREADY DESCRIBED THIS WORKER AS IF IT EXISTED. A CI step
// comment (in the since-deleted hand-written workflow) asserted "THE RATE LIMIT IS A SAFETY
// PROPERTY, NOT A TUNABLE, and it is tested as one... MAX_PER_RUN (10), the
// inter-request delay (500ms) and the do-not-fire-on-boot behaviour each have
// their own case, and each is verified by mutation". None of that code or
// those tests existed — `MAX_PER_RUN` appeared nowhere in backend/src or
// backend/tests. This commit makes that paragraph true instead of deleting it,
// which is why the three constants below are the ones it names.
//
// ⚠️ ONE CLAUSE OF THAT PARAGRAPH IS NOW STALE: "the
// do-not-fire-on-boot behaviour" no longer exists — the worker DOES fire on boot,
// because a 15-minute interval meant a 28-minute pod completed zero or one tick.
// The full measurement and the stampede argument are in the docblock on
// `startDeblockRedeliveryWorker` at the bottom of this file. MAX_PER_RUN and the
// 500 ms pace are unchanged and still tested; only the boot clause moved.
//
// ═════════════════════════════════════════════════════════════════════════════
// ⛔ MIGRATION 113 — THE WORKER WAS RETIRING ROWS ON AN ACK, AND NEVER RETIRING
//    THE ROWS IT SKIPPED. Both halves are fixed here. Read this before touching
//    the candidate SQL or `deliverAll`.
// ═════════════════════════════════════════════════════════════════════════════
//
// DEFECT 1 — A 2xx IS NOT A REPAIR.
// `deliverDecisionCallback` stamped `callback_delivered_at` the moment n8n
// returned 2xx, and `callback_delivered_at IS NULL` was half of the predicate
// below. So every row that got a transport ack was permanently retired from the
// only repair path there is — whether or not anything moved. n8n acks on
// receipt; the Planka `card.update{listId}` happens afterwards, in a queue
// measured giving up (61 rows) behind a Planka measured 504-ing (20 rows).
//
//   MEASURED 2026-09-06: of 373 callbacks delivered in the last 30h, 373 of 373
//   (253 distinct cards) are STILL IN BLOCKED. 216 approved-but-still-blocked
//   cards are already stamped and therefore already unreachable. This worker was
//   draining its own queue, not the board — and reporting healthy ticks doing it.
//
// The fix: `deliverDecisionCallback` now writes `callback_acked_at`, and
// `callback_delivered_at` is written HERE, only next to
// `callback_resolution = 'moved'`, only after Planka has been re-read and the
// card is observably out of BLOCKED. An ack no longer retires anything; it opens
// a grace window (ACK_GRACE_MS) so a card that is genuinely mid-move is not
// hammered, and a card that never moves comes back as a candidate.
//
// ⚠️ THE IMMEDIATE POST-SEND RE-CHECK IS BEST-EFFORT AND IS SUPPOSED TO BE.
// n8n's move is asynchronous, so the re-read right after the 2xx will often
// still say BLOCKED. That is not a failure — it leaves the row acked, unretired,
// and the NEXT tick past the grace window resolves it. The synchronous check is
// there because when n8n *is* synchronous it closes the row immediately and
// costs one Planka read; the deferred path is what makes the mechanism correct.
//
// DEFECT 2 — `not_blocked` AND `unreadable` ROWS WERE NEVER WRITTEN TO AT ALL.
// The candidate SQL has no blocked predicate; blockedness is decided afterwards
// by the live `isBlockedList` gate. A row the gate classified `not_blocked`
// (~29/tick) or `unreadable` (~11/tick) was merely counted and skipped, so it was
// re-selected on every scan cycle, forever, and the residue grew until it owned
// the 40-row window. They now reach a TERMINAL state — `callback_resolution` —
// and the values are kept distinct on purpose (⚠️ FIVE now, not three; this list
// has been wrong about its own length twice, so count the lines, not the prose):
//
//   'moved'             we sent and the card was then observed out of BLOCKED
//   'not_blocked'       the card was already off the board and we never sent
//   'card_unreadable'   Planka answered 404 for the card, repeatedly, over hours
//   'send_exhausted'    MAX_SEND_ATTEMPTS acked sends and the card never moved
//   'hold_acknowledged' the receiver's own 200 body says it is holding the card
//                       ON PURPOSE, so we stopped after ONE send — see
//                       `classifyReceiverHold`. Distinct from `send_exhausted`
//                       because that value blames a receiver that was in fact
//                       answering and explaining itself.
//
// A future reader must be able to tell "we moved it" from "it was already gone"
// from "we cannot see it" from "n8n keeps accepting and nothing happens" from
// "n8n is deliberately holding it and told us so". A single boolean cannot, which
// is why there is not one.
//
// ⛔ `card_unreadable` NEEDS MORE THAN A COUNT OF MISSES. The note on
// `scanOffset` below already refuses the one-shot version and is right: a card
// reads as unreadable both when it is deleted and when Planka is unreachable.
// ⚠️ CORRECTED 2026-09-06 — this paragraph used to finish "UNREADABLE_STRIKES
// consecutive misses across a 15-minute tick with a rotating window spans hours;
// no blip does". IT DOES NOT. `advanceScan` wraps the window to 0 as soon as a
// scan comes back short, so the same rows are re-read every 15 minutes and three
// strikes is FORTY-FIVE MINUTES — shorter than the Planka 504 windows this
// repo's own headers measure. Retirement therefore needs FOUR things, and the
// fourth is a different KIND of thing from the first three. See the constants.
//
//   1. a DEFINITIVE miss — a 404, and ⛔ a 404 ON THE CARD'S OWN READ PATH. A
//      5xx, a 429, a timeout, an auth failure, or a 404 raised by the LIST read
//      or by `loginAgent` does not strike at all. See `classifyReadFailure`:
//      testing `status === 404` alone struck on all three, and a misrouted
//      PLANKA_BASE_URL therefore struck every candidate on every tick.
//   2. UNREADABLE_STRIKES consecutive such misses.
//   3. that run spanning UNREADABLE_MIN_SPAN_MS of wall clock.
//   4. ⭐ the TICK containing at least one SUCCESSFUL card read — positive proof
//      that Planka is reachable, authenticating and correctly routed. See
//      BREAKER_MIN_READS and `applyStrikes`. ⚠️ CORRECTED 2026-09-07: term 4 used
//      to be "≥60% of this tick's verdicts were 404", which keyed the guard on
//      DELETION instead of on brokenness, and fired on a healthy Planka.
//
// ⛔ THERE IS NO TERM 5, AND FOUR CANDIDATES FOR ONE WERE BUILT AND DELETED ON
//    2026-09-07. Do not add a fifth without reading the block at `applyStrikes`
//    titled "FOUR DISCRIMINATORS WERE TRIED" — every probe fr can make of Planka
//    collapses to the SAME predicate (the agent's own access), so a new one
//    cannot distinguish "this card is gone" from "I can no longer see it". The
//    exposure that leaves is stated there, and it is unchanged from main.
//
// ⚠️ CORRECTED 2026-09-06 — TERMS 1-3 ARE NOT INDEPENDENT DEFENCES, AND THIS
// FILE USED TO CLAIM THEY WERE ("Two independent terms, so either one alone
// still refuses", at UNREADABLE_MIN_SPAN_MS). All three look at ONE ROW. Against
// the failure the claim itself named — a Planka that 404s everything, e.g. a
// token that lost board access — term 1 never refuses because every read really
// is a 404, and term 3 only postpones the write-off by six hours. There was NO
// cross-row guard at all, so ~726 rows still went terminal, silently, reversible
// only by hand-written SQL. Term 4 is that guard, and it is the only one of the
// four that can see the difference between a deleted card and a broken Planka.
//
// ⭐ WHY BLOCKEDNESS STAYS A LIVE CHECK AND DOES NOT MOVE INTO THE SQL.
// It cannot move. Blockedness is a property of a Planka card's list; nothing in
// the `approvals` table mirrors it, and any column that did would be a stale copy
// — which is exactly the ambiguity the header above says asking Planka dissolves.
// The reconciliation is the other direction: the OUTCOME of the live gate is now
// PERSISTED, so the query can exclude rows the gate has already decided about.
// The two notions no longer disagree; one feeds the other.
import { sql } from 'drizzle-orm';

import { db as defaultDb } from '../db/client';
import { LOCK_KEYS } from '../db/advisory-lock-keys';
import {
  causeOfSendExhaustion,
  classifyDeblockExit,
  HOLD_CAUSES,
  READ_DEGRADED_CAUSES,
  SEND_EXHAUSTION_CAUSES,
  type HoldCause,
  type ReadDegradedCause,
  type SendExhaustionCause,
  isReceiverRefusedReclassify,
  REJECTED_HOLD_ACTIONS,
} from '../domain/engagement/deblock-actions';
import {
  recordHoldAcknowledged,
  recordReadDegraded,
  recordSendExhaustion,
} from '../lib/deblock-action-metrics';
// ⭐ `VOIDED_CALLBACK_PATHS` is IMPORTED, NOT RETYPED — see `notAnUnroutableVoid`.
// This worker's exclusion and the sender's refusal must be the same set or they
// disagree about the same row, which is the defect the exclusion exists to end.
import { VOIDED_CALLBACK_PATHS, deliverDecisionCallback } from '../services/n8n-callback';
// `encodePath` is imported for `cardReadPath` — the card-read path must be
// constructed the SAME way services/planka/cards.ts constructs it, not merely
// the same way by eye. See the note on `classifyReadFailure`.
import { encodePath, plankaClient } from '../services/planka';
import { PlankaError, PlankaValidationError } from '../services/planka/errors';
import { isBlockedList } from '../services/toc-hooks';
// ⭐ MERGE-QUEUE fr row 12 — the signoff refusals. Every input is IMPORTED, never
// retyped: the platform list is fr's ONE `PLATFORM_TENANT_IDS`, the card→tenant
// chain is the one GET /api/cards/:id gates on, the journey reducer is the one that
// route serves as `phase_journey`, and the receiver path is the one the signoff
// mint route validates against.
import { isPlatformTenant } from '../routes/assets/_lib/system-union';
import {
  buildPhaseJourney,
  loadCardActionsViaPlanka,
  readCardActionHistory,
  type RawCardAction,
} from '../routes/cards/get';
import { CANONICAL_CALLBACK_PATH as SIGNOFF_CALLBACK_PATH } from '../routes/execution-approvals';
import { resolveBoardTenant } from '../lib/board-tenant-access';

const ADVISORY_LOCK_KEY = LOCK_KEYS.deblockCallbackRedelivery;

/**
 * Every 15 minutes — the cadence of the expiry reaper this complements.
 *
 * ⚠️ READ THIS BEFORE REASONING ABOUT ANY "how long until we give up" WINDOW.
 * The scan window rotates (see `scanOffset`), but `advanceScan` WRAPS TO 0 the
 * moment a scan comes back short — which it does as soon as the residue drains
 * and fewer than MAX_READS_PER_RUN candidates remain. From then on the same
 * rows are re-read EVERY interval. So a threshold expressed in ticks is a
 * threshold in multiples of 15 minutes, not "hours": three ticks is 30 minutes
 * of elapsed time and 45 minutes from first miss to third. Any window that must
 * outlast an outage has to be measured on the WALL CLOCK, not counted in ticks.
 */
const DEFAULT_INTERVAL_MS = 900_000;

/**
 * Rows this worker may DELIVER in one tick.
 *
 * ⛔ A SAFETY PROPERTY, NOT A TUNABLE.
 * Of the original delivery failures, 20 were Planka answering `504 Gateway
 * Time-out ... nginx` under load, and the trigger for the whole incident was
 * 727 approvals decided in ~7 seconds. An unthrottled retry of a 282-card
 * backlog re-creates the exact burst that caused it. Raising this is not a
 * throughput decision, it is a decision to risk repeating the outage.
 */
export const MAX_PER_RUN = 10;

/**
 * Pause between rows, for the same reason as MAX_PER_RUN.
 *
 * ⛔ NOT AN ENV VAR, DELIBERATELY. The rate limit is a safety property, not a
 * tunable — an operator must not be able to set it to 0 and re-create the burst
 * that produced the Planka 504s.
 */
const PACE_MS = 500;

/**
 * Rows this worker may READ (i.e. ask Planka about) in one tick.
 *
 * ⛔ THIS IS SEPARATE FROM MAX_PER_RUN AND IT HAS TO BE. Measured on the FIRST
 * production tick, 2026-09-05 10:45Z:
 *
 *     candidates=10 eligible=0 delivered=0 not_blocked=0 unreadable=10 more=true
 *
 * All ten were `Card not found`. The gate did exactly the right thing — it sent
 * nothing — but an unreadable row is NEVER STAMPED (correctly: nothing was
 * delivered), so the identical ten come back next tick, and the tick after that,
 * forever. The eleven oldest candidates are from 2026-07-04 and their cards are
 * long deleted, so the worker would have spun on dead rows every 15 minutes and
 * never reached the 526 distinct cards behind them. HEAD-OF-LINE STARVATION: it
 * would have repaired nothing, while reporting healthy ticks.
 *
 * Using one constant for both is what caused it — `LIMIT MAX_PER_RUN` bounded
 * the SCAN when MAX_PER_RUN's whole purpose is to bound the SENDS (Planka 504
 * protection). They are different risks and now have different numbers.
 */
const MAX_READS_PER_RUN = 40;

/**
 * How long an ACKED-but-unresolved row is left alone before it is a candidate
 * again.
 *
 * ⛔ THIS IS THE REPLACEMENT FOR "a 2xx retires the row", NOT A TUNABLE EITHER.
 * n8n's move is asynchronous, so a row that has just been acked may be moments
 * from moving; re-sending it immediately would move the card twice (the receiver
 * still does not dedupe — see the header). Two ticks is long enough that a
 * healthy n8n has certainly finished, and short enough that a card the queue
 * dropped is retried the same hour instead of never.
 *
 * ⚠️ NOT AN ENV VAR AND NOT INJECTABLE, deliberately: a test that needs to prove a
 * row is still a candidate backdates `callback_acked_at` in SQL, which exercises
 * this real constant instead of replacing it.
 */
const ACK_GRACE_MS = 1_800_000;

/**
 * ⭐ THE FAST LANE'S WINDOW — how recently a decision must have been made for it
 * to be scanned AHEAD of the rotating backlog walk.
 *
 * ⛔ THE DEFECT THIS CLOSES. The scan was `ORDER BY a.completed_at NULLS LAST`
 * over ONE window of MAX_READS_PER_RUN rows at a rotating offset. Measured on
 * prod `fr` (worker4) 2026-09-10: 1,410 approved rows carry no
 * `callback_resolution`; decomposed against this worker's own predicate, 2 lack
 * `card_id`/`callback_path`, 593 are shadowed by a live `pending` gate on the
 * same card, and **815 are live candidates the walk has simply not reached**. A
 * decision made SECONDS ago sorts behind every one of them, so at 40 reads a
 * tick and 900 s a tick it is ~11 ticks — **≈2.7 hours** — before the newest
 * failure is so much as LOOKED at. For a conveyor with humans (or Claude agents)
 * in the approval seats, that is the difference between "the callback failed and
 * self-repaired" and "the demo is stuck".
 *
 * ⛔ AND THE FIX IS NOT TO INVERT THE ORDER. `ORDER BY completed_at DESC` repairs
 * the newest and starves the 815 permanently — one starvation traded for
 * another, and the older one is the bigger population. The fast lane is a
 * BOUNDED RESERVE instead: see FAST_LANE_READS.
 *
 * ⚠️ THE WIDTH IS DERIVED, NOT CHOSEN, so it cannot drift out of step with the
 * two constants it depends on. A fresh row is sent on the tick that finds it,
 * `deliverDecisionCallback` stamps `callback_acked_at`, and the ack clause in
 * `candidateWhereBase` then hides the row for ACK_GRACE_MS. So a window narrower
 * than `ACK_GRACE_MS + one tick` would let a row leave the fast lane DURING its
 * own grace period — i.e. get exactly one attempt and then fall back into the
 * 2.7-hour walk, which is the defect wearing a fast lane's name. Two ticks of
 * headroom guarantees the second attempt lands strictly INSIDE the window:
 *
 *   sent at        <= T + 900_000                    (one tick to be found)
 *   invisible until   + 1_800_000                    (ACK_GRACE_MS)
 *   next look at   <= T + 2_700_000  <  T + 3_600_000  ✅
 */
export const FRESH_WINDOW_MS = ACK_GRACE_MS + 2 * DEFAULT_INTERVAL_MS;

/**
 * Rows the FAST LANE may read in one tick, on top of the backlog page.
 *
 * ⚠️ THIS NUMBER IS ONLY HALF THE ANTI-STARVATION GUARANTEE. THIS DOCBLOCK USED
 * TO CLAIM IT WAS THE WHOLE OF IT, AND THAT CLAIM WAS FALSE IN EXACTLY THE
 * CONDITION THE LANE EXISTS FOR — corrected 2026-09-10, hours after it shipped.
 *
 * What it said is true as far as it goes, and still holds: FAST_LANE_READS (5)
 * is strictly less than MAX_PER_RUN (10) and the fresh rows are delivered FIRST,
 * so the fast lane can consume at most 5 of the tick's 10 SEND slots and
 * MAX_PER_RUN - FAST_LANE_READS = 5 send slots are always left unclaimed by it.
 *
 * ⛔ BUT MAX_PER_RUN IS NOT THE ONLY THING THAT ENDS A TICK, AND IT IS NOT THE
 * BINDING ONE WHEN IT MATTERS. `deliverAll` ALSO breaks on
 * `Date.now() >= deadline` (DEBLOCK_REDELIVERY_TICK_DEADLINE_MS, default 60s),
 * and every row costs PACE_MS plus a Planka `cards.get` — plus a `lists.get` —
 * whose client timeout is 15s with one retry. An unclaimed SEND SLOT is worth
 * nothing to a lane the loop never reaches:
 *
 *   healthy Planka (~100 ms/read): 5 fresh rows ≈ 3s of a 60s budget. The send-
 *     slot argument above is the whole story and the backlog gets its 5 sends.
 *   degraded Planka (~11 s/read) : 5 fresh rows ≈ 57s of a 60s budget — and
 *     11s+ reads are precisely the condition that CREATES the backlog. The
 *     deadline fires at or before the backlog's FIRST row, so the 815-row
 *     backlog receives ZERO repairs, on every tick, for the whole outage.
 *
 * A guarantee that holds in the happy path and fails in the condition it was
 * written for is worse than no guarantee, because it gets quoted instead of
 * re-derived. ⭐ THE COUNT RESERVE IS THEREFORE PAIRED WITH A TIME RESERVE —
 * see FAST_LANE_DEADLINE_SHARE. Read the two together; NEITHER ALONE IS THE
 * GUARANTEE, and the time reserve is the one that binds under load.
 *
 * ⚠️ AND THE READ BUDGET IS ADDITIVE, NOT CARVED OUT OF MAX_READS_PER_RUN —
 * deliberately, and this is the load-bearing choice. Shrinking the backlog page
 * to 40 - 5 would change the page SIZE, and `seedScanOffset` aligns start
 * positions to that size precisely so "start positions and walk positions are
 * the same grid" is an identity. Changing it silently changes the coverage
 * argument the whole scan rests on (and reddens the literals in
 * tests/unit/workers/deblock-scan-seed.test.ts, which exist to make exactly that
 * change loud). So the backlog page stays 40 and a tick reads at most 45 rows.
 *
 * ⚠️ WHAT THAT COSTS, STATED RATHER THAN HIDDEN: up to 5 extra `cards.get` calls
 * per tick — a ~12% increase in this worker's Planka read volume, one tick every
 * 900 s. It does NOT touch the bound that the 504 incident was actually about:
 * MAX_PER_RUN (10 sends) and PACE_MS (500 ms) are unchanged, so the outbound
 * burst is identical. MAX_READS_PER_RUN's own docblock says its purpose is
 * head-of-line starvation, not load — and this is the same purpose, one lane over.
 *
 * ⚠️ SIZED AGAINST MEASURED DEMAND, NOT GUESSED: 5 rows/tick is 20/hour, against
 * a measured decision rate of ~1,756 decisions in 30 days ≈ 2.4/hour. The lane
 * has ~8x headroom over steady state. What happens ABOVE that is the honest
 * limit — see the ORDER BY note on `selectFreshCandidates`.
 */
export const FAST_LANE_READS = 5;

/**
 * The share of ONE TICK'S WALL CLOCK the fast lane may spend before it must hand
 * the rest of the tick to the backlog walk.
 *
 * ⭐ THIS IS THE HALF OF THE ANTI-STARVATION GUARANTEE THAT BINDS UNDER LOAD.
 * FAST_LANE_READS reserves SEND SLOTS; this reserves TIME, and time is what
 * `deliverAll` actually runs out of first when Planka is slow. Together:
 *
 *   • the fast lane may START a row only while `now < tickStart + SHARE*budget`;
 *   • the backlog therefore ENTERS the loop with at least `(1-SHARE)*budget`
 *     of the tick left, whatever a fresh read cost;
 *   • and the FIRST row of EACH lane is attempted unconditionally, so neither
 *     lane can be reduced to zero attempts by the other or by a budget that was
 *     already spent before the loop began.
 *
 * ⛔ A FRACTION, NOT A MILLISECOND CONSTANT, AND THAT IS LOAD-BEARING. The tick
 * budget is operator-tunable (`DEBLOCK_REDELIVERY_TICK_DEADLINE_MS`). An
 * absolute reserve — "the fast lane gets 30s" — silently becomes the WHOLE
 * budget the moment someone sets the deadline to 30s, i.e. the guarantee
 * evaporates through a knob that has nothing to do with it and no test on this
 * file would notice. A share is invariant under that knob by construction.
 *
 * ⚠️ WHY 0.5 AND NOT 0.2 OR 0.8, STATED AS A TRADE-OFF RATHER THAN A DEFAULT.
 * The two lanes are repairing the SAME defect for two populations and neither is
 * the junior one: the fast lane exists so a decision made 30 seconds ago is not
 * invisible for 2.7 hours, and the backlog walk exists so 815 older rows are not
 * invisible forever. An even split is the only number that does not encode a
 * preference between them, and the preference is already expressed once — the
 * fast lane goes FIRST, so under a healthy Planka it finishes inside ~3s and
 * hands back 95% of the budget it was allowed. The share only bites when reads
 * are slow, and then it bites both lanes identically.
 *
 * ⚠️ WHAT IT COSTS THE FAST LANE, SAID PLAINLY: under a degraded Planka the lane
 * no longer gets 5 reads. At ~11 s/read and a 60s budget it gets 2 or 3, and the
 * rest of the fresh rows wait one interval (900s) — NOT the ~2.7h backlog walk,
 * because `selectFreshCandidates` orders `completed_at DESC` and FRESH_WINDOW_MS
 * is four intervals wide, so a deferred fresh row is still in the fast lane next
 * tick and still ahead of every backlog row. The NEWEST decision is attempted
 * FIRST on every tick, unconditionally — that property is stronger than the one
 * this lane originally shipped with, which held only while 5 reads fit.
 *
 * ⚠️ AND WHAT IT COSTS THE LOCK. The advisory lock is held across the sends (see
 * runDeblockRedeliveryTick), and the deadline is checked BEFORE a row, so a hung
 * read always overshoots by one row. The per-lane floor makes the worst case TWO
 * rows rather than one — bounded by the same Planka client timeout, ~131s per
 * row, against a 900s interval. That is a real cost and it is the price of the
 * backlog never being reduced to zero.
 */
export const FAST_LANE_DEADLINE_SHARE = 0.5;

/**
 * Consecutive DEFINITIVE misses before a row is retired as `card_unreadable`.
 *
 * ⛔ NOT 1, and ⛔ NOT SUFFICIENT ON ITS OWN. Retirement needs all four of:
 *   1. the miss being DEFINITIVE — Planka answered 404 ON THE CARD'S OWN READ
 *      PATH (`/api/cards/:id`). See `classifyReadFailure`: a 5xx, a 429, a
 *      timeout, a network error, a malformed payload, a 404 from the LIST read,
 *      or an auth failure (`loginAgent`, which raises 404 on a misrouted base
 *      URL) is NOT evidence the card is gone, and does not strike at all;
 *   2. UNREADABLE_STRIKES consecutive such misses, any successful read
 *      resetting the run;
 *   3. that run spanning UNREADABLE_MIN_SPAN_MS of wall clock;
 *   4. the TICK not looking like a Planka-wide failure — see
 *      BREAKER_MIN_READS + the successful-read rule. ⚠️ Terms 1-3 are all
 *      PER-ROW and therefore all blind to a Planka that 404s everything; term 4
 *      is the only cross-row one. They are NOT four independent defences and
 *      this file used to say they were;
 *
 * ⛔ AND THERE IS NO FIFTH TERM. Terms 1-4 all assumed a token that lost board
 * access answers 403; the Planka this estate runs answers 404 (see
 * `classifyReadFailure`), and term 4 cannot see a PARTIAL access loss because the
 * boards we still hold keep `successfulReads` above zero. Four different probes
 * were built to close that and all four collapse to the same predicate — see the
 * block at `applyStrikes` titled "FOUR DISCRIMINATORS WERE TRIED". The residual
 * exposure is real, stated there, and identical to `origin/main`'s.
 *
 * ⚠️ CORRECTED 2026-09-06. This block used to say a card missing "across three
 * separate ticks (≥30 min apart, and further apart once the scan window
 * rotates)" is written off, and the migration header said the same three misses
 * "spans hours". BOTH WERE WRONG. `advanceScan` wraps the offset to 0 whenever a
 * scan comes back short, so once the residue drains the same rows are re-read
 * every DEFAULT_INTERVAL_MS: three strikes is FORTY-FIVE MINUTES from first miss
 * to retirement (0, +15, +30, retire at the third). A Planka 504 window and an
 * expired agent token both routinely outlast that. Conditions 1 and 3 exist
 * because condition 2 measures ticks, and ticks are not time.
 */
const UNREADABLE_STRIKES = 3;

/**
 * Wall-clock span the run of definitive misses must cover before it retires a
 * row, measured from `callback_unreadable_first_at`.
 *
 * ⛔ THIS IS THE ONLY TERM IN THE RETIREMENT RULE THAT AN OUTAGE CANNOT
 * COMPRESS. Six hours is chosen against two measured numbers: a full rotation
 * of the scan window over the 726-row population is ~4.75h (19 ticks at 40
 * reads), and the incident this worker repairs was a burst-induced Planka
 * degradation lasting minutes-to-hours. Six hours therefore outlasts a full
 * rotation, so a retirement can never be the product of one degraded window,
 * and it is short enough that a genuinely deleted card is off the books the
 * same day.
 *
 * ⚠️ CORRECTED 2026-09-06 — THIS BLOCK USED TO CLAIM: "It is redundant with the
 * 404-only rule ON PURPOSE — a Planka that answers 404 for everything (a bad
 * deploy, an agent token that lost board access) is precisely the failure the
 * 404 rule cannot see... Two independent terms, so either one alone still
 * refuses." ⛔ THAT WAS FALSE, AND FALSE FOR THE EXACT EXAMPLE IT NAMED.
 *
 * Both terms are PER-ROW. Under a Planka that 404s every card, term 1 (the
 * 404-only rule) never refuses — every read really IS a 404 — and this term
 * refuses only for six hours, after which every row in the population satisfies
 * it simultaneously and ~726 rows go terminal in a handful of ticks. There was
 * no cross-row guard anywhere, so "either one alone still refuses" was exactly
 * backwards: neither one alone refuses, they merely agree to wait 6h first.
 *
 * The cross-row term is BREAKER_MIN_READS below, and it is a DIFFERENT KIND of
 * term — it reads the tick, not the row. This one still earns its place: it is
 * the only term that survives a Planka that answers 404 for SOME cards while
 * answering normally for others (which the breaker deliberately does NOT trip
 * on — see that block), and it is the only one an outage cannot compress.
 */
const UNREADABLE_MIN_SPAN_MS = 21_600_000;

/**
 * ⭐ THE CROSS-ROW TERM'S SAMPLE-SIZE FLOOR. The minimum number of card reads a
 * tick must have made before the SHAPE of that tick is allowed to mean anything.
 *
 * ⚠️ RENAMED 2026-09-07 from `DEGRADED_TICK_MIN_READS`. It floors the same
 * denominator it always did — VERDICTS, never reads attempted — but the test it
 * floors is no longer a ratio. See `applyStrikes`.
 *
 * ⛔ WHY A CROSS-ROW TERM HAD TO EXIST AT ALL. Terms 1-3 are all per-row, and a
 * per-row rule cannot distinguish "this card was deleted" from "the card read is
 * broken for every card", because in the second case each individual row
 * presents EXACTLY as the first. The only thing that can see it is the SHAPE OF
 * THE TICK.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ ITS COMPANION CONSTANT `DEGRADED_TICK_GONE_RATIO = 0.6` IS DELETED, NOT
 *    RETUNED, AND MUST NOT BE REINTRODUCED. 2026-09-07.
 * ═══════════════════════════════════════════════════════════════════════════
 * The breaker used to trip when ≥60% of a tick's verdicts came back 404, on the
 * premise printed in its own log line: "A whole population does not vanish at
 * once; this is evidence about Planka — a lost agent token, a bad deploy or a
 * misrouted PLANKA_BASE_URL."
 *
 * ⭐ THAT PREMISE IS FALSE HERE, AND THE FALSIFICATION IS MEASURED, NOT ARGUED.
 * A whole population CAN vanish at once — in AGE ORDER — because Planka reaps old
 * cards. The age distribution of the cards that read 404: every one is 24-85 days
 * old against a healthy-population mean of 11.3 days (n=270), clustered in two
 * tenants, minted 2026-06-14 to 2026-08-13. That is retention, not an outage.
 * ⚠️ AND THE PAGING CONCENTRATES IT WHERE THE BREAKER LOOKS: the scan is `ORDER
 * BY a.completed_at NULLS LAST` (oldest first) and `advanceScan` wraps to offset
 * 0 on any short scan, so the reaped head is packed into the head of every
 * rotation. A high gone-ratio is therefore the EXPECTED shape of a healthy tick
 * here, not an anomaly — which is why no value of that ratio was ever going to
 * work, and why the 0.6 derivation ("the worst legitimate all-gone concentration
 * is 11 in a 20-verdict window = 0.55, so 0.6 clears it") was falsified by the
 * very population it was derived against: production produced 22 gone in a
 * 35-verdict page, and 22 in 27.
 *
 * ⭐ WHAT REPLACED IT IS THE AUTHOR'S OWN THREAT MODEL, TESTED DIRECTLY. Every
 * failure that block named — lost agent token, bad deploy, misrouted
 * PLANKA_BASE_URL — produces ZERO SUCCESSFUL CARD READS. Retention does not: the
 * two tripping production ticks had 13 successful reads and 5. A token that is
 * lost cannot read 13 cards correctly. So the breaker now trips on
 * `successfulReads === 0`, which is already inside its old denominator
 * (`verdicts - pending.length`) and needed no new measurement at all.
 *
 * WHY 20 IS STILL 20: MAX_READS_PER_RUN is 40, so 20 is HALF THE SCAN WINDOW. A
 * tick that got a verdict on fewer than half its window is the drained tail,
 * where "all 3 candidates were 404" is a statement about 3 rows and not about
 * Planka.
 *
 * ⚠️ THE RESIDUAL IS STATED, NOT HIDDEN: a tick with fewer than 20 verdicts is
 * not covered. Under a total-404 misconfiguration that can wrongly retire at most
 * 19 rows — and only after each has independently satisfied UNREADABLE_STRIKES
 * and the 6h span. Bounded, unlike the whole-population write-off it stops.
 */
const BREAKER_MIN_READS = 20;

/**
 * ⭐ #1104 — CONSECUTIVE ANSWERLESS READS BEFORE A ROW IS RETIRED AS `read_degraded`.
 *
 * ⛔ READ THIS BEFORE CONCLUDING THAT THE NO-STRIKE RULE HAS BEEN WEAKENED. IT HAS
 * NOT, AND NOTHING BELOW TOUCHES IT.
 * ═══════════════════════════════════════════════════════════════════════════
 * A 'degraded' read still charges NO `callback_unreadable_reads` strike, still
 * clears no run, and still sends nothing. `card_unreadable` means exactly what it
 * meant — Planka answered 404 on the card's OWN read path — and this bound cannot
 * write that value. What #1104 measured is the CONSEQUENCE of that correct rule
 * having no companion: an answerless read charged nothing at all, so a card whose
 * read NEVER answers had no bounded exit of any kind. `callback_send_attempts` never
 * moved (the worker fails closed and never sends), `callback_unreadable_reads` never
 * moved (correctly), and the row re-entered the scan forever.
 *
 * MEASURED on prod, 12 consecutive ticks 2026-09-21T15:10:42Z → 17:55:41Z, every
 * field byte-identical: `candidates=18 ... unreadable=18 eligible=0 acked=0
 * successful_reads=0 more=false`. The whole visible queue, stuck, with zero churn —
 * ~3,456 Planka reads a day producing nothing. All 18 fail at `lists.get` on two
 * `type='archive'` lists, while the CARD read returns 200 for every one of them.
 *
 * ⛔ AND IT IS A DIFFERENT NUMBER FROM UNREADABLE_STRIKES BECAUSE THE EVIDENCE IS
 * WEAKER. A 404 on the card's own path is an ANSWER about the card; an answerless
 * read is not an answer about anything. Weaker evidence must buy a longer rope, so
 * this is 12 (not 3) against a 48h span (not 6h).
 *
 * ⚠️ WHAT 12 COSTS, AS ARITHMETIC RATHER THAN AS A FEELING. Which of the two terms
 * binds depends on the population, and BOTH orders are fine because both are long:
 *   • drained queue (the measured shape): `advanceScan` wraps to 0 on a short scan,
 *     so a row is read EVERY tick — 12 strikes is 3h, and the 48h SPAN binds.
 *   • full backlog (~815 rows): a full rotation is ~19 ticks ≈ 4.75h, so 12 strikes
 *     is ~57h and the STRIKE COUNT binds.
 * Either way a row is looked at a dozen separate times across at least two days,
 * with Planka demonstrably answering other cards on every one of them.
 */
const DEGRADED_STRIKES = 12;

/**
 * Wall-clock span a run of answerless reads must cover before it retires a row,
 * measured from `callback_degraded_first_at`.
 *
 * ⛔ THE TERM AN OUTAGE CANNOT COMPRESS, and it exists here for the same reason
 * UNREADABLE_MIN_SPAN_MS exists one class over: `advanceScan` wraps the scan window
 * to 0 as soon as a scan comes back short, so once the residue drains the same rows
 * are re-read every DEFAULT_INTERVAL_MS and a threshold counted in TICKS is a
 * threshold in multiples of 15 minutes. Twelve strikes alone would be three hours —
 * well inside the Planka 504 windows this file's own headers measure.
 *
 * ⚠️ 48h IS CHOSEN AGAINST TWO MEASURED NUMBERS, NOT PICKED. A full rotation of the
 * scan over the ~815-row population is ~4.75h, so 48h outlasts TEN rotations and a
 * retirement can never be the product of one degraded window. And the incident this
 * worker repairs was a burst-induced Planka degradation lasting minutes-to-hours —
 * 48h is more than an order of magnitude past it. It is strictly longer than
 * UNREADABLE_MIN_SPAN_MS (6h) on purpose: see DEGRADED_STRIKES on why weaker
 * evidence buys a longer rope.
 *
 * ⚠️ AND IT IS NOT THE GUARD THAT MATTERS MOST, WHICH IS WORTH SAYING PLAINLY
 * BECAUSE THIS FILE HAS TWICE RECORDED A DOC CLAIMING PER-ROW TERMS WERE INDEPENDENT
 * DEFENCES WHEN THEY WERE NOT. This term and DEGRADED_STRIKES are BOTH PER-ROW, and
 * both are therefore blind to a Planka that answers nothing at all: under a
 * sufficiently long total outage they would merely agree to wait 48h and then retire
 * the whole population at once. The cross-row term — `applyDegradedStrikes`, which
 * charges NOTHING on a tick with no successful card read — is what actually stops
 * that, and it stops it absolutely: during an outage the counter does not increment
 * and the clock does not start.
 */
const DEGRADED_MIN_SPAN_MS = 172_800_000;

/**
 * How many times we may SEND for one row before giving up on it.
 *
 * ⛔ WITHOUT THIS THE WORKER RE-SENDS AN ACKED-BUT-UNMOVED ROW FOREVER — every
 * ACK_GRACE_MS (30 min), for the life of the row, because nothing else ever
 * makes it terminal. That is not merely noise: the n8n receiver does NOT dedupe
 * (`Move Card` is an unconditional `card.update{listId}`), so every one of those
 * sends moves the card if the queue ever does drain, and the measured population
 * is 373 rows that acked and never moved.
 *
 * Five attempts spans ≥2.5h of grace windows. Past that the fault is not
 * transport — n8n has accepted five times — so a sixth send carries the same
 * double-move risk as the first and no new information. The row goes terminal as
 * `send_exhausted`, which is deliberately NOT `moved`: it stamps no
 * `callback_delivered_at`, and `WHERE callback_resolution = 'send_exhausted'` is
 * the operator's queue of cards n8n keeps accepting and never moving.
 */
const MAX_SEND_ATTEMPTS = 5;

/**
 * The SIX terminal values. Constrained in SQL by approvals_callback_resolution_check.
 *
 * ⛔ ADDING ONE IS A MIGRATION, NOT A TYPE EDIT. The CHECK constraint is the
 * authority and it REJECTS an unknown value at runtime while `tsc` stays green:
 * `hold_acknowledged` needs `backend/migrations/119_approval_callback_hold_acknowledged.sql`
 * AND the parity declaration in `db/schema.ts` (see the block above
 * `approvals_callback_resolution_check` there — a `drizzle-kit push` DB gets the
 * constraint from schema.ts, a migrated DB gets it from 119, and a value missing
 * from either one fails in exactly one of the two environments).
 */
export type CallbackResolution =
  | 'moved'
  | 'not_blocked'
  | 'card_unreadable'
  | 'send_exhausted'
  /**
   * ⭐ THE RECEIVER TOLD US, IN ITS 200 BODY, THAT IT IS HOLDING THE CARD ON
   * PURPOSE — so there is nothing here to repair and no reason to send again.
   *
   * ⛔ IT IS NOT A FAILURE AND IT IS NOT A SUCCESS, WHICH IS WHY IT IS NEITHER OF
   * THE TWO VALUES IT WOULD OTHERWISE COLLAPSE INTO. `send_exhausted` claims five
   * acked sends and an unresponsive receiver — measured false: the receiver
   * answered every time and said what it was doing. `moved` claims the card left
   * BLOCKED — measured false: the hold is precisely that it did not. This row
   * stamps NO `callback_delivered_at`.
   *
   * ⛔ AND IT DOES NOT RELEASE THE HOLD. Read `notARejectedHold` below and
   * n8n's `blocked-sweep.json :: Classify + Plan:76` ("DO NOT 'FIX' approval_hold
   * BY MAKING A DECIDED HOLD MOVABLE"): the card SHOULD stay in BLOCKED until a
   * real answer arrives, and the defect being fixed is fr's RECORD of that, not
   * the card's position. `WHERE callback_resolution = 'hold_acknowledged'` is the
   * operator's queue of cards waiting on a human answer that no re-send can supply.
   */
  | 'hold_acknowledged'
  /**
   * ⭐ #1104 — fr COULD NEVER ESTABLISH WHICH LIST THIS CARD IS IN, for long enough,
   * while Planka was demonstrably serving OTHER cards.
   *
   * ⛔ IT CLAIMS NOTHING ABOUT THE CARD, AND THAT IS THE ENTIRE DIFFERENCE FROM
   * `card_unreadable`. That value means Planka answered 404 ON THE CARD'S OWN READ
   * PATH — an answer, about this card. This one means no answer was ever obtained:
   * a 5xx/timeout on the card read, a failure on the LIST read (reached only after
   * the card read returned 200, i.e. after Planka affirmatively said the card
   * EXISTS), or a 200 that carried no listId or no list name. Folding the two
   * together would destroy the `definitivePath` distinction this file spends a
   * screen defending at `classifyReadFailure`.
   *
   * ⛔ AND IT IS NOT A DELIVERY. Nothing was ever sent for such a row — the worker
   * fails CLOSED on a card whose list it cannot establish — so it stamps no
   * `callback_delivered_at`, and `send_exhausted` would be a lie about a row with
   * ZERO sends and ZERO acks (the same lie #1029 refunded an attempt to avoid).
   * `WHERE callback_resolution = 'read_degraded'` is the operator's queue of cards
   * fr can no longer see.
   */
  | 'read_degraded'
  /**
   * ⭐ MERGE-QUEUE fr row 12 (migration 159). APPROVED signoff rows only
   * (`execution-ready-signoff-callback`). The card's Planka phase journey shows it
   * LEFT BLOCKED at or after the approval's `created_at`, so the BLOCKED it is in
   * now is not the one this approval answered — typically a QA verdict re-blocked
   * it. The signoff receiver moves a card to DOING from ANY list on a late
   * approval, so a re-send would free a card the QA gate just blocked. Never sent;
   * stamps no `callback_delivered_at`.
   */
  | 'card_left_blocked_since_approval'
  /**
   * ⭐ MERGE-QUEUE fr row 12 (migration 159). APPROVED signoff rows only. The
   * card's owning tenant (board → project/stream — the chain GET /api/cards/:id
   * gates on) is not in fr's `PLATFORM_TENANT_IDS`. Strict tenant separation: the
   * system operator never acts on a customer card. Never sent.
   */
  | 'card_tenant_not_platform';


/**
 * Why the receiver said it was holding. A LOG AND PER-TICK LABEL, never a column —
 * exactly like `SendExhaustionCause`, and for the same reason: it changes which
 * sentence a reader is sent to, and nothing about whether a row retires.
 *
 * ⭐ AND NOW A PROMETHEUS FAMILY TOO, WHICH IS WHAT "EXACTLY LIKE
 * `SendExhaustionCause`" ALWAYS MEANT (#1115). The follow-up named below is
 * DISCHARGED: `fr_deblock_redelivery_hold_total{cause=…}` exists in
 * `lib/deblock-action-metrics.ts`, on the same pushgateway group as its sibling.
 *
 * ⛔ IT IS STILL NOT A COLUMN AND STILL NOT A JSONB KEY, AND THAT WAS TESTED RATHER
 * THAN ASSUMED. 48892aec on this branch persisted it as
 * `metadata->>'callback_hold_cause'`, reading THIS comment's "the worker names the
 * gap about itself" — and the sentence it leaned on is the one that refutes it:
 * `SendExhaustionCause` is log + Prometheus and is persisted NOWHERE, no column and
 * no jsonb key. The persistence was reverted in 1e7ea8f4. Whether a hold cause
 * should ALSO be stored on the row is an open question for a HUMAN; #1115 stays
 * open for it, and an issue filed by a peer agent is not authority to decide it.
 *
 * ⇒ THE VALUES AND THE TYPE NOW LIVE IN `domain/engagement/deblock-actions.ts`,
 * beside `SEND_EXHAUSTION_CAUSES`, and are re-exported here unchanged. Forced, not
 * cosmetic: `lib/deblock-action-metrics.ts` must pre-zero and render them, and it
 * may not import this file — it lives in `lib/` so `routes/metrics.ts` cannot
 * transitively pull `db/client`, which this worker does import.
 *
 * ⛔ `fr_deblock_redelivery_exhausted_total` was NOT reused — its own HELP text says
 * "Approvals retired as send_exhausted", and a hold is not one, so folding it in
 * would make a healthy hold arithmetically indistinguishable from the failure that
 * counter exists to report.
 */
export { HOLD_CAUSES, type HoldCause };

/**
 * ⭐ #1104. Which read kept failing, for a row retired as `read_degraded`. A LOG AND
 * PROMETHEUS LABEL, never a column — exactly like `SendExhaustionCause` and
 * `HoldCause` above, and derived AFTER the row has already satisfied the retirement
 * rule, so it decides nothing. Values and type live in
 * `domain/engagement/deblock-actions.ts` beside their two siblings for the forced
 * reason recorded there (`lib/deblock-action-metrics.ts` must render them and may
 * not import this file), and are re-exported here unchanged.
 */
export { READ_DEGRADED_CAUSES, type ReadDegradedCause };

/**
 * Why a card's list could not be read.
 *
 * ⛔ THE DISTINCTION IS THE WHOLE POINT. 'gone' is Planka telling us the card
 * does not exist (404). 'degraded' is Planka failing to tell us anything —
 * 5xx, 429, timeout, network, auth, or a 200 whose body has no listId / no list
 * name. Only 'gone' is evidence about the CARD; 'degraded' is evidence about
 * PLANKA, and writing a row off for it is how one blip retires a backlog.
 */
type ReadFailureKind = 'gone' | 'degraded';

/**
 * Exported so the exported `classifyReadFailure` has a nameable return type.
 * Nothing outside this file constructs one.
 */
export class CardReadFailure extends Error {
  readonly kind: ReadFailureKind;
  /**
   * ⭐ #1104. WHICH read produced this failure, for the `read_degraded` label.
   *
   * ⛔ IT IS SET AT THE CALL SITE, NOT INFERRED IN `classifyReadFailure`, and it has
   * to be: that function is handed an error and cannot know whether the throw came
   * out of `cards.get` or out of `lists.get` — the two land on the same lines and
   * only the caller knows which read it was making. Inferring it from `err.path`
   * would be a second construction of a string this file already refuses to
   * re-derive (see `cardReadPath`).
   *
   * ⚠️ MEANINGLESS ON A `'gone'` FAILURE and unused there — a definitive miss is
   * counted by `callback_unreadable_reads`, which has no cause label at all.
   * Defaults to `card_read` so a failure from an unrecognised source is attributed
   * to the read the worker actually initiated, never silently dropped.
   */
  readonly degradedCause: ReadDegradedCause;
  constructor(
    kind: ReadFailureKind,
    message: string,
    cause?: unknown,
    degradedCause: ReadDegradedCause = 'card_read',
  ) {
    super(message);
    this.name = 'CardReadFailure';
    this.kind = kind;
    this.degradedCause = degradedCause;
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/**
 * Re-label an already-classified read failure with the read that produced it.
 *
 * ⛔ IT RETURNS A NEW OBJECT RATHER THAN MUTATING, because `classifyReadFailure`
 * returns its INPUT unchanged when handed a `CardReadFailure` (the idempotence
 * `deliverAll`'s re-classify relies on), so mutating would let a downstream
 * re-classification rewrite a verdict made at the read site with better information.
 * ⚠️ `kind` is carried across untouched: this changes the LABEL, never the decision.
 */
function withDegradedCause(f: CardReadFailure, degradedCause: ReadDegradedCause): CardReadFailure {
  if (f.degradedCause === degradedCause) return f;
  return new CardReadFailure(f.kind, f.message, (f as { cause?: unknown }).cause, degradedCause);
}

/**
 * The ONE request path whose 404 is evidence about THIS card.
 *
 * ⛔ BUILT WITH PLANKA'S OWN `encodePath`, NOT WITH A HAND-WRITTEN TEMPLATE.
 * `services/planka/cards.ts::get` issues `/api/cards/${encodePath(id)}`, and
 * `PlankaHttp.request` hands that EXACT string to `mapPlankaError`, which stores
 * it on `PlankaError.path`. Re-deriving it with a bare `${cardId}` would drift
 * the moment a card id ever needed escaping, and drift here fails in the
 * dangerous direction — every genuine deletion would read as 'degraded' and no
 * dead row would ever retire. Importing the same helper makes the two strings
 * the same construction, not two constructions that happen to agree.
 */
function cardReadPath(cardId: string): string {
  return `/api/cards/${encodePath(cardId)}`;
}

/**
 * ⭐ #1104 — IS THIS STRING SHAPED LIKE A PLANKA ID AT ALL?
 *
 * Planka ids are decimal snowflake strings (`/api/cards/1234567890123456789`),
 * generated by its own id service; there is no other shape a real card id can
 * take. So a `card_id` with any non-digit in it was NEVER minted by Planka and
 * names no card that could ever exist — it is a literal that leaked out of a
 * fixture or a smoke run into `approvals.card_id`.
 *
 * ⛔ IT IS DELIBERATELY A SHAPE TEST AND NOT A LIVENESS TEST, and the distinction
 * is the whole reason it is safe to strike on. A NUMERIC id that Planka rejects
 * or cannot find is ambiguous — the card may be deleted, or the token may have
 * lost the board (see the 404 block below, where the fork launders forbidden into
 * not-found). A NON-NUMERIC id is not ambiguous in any environment, at any time,
 * under any token: it cannot address a card, so no amount of Planka recovering
 * will make the read succeed. That is exactly the property `'gone'` requires.
 *
 * ⚠️ EMPTY IS NOT AN ID. `/^[0-9]+$/` rejects `''`, which is the right answer —
 * an empty card id addresses nothing either.
 */
function isPlankaCardId(cardId: string): boolean {
  return /^[0-9]+$/.test(cardId);
}

/**
 * Classify anything thrown while reading a card or its list.
 *
 * ⭐ FAILS TOWARDS 'degraded'. An error we do not recognise is not evidence a
 * card was deleted, and the cost of guessing wrong in that direction is a row
 * retired without repair — silently, which is the defect class this whole file
 * exists to close. The cost of guessing 'degraded' wrongly is one more read next
 * tick.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * ⛔ `definitivePath` IS LOAD-BEARING. WITHOUT IT THIS FUNCTION STRIKES ON ANY
 *    404, NOT ON A 404 *ABOUT THE CARD*. Read this before removing it.
 * ═══════════════════════════════════════════════════════════════════════════
 * An adversarial audit found the previous version tested only `err.status ===
 * 404`, and `PlankaHttp` raises 404 from THREE distinct call sites that all land
 * on that line:
 *
 *   1. `GET /api/cards/:id` — the genuine "the card is gone" case. The ONLY one
 *      that is evidence about the card, and the only one that may strike.
 *   2. `GET /api/lists/:id` — reached ONLY AFTER the card read returned 200 WITH
 *      a listId, i.e. after Planka has just told us the card EXISTS. Striking a
 *      row here says "the card is deleted" on the strength of a read that
 *      demonstrated the opposite. It is not a judgement call; it is wrong.
 *   3. `POST /api/access-tokens` in `services/planka/auth.ts::loginAgent`. An
 *      AUTH failure — a wrong `PLANKA_BASE_URL`, an ingress route that stopped
 *      matching, a tenant path that moved. Three separate places in this repo
 *      (the UNREADABLE_STRIKES block below, migration 113's header, and the
 *      commit message that introduced them) state that an auth failure "does not
 *      strike at all". The code said otherwise, so the contract was documented
 *      and unenforced.
 *
 * The failure that made it blocking: point the base URL at a host that answers
 * 404, and EVERY candidate strikes on EVERY tick. The 404-only rule never
 * refuses, because every read really is a 404. Once UNREADABLE_MIN_SPAN_MS has
 * elapsed the entire population retires as `card_unreadable` — a terminal state
 * reversible only by hand-written SQL.
 *
 * ⚠️ THE SHAPE OF `path` WAS MEASURED, NOT ASSUMED, and the two shapes differ:
 *   * `PlankaHttp.request` passes the BARE path (`/api/cards/abc`,
 *     `/api/lists/xyz`) — `http.ts:89`, `mapPlankaError(response, path)`.
 *   * `loginAgent` passes the FULL ABSOLUTE URL (`${baseUrl}/api/access-tokens`)
 *     — `auth.ts:120,133`, `mapPlankaError(response, url)`.
 * So an auth 404 cannot equal a bare card path under ANY base URL, and an exact
 * `===` comparison excludes all three non-card sources at once. It is deliberately
 * `===` and not `endsWith`/`includes`: a suffix test would re-admit an absolute
 * URL that happens to end in the card path, which is exactly the misrouting case.
 *
 * A caller that passes NO `definitivePath` can therefore never produce a strike.
 * That is the correct default — every read except the card read is, at most,
 * evidence about Planka.
 */
function classifyReadFailure(
  err: unknown,
  what: string,
  definitivePath?: string,
  definitiveCardId?: string,
): CardReadFailure {
  if (err instanceof CardReadFailure) return err;
  // ═════════════════════════════════════════════════════════════════════════
  // ⭐ #1104. A 400 ON THE CARD'S OWN READ PATH FOR AN ID THAT IS NOT A PLANKA
  //    ID IS DEFINITIVE, AND WITHOUT THIS BRANCH SUCH A ROW NEVER RETIRES.
  // ═════════════════════════════════════════════════════════════════════════
  // MEASURED: approval `cf5c5a2f-26c9-4ae8-9e95-ba891780b653` is `voided` with
  // `card_id = 'smoke-n8n-r2-2'` — a smoke-run literal, never a Planka id.
  // Planka answers that read 400, `mapPlankaError` (services/planka/errors.ts:124)
  // turns a 400 into `PlankaValidationError`, and every branch below classified it
  // `'degraded'`. `recordUnreadable` is called ONLY for `'gone'`, so the row took
  // ZERO strikes, `UNREADABLE_STRIKES` could never be reached, and it came back on
  // every scan cycle forever with `callback_unreadable_reads` stuck at 0.
  //
  // ⛔ IT IS NARROWED BY THE SAME TWO TESTS THE 404 BRANCH USES, PLUS ONE MORE, AND
  // ALL THREE ARE REQUIRED. `definitivePath === err.path` excludes a 400 raised by
  // the list read or by `loginAgent` (the three-sources note below); `err.status
  // === 400` excludes the 422 that `mapPlankaError` maps to the SAME class; and
  // `!isPlankaCardId` is what makes the verdict definitive rather than a guess —
  // see that helper. A 400 for ANY OTHER reason, including a 400 on a numeric id,
  // falls through to the `'degraded'` default at the bottom of this function,
  // which is the direction this file always fails in.
  if (
    err instanceof PlankaValidationError &&
    err.status === 400 &&
    definitivePath !== undefined &&
    err.path === definitivePath &&
    definitiveCardId !== undefined &&
    !isPlankaCardId(definitiveCardId)
  ) {
    return new CardReadFailure(
      'gone',
      `${what}: Planka answered 400 for the card's own read path and ` +
        `'${definitiveCardId}' is not a Planka id (Planka ids are decimal), so no ` +
        `card of that id can exist under any token or at any later time`,
      err,
    );
  }
  if (err instanceof PlankaError && err.status === 404) {
    // ═══════════════════════════════════════════════════════════════════════
    // ⛔ CORRECTED 2026-09-07. THIS COMMENT USED TO READ, VERBATIM: "404 is the
    //    only status that CAN mean 'this card is not there' — note 403 is not:
    //    an agent token that lost board access answers 403 for cards that
    //    exist." ⛔ THAT SENTENCE IS FALSE FOR THE PLANKA WE ACTUALLY RUN, and
    //    TWO successive strike rules were built on top of it.
    // ═══════════════════════════════════════════════════════════════════════
    // EVIDENCE — not reasoning about upstream Planka, but the image this estate
    // deploys (`registry.example.com:5000/planka-private:latest`), read out of the
    // live container: `/app/api/controllers/cards/show.js` says
    //
    //     if (!boardMembership) {
    //       throw Errors.CARD_NOT_FOUND;          // its own comment says "Forbidden"
    //     }
    //     exits: { cardNotFound: { responseType: 'notFound' } }   // -> HTTP 404
    //
    // So a card that EXISTS, on a board this token can no longer see, answers
    // **404 on the card's own read path** — byte-identical to a genuinely
    // deleted card. The fork launders the forbidden case into a not-found on
    // purpose, so an outsider cannot probe which card ids exist. There is no 403
    // to look for and no body, header or status that separates the two.
    //
    // ⛔ CONSEQUENCE, AND THE WHOLE REASON THIS BLOCK IS SO LOUD: NOTHING IN
    // THIS FUNCTION CAN TELL THEM APART, so it must not pretend to. 'gone' here
    // means exactly "Planka answered 404 for THIS CARD'S OWN PATH" and NOT "the
    // card was deleted".
    //
    // ⛔ AND NOTHING ELSE IN fr CAN TELL THEM APART EITHER. Four probes were built
    // to try — a board read, a board enumeration, an admin bypass — and all of
    // them reduce to the same access predicate. The proof, with the Planka source
    // it was read out of, is at `applyStrikes` under "FOUR DISCRIMINATORS WERE
    // TRIED". ⚠️ Do not add a fifth here or anywhere else.
    //
    // The `definitivePath` test below is still necessary and still narrower than
    // it looks: it only excludes 404s raised by OTHER requests (see the three
    // sources above). It says nothing about deletion.
    if (definitivePath !== undefined && err.path === definitivePath) {
      return new CardReadFailure('gone', `${what} not found (404)`, err);
    }
    return new CardReadFailure(
      'degraded',
      `${what}: Planka answered 404 for ${err.path ?? '(no path recorded)'}, which is not ` +
        `the card read ${definitivePath ?? '(this read may never strike)'} — that is ` +
        `evidence about Planka or about another object, not about the card`,
      err,
    );
  }
  return new CardReadFailure('degraded', `${what} unreadable: ${errMessage(err)}`, err);
}

/**
 * ⭐ #1104. `classifyReadFailure` is the whole of the strike decision and it is a
 * pure function of (error, path, card id), so it is exported and tested directly.
 */
export { classifyReadFailure, isPlankaCardId };

/** Per-tick wall clock. See the lock-scope note in runDeblockRedeliveryTick. */
function tickDeadlineMs(): number {
  const raw = Number(process.env.DEBLOCK_REDELIVERY_TICK_DEADLINE_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Where the next tick starts its scan. `null` = this process has not seeded yet.
 *
 * ⭐ THIS IS WHAT STOPS A PERMANENTLY-UNREADABLE HEAD STARVING THE TAIL. A row
 * whose card is deleted can never be stamped, so a fixed `ORDER BY … LIMIT n`
 * re-reads the same n rows forever. Advancing the offset each tick walks the
 * whole population — 726 rows at 40 per tick is full coverage in ~19 ticks
 * (~4.75h) — and wraps when a scan comes back short, i.e. at the end.
 *
 * ⛔ Deliberately NOT an in-memory "known unreadable" skip-set, which is the
 * other obvious fix. A card reads as unreadable both when it is deleted and when
 * Planka is briefly unreachable, and those are indistinguishable here. A skip-set
 * would let one Planka blip exclude a perfectly live card for the rest of the
 * pod's life, silently. Rotation costs one integer and cannot do that.
 *
 * ⛔ IT NO LONGER RESETS TO 0 ON PROCESS START, AND THE OLD REASONING FOR THAT
 * HAS EXPIRED — MEASURED, NOT ARGUED.
 * ==========================================================================
 * This block used to say: "Resets on process start, which is fine: the scan is
 * cheap and the order is stable, so a restart re-walks rather than skips." That
 * is only true if a restart is rare relative to ONE FULL WALK. Measured on prod
 * 2026-09-06 it is the other way round:
 *
 *   eligible candidates (approved 333 + voided 261)   594  = 15 pages at 40
 *   ticks to REACH the voided rows (they sort LAST)     9  = 2h15m of uptime
 *   fr ReplicaSets created that morning                 3  in 41 minutes
 *   longest observed pod uptime                        28  minutes
 *   fr Deployment metadata.generation                 781
 *
 * A walk that needs 2h15m of uninterrupted uptime never completes on a pod that
 * lives 28 minutes, and every rollout sent it back to page 0. Confirmed in the
 * database: `approved` rows at the HEAD kept draining (delivered 377 -> 379)
 * while 0 of 274 `voided` rows had EVER been delivered. The tail was not slow,
 * it was STRUCTURALLY UNREACHABLE. Frequent deploys are normal here — that
 * generation counter is 781 — so the deploy rate is not the thing to change.
 *
 * THE FIX: SEED THE OFFSET FROM THE WALL CLOCK, NOT FROM 0. See
 * `seedScanOffset`. The clock advances whether or not this process does, so a
 * pod that restarts resumes roughly where the fleet clock says the walk should
 * be, and the walk covers the whole population across restarts instead of
 * re-grinding the head.
 *
 * WHY NOT THE ALTERNATIVES:
 *   • PERSISTING THE OFFSET IN THE DB would work, but it needs a migration and a
 *     new state row for a value that does not need durability — losing it costs
 *     at most one mis-placed page, not correctness.
 *   • A RANDOM START is restart-immune too, but it gives no coverage guarantee
 *     (nothing stops it drawing the same page every boot) and it makes the walk
 *     untestable — there is no arithmetic to pin.
 *   • DOING NOTHING is what shipped, and the table above is what it produced.
 */
let scanOffset: number | null = null;

/**
 * The unit the seed counts in: one page per worker interval.
 *
 * ⚠️ DELIBERATELY THE SAME NUMBER AS `DEFAULT_INTERVAL_MS`, and derived from it
 * rather than re-typed, so the two cannot drift. The seed's whole meaning is
 * "where would a single immortal pod, walking one page per tick since the epoch,
 * be right now" — which is only true while the seed unit IS the tick cadence.
 */
const SEED_TICK_MS = DEFAULT_INTERVAL_MS;

/**
 * Which offset the fleet clock says this walk should start on.
 *
 * ⛔ THE MODULO IS NOT OPTIONAL, AND A BARE `floor(now / TICK) * 40` IS A NO-OP
 * FIX. Measured: `floor(Date.now() / 900_000) * 40` is **79,496,920**, against a
 * population of **594**. Every single process start would scan an empty window,
 * `advanceScan` would see a short scan and wrap to 0, and the pod would walk from
 * page 0 exactly as before — the identical starvation, one wasted tick later. The
 * seed has to land INSIDE the population to mean anything, so it is reduced
 * modulo the page count.
 *
 * PAGE-ALIGNED, not `% candidateCount`: aligning to `MAX_READS_PER_RUN` means the
 * set of reachable start positions is exactly the set of pages the sequential
 * walk uses, so start positions and walk positions are the same grid and every
 * row is reachable from some start. A non-aligned start would straddle pages and
 * make coverage an argument rather than an identity.
 *
 * A population that fits in one page yields 0 — correct, and not a special case:
 * `pages` is 1, so `% 1` is 0. There is no tail to starve.
 *
 * Pure and exported so the arithmetic is pinned by a test: a future edit to
 * `MAX_READS_PER_RUN` or `SEED_TICK_MS` cannot silently change coverage.
 *
 * ⚠️ HONEST LIMIT, STATED RATHER THAN HIDDEN: the granularity is one interval, so
 * two pods started inside the SAME 15-minute window seed identically. That is the
 * intended behaviour (they should agree with the fleet clock), and the advisory
 * lock — not the offset — is what stops two replicas double-delivering.
 */
export function seedScanOffset(nowMs: number, candidateCount: number): number {
  if (!Number.isFinite(nowMs) || nowMs <= 0) return 0;
  if (!Number.isFinite(candidateCount) || candidateCount <= 0) return 0;
  const pages = Math.ceil(candidateCount / MAX_READS_PER_RUN);
  const page = Math.floor(nowMs / SEED_TICK_MS) % pages;
  return page * MAX_READS_PER_RUN;
}

export type DeblockOutcome = 'ok' | 'skipped' | 'failed';

export interface DeblockTickResult {
  outcome: DeblockOutcome;
  acquiredLock: boolean;
  /** Rows matching the SQL predicate before the live card-state gate. */
  candidates: number;
  /** Candidates whose card really is still in BLOCKED. */
  eligible: number;
  /**
   * Callbacks that returned 2xx.
   * ⚠️ THIS IS AN ACK COUNT, NOT A REPAIR COUNT — see the migration-113 block in
   * the header. `resolvedMoved` is the number of cards that actually left BLOCKED.
   */
  delivered: number;
  /** Gate said the card is no longer BLOCKED — the ONLY reason we skip a send. */
  notBlocked: number;
  /** Card gone (deleted / 404) or Planka unreachable for that row. */
  cardUnreadable: number;
  /** Callback attempted and did not succeed. Row stays NULL and is retried. */
  failed: number;
  /** Rows retired as `moved` — we sent, and the card was observed out of BLOCKED. */
  resolvedMoved: number;
  /** Rows retired as `not_blocked` — already off the board, we never sent. */
  resolvedNotBlocked: number;
  /** Rows retired as `card_unreadable` — UNREADABLE_STRIKES definitive misses spanning UNREADABLE_MIN_SPAN_MS. */
  resolvedUnreadable: number;
  /** Rows retired as `send_exhausted` — MAX_SEND_ATTEMPTS acked sends, card never moved. */
  resolvedSendExhausted: number;
  /**
   * ⭐ #1104. Rows retired as `read_degraded` — DEGRADED_STRIKES consecutive
   * answerless reads spanning DEGRADED_MIN_SPAN_MS, every strike charged on a tick
   * that read OTHER cards successfully.
   *
   * ⛔ NOT A REPAIR COUNT AND NOT A COMPLETION COUNT. Nothing was sent for these
   * rows and no card is claimed to have moved; they stamp no `callback_delivered_at`.
   * A sustained non-zero is a PLANKA signal — cards, or their lists, that fr can no
   * longer read while it reads their siblings fine.
   */
  resolvedReadDegraded: number;
  /**
   * `resolvedReadDegraded` split by which read kept failing, every cause present at
   * zero on every tick — same construction and same reason as `sendExhaustedByCause`
   * and `holdAcknowledgedByCause`: a bucket that appears only when non-zero cannot
   * tell "none of these" from "not measured". Sums to `resolvedReadDegraded` by
   * construction.
   */
  readDegradedByCause: Record<ReadDegradedCause, number>;
  /**
   * ⭐ #1104. Answerless reads this tick that were NOT charged a strike, because the
   * tick obtained no successful card read at all and therefore has no standing to
   * call any of them a property of a row.
   *
   * ⛔ THIS IS THE CROSS-ROW GUARD MADE VISIBLE, and it is the exact sibling of
   * `strikesWithheld` one failure class over. A guard whose operation is invisible
   * is indistinguishable from one that is not wired up — which is the shape this
   * file keeps correcting. Non-zero here means a tick saw only answerless reads:
   * consistent with a Planka outage, a misroute, or simply a tick whose only
   * candidate was the unreadable row.
   */
  degradedStrikesWithheld: number;
  /**
   * ⭐ `resolvedSendExhausted` SPLIT BY CAUSE, so the two populations are COUNTABLE and
   * not merely worded differently. Every cause is present on every tick, at zero when it
   * did not occur, so a reader can tell "none of these" from "this tick did not measure
   * it". Sums to `resolvedSendExhausted` by construction — the same call site increments
   * both, one line apart.
   *
   * The operator question this exists to answer without a psql session — "how many
   * exhausted because there was nothing to move them to?" — is
   * `sendExhaustedByCause.no_actionable_exit` per tick, and cumulatively
   * `fr_deblock_redelivery_exhausted_total{cause="no_actionable_exit"}` in Prometheus.
   */
  sendExhaustedByCause: Record<SendExhaustionCause, number>;
  /**
   * ⭐ Rows retired as `hold_acknowledged` — the receiver answered 200 and said in
   * the body that it is holding the card ON PURPOSE, so we stopped sending. See
   * `classifyReceiverHold`.
   *
   * ⛔ NOT A FAILURE COUNT AND NOT A REPAIR COUNT. It is the number of rows this
   * tick stopped LYING about: each one would otherwise have consumed four more
   * sends and retired as `send_exhausted / receiver_unresponsive`. A steady
   * non-zero here is a queue of cards waiting on a human answer — the release path
   * is a real answer elsewhere, never a re-send from this worker.
   */
  resolvedHoldAcknowledged: number;
  /**
   * `resolvedHoldAcknowledged` split by cause, every cause present at zero on every
   * tick — same construction and same reason as `sendExhaustedByCause`: a bucket
   * that appears only when non-zero cannot tell "none of these" from "not
   * measured". Sums to `resolvedHoldAcknowledged` by construction.
   */
  holdAcknowledgedByCause: Record<HoldCause, number>;
  /**
   * ⭐ The per-tick circuit breaker tripped: this tick got a verdict on at least
   * BREAKER_MIN_READS cards and NOT ONE card read succeeded, so it has no
   * standing to call any of its 404s a deletion and no row was struck. Sends and
   * resolutions are unaffected.
   *
   * ⚠️ RENAMED 2026-09-07 from `degradedTick`, together with the condition it
   * reports. It used to mean "≥60% of this tick's verdicts were 404", which fired
   * on a healthy Planka reaping old cards — see BREAKER_MIN_READS.
   */
  breakerTripped: boolean;
  /** Definitive 404s this tick that the breaker withheld. 0 on a normal tick. */
  strikesWithheld: number;
  /**
   * ⭐ #1034. Rows that passed EVERY OTHER candidate clause and were withheld
   * ONLY because their card carries a live `pending` gate. Same idiom as
   * `strikesWithheld` directly above, and for the same reason: a set this worker
   * deliberately declines to act on is still a set an operator has to be able to
   * see.
   *
   * ⛔ IT IS NOT A BACKLOG THE WORKER IS FAILING TO DRAIN, AND MUST NOT BE READ
   * AS ONE. These rows are correctly suppressed — see `notShadowedByOpenGate`.
   * What was wrong was that `candidates=1` beside a silent 452 read as a DRAINED
   * queue. Measured on prod 2026-09-08: 452 shadowed across 396 distinct cards,
   * 239 of whose shadowing gates expire on a single day (2026-09-10), so the set
   * un-shadows as a burst against a per-run send budget of MAX_PER_RUN=10.
   *
   * ⚠️ MEASURED WHENEVER A TICK SCANS, WHICH IS NOT EVERY TICK. A tick that lost
   * the advisory lock returns `outcome: 'skipped'` before the census and reports
   * 0 — but that tick prints no log line either, so a printed `shadowed=N` is
   * always a real measurement. Do not read a 0 from a skipped tick as "none".
   */
  shadowed: number;
  /**
   * ⭐ THE FAST LANE. Rows this tick read because they were decided within
   * FRESH_WINDOW_MS, i.e. AHEAD of the rotating backlog walk rather than behind
   * ~815 older candidates.
   *
   * Reported for the same reason `scanOffset` is: it is the only way to tell a
   * working fast lane from one whose window or predicate has quietly stopped
   * matching anything. `fast_lane=0` on a tick where a decision was just made is
   * the signal that the lane is inert.
   */
  fastLane: number;
  /**
   * ⭐ Fresh rows this tick READ but did not attempt, because the fast lane hit
   * FAST_LANE_DEADLINE_SHARE of the tick budget and handed the rest to the
   * backlog walk.
   *
   * ⛔ REPORTED BECAUSE `fastLane` ALONE IS NOW AMBIGUOUS, and that ambiguity is
   * the shape this file keeps correcting elsewhere: `fast_lane=5` says five rows
   * were SELECTED, not that five were tried. Without this number a tick where
   * Planka is slow enough to eat the lane is indistinguishable from a healthy one
   * — the operator sees `fast_lane=5 acked=2` and has no way to tell a deferred
   * lane from three unreadable cards.
   *
   * ⚠️ NON-ZERO IS NOT A FAULT IN THIS WORKER. It is the time reserve doing
   * exactly its job, and it is the earliest visible signal that Planka reads have
   * degraded — sustained non-zero here is a PLANKA latency alarm, not a
   * redelivery one.
   */
  fastLaneDeferred: number;
  /**
   * ⭐ Rows withheld because they are a REJECTED BLOCKED-exit proposition, whose
   * receiver deliberately holds the card in BLOCKED — see `notARejectedHold`.
   *
   * ⛔ NOT A BACKLOG THIS WORKER IS FAILING TO DRAIN, and it must not be read as
   * one. Same idiom, and the same justification, as `shadowed` above: a set the
   * worker deliberately declines to act on is still a set an operator has to be
   * able to see, because "0 rejected rows in the scan" and "16 rejected rows
   * that can never be repaired here" are indistinguishable otherwise — which is
   * exactly how those 16 read as unrepaired work for as long as `rejected` was
   * excluded by construction.
   */
  rejectedHeld: number;
  /**
   * ⭐ Rows withheld because they are `voided` and their receiver structurally
   * cannot route `voided` — see `notAnUnroutableVoid`.
   *
   * ⛔ NOT A BACKLOG THIS WORKER IS FAILING TO DRAIN. Same idiom, and the same
   * justification, as `shadowed` and `rejectedHeld` above. ⚠️ BUT UNLIKE THOSE TWO
   * IT IS ALSO A STANDING WORK ITEM, and the difference matters to whoever reads
   * it: a shadowed row drains when its gate is answered and a rejected hold is
   * finished business, whereas these rows are waiting on a CHANGE TO n8n (teach
   * `exec::ready-signoff-callback` a `voided` route, then add the path to
   * `VOIDED_CALLBACK_PATHS`). Non-zero here forever means that change has not
   * happened — it does not mean this worker is broken. The count IS the queue for
   * that work, which is the second reason it is printed rather than merely applied.
   */
  voidedUnroutable: number;
  /**
   * ⭐ #1144. Rows withheld because a strictly NEWER approval on the same
   * `card_id` has already reached a terminal status — see `notSuperseded`.
   *
   * ⛔ NOT A BACKLOG THIS WORKER IS FAILING TO DRAIN. Same idiom, and the same
   * justification, as `shadowed`, `rejectedHeld` and `voidedUnroutable` above.
   *
   * ⚠️ AND IT IS THE ONLY RECORD THESE ROWS GET, WHICH IS WHY IT IS NOT OPTIONAL.
   * #1144 is a FILTER and deliberately writes no `callback_resolution` (the two
   * refusals at `notARejectedHold` / `notAnUnroutableVoid` say why), so nothing on
   * the row itself says it was withheld. If this number is not printed, the
   * suppression is total and silent — the exact shape #1034 was filed for.
   *
   * ⛔ IT IS A MONOTONE FLOOR, NOT A RATE, AND AN ALERT ON THE LEVEL WOULD BE WRONG.
   * Approval status is forward-only into the terminal set and `'expired'` is
   * absorbing, so a row counted here is counted here forever — see `notSuperseded`.
   * The ~153 rows expiring 2026-09-22 become a standing baseline; read the DELTA.
   */
  superseded: number;
  /**
   * Card reads this tick that SUCCEEDED — Planka named the list. This is the
   * breaker's whole discriminator, so it is reported rather than left to be
   * re-derived: a tick with 22 gone and 13 of these is retention, and a tick with
   * 22 gone and 0 of these is a broken client.
   */
  successfulReads: number;
  /**
   * ⭐ MERGE-QUEUE fr row 12. Approved signoff rows retired as
   * `card_left_blocked_since_approval` — the card left BLOCKED after the approval
   * was created, so we did NOT re-send.
   */
  resolvedLeftBlocked: number;
  /** ⭐ Approved signoff rows retired as `card_tenant_not_platform` — never sent. */
  resolvedTenantNotPlatform: number;
  /**
   * ⭐ Approved signoff rows neither sent NOR retired this tick, because fr could
   * not establish the card's journey since the approval (actions unreadable, or the
   * readable window does not reach back to `created_at`) or its tenant (no boardId,
   * a failed lookup). Left as candidates for the next tick; each one is logged.
   */
  signoffDeferred: number;
  /** True when MAX_PER_RUN or the deadline cut the tick short. */
  more: boolean;
  /**
   * The OFFSET this tick actually scanned at, or null when no scan happened (the
   * advisory lock was held elsewhere, or the tick failed before selecting).
   *
   * ⚠️ Reported, not decorative: with the cursor now seeded from the wall clock,
   * "which page is this pod walking" is the thing an operator needs to see to
   * tell a healthy walk from one pinned at the head — the failure that made 0 of
   * 274 `voided` rows reachable. It is also what lets a test assert the seed
   * without having to observe module-private state through `advanceScan`.
   */
  scanOffset: number | null;
  error?: string;
}

interface CandidateRow extends Record<string, unknown> {
  id: string;
  card_id: string | null;
  // ⚠️ NO BOARD COLUMNS HERE, AND THAT IS A DELETION, NOT AN OMISSION. This
  // interface briefly carried `metadata_board_id` + `project_board_id` to feed a
  // board-existence/readability gate. Both are gone: see the block at
  // `applyStrikes` titled "FOUR DISCRIMINATORS WERE TRIED" for the proof that
  // every such probe reduces to the same predicate.
  /** Non-null = we already sent and n8n accepted it; the card just has not moved. */
  callback_acked_at: Date | string | null;
  /** Consecutive DEFINITIVE misses so far. */
  callback_unreadable_reads: number;
  /** When the current run of them started; NULL when there is no run. */
  callback_unreadable_first_at: Date | string | null;
  /**
   * ⭐ #1104. Consecutive ANSWERLESS reads so far — a different counter from the one
   * above, for a different failure class, and deliberately so: an answerless read is
   * evidence about Planka and may never touch `callback_unreadable_reads`.
   */
  callback_degraded_reads: number;
  /** When the current run of answerless reads started; NULL when there is no run. */
  callback_degraded_first_at: Date | string | null;
  /** Sends made for this row, ever. Bounded by MAX_SEND_ATTEMPTS. */
  callback_send_attempts: number;
  // ─────────────────────────────────────────────────────────────────────────
  // ⭐ THE EXHAUSTION DISCRIMINATOR. Five fields, and they are NOT the board
  // columns the note above deletes. That deletion was of `metadata->>'boardId'`
  // + a `projects` JOIN, added to feed a GATE that decided whether to strike a
  // row; "FOUR DISCRIMINATORS WERE TRIED" refutes that whole class because every
  // such probe asks PLANKA a question scoped by fr's own access.
  //
  // These five ask fr a question about fr. They are the inputs
  // `classifyDeblockExit` already takes at the mint and decide seams, read from
  // the row's OWN `metadata` jsonb and its OWN `kind` column — no join, no
  // outbound request, and ⛔ THEY DECIDE NOTHING. They are read at exactly one
  // place, `describeSendExhaustion`, and their only effect is which sentence is
  // logged and which counter is incremented once a row has ALREADY exhausted on
  // the untouched `callback_send_attempts >= MAX_SEND_ATTEMPTS` rule.
  // ─────────────────────────────────────────────────────────────────────────
  /** Raw `metadata->>'deblock_action'`. Free-form jsonb — narrowed by the classifier, never here. */
  deblock_action: unknown;
  /**
   * Raw `metadata->>'doingListId'`.
   *
   * ⚠️ THE TWO STATES ARE DIFFERENT AND THIS COMMENT USED TO COLLAPSE THEM — which is the
   * very defect this file is about. Re-measured on prod `fr` (worker4) 2026-09-07T14:51:01Z,
   * keyed by `callback_path='kanban/approval-callback'` (⛔ there is no `kind='kanban'`; the
   * `approval_kind` enum has no such label at all): **2032** rows, of which **2031** carry
   * `doingListId`/`todoListId` as EMPTY STRINGS and **1** does not carry the keys AT ALL.
   * `->>` yields `''` for the first and SQL NULL for the second, so both reach
   * `classifyDeblockExit` as "no list target" — but only the first proves the mint wrote a
   * field and left it blank.
   */
  doing_list_id: unknown;
  /** Raw `metadata->>'todoListId'`. Same shape. */
  todo_list_id: unknown;
  /** Raw `metadata->>'advance_phase_on_approve'` — the `phase_advance` lane carve-out. */
  advance_phase_on_approve: unknown;
  /** The `kind` column: carries the `improvement*` and `execution.ready_signoff` carve-outs. */
  approval_kind: string | null;
  /** ⭐ MERGE-QUEUE fr row 12. `status::text` — the signoff refusals apply to `approved` only. */
  approval_status: string | null;
  /** ⭐ The receiver path — the signoff refusals apply to `execution-ready-signoff-callback` only. */
  callback_path: string | null;
  /** ⭐ `approvals.created_at` — the instant the journey check measures "since". */
  approval_created_at: Date | string | null;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** The classifier inputs a candidate row carries. Narrow on purpose: this is all it reads. */
export type SendExhaustionSubject = Pick<
  CandidateRow,
  | 'callback_acked_at'
  | 'deblock_action'
  | 'doing_list_id'
  | 'todo_list_id'
  | 'advance_phase_on_approve'
  | 'approval_kind'
>;

/**
 * Why THIS row exhausted, and the sentence to log about it.
 *
 * ⛔ THE BUG THIS REPLACES. The exhaustion branch used to log ONE unconditional sentence —
 * "n8n is accepting and not moving; this row needs a human, not another send." — for every
 * retired row. Measured on prod `fr` (worker4) 2026-09-07T14:01Z, that sentence was WRONG
 * on 93 of 108 `send_exhausted` rows (86%): those rows carry no usable `deblock_action`
 * and an EMPTY `doingListId`/`todoListId`, so the callback fr sent them out with contained
 * nothing n8n could move a card with. The evidence was one JSON key away on a row the
 * worker was already holding, and it did not read it.
 *
 * ⭐ THE HARM WAS MISDIRECTED DEBUGGING, NOT DATA LOSS. Nothing about retry, striking or
 * the exhaustion rule changes here — the row still retires on
 * `callback_send_attempts >= MAX_SEND_ATTEMPTS` and still writes `send_exhausted`. Only
 * the sentence and the counter change, and they now name a cause the row can support.
 *
 * ⚠️ IT DELEGATES; IT DOES NOT RE-DERIVE. `classifyDeblockExit` is the single source of
 * truth for "does this row owe a card move, and did it bring one", and its precedence is
 * load-bearing (a usable action outranks the list test — testing lists first exempted
 * 1,730 live rows and left the mint guard inert). Re-implementing that ordering here would
 * make this the THIRD spelling of a predicate whose whole file exists because it was once
 * spelled five times.
 */
export function describeSendExhaustion(row: SendExhaustionSubject): {
  cause: SendExhaustionCause;
  blame: string;
} {
  // ─────────────────────────────────────────────────────────────────────────────────
  // DISCRIMINATOR 1 — DID ANY RECEIVER ACK? (#1023). It runs FIRST and it dominates.
  //
  // ⚠️ The cause is CONDITIONAL on what this row can actually establish. This message used
  // to assert "n8n is accepting and not moving" unconditionally. That is only true when a
  // receiver ACKED — and since `VOIDED_CALLBACK_PATHS` (services/n8n-callback.ts) fr now
  // WITHHOLDS a `voided` decision from receivers not measured to route it, a row can reach
  // the ceiling having never contacted n8n at all. Blaming a system that never saw the
  // request sends the operator to the wrong place, which is the failure this whole area
  // keeps producing.
  //
  // `callback_acked_at` is the discriminator and is already selected: non-null means a
  // receiver accepted it (see its own docblock above).
  //
  // ⛔ IT MUST PRECEDE DISCRIMINATOR 2, not merge with it. "What did the payload contain"
  // is a question about a request something ACCEPTED; asking it of a request nothing ever
  // received would report a payload defect for a row that was never delivered.
  // ─────────────────────────────────────────────────────────────────────────────────
  // ⚠️ AN UNSTATED BEHAVIOUR CHANGE, NOW STATED. `origin/main` tested `acked !== null`;
  // this tests `=== null || === undefined`. That is a WIDENING — `undefined` now takes the
  // never-acked arm where before it took the acked arm. It is safe on real rows because a
  // SQL NULL arrives from `execute()` as JS `null`, never `undefined`; `undefined` can only
  // arise if `callback_acked_at` were dropped from the candidate SELECT, and failing SAFE
  // (blame nobody) rather than asserting an ack nothing proved is the correct direction for
  // exactly that mutant. It changes no production row today: re-measured 2026-09-07T14:51:18Z,
  // 108 of 108 `send_exhausted` rows on prod are ACKED, so `never_acked` has ZERO prod rows
  // and this check cannot disturb the 15/93 payload split below it.
  if (row.callback_acked_at === null || row.callback_acked_at === undefined) {
    return {
      cause: 'never_acked',
      blame:
        'NO receiver ever acked this row — the send may have failed, or fr may have ' +
        'withheld it because the decision value is not routable by this callback_path ' +
        '(see VOIDED_CALLBACK_PATHS). Check fr before n8n.',
    };
  }

  // ─────────────────────────────────────────────────────────────────────────────────
  // DISCRIMINATOR 2 — A RECEIVER DID ACK, SO: WAS THERE ANYTHING TO ACT ON?
  // ─────────────────────────────────────────────────────────────────────────────────
  const exit = classifyDeblockExit({
    action: row.deblock_action,
    doingListId: row.doing_list_id,
    todoListId: row.todo_list_id,
    advancePhase: row.advance_phase_on_approve,
    // Mirrors the decide seam in routes/approvals.ts exactly.
    improvementKind:
      typeof row.approval_kind === 'string' && row.approval_kind.startsWith('improvement')
        ? row.approval_kind
        : undefined,
    approvalKind: row.approval_kind ?? undefined,
  });
  // Branched on `exit`, NOT on `cause`, because `exit` is the discriminated union: it is
  // what lets each arm reach the field that makes its sentence specific (`action`,
  // `rawWasPresent`, `exemption`) and makes a missing arm a `tsc` error rather than a
  // silently generic message. `cause` rides along as the label.
  const cause = causeOfSendExhaustion(exit);

  if (exit.required && exit.usable) {
    // The ONLY arm that earns the original message. fr sent a real instruction.
    return {
      cause,
      blame:
        `fr sent a usable deblock_action=${exit.action} and n8n acked every send, and the ` +
        `card is still BLOCKED. The receiver accepted and did not move it — this row needs ` +
        `a human, not another send.`,
    };
  }

  if (exit.required) {
    return {
      cause,
      blame:
        `⛔ THIS IS NOT AN n8n FAULT. The row names a list target but its deblock_action is ` +
        `${
          exit.rawWasPresent
            ? 'present and NOT in the closed allowlist, so buildCallbackPayload dropped it'
            : 'absent'
        }, so the callback went out with no action. Fix the producer that minted it, not ` +
        `the receiver.`,
    };
  }

  if (exit.exemption === 'no_list_target') {
    return {
      cause,
      blame:
        `⛔ THIS IS NOT AN n8n FAULT. The row carries no usable deblock_action AND no ` +
        `doingListId/todoListId, so every callback fr sent for it contained no actionable ` +
        `exit — n8n was never given anything to move the card with, and acking that is ` +
        `correct behaviour. Look upstream at the mint (routes/webhooks.ts), not at the ` +
        `receiver.`,
    };
  }

  return {
    cause,
    blame:
      `⚠️ This row's exit is driven by the ${exit.exemption} lane, not by a card move, so ` +
      `"n8n did not move the card" is not the right question about it. It exhausted its ` +
      `sends because nothing here was ever going to move a card.`,
  };
}

/**
 * One tick.
 *
 * ⚠️ THE ADVISORY LOCK IS HELD ACROSS THE SENDS HERE, and that is a DELIBERATE
 * departure from workers/approval-expiry.ts, whose docblock says outbound HTTP
 * belongs outside the lock. The reason the two differ: approval-expiry's
 * selection is an `UPDATE … RETURNING` that transitions the row inside the
 * lock, so a second replica physically cannot re-select it afterwards. Our
 * selection is a pure SELECT — it mutates nothing — so the lock is the ONLY
 * mutual exclusion we have, and releasing it before the sends would let two
 * replicas deliver the same callback and move the same card twice.
 *
 * That choice is what makes MAX_PER_RUN and the deadline load-bearing rather
 * than decorative: they are the bound on how long the lock can be held.
 * ⚠️ Planka's client has a fixed 15s HTTP timeout that `cards.get`/`lists.get`
 * do not let a caller override, AND its GETs retry once on a network failure
 * (+250 ms), so a single hung read can overshoot the deadline by ~30s. The
 * deadline is checked BEFORE each row, so the overshoot is one row, not the
 * batch. ⚠️ CORRECTED: an earlier draft of this note put the worst case at
 * ~75s by forgetting the retry; measured against the client it is ~131s. The lock is unique to this worker
 * (see db/advisory-lock-keys.ts), so the worst case delays only this worker's
 * next tick, 15 minutes later.
 *
 * ⚠️ CORRECTED 2026-09-10, AND THE DIRECTION IS UPWARD: the overshoot is now up
 * to TWO rows, not one. `deliverAll` gives each lane an unconditional first
 * attempt (see FAST_LANE_DEADLINE_SHARE), so a fresh row that starts just inside
 * the fast lane's sub-deadline and hangs can be followed by one backlog row that
 * starts past `deadline`. Worst case is therefore `deadline + 2 x ~131s ≈ 322s`
 * of lock hold against a 900s interval. That is deliberate: the alternative — a
 * conditional floor — is what let a slow Planka reduce the backlog lane to zero
 * attempts per tick, which is the defect this pairing exists to remove.
 */
/**
 * Move the scan window on. A scan that came back SHORT means we reached the end
 * of the population, so wrap; otherwise step by the window size.
 *
 * ⚠️ Called with the offset the tick actually USED, not the live `scanOffset`,
 * so a concurrent tick cannot make this advance twice from one scan.
 *
 * ⚠️ THE WRAP IS INTRA-LIFETIME AND STAYS THAT WAY. It answers "the walk reached
 * the end", which is a different question from "where should a NEW process start"
 * — that one is `seedScanOffset`'s, and it is why an out-of-range seed would be
 * useless: this function would wrap it straight back to 0. Unchanged otherwise.
 */
function advanceScan(rowsSeen: number, usedOffset: number): void {
  scanOffset = rowsSeen < MAX_READS_PER_RUN ? 0 : usedOffset + MAX_READS_PER_RUN;
}

/**
 * The actions whose REJECTION the receiver HOLDS in BLOCKED — defined beside the set in
 * `domain/engagement/deblock-actions.ts` (the single-definition guard forbids spelling
 * action literals out here) and re-exported for this worker's callers.
 */
export { REJECTED_HOLD_ACTIONS };

/**
 * Holding actions, from the receiver's OWN closed set.
 *
 * ⚠️ COPIED FROM THE RECEIVER, NOT FROM `DEBLOCK_ACTIONS`, AND THE DIFFERENCE IS
 * THE POINT. `AA Pattern - Approval Callback :: Resolve Target List` spells
 * `HOLDING_ACTIONS = new Set(['QUESTION', 'INFRASTRUCTURE', 'DEPENDENCY'])` and
 * `SIDE_EFFECT_ACTIONS = { MERGE: … }`. Only the first set is a HOLD; MERGE also
 * arrives with `deliberate_hold: true` and is deliberately NOT in here — see
 * `classifyReceiverHold`. Deriving this from fr's seven-value `DEBLOCK_ACTIONS`
 * would silently include DROP/SPLIT/RETRY (which the receiver MOVES) and MERGE
 * (which it may still move, later), i.e. it would retire rows that are not held.
 *
 * The R5 reclassify action is deliberately ABSENT: an APPROVED reclassify is a MOVE (the
 * receiver writes the new card_type, then BLOCKED -> TODO), never a deliberate hold. Its
 * LAPSE hold (`LAPSE_HOLDS_ACTIONS`) is the MERGE precedent: in the lapse set, not in this one,
 * so a held-on-lapse body is not retired by this predicate and keeps its retry budget.
 */
const RECEIVER_HOLDING_ACTIONS: ReadonlySet<string> = new Set([
  'QUESTION',
  'INFRASTRUCTURE',
  'DEPENDENCY',
]);

/**
 * ⭐ THE RECEIVER'S 200 BODY SAYS WHETHER IT HELD THE CARD ON PURPOSE. READ IT.
 * =========================================================================
 * MEASURED 2026-09-10 on prod: EVERY tick in a 2h window read `acked=10 moved=0`,
 * and rows carrying `metadata->>'deblock_action' = 'QUESTION'` retired
 * `send_exhausted / receiver_unresponsive` after FIVE SUCCESSFUL acks. The
 * receiver was not unresponsive. Verified byte-equal live-vs-repo, `AA Pattern -
 * Approval Callback :: Resolve Target List` computes
 *
 *     questionAnswered = action === 'QUESTION' && decision === 'approved'
 *                        && String(ctx.comment ?? '').trim().length > 0
 *
 * and with no answer text it sets `shouldMoveCard = false`, `deliberate_hold =
 * true`, and answers 200 with a `resolve_diagnostic` ending `APPROVED WITH NO
 * ANSWER: the ask is still open`. fr counted the ack and ignored the body. Those
 * rows are also SPENT — fr accepts no second decision on a decided approval — so
 * no answer can ever ride on them: the five retries were five sends of a payload
 * that could not succeed, against a receiver that had already explained itself.
 *
 * Returns the cause when the body reports a hold THIS WORKER MUST STOP SENDING
 * FOR, and `null` otherwise. Pure, total over `unknown`, and exported so the
 * predicate can be tested directly — asserting it through the tick would prove a
 * row retired, not WHICH bodies retire it.
 *
 * ⛔ THE THREE REFUSALS BELOW ARE THE CORRECTNESS OF THIS FUNCTION. A naive
 * `deliberate_hold === true` is TOO BROAD and would retire rows that must keep
 * their retry budget:
 *
 *   1. `movedOn` SETS THE SAME FLAG. In the receiver, `deliberate_hold = movedOn
 *      || (…)`, and `movedOn` on a re-delivery means THE CARD IS NO LONGER IN
 *      BLOCKED — the idempotence guard suppressing our own re-send. That is a
 *      `moved` row, not a held one, and its diagnostic says so (`redelivery
 *      suppressed …`/`… had already left BLOCKED`). Retiring it here would write
 *      "held, waiting on an answer" over a card that has already left the board,
 *      and stamp no `callback_delivered_at` on a row that earned one. The caller
 *      ALSO re-reads Planka first and takes `moved` when the card is gone; this
 *      is the belt to that braces, for the tick where the post-send read throws.
 *   2. `MERGE` SETS THE SAME FLAG AND IS NOT A HOLD. An approved MERGE reaches
 *      `Merge PR`, and `Resolve Merge Outcome` then recomputes `shouldMoveCard`
 *      and OVERWRITES `resolve_diagnostic` from the merge result — but `Final
 *      Output` reads `deliberate_hold` from `Resolve Target List`, i.e. from
 *      BEFORE the merge ran. So the flag is `true` on a merge that landed AND on
 *      one that did not. Neither is answer-missing; a failed merge may well
 *      succeed on the next attempt, and retiring it would delete that repair.
 *      MERGE keeps today's behaviour exactly.
 *   3. A REJECTED PROPOSITION also sets it — and never reaches here, because
 *      `notARejectedHold` excludes those rows from the scan entirely. Named so a
 *      future reader does not "fix" the same population twice, in two places,
 *      with two different terminal values.
 *
 * ⭐ AND THE DIAGNOSTIC TEXT IS SUFFICIENT ON ITS OWN, deliberately. A receiver
 * that reports `APPROVED WITH NO ANSWER` (or the escalator's
 * `approval_hold:<ACTION>` token, which `blocked-sweep.json`/`Compose Hold Reason`
 * write into the card's `block_reason`) has said the thing unambiguously, so the
 * flag is not also required — a receiver that grew the prose before the flag, or
 * dropped the flag in a refactor, must not silently fall back to five pointless
 * sends. ⛔ But the moved-on refusal is checked FIRST and beats every other
 * signal, because `moved` is a claim about the WORLD and a hold is a claim about
 * an INTENTION.
 */
export function classifyReceiverHold(body: unknown): HoldCause | null {
  // ⚠️ TOP LEVEL *AND* `data`, AND NEITHER IS SPECULATIVE. The live receiver's
  // `Final Output` returns these fields at the TOP LEVEL (there is no `data`
  // envelope, and no `success` key either — see `DecisionCallbackResult.response`);
  // `N8nWebhookResponse` nonetheless declares `{ success, message?, data? }`, which
  // is the shape the OTHER receivers in EXPIRY_CALLBACK_PATHS answer with. Reading
  // both is what stops this predicate from being a no-op the day a hold arrives
  // wrapped, and `top` wins so the measured shape is never shadowed.
  // ⚠️ BOTH ANNOTATED, NOT INFERRED. Without the annotation the ternary widens to
  // `Record<string, unknown> | {}` and every read below is a `tsc` error on the `{}`
  // arm — an empty object literal has no properties. The annotation is what makes
  // "absent" a readable value rather than a compile failure.
  const top: Record<string, unknown> = isRecord(body) ? body : {};
  const nested: Record<string, unknown> = isRecord(top.data) ? top.data : {};
  const field = (name: string): unknown => (top[name] !== undefined ? top[name] : nested[name]);

  const diagnostic = typeof field('resolve_diagnostic') === 'string'
    ? (field('resolve_diagnostic') as string)
    : '';

  // REFUSAL 1 — the card left BLOCKED. Not a hold, whatever the flag says.
  if (MOVED_ON_DIAGNOSTIC.test(diagnostic)) return null;

  // ⭐ THE UNAMBIGUOUS PROSE, SUFFICIENT WITHOUT THE FLAG. `APPROVED WITH NO
  // ANSWER` is emitted on exactly one condition in the receiver — `answerMissing =
  // action === 'QUESTION' && decision === 'approved' && !answerText` — so it needs
  // no corroboration.
  if (ANSWER_MISSING_DIAGNOSTIC.test(diagnostic)) return 'answer_missing';

  // ⚠️ `approval_hold:<ACTION>` IS *NOT* SUFFICIENT ON ITS OWN, AND AN EARLIER
  // DRAFT OF THIS FUNCTION TREATED IT AS IF IT WERE. `Compose Hold Reason` pushes
  // that token for EVERY `deliberate_hold`, MERGE INCLUDED (`if (r.deliberate_hold)
  // { if (action) parts.push('approval_hold:' + action) }`), so matching the bare
  // prefix would have retired the very rows REFUSAL 2 exists to protect. The
  // ACTION it names is the discriminator, and it is read from the token itself.
  const tokenAction = HOLD_TOKEN_DIAGNOSTIC.exec(diagnostic)?.[1];
  if (tokenAction && RECEIVER_HOLDING_ACTIONS.has(tokenAction.toUpperCase())) {
    return tokenAction.toUpperCase() === 'QUESTION' ? 'answer_missing' : 'hold_by_design';
  }

  if (field('deliberate_hold') !== true) return null;

  // R5: an approved reclassify whose new_card_type the receiver REFUSED (unknown
  // to ncn's catalogue) keeps the card BLOCKED on purpose. The reclassify action is NOT in
  // RECEIVER_HOLDING_ACTIONS — an accepted one moves the card — so only the
  // receiver's refusal marker retires it; without this it burns MAX_SEND_ATTEMPTS
  // and is logged as a receiver fault. The marker is a cross-repo contract,
  // pinned by ncn's test-approval-callback-reclassify.mjs.
  if (isReceiverRefusedReclassify(field('deblock_action'), diagnostic)) {
    return 'hold_by_design';
  }

  // REFUSAL 2 — the flag alone is only trusted for a HOLDING action. MERGE and
  // any action the receiver actually moves for keep their retry budget.
  const action = field('deblock_action');
  if (typeof action !== 'string' || !RECEIVER_HOLDING_ACTIONS.has(action)) return null;

  // An approved QUESTION with the flag set and no `questionAnswered` is the
  // answer-missing population even when the prose is absent; the receiver's own
  // `answerMissing` is exactly `action === 'QUESTION' && decision === 'approved'
  // && !answerText`, and it does not reach `Final Output`, so it is re-derived
  // from the two fields that do.
  if (action === 'QUESTION' && field('decision') === 'approved') return 'answer_missing';
  return 'hold_by_design';
}

/**
 * `resolve_diagnostic` of a hold that is really the idempotence guard. Both
 * spellings the receiver can emit — the re-delivery branch (`redelivery
 * suppressed …`) and the first-delivery branch (`decision not applied - the card
 * had already left BLOCKED`).
 */
const MOVED_ON_DIAGNOSTIC = /redelivery suppressed|already .*left BLOCKED/i;

/**
 * The answer-missing prose — `Resolve Target List`'s own suffix, emitted on the
 * single condition `action === 'QUESTION' && decision === 'approved' && !answerText`.
 */
const ANSWER_MISSING_DIAGNOSTIC = /APPROVED WITH NO ANSWER/i;

/**
 * `approval_hold:<ACTION>` — the token `Compose Hold Reason` writes into the card's
 * `block_reason` and `AA Pattern - Blocked Escalate :: __deriveReason()` classifies
 * on. ⛔ THE CAPTURE GROUP IS LOAD-BEARING: the token is emitted for every
 * `deliberate_hold`, including MERGE, so only the action inside it says whether
 * this is a hold that can never be released by a re-send.
 */
const HOLD_TOKEN_DIAGNOSTIC = /approval_hold:([A-Za-z_]+)/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

/**
 * Should this tick print its summary line?
 *
 * ⚠️ `shadowed` IS ONE OF THE TERMS ON PURPOSE, and leaving it out would have
 * made #1034's fix self-defeating. The other three all mean "this tick did
 * something" — and #1034 is precisely the state where the worker does NOTHING
 * while a suppressed population sits behind the shadow clause. Measured on prod
 * 2026-09-08: 452 shadowed, 1 visible, and that 1 is a permanently unreadable
 * smoke card. The day that row retires, or the 239 gates expiring 2026-09-10
 * drain, every other term goes to 0 — and without `shadowed` here the tick would
 * fall silent again with 452 rows still parked. That is the exact invisibility
 * this change exists to remove, restored by its own log gate.
 *
 * Extracted as a named predicate rather than left inline SO THAT IT CAN BE
 * TESTED. Asserting the condition by matching the source text of this file
 * proves a sequence of characters exists, not that the branch is reached — a
 * dead-code wrapper satisfies the former and defeats the latter.
 */
export function shouldLogTick(r: {
  delivered: number;
  failed: number;
  cardUnreadable: number;
  shadowed: number;
  /**
   * ⭐ 2026-09-10. OPTIONAL so the existing cases — which describe ticks that
   * predate this field — still express a complete tick. A missing value means
   * "not measured", and `?? 0` below makes that read as "none", which is the same
   * thing every pre-existing caller meant.
   */
  rejectedHeld?: number;
  /**
   * ⭐ #1089. OPTIONAL for exactly the reason `rejectedHeld` is: the cases below
   * predate this field, and `?? 0` makes a missing value read as "none", which is
   * what every pre-existing caller meant.
   */
  voidedUnroutable?: number;
  /**
   * ⭐ #1144. OPTIONAL for exactly the reason `rejectedHeld` and `voidedUnroutable`
   * are: the cases below predate this field and `?? 0` makes a missing value read
   * as "none", which is what every pre-existing caller meant.
   */
  superseded?: number;
  /**
   * ⭐ #1104. OPTIONAL for exactly the reason its three predecessors are: the cases
   * below predate this field and `?? 0` makes a missing value read as "none".
   */
  resolvedReadDegraded?: number;
  /** ⭐ #1104. Same, for the withheld counterpart. */
  degradedStrikesWithheld?: number;
  /** ⭐ MERGE-QUEUE fr row 12. OPTIONAL for the same reason as its predecessors. */
  resolvedLeftBlocked?: number;
  resolvedTenantNotPlatform?: number;
  signoffDeferred?: number;
}): boolean {
  return (
    r.delivered > 0 ||
    r.failed > 0 ||
    r.cardUnreadable > 0 ||
    r.shadowed > 0 ||
    // ⭐ IN THE GATE FOR EXACTLY #1034's REASON, ONE EXCLUSION OVER. `shadowed`
    // is here because a tick doing nothing while a suppressed population sits
    // behind the shadow clause is the invisibility being fixed. The rejected-hold
    // set is the same shape: leaving it out would let the line fall silent with N
    // rejected rows parked, which is precisely how 16 of them went unnoticed for
    // the whole life of this worker. A suppressed set must be able to print on
    // its own or it is not reported, only stored.
    (r.rejectedHeld ?? 0) > 0 ||
    // ⭐ #1089, AND THIS TERM IS THE ONE THAT MATTERS MOST FOR THIS EXCLUSION.
    // The other suppressed sets coexist with work; this one REPLACES it. Before
    // the exclusion these 18 rows guaranteed `failed=10` every tick, so the line
    // always printed. Excluding them can take a tick to `delivered=0 failed=0
    // cardUnreadable=0` — i.e. the fix would have SILENCED the very log a reader
    // needs to confirm it worked, and 18 rows waiting on an n8n change would sit
    // behind a tick that prints nothing. Removing this term re-creates #1034 for
    // the population this change creates.
    (r.voidedUnroutable ?? 0) > 0 ||
    // ⭐ #1144, AND FOR THIS EXCLUSION THE TERM IS LOAD-BEARING TWICE OVER. Like
    // #1089's set these rows can REPLACE the tick's work rather than sit beside
    // it — a card whose newer decision superseded the old one is exactly the card
    // that would otherwise have produced the send this gate keys on. And unlike
    // every other suppressed set, a superseded row carries NO `callback_resolution`
    // and no counter on itself, so this log line is its ONLY record. Remove this
    // term and the population becomes invisible everywhere at once.
    (r.superseded ?? 0) > 0 ||
    // ⭐ #1104. A RETIREMENT MUST NEVER BE SILENT, and without these two terms it
    // could be. `cardUnreadable` above already fires on the tick that READS such a
    // row, so in the measured shape the line prints anyway — but that is a
    // coincidence of this population, not a guarantee: a tick whose only work was to
    // mature one long-running degraded row past its 48h bound would otherwise retire
    // it and print nothing at all. A terminal state written with no line in the log
    // is precisely the invisibility #1034 was filed for, one exclusion over.
    (r.resolvedReadDegraded ?? 0) > 0 ||
    // ⭐ AND THE WITHHELD COUNT TOO. A guard that silently declines to act is
    // indistinguishable from a guard that is not wired up — see
    // `degradedStrikesWithheld`.
    (r.degradedStrikesWithheld ?? 0) > 0 ||
    // ⭐ MERGE-QUEUE fr row 12. A retirement or a refusal must never be silent.
    (r.resolvedLeftBlocked ?? 0) > 0 ||
    (r.resolvedTenantNotPlatform ?? 0) > 0 ||
    (r.signoffDeferred ?? 0) > 0
  );
}

export async function runDeblockRedeliveryTick(): Promise<DeblockTickResult> {
  const db = defaultDb;
  const planka = plankaClient;
  const tickStartedAt = Date.now();
  const tickBudgetMs = tickDeadlineMs();
  const deadline = tickStartedAt + tickBudgetMs;
  /**
   * ⭐ THE TIME RESERVE. See FAST_LANE_DEADLINE_SHARE — the fast lane may not
   * START a row past this instant, so the backlog walk always enters `deliverAll`
   * with `(1 - FAST_LANE_DEADLINE_SHARE)` of the tick still unspent. Derived from
   * the same `tickBudgetMs` the deadline is, so the two cannot drift apart when
   * an operator moves DEBLOCK_REDELIVERY_TICK_DEADLINE_MS.
   */
  const fastLaneDeadline = tickStartedAt + Math.floor(tickBudgetMs * FAST_LANE_DEADLINE_SHARE);
  const nowMs = Date.now();
  const paceMs = PACE_MS;

  const result: DeblockTickResult = {
    outcome: 'ok',
    acquiredLock: false,
    candidates: 0,
    eligible: 0,
    delivered: 0,
    notBlocked: 0,
    cardUnreadable: 0,
    failed: 0,
    resolvedMoved: 0,
    resolvedNotBlocked: 0,
    resolvedUnreadable: 0,
    resolvedSendExhausted: 0,
    // Built from the cause list, never spelled a second time: a new cause gets its series
    // here and in the metric at once, rather than reading as a permanent absence.
    sendExhaustedByCause: Object.fromEntries(SEND_EXHAUSTION_CAUSES.map((c) => [c, 0])) as Record<
      SendExhaustionCause,
      number
    >,
    resolvedHoldAcknowledged: 0,
    // Built from HOLD_CAUSES for the same reason the line above is built from
    // SEND_EXHAUSTION_CAUSES: a new cause gets its bucket and its printed label at
    // once, instead of reading as a permanent absence until someone notices.
    holdAcknowledgedByCause: Object.fromEntries(HOLD_CAUSES.map((c) => [c, 0])) as Record<
      HoldCause,
      number
    >,
    resolvedReadDegraded: 0,
    // Built from READ_DEGRADED_CAUSES for the same reason the two lines above are
    // built from their cause lists: a new cause gets its bucket and its printed
    // label at once, instead of reading as a permanent absence until someone notices.
    readDegradedByCause: Object.fromEntries(READ_DEGRADED_CAUSES.map((c) => [c, 0])) as Record<
      ReadDegradedCause,
      number
    >,
    degradedStrikesWithheld: 0,
    breakerTripped: false,
    strikesWithheld: 0,
    shadowed: 0,
    fastLane: 0,
    fastLaneDeferred: 0,
    rejectedHeld: 0,
    voidedUnroutable: 0,
    superseded: 0,
    successfulReads: 0,
    resolvedLeftBlocked: 0,
    resolvedTenantNotPlatform: 0,
    signoffDeferred: 0,
    more: false,
    scanOffset: null,
  };

  // `callback_path IS NOT NULL` is required, not defensive: n8n-callback.ts
  // deliberately never stamps a web-only approval, so including those rows
  // would select the same never-stampable set forever.
  //
  // ⛔ THE `NOT EXISTS` IS THE SECOND HALF OF THE SAFETY ARGUMENT. DO NOT DROP IT.
  // ---------------------------------------------------------------------------
  // The live-list gate below proves a card is "in BLOCKED". That is NOT the
  // property this worker needs, and an adversarial review caught the gap by
  // measuring it: a card is in BLOCKED for TWO different reasons, and only one
  // of them is ours.
  //
  //   (a) its approval was answered but the callback never landed  <- ours
  //   (b) it is waiting on an approval a human has not answered yet <- NOT ours
  //
  // `approvals.card_id` has no unique constraint, so one card can carry several
  // approvals; 138 cards already carry more than one candidate row. Measured on
  // prod 2026-09-05, WITHOUT this clause: 1,081 candidate rows over 860 cards,
  // of which 248 rows fire against 228 cards that ALSO hold a live, UNEXPIRED
  // `pending` approval (newest created the day before). Re-delivering those
  // moves 228 cards out of BLOCKED out from under a decision nobody has made —
  // TWICE the size of the 110-DONE-card class that made main refuse this worker
  // in the first place, and the first offender sits at ordinal 36, i.e. tick 4,
  // roughly 45 minutes after deploy, unattended.
  //
  // ⚠️ The unit test "ignores a still-pending approval" does NOT cover this. It
  // pins that a pending ROW is not a candidate. This clause is about a card HELD
  // BY a pending row while a different, already-approved row on the same card is
  // the candidate. The two read as the same guarantee and are not.
  // ⛔ 'approved', 'voided' AND — SINCE 2026-09-10 — 'rejected' DE-BLOCK. DO NOT
  // WIDEN THIS FURTHER WITHOUT A SEPARATE DECISION.
  // ---------------------------------------------------------------------------
  // ⚠️ CORRECTED 2026-09-10. This block used to read: "'rejected' is a human
  // saying no. Selecting it here would move a refused card onward as if it had
  // been approved — the opposite of what a rejection means. It must never be
  // added." ⛔ THE PREMISE IS FALSE, AND IT WAS NEVER MEASURED — it assumed what
  // the receiver does with `decision: 'rejected'` instead of reading it.
  //
  // ⭐ WHAT THE RECEIVER ACTUALLY DOES. Read off the live card-blocking receiver
  // "AA Pattern - Approval Callback" (n8n id yG1N9K2hTswEZNTq, the workflow the
  // repo copy `n8n_custom_nodes/workflows/patterns/approval-callback.json`
  // mirrors), node `Resolve Target List`. A rejection has TWO behaviours, and
  // the discriminator is whether the payload carries a `deblock_action`:
  //
  //   NO action (the legacy shape)   `else if (ctx.decision === 'rejected' &&
  //                                  todoListId) { target_list_kind = 'TODO' }`
  //                                  -> ⭐ THE CARD MOVES, BLOCKED -> TODO.
  //   WITH an action (a proposition) `if (action) { if (ctx.decision !==
  //                                  'approved') target_list_kind = null }`
  //                                  -> the card deliberately STAYS in BLOCKED.
  //                                  Its own comment: "A rejection always holds
  //                                  the card in BLOCKED: rejecting the
  //                                  proposition means 'no, not that', and
  //                                  moving the card anyway would discard the
  //                                  human's actual answer."
  //
  // ⚠️ AND `todoListId` IS NOT THE ROW'S METADATA. `Resolve Target List` computes
  // `ctx.todoListId || resolved.TODO` — it DERIVES the list from the board when
  // the caller named none, which is the entire point of that node ("0 of 317
  // decisions could move a card" before it shipped). So the 2,031 rows measured
  // carrying `todoListId: ''` still resolve a real TODO list. The empty string
  // does NOT make a legacy rejection unmovable.
  //
  // ⭐ CORROBORATED ON fr's SIDE, not only n8n's. `services/n8n-callback.ts`
  // passes the status THROUGH (`decision: approval.status`) and gates ONLY
  // `voided` against `VOIDED_CALLBACK_PATHS`; its comment there states outright
  // that "`approved`/`rejected` are routed by every receiver measured and are not
  // gated here". `Parse Decision`'s own TEST-branch mapping agrees:
  // `decision === 'rejected' ? todoListId : ''`.
  //
  // ⇒ SO A REJECTION DOES LEGITIMATELY PRODUCE A CALLBACK, AND FOR THE LEGACY
  //   SHAPE IT PRODUCES AN OBSERVABLE CARD MOVE. Measured on prod 2026-09-10:
  //   **16 rejected rows, 0 with a `callback_resolution`, 0 with any retry path,
  //   ever.** A rejection whose callback failed was silently unrepairable for the
  //   life of this worker. That is the gap, and it is closed by adding the status
  //   here — NOT by widening to a decision the receiver refuses to route.
  //
  // ⛔ THE PROPOSITION HALF IS EXCLUDED SEPARATELY AND ON PURPOSE — see
  // `notARejectedHold` below. Sending for one would ack, move nothing (correctly),
  // burn all MAX_SEND_ATTEMPTS, and then retire the row blaming the receiver for
  // behaviour that is by design.
  //
  // 'expired' is NOBODY ANSWERING. Selecting it here would fabricate consent
  // that was never given. Measured on prod 2026-09-05: 120 rows sit in
  // `expired` with a BLOCKED card and no drain — this worker deliberately does
  // NOT repair them. That is a KNOWN OPEN QUESTION, not an oversight: does an
  // expired card-blocking approval get re-raised (TODO, per
  // EXPIRY_CALLBACK_PATHS / sendN8nExpiryCallback), silently re-block forever,
  // or something else? That decision belongs to whoever owns the expiry
  // contract, not to this predicate. Naming it here is the deliverable.
  //
  // ⛔ ONE FRAGMENT, TWO QUERIES, DELIBERATELY. The seed below needs a COUNT over
  // the SAME population the scan reads, and re-typing this predicate there would
  // let the two drift — a count taken over a wider predicate would seed the walk
  // past the end of the real population, and nothing would notice. Every safety
  // clause above is therefore written exactly once.
  //
  // ⚠️ IT IS NOW ONE FRAGMENT AND *THREE* READERS — the scan, the seed COUNT, and
  // #1034's shadow census — and the rule got STRICTER, not looser. The predicate
  // is split in two (`candidateWhereBase` here, `notShadowedByOpenGate` below)
  // ONLY so the census can count the rows the shadow clause removes by reusing
  // that clause's exact text. `candidateWhere` recomposes them, so the scan's
  // population is unchanged. Both halves are still written exactly once; a fourth
  // reader must interpolate them too, never retype them.
  const candidateWhereBase = sql`
       WHERE a.status IN ('approved', 'voided', 'rejected')
         AND a.callback_delivered_at IS NULL
         -- ⭐ MIGRATION 113, DEFECT 2. Without this term a row the live gate
         -- classifies not_blocked or unreadable is never written to at all and
         -- comes back on EVERY scan cycle forever. callback_resolution is where
         -- the gate's verdict is now persisted, so the query can exclude what
         -- the gate has already decided.
         AND a.callback_resolution IS NULL
         -- ⭐ MIGRATION 113, DEFECT 1. An ack is NOT a retirement -- it is a
         -- grace window. The callback_delivered_at IS NULL term above no longer
         -- hides an acked-but-unmoved row (nothing stamps it on an ack any
         -- more), so this is the only thing keeping us from re-sending a card
         -- that is still mid-move. Deleting it re-creates the double-move risk;
         -- changing it to a retirement re-creates the 373/373 defect.
         AND (
               a.callback_acked_at IS NULL
            OR a.callback_acked_at < now() - (${ACK_GRACE_MS / 1000} * interval '1 second')
         )
         AND a.card_id IS NOT NULL
         AND a.callback_path IS NOT NULL`;

  /**
   * The shadow clause, LIFTED OUT OF `candidateWhere` AND STILL WRITTEN ONCE.
   *
   * ⛔ THIS IS NOT A WEAKENING, AND THE PREDICATE STILL SELECTS EXACTLY WHAT IT
   * SELECTED BEFORE. `candidateWhere` below is `candidateWhereBase AND this`, so
   * the scan's population is byte-for-byte the old one. It is a separate fragment
   * for ONE reason: the census needs to count the rows this clause REMOVES, and
   * the only honest way to do that is to reuse the same text rather than retype
   * it — the "ONE FRAGMENT, TWO QUERIES" rule above, extended to a third reader.
   *
   * ⭐ #1034 — WHY THE WITHHELD SET IS NOW COUNTED. Measured on prod 2026-09-08:
   * 453 rows passed every clause in `candidateWhereBase`, ONE passed this one,
   * and the other 452 (across 396 distinct cards) were withheld and never
   * counted, logged, or resolved. The tick line printed `candidates=1`, which is
   * indistinguishable from a drained queue. It was 99.8% censored.
   *
   * ⚠️ THE SUPPRESSION IS CORRECT. THE SILENCE WAS THE DEFECT. A card with a live
   * `pending` gate must not be re-driven — see the block above for the 228-card
   * measurement that put this clause here. Nothing about that changes; the only
   * change is that the withheld count now reaches the log as `shadowed=N`.
   */
  const notShadowedByOpenGate = sql`NOT EXISTS (
               SELECT 1
                 FROM approvals p
                WHERE p.card_id = a.card_id
                  AND p.status = 'pending'
             )`;

  /**
   * ⭐ THE OTHER HALF OF THE `rejected` DECISION — the rows that must NOT be sent
   * for even though the status is now selected.
   *
   * A rejected BLOCKED-exit PROPOSITION is held in BLOCKED by the receiver on
   * purpose (`Resolve Target List`: `if (action) { if (ctx.decision !==
   * 'approved') target_list_kind = null }`). This worker's only success criterion
   * is "the card was observed OUT of BLOCKED", so such a row can never reach
   * `moved`. Without this clause it would be sent for on every tick past
   * ACK_GRACE_MS until `callback_send_attempts` hit MAX_SEND_ATTEMPTS, then
   * retired `send_exhausted` with cause `receiver_unresponsive` — five pointless
   * POSTs and a permanent record blaming n8n for doing exactly the right thing.
   *
   * ⛔ IT IS AN EXCLUSION, NOT A RETIREMENT, AND THAT IS DELIBERATE. Retiring it
   * would need a FIFTH `callback_resolution` value ("held by design"), which
   * means a CHECK-constraint change and a migration — and none of the four
   * existing values is honest about it: `send_exhausted` claims MAX_SEND_ATTEMPTS
   * sends that never happened, `not_blocked` claims the card left BLOCKED when it
   * demonstrably did not. Writing the wrong terminal value is worse than writing
   * none, so the row is excluded from the population the same way a web-only
   * approval (`callback_path IS NULL`) and an `expired` row already are, and the
   * census below COUNTS it so the exclusion is loud instead of silent. ⇒ THE
   * FOLLOW-UP, NAMED RATHER THAN SMUGGLED IN: a `'no_move_expected'` resolution
   * belongs with whoever owns the migration lane.
   *
   * ⚠️ `DEBLOCK_ACTIONS` IS INTERPOLATED, NEVER RETYPED. It is the same closed set
   * `buildCallbackPayload` narrows through (`asDeblockAction`), so a seventh
   * action widens both at once. Spelling the list here is the five-copies defect
   * `domain/engagement/deblock-actions.ts` exists to have ended.
   *
   * ⛔ HONEST LIMIT — THIS IS AN APPROXIMATION OF `buildCallbackPayload`, AND THE
   * DIVERGENCE CLASS IS NAMED. That builder emits an action only when
   * `irreconcilableDualExit` does NOT fire, i.e. it WITHHOLDS the action from a
   * row that also carries `advance_phase_on_approve` or is
   * `kind='execution.ready_signoff'`. Such a row would reach the receiver with no
   * action, take the legacy branch, and move to TODO — so this clause withholds
   * it wrongly. Two reasons that is the right trade:
   *   • MEASURED EMPTY. `deblock-actions.ts` records 0 rows in all of history
   *     carrying `advance_phase_on_approve` (an ILIKE sweep over every key in
   *     every row returns nothing) and 0 of 844 `signoff_rail` rows carrying an
   *     action. The class is constructible, not populated.
   *   • THE ERROR IS NEVER WORSE THAN TODAY. A wrongly-withheld rejection stays
   *     unrepaired — which is precisely its status quo, since `rejected` was
   *     excluded outright. Nothing regresses; the improvement is merely smaller
   *     than it looks. Re-deriving the dual-exit rule in SQL WOULD be the
   *     "two code paths, one row, different conclusions" defect this file is
   *     built to refuse.
   *
   * ⛔ `IN (…)` VIA `sql.join`, NOT `= ANY(${'${array}'}::text[])`, AND THAT IS NOT A
   * STYLE CHOICE. MEASURED against `PgDialect.sqlToQuery` before this shipped:
   * drizzle expands a bound JS array into a ROW CONSTRUCTOR, so
   * `ANY(${'${DEBLOCK_ACTIONS}'}::text[])` renders as `ANY(($1, $2, … $7)::text[])` —
   * a 7-column row cast to `text[]`, which Postgres rejects. The whole scan would
   * have thrown on every tick. `sql.join` renders `IN ($1, …, $7)`, which is the
   * idiom already in use at `routes/tools/analytics.ts:494`.
   *
   * ✅ RESOLVED (was: a drive-by report that `workers/approval-expiry.ts` used the
   * refuted spelling). It did, in `recordCallbacksDeferred`, and it was LIVE — the
   * statement threw on every invocation inside a `catch` that only logged, so no row
   * the expiry tick ran out of time to notify was EVER stamped with the marker that
   * exists so a human can find those rows. Proved on a real database: the bound-array
   * form fails `cannot cast type record to uuid[]`; the `sql.join` form executes.
   * Fixed, with a regression test that asserts the ROW (not a spy — the defect is that
   * the write silently did not happen while the code path "ran"), and a repo guard,
   * `backend/scripts/check-any-bound-array.ts`, because this comment proves someone
   * already learned the lesson here and the other site stayed broken anyway.
   *
   * ⛔ THE `coalesce` IS LOAD-BEARING AND ITS ABSENCE WOULD HAVE INVERTED THE
   * WHOLE FIX. `metadata->>'deblock_action'` is SQL NULL on a legacy rejection —
   * the exact class this change exists to repair — and `NULL IN (…)` is NULL, not
   * FALSE. So `NOT ('rejected' = 'rejected' AND NULL)` is `NOT NULL` = NULL, the
   * row fails the WHERE, and every legacy rejection is silently withheld: the
   * predicate would have selected ONLY the propositions it is meant to exclude and
   * excluded ONLY the rows it is meant to select. `coalesce(…, '')` makes the
   * comparison total — `''` is in no allowlist — so a missing key reads as FALSE
   * and the row is a candidate.
   */
  /**
   * ⭐ #1146 — PARAMETERISED BY ALIAS, AND THAT IS THE "WRITTEN EXACTLY ONCE" RULE
   * BEING KEPT, NOT BENT. `notSuperseded` below has to ask the SAME question of a
   * SIBLING row (`s`) that this asks of the candidate (`a`): "is this a row this
   * worker could ever act on?". Retyping the clause against `s` is precisely the
   * drift the "ONE FRAGMENT, N READERS" note above forbids — two spellings of one
   * predicate that can silently disagree. Taking the alias as an argument makes the
   * two readers the SAME text by construction.
   */
  const notARejectedHoldFor = (t: 'a' | 's') => sql`NOT (
                  ${sql.raw(t)}.status = 'rejected'
              AND coalesce(${sql.raw(t)}.metadata->>'deblock_action', '') IN (${sql.join(
                REJECTED_HOLD_ACTIONS.map((action) => sql`${action}`),
                sql`, `,
              )})
             )`;
  const notARejectedHold = notARejectedHoldFor('a');

  /**
   * The candidate predicate: base clauses AND the shadow clause AND the
   * rejected-hold clause. Every half is interpolated, never retyped, so
   * `selectFreshCandidates`, `selectBacklogCandidates`, the census and any future
   * reader cannot drift apart.
   *
   * ⚠️ IT IS NOW ONE PREDICATE AND *FOUR* READERS. The "ONE FRAGMENT, TWO
   * QUERIES" rule above is unchanged in spirit and stricter in practice: the two
   * scan lanes differ ONLY in their `completed_at` window, their ORDER BY and
   * their LIMIT — never in what they consider a candidate. A fifth reader must
   * interpolate these fragments too.
   */
  /**
   * ⭐ #1089 — THE THIRD EXCLUSION: A `voided` ROW WHOSE RECEIVER CANNOT ROUTE
   * `voided`. Same shape, and the same justification, as `notARejectedHold`.
   *
   * ⛔ THIS IS NOT A RETREAT FROM THE REFUSAL, AND IT IS NOT A RETIREMENT.
   * `services/n8n-callback.ts` refuses to send such a row (`VOIDED_CALLBACK_PATHS`)
   * because the receiver's `Route by decision` Switch has outputs
   * `idempotent,approved,rejected,expired` and `fallbackOutput: none` — a `voided`
   * send would 200 and be silently dropped. That refusal is CORRECT and is
   * untouched here. What was missing is that fr kept SELECTING those rows anyway.
   *
   * ⛔ WHAT IT COST. Measured 2026-09-12: 18 rows, `status='voided'`,
   * `callback_path='execution-ready-signoff-callback'`. Each tick they pass every
   * clause, reach the send, come back `skipped-unsupported-receiver`, are refunded
   * (#1029 — correctly), and are charged `result.failed += 1`, which counts against
   * MAX_PER_RUN. Ten of them filled all ten send slots and the tick ended: live
   * `eligible=11 acked=0 moved=0-1 failed=10`. The population is structurally
   * undrainable — the refund means `callback_send_attempts` stays 0, so
   * `send_exhausted` can never trip — so this is not slow, it is a deadlock, and
   * the ONE genuinely sendable voided row (on `kanban/approval-callback`) was
   * never reached.
   *
   * ⛔ AN EXCLUSION, NOT A RETIREMENT, AND THAT IS DELIBERATE — read
   * `notARejectedHold` above, which refused the same shortcut for the same reason.
   * A `callback_resolution` is matched by `AND a.callback_resolution IS NULL` in
   * `candidateWhereBase` and is therefore PERMANENT: it would falsify the refusal's
   * own promise one file away ("the rows this refused are still there to be
   * delivered" the day the receiver is taught `voided`) — which is precisely the
   * trap #1029/#1041 removed by adding the refund. None of the five existing values
   * is honest about this row either: `send_exhausted` claims MAX_SEND_ATTEMPTS acked
   * sends and this row has ZERO of both.
   *
   * ⭐ RE-OPENABLE BY CONSTRUCTION, WHICH IS THE WHOLE REASON THIS IS A PREDICATE
   * AND NOT A COLUMN. The clause is evaluated live from `VOIDED_CALLBACK_PATHS`, so
   * the day the receiver is taught `voided` and the path is added to that set,
   * every withheld row re-enters the population on the next tick — no backfill, no
   * migration, nothing to remember. A persisted resolution would need someone to
   * find and un-retire 18 rows they no longer have a query for.
   *
   * ⚠️ `regexp_replace(…, '^/+', '')` IS `normalizeCallbackPath` (n8n-callback.ts:391
   * — `path.replace(/^\/+/, '')`), REPRODUCED, NOT APPROXIMATED. It is the whole of
   * that function: strip leading slashes. If that function ever grows a second rule
   * this clause silently stops agreeing with the sender's own guard, which is the
   * "two code paths, one row, different conclusions" defect this file refuses — so
   * a change there must change this.
   *
   * ⚠️ THE `coalesce` IS BELT-AND-BRACES HERE, AND UNLIKE `notARejectedHold`'S IT IS
   * NOT LOAD-BEARING — stated so nobody deletes that one by analogy with this one.
   * There, `metadata->>'deblock_action'` is genuinely NULL on a legacy rejection and
   * `NULL IN (…)` would have inverted the whole clause. Here `callback_path IS NOT
   * NULL` is already a term of `candidateWhereBase`, so the left side cannot be NULL
   * in either reader; the `coalesce` only makes the fragment total if it is ever
   * lifted somewhere that guarantee does not hold.
   *
   * ⚠️ THE EMPTY-SET GUARD IS NOT DEFENSIVE PADDING. `sql.join([])` renders `IN ()`,
   * which is a syntax error, so emptying `VOIDED_CALLBACK_PATHS` would throw on EVERY
   * tick rather than degrade. `false` is also the semantically right answer: if no
   * receiver can route `voided`, no voided row is routable.
   *
   * ⛔ `IN (…)` VIA `sql.join`, NEVER `= ANY(${'${array}'}::text[])`, and the set is
   * INTERPOLATED, never retyped — both for the reasons `notARejectedHold` spells out
   * at length, and the second one is why this reads `VOIDED_CALLBACK_PATHS` from the
   * sender instead of copying its one entry: adding a path must widen the sender's
   * guard and this predicate in the same edit, or they disagree.
   */
  const voidedPaths = [...VOIDED_CALLBACK_PATHS];
  /** See `notARejectedHoldFor` for why this takes the alias rather than hard-coding `a`. */
  const receiverRoutesVoidedFor = (t: 'a' | 's') =>
    voidedPaths.length === 0
      ? sql`false`
      : sql`coalesce(regexp_replace(${sql.raw(t)}.callback_path, '^/+', ''), '') IN (${sql.join(
          voidedPaths.map((path) => sql`${path}`),
          sql`, `,
        )})`;
  const notAnUnroutableVoidFor = (t: 'a' | 's') => sql`NOT (
                  ${sql.raw(t)}.status = 'voided'
              AND NOT (${receiverRoutesVoidedFor(t)})
             )`;
  const notAnUnroutableVoid = notAnUnroutableVoidFor('a');

  /**
   * ⭐ #1144 — THE FOURTH EXCLUSION: A ROW A NEWER DECISION ON THE SAME CARD HAS
   * ALREADY OVERTAKEN. Same shape, and the same justification, as the three
   * exclusions above: a FILTER, never a retirement.
   *
   * ⛔ THE SIBLING MUST STILL BE ABLE TO DELIVER. THE FIRST DRAFT OF THIS CLAUSE
   * ASKED ONLY WHETHER ONE EXISTED, AND THAT STRANDED CARDS — MEASURED ON PROD.
   * `candidateWhereBase` excludes any row with a `callback_resolution`, PERMANENTLY.
   * So a newer sibling already retired `not_blocked` (or `card_unreadable`, or
   * `send_exhausted`) can NEVER repair its card again. If the card is re-BLOCKED
   * afterwards, suppressing the older row as well leaves the card with NO delivery
   * path at all — and because approval status is forward-only (see the correction
   * below) that state is permanent, not transient.
   *
   * ⭐ MEASURED READ-ONLY ON PROD with this predicate rebuilt: 84 candidates → 39,
   * 45 suppressed, and of those **17 rows across 10 cards lost EVERY delivery path**.
   * All 10 cards were BLOCKED at the time, on active non-hidden projects (Asset
   * Authoring; Principles/Requirements/Decisions). Named instance: approval
   * `eaf6805d-118c-458e-8915-2b452918d125` on card `1849512986897548626`.
   *
   * ⛔ AND `callback_resolution IS NULL` DOES NOT MEAN "CAN STILL DELIVER". It means
   * "NOT YET RETIRED", and the gap between those is STRUCTURAL, not statistical.
   * `callback_resolution` is written in exactly three places and none of them can
   * ever reach the rows that matter here: THIS worker (only for rows passing
   * `candidateWhere`), `workers/approval-expiry.ts` (only for `status='expired'`),
   * and a one-off repair script. ⇒ A row excluded by a PERMANENT clause of
   * `candidateWhere` can NEVER acquire a resolution, so it satisfies "unresolved"
   * FOREVER while being permanently undeliverable.
   *
   * ⭐ MEASURED ON PROD, relaxing only the TEMPORARY (shadow) clause: 27 rows across
   * 21 cards are suppressed by a sibling of exactly one shape — `voided` on
   * `execution-ready-signoff-callback`, which is NOT in `VOIDED_CALLBACK_PATHS`,
   * resolution NULL, never delivered. That is this file's own `notAnUnroutableVoid`
   * hole seen FROM THE SIBLING SIDE, and fr can never send those rows. Worked case:
   * card `1854801193616803081` (Requirement Development), rows `a25757a5…` and
   * `840f7510…` suppressed by `d49192b4-1bf9-49e1-b595-027b4c7f9454`.
   *
   * ⚠️ THOSE CARDS ARE SHIELDED TODAY ONLY BY `notShadowedByOpenGate` — one live
   * pending row each. 239 rows expire 2026-09-22; when those gates lapse the shield
   * lifts and the strand appears on exactly the cards this change exists to protect.
   *
   * ⛔ BUT THE SIBLING TERM MIRRORS `notAnUnroutableVoid` AND **NOT**
   * `notARejectedHold`, AND THAT ASYMMETRY IS THE MEASUREMENT, NOT AN OVERSIGHT.
   * Both are permanent exclusions, so "mirror the permanent exclusions" would take
   * both — and taking `notARejectedHold` would be a REGRESSION of the very defect
   * class this clause closes. A rejected BLOCKED-exit proposition is held in BLOCKED
   * BY DESIGN (read `notARejectedHold` above, and n8n's `blocked-sweep.json ::
   * Classify + Plan:76`, "DO NOT 'FIX' approval_hold BY MAKING A DECIDED HOLD
   * MOVABLE"). Letting an OLDER approval out from under it would move a card whose
   * newest decision says stay — the same shape as the 0-vs-228 `decision:expired`
   * finding. An unroutable void is the opposite: it is INERT. fr structurally cannot
   * send it, it asserts no intent about the card, and it is typically a drain-seat
   * withdrawal of an UNANSWERABLE row — so it must not shadow a live decision.
   * Measured split of the same cohort: unroutable-void suppressors 27 rows / 21
   * cards; rejected-hold suppressors 2 rows / 2 cards, and those 2 are cards a
   * deliberate hold is holding correctly.
   *
   * The third term is therefore "can this sibling still act, or did it already?",
   * and it has exactly two ways to say yes:
   *   * `s.callback_delivered_at IS NOT NULL` — it ALREADY acted. The card was
   *     driven on the newer decision; the older one is genuinely obsolete. (This is
   *     also every `moved` row, since `moved` is the one resolution that stamps
   *     `callback_delivered_at`.)
   *   * `s.callback_resolution IS NULL` AND it is not an unroutable void — it has not
   *     been retired AND this worker is not structurally barred from sending it, so
   *     it is still a candidate in its own right and will be delivered on a future
   *     tick. ⛔ The second half is load-bearing: without it, "unresolved" admits the
   *     27 permanently-unsendable rows measured above.
   * Anything else is a sibling that neither acted nor can act, and it must NOT
   * suppress. ⛔ A retired-but-undelivered sibling is precisely the stranding case;
   * deleting this term re-creates it, silently, on cards nobody is watching.
   *
   * ⛔ IT IS SUPERSESSION, NOT AGE, AND THAT DISTINCTION IS THE WHOLE CLAUSE. An
   * old undelivered row is not by itself a reason to withhold — the backlog walk
   * exists precisely to reach rows whose decisions are weeks old, and a clause
   * keyed on `completed_at < now() - X` would silently delete that lane. What
   * disqualifies a row is that SOMEBODY DECIDED THE SAME CARD AGAIN AFTERWARDS:
   * a strictly newer sibling (`created_at >`) on the same `card_id` that has
   * reached a terminal status. Replaying the older callback then drives the card
   * on an instruction the newer decision has already overwritten.
   *
   * ⛔ WHY `approved` IS IN THE TERMINAL SET, WHICH LOOKS WRONG AND IS NOT. The
   * receiver's `Move Card` is an unconditional `card.update{listId}` (the header,
   * objection 1), and the suite already pins this at "still repairs a card whose
   * only other approval is itself approved": two approved rows on one card mean
   * ONE card and TWO sends. Before this clause the second send met a card that had
   * already moved and resolved `not_blocked` — correct only because the first send
   * happened to win the race. Withholding the OLDER of the two makes that an
   * identity instead of an ordering accident.
   *
   * ⛔ `pending` IS NOT IN THE SET, AND MUST NOT BE ADDED. `notShadowedByOpenGate`
   * above already withholds on a pending sibling, and it does so SYMMETRICALLY
   * (any pending row on the card, newer or older). Duplicating it here would make
   * the census's two FILTERs count the same population twice under two names —
   * the arithmetic the census docblock refuses. ⭐ And the two are NOT the same
   * fact: a pending sibling is a gate that will open, so its row comes back; a
   * terminal sibling is a decision that will not be taken again. `shadowed` drains
   * and `superseded` does not, which is why they are counted apart.
   *
   * ⚠️ `created_at`, NEVER `id` AND NEVER `completed_at`. `approvals.id` is
   * `uuid().defaultRandom()` (db/schema.ts:446) — it carries NO ordering at all, so
   * `s.id > a.id` would be a coin flip dressed as a comparison. `completed_at` IS
   * nullable (:473) and a NULL makes the comparison NULL, not FALSE, so a row that
   * was never stamped would neither supersede nor be superseded — it would silently
   * fall out of both halves. `created_at` is NOT NULL (:466) and monotonic with the
   * insert, which is the only one of the three that can carry this predicate.
   *
   * ⚠️ MATCHED ON `card_id` ALONE, NOT ON `(tenant_id, card_id)`, AND THAT IS
   * MEASURED RATHER THAN COPIED FROM THE SIBLING CLAUSE. 10 cards in the live
   * queue carry BOTH a `…0001` `generic` gate and a `…0003` `execution.ready_signoff`
   * gate, i.e. two tenant ids over one Planka card. Tenant-scoping this NOT EXISTS
   * lets exactly those siblings escape — the cards with the most decisions on them
   * would be the only ones the clause could not protect. `notShadowedByOpenGate`
   * matches on `card_id` alone for the same reason; the cross-tenant question the
   * census docblock raises is filed separately, and answering it must change BOTH
   * clauses in one edit or they disagree about what a sibling is.
   *
   * ⛔ A FILTER, NOT A `callback_resolution` STAMP, AND THAT WAS DECIDED AGAINST
   * PRECEDENT IN THIS FILE RATHER THAN BY TASTE. `notARejectedHold` (above) and
   * `notAnUnroutableVoid` (directly above) each refused to retire the rows they
   * withhold, for one reason: `AND a.callback_resolution IS NULL` is a clause of
   * `candidateWhereBase`, so a resolution is PERMANENT and there is no query left
   * to find the rows by. Supersession is the same shape — it is a statement about a
   * SIBLING row, evaluated live from the siblings' current statuses rather than
   * frozen into this row. A stamp would have written a judgement about OTHER rows
   * into THIS one, irreversibly.
   *
   * ⛔ CORRECTED — AND THIS IS THE PART THAT MUST NOT BE SOFTENED. An earlier draft
   * of this comment said a withheld row "re-enters the population the day its newer
   * sibling stops being terminal". ⚠️ THAT IS FALSE, and false for the DOMINANT
   * case. Approval status is FORWARD-ONLY into the terminal set: the only writer of
   * a non-`pending` status is `workers/approval-expiry.ts:454` (`SET status =
   * 'expired' WHERE status = 'pending'`) and the decide/void routes, and nothing
   * anywhere returns a decided approval to `pending`. `'expired'` is additionally
   * ABSORBING here — `candidateWhereBase` selects only `approved/voided/rejected`,
   * so an expired sibling is never itself a candidate and never changes state again.
   * ⇒ IN PRACTICE A SUPERSEDED ROW IS WITHHELD FOREVER.
   *
   * ⭐ THE CONSEQUENCE AN OPERATOR MUST READ BEFORE TRUSTING THE COUNTER:
   * `superseded=N` IS A MONOTONE FLOOR, NOT A RATE. The ~153 rows whose gates expire
   * 2026-09-22 land in this count and never leave it, so from that day the number is
   * a standing baseline and CANNOT be read as "new supersessions today". Any alert
   * written over it must be on the DELTA, never on the level, and a reader comparing
   * two days must subtract the floor. This is a real difference from `shadowed`,
   * which drains when its gate is answered.
   *
   * ⚠️ THE DIFFERENCE FROM THE TWO CLAUSES ABOVE IS THEREFORE NARROWER THAN IT
   * LOOKS, AND SAYING SO HONESTLY IS THE POINT. `notAnUnroutableVoid` is genuinely
   * re-openable — its clause reads `VOIDED_CALLBACK_PATHS` live, so teaching the
   * receiver `voided` releases 18 rows with no backfill. This clause reads row
   * STATUS, which does not move backwards. What a filter still buys over a stamp is
   * that the decision is never WRITTEN: the row keeps `callback_resolution` NULL, so
   * if this predicate is ever changed or removed the population is recovered by
   * deploying that change, with nothing to un-retire and no `WHERE` to reconstruct.
   * ⛔ NO DRAIN PATH IS BUILT HERE AND NONE SHOULD BE SMUGGLED IN. If one is wanted,
   * the honest shape is a separate, explicitly-owned pass that RETIRES these rows
   * under a value that admits what happened — which is a migration, a CHECK change
   * and a decision about reversibility, i.e. its own change with its own review.
   */
  const notSuperseded = sql`NOT EXISTS (
               SELECT 1
                 FROM approvals s
                WHERE s.card_id = a.card_id
                  AND s.created_at > a.created_at
                  AND s.status IN ('approved', 'expired', 'voided', 'rejected')
                  -- ⛔ AND THE SIBLING MUST STILL BE ABLE TO ACT. Read the docblock:
                  -- delivered = it already drove the card; resolution IS NULL = it is
                  -- still a candidate and will. A sibling that is neither STRANDS the
                  -- card, because candidateWhereBase excludes a resolved row forever.
                  AND (
                        s.callback_delivered_at IS NOT NULL
                     OR (s.callback_resolution IS NULL AND ${notAnUnroutableVoidFor('s')})
                      )
             )`;

  const candidateWhere = sql`${candidateWhereBase} AND ${notShadowedByOpenGate} AND ${notARejectedHold} AND ${notAnUnroutableVoid} AND ${notSuperseded}`;

  /**
   * The fresh/stale boundary, written ONCE and used in BOTH directions.
   *
   * ⛔ THE TWO LANES MUST PARTITION THE POPULATION, NOT OVERLAP IT. `isFresh` is
   * the fast lane's admission test and `NOT (isFresh)` is the backlog's, so every
   * candidate is in exactly one lane on every tick. Overlap would mean the same
   * row read twice and — worse — SENT twice in one tick against a receiver the
   * header records as non-idempotent, i.e. one card moved twice. Deriving the
   * backlog clause by negating this expression rather than by writing a second
   * comparison is what makes "exactly one lane" an identity instead of a claim
   * about two hand-written inequalities agreeing.
   *
   * `completed_at IS NULL` is FALSE here and therefore lands in the backlog —
   * correct: a row with no decision timestamp is not a recent decision.
   */
  const isFresh = sql`(
               a.completed_at IS NOT NULL
           AND a.completed_at > now() - (${FRESH_WINDOW_MS / 1000} * interval '1 second')
             )`;

  /**
   * The projection, WRITTEN ONCE for both lanes.
   *
   * ⚠️ NO JOIN TO `projects`, AND NO `metadata->>'boardId'`. Both were added on
   * 2026-09-07 to feed a board gate and both were deleted the same day — see
   * "FOUR DISCRIMINATORS WERE TRIED" at `applyStrikes`. Re-adding either means
   * re-adding that gate; read the proof there first.
   *
   * ⛔ ONE FRAGMENT, TWO LANES — the same rule the predicate above follows, for
   * the same reason. `CandidateRow` is what `describeSendExhaustion` reads, so a
   * column present in one lane's SELECT and missing from the other would make a
   * row's exhaustion BLAME depend on which lane happened to find it.
   */
  const candidateColumns = sql`
      a.id, a.card_id, a.callback_acked_at, a.callback_unreadable_reads,
      a.callback_unreadable_first_at, a.callback_send_attempts,
      -- ⭐ #1104. Read for ONE reason: so clearReadFailureRuns can skip the UPDATE
      -- on a row that has no run to clear. Nothing branches on them, and the
      -- retirement test is evaluated in SQL inside recordDegraded so the count,
      -- the clock and the threshold cannot disagree under concurrency.
      a.callback_degraded_reads, a.callback_degraded_first_at,
      -- ⭐ The exhaustion discriminator. See CandidateRow for why these are
      -- NOT the board columns the note above deletes: no join, no Planka
      -- probe, and nothing in the scan branches on them.
      a.metadata->>'deblock_action'            AS deblock_action,
      a.metadata->>'doingListId'               AS doing_list_id,
      a.metadata->>'todoListId'                AS todo_list_id,
      a.metadata->>'advance_phase_on_approve'  AS advance_phase_on_approve,
      a.kind::text                             AS approval_kind,
      -- ⭐ MERGE-QUEUE fr row 12 — inputs to the signoff refusals only.
      a.status::text                           AS approval_status,
      a.callback_path,
      a.created_at                             AS approval_created_at`;

  const rowsOf = (rows: unknown): CandidateRow[] =>
    Array.isArray(rows) ? (rows as CandidateRow[]) : [];

  /**
   * ⭐ THE FAST LANE. Decisions made within FRESH_WINDOW_MS, read AHEAD of the
   * backlog walk and delivered FIRST.
   *
   * ⛔ NO `OFFSET`, AND THAT IS THE POINT. The backlog's offset is what makes a
   * new row wait ~11 ticks for the rotating cursor to arrive at it; this lane has
   * no cursor at all, so a decision made 30 seconds ago is read on the very next
   * tick — a bounded ≤900 s instead of an unbounded ≈2.7 h.
   *
   * ⚠️ `ORDER BY completed_at DESC` — NEWEST FIRST, and the trade-off is real
   * rather than free. It guarantees the property the lane exists to buy: the
   * FRESHEST failure is always looked at first, which is what a live demo needs.
   * The cost is that, in the (measured-rare) case of more than FAST_LANE_READS
   * decisions inside one window, the OLDER fresh rows are deferred. ⭐ THE
   * DEGRADATION IS BOUNDED AND IS NEVER WORSE THAN TODAY: such a row ages out of
   * the window and rejoins the backlog walk — i.e. exactly the behaviour every
   * row has right now. Nothing regresses; only the newest rows are lifted.
   * (An ASC ordering would flip both halves: the oldest fresh row always first,
   * and a burst could push the 30-second-old row out past the window. Given the
   * lane exists FOR the 30-second-old row, DESC is the ordering that matches its
   * purpose.)
   */
  const selectFreshCandidates = async (exec: typeof defaultDb): Promise<CandidateRow[]> => {
    const rows = await exec.execute<CandidateRow>(sql`
      SELECT ${candidateColumns}
        FROM approvals a
        ${candidateWhere}
         AND ${isFresh}
       ORDER BY a.completed_at DESC
       LIMIT ${FAST_LANE_READS}
    `);
    return rowsOf(rows);
  };

  /**
   * THE BACKLOG WALK — unchanged in every respect that the coverage argument
   * rests on: same `ORDER BY a.completed_at NULLS LAST`, same
   * `LIMIT MAX_READS_PER_RUN`, same rotating `OFFSET`, so `seedScanOffset`'s
   * page grid and `advanceScan`'s wrap are exactly what they were.
   *
   * ⛔ THE ONLY CHANGE IS `AND NOT (isFresh)` — THE COMPLEMENT OF THE FAST LANE,
   * derived from the same expression rather than written a second time. This is
   * what keeps the two lanes disjoint: without it a fresh row could be returned
   * by BOTH queries and sent for TWICE in one tick, and the receiver does not
   * dedupe (see the header) — one card moved twice.
   *
   * ⚠️ IT SHRINKS THE BACKLOG POPULATION BY AT MOST FAST_LANE_READS ROWS AT A
   * TIME, and those rows are not lost: they re-enter this lane the moment they
   * age past FRESH_WINDOW_MS. The seed is computed over `visible`, which still
   * counts them, so the page count can be over-estimated by at most one page —
   * absorbed by `advanceScan`'s short-scan wrap, which is what it is for.
   */
  const selectBacklogCandidates = async (
    exec: typeof defaultDb,
    offset: number,
  ): Promise<CandidateRow[]> => {
    const rows = await exec.execute<CandidateRow>(sql`
      SELECT ${candidateColumns}
        FROM approvals a
        ${candidateWhere}
         AND NOT ${isFresh}
       ORDER BY a.completed_at NULLS LAST
       LIMIT ${MAX_READS_PER_RUN}
      OFFSET ${offset}
    `);
    return rowsOf(rows);
  };

  /**
   * ⭐ #1034 — ONE PASS, TWO NUMBERS. How many rows the predicate matches right
   * now (`visible`), and how many the shadow clause WITHHELD (`shadowed`).
   *
   * ⛔ WHY THIS IS ONE QUERY AND NOT TWO. The obvious implementation is a second
   * `SELECT COUNT(*) … WHERE base AND EXISTS(pending)`, which evaluates the base
   * predicate a SECOND time on every tick. `COUNT(*) FILTER (WHERE …)` gets both
   * numbers from a SINGLE pass over the base population instead, and it consumes
   * `notShadowedByOpenGate` as a fragment, so the clause the scan applies and the
   * clause the census measures cannot disagree.
   *
   * ⚠️ AND IT IS HONESTLY MORE WORK THAN BEFORE, WHICH IS WORTH STATING RATHER
   * THAN HIDING. This replaced `countCandidates`, which ran at most ONCE per
   * process (only when the cursor was un-seeded). `shadowed` has to be measured
   * on the tick it is printed on — a number carried over from process start is
   * exactly the kind of stale figure this file keeps correcting — so the census
   * now runs once per tick.
   *
   * ⛔ AN EARLIER DRAFT OF THIS COMMENT JUSTIFIED THAT AS "against a scan that
   * already makes Postgres evaluate the same predicate set because of its
   * `OFFSET n`". THAT WAS FALSE, and it was false by construction rather than by
   * degree. MEASURED with EXPLAIN ANALYZE on a prod-shaped set (453 base rows,
   * 400 pending gates):
   *
   *     the scan                 :  2.7 ms /    87 buffers
   *     this census              : 27.4 ms / 5,520 buffers
   *
   * — 10x the time and 63x the buffers, because `COUNT(*) FILTER (WHERE NOT
   * EXISTS …)` CANNOT be pulled up into the anti-join the scan gets; it stays a
   * correlated SubPlan, one index search per base row. The old `countCandidates`
   * did get the anti-join (2.2 ms / 84 buffers) and ran once per PROCESS.
   *
   * It scales O(base x pending-index-size) because there is no
   * `approvals(card_id)` index: the only candidate,
   * `approvals_one_open_gate_per_card_idx (tenant_id, card_id) WHERE
   * status='pending'`, has its leading column unbound here. At 3,000 base rows
   * and 2,500 gates the census measures ~456 ms / 36k buffers.
   *
   * ⇒ 27 ms once every 900 s is affordable and this ships. But the honest
   * statement is "a correlated subplan we are choosing to pay for", NOT "free
   * because the scan does it anyway". If the base population grows an order of
   * magnitude, add the index or bind `tenant_id` into the NOT EXISTS — the
   * latter also closes a pre-existing cross-tenant shadowing defect (a pending
   * gate in tenant B currently shadows tenant A's row on the same `card_id`),
   * which is filed separately rather than smuggled into this change.
   *
   * ⛔ IT CANNOT BE FOLDED INTO THE SCAN, AND THAT WAS TRIED FIRST. The scan's
   * OFFSET is `seedScanOffset(nowMs, visible)` on an un-seeded cursor, so the
   * census has to have ANSWERED before the scan can be written — a CTE sharing
   * one pass is circular for exactly the tick that needs it. Sharing the pass the
   * other way (materialising the base set in a CTE the scan then pages) would
   * also disable the LIMIT push-down on the hot query. One small aggregate is the
   * cheaper of the two honest options.
   */
  const censusCandidates = async (
    exec: typeof defaultDb,
  ): Promise<{
    visible: number;
    shadowed: number;
    rejectedHeld: number;
    voidedUnroutable: number;
    superseded: number;
  }> => {
    const rows = await exec.execute<{
      visible: number | string;
      shadowed: number | string;
      rejected_held: number | string;
      voided_unroutable: number | string;
      superseded: number | string;
    }>(sql`
      SELECT COUNT(*) FILTER (
               WHERE ${notShadowedByOpenGate} AND ${notARejectedHold}
                 AND ${notAnUnroutableVoid} AND ${notSuperseded}
             )                                                AS visible,
             -- ⚠️ COUNTED EXPLICITLY, NOT DERIVED AS \`total - visible\` ANY MORE.
             -- With TWO exclusion clauses a subtraction would silently mean
             -- "shadowed OR rejected-held", and a row that is BOTH would be
             -- counted once against whichever number the arithmetic happened to
             -- attribute it to. Explicit FILTERs over the same single pass keep the
             -- populations separable. ⚠️ THE SECOND HALF OF THIS NOTE USED TO SAY THEY
             -- SHOULD "OVERLAP HONESTLY" AND THAT IS NO LONGER WHAT THEY DO -- see the
             -- marginal-counting block below, and the prod measurement that forced it.
             -- ⭐ MARGINAL, IN candidateWhere'S OWN ORDER. Each row is counted
             -- under the FIRST fragment that excludes it and under no other, so the
             -- five numbers PARTITION the base population:
             --   visible + shadowed + rejected_held + voided_unroutable + superseded
             --     = COUNT(*) over candidateWhereBase, exactly.
             --
             -- ⛔ CORRECTED — THE INDEPENDENT FORM WAS DOUBLE-COUNTING AND THE
             -- CONSEQUENCE WAS MEASURED ON PROD. Each FILTER used to test its own
             -- fragment alone, so a row excluded by several clauses was reported under
             -- every one of them. Live reading: superseded=253 against a TRUE
             -- marginal suppression of 45, with 162 of those 253 ALSO inside
             -- shadowed=506. A reader cannot act on that: the headline number for
             -- this clause was 5.6x its real effect, and the overlap was invisible.
             --
             -- ⚠️ WHAT THIS GIVES UP, STATED RATHER THAN HIDDEN. The note below used
             -- to argue for independent FILTERs so the populations could "overlap
             -- honestly". That argument was against DERIVING a count by subtraction
             -- (total - visible), and that refusal still stands — every number here
             -- is its own explicit FILTER over the same single pass, nothing is
             -- subtracted. What changes is the question each answers: rejected_held
             -- is now "rows the rejected-hold clause is the REASON for", not "rows that
             -- are rejected holds". The total-population question ("how many rows carry
             -- a pending gate at all?") is no longer readable off the log and must be
             -- asked in SQL. That trade is deliberate: a per-tick log is read to decide
             -- WHICH clause to go and look at, and for that the marginal number is the
             -- only correct one.
             --
             -- ⚠️ THE ORDER IS NOT ARBITRARY AND MUST TRACK candidateWhere. It is the
             -- order the fragments are composed in above. Reordering one without the
             -- other silently re-attributes rows between the counters while every test
             -- that exercises a single exclusion stays green.
             COUNT(*) FILTER (WHERE NOT (${notShadowedByOpenGate}))  AS shadowed,
             COUNT(*) FILTER (
               WHERE ${notShadowedByOpenGate} AND NOT (${notARejectedHold})
             )                                                       AS rejected_held,
             -- ⭐ #1089. THIRD INDEPENDENT FILTER, for the reason the note above
             -- gives about the second: with three exclusion clauses a subtraction
             -- would collapse them into "withheld for SOME reason", and these three
             -- populations send a reader to three different files. Counted over the
             -- same single pass, and free to overlap honestly with the other two.
             COUNT(*) FILTER (
               WHERE ${notShadowedByOpenGate} AND ${notARejectedHold}
                 AND NOT (${notAnUnroutableVoid})
             )                                                       AS voided_unroutable,
             -- ⭐ #1144. FOURTH INDEPENDENT FILTER, for the reason the two notes above
             -- give: a subtraction would collapse four exclusions into "withheld for SOME
             -- reason", and these four send a reader to four different places. It is
             -- ALSO the only visibility this clause gets -- #1144 is deliberately a
             -- FILTER and writes no callback_resolution (see notSuperseded), so a row it
             -- withholds leaves NO trace on the row itself. Without this count the
             -- population would be invisible in exactly the way shadowed was: 452 rows
             -- behind a candidates=1 that read as a drained queue.
             COUNT(*) FILTER (
               WHERE ${notShadowedByOpenGate} AND ${notARejectedHold}
                 AND ${notAnUnroutableVoid} AND NOT (${notSuperseded})
             )                                                       AS superseded
        FROM approvals a
        ${candidateWhereBase}
    `);
    const row = Array.isArray(rows) && rows.length > 0 ? rows[0]! : undefined;
    const num = (raw: number | string | undefined): number => {
      const n = typeof raw === 'number' ? raw : Number(raw ?? 0);
      return Number.isFinite(n) ? n : 0;
    };
    // ⚠️ THE SECOND SUBPLAN, STATED RATHER THAN HIDDEN. `notShadowedByOpenGate`
    // is the correlated `NOT EXISTS` measured at 27.4 ms / 5,520 buffers (see the
    // docblock above); it now appears in TWO filters, and Postgres is not obliged
    // to evaluate it once per row. Worst case this census costs ~55 ms, once per
    // 900 s tick. That is affordable and it ships — but the honest statement is
    // "a correlated subplan we are choosing to pay for TWICE", not "free".
    return {
      visible: num(row?.visible),
      shadowed: num(row?.shadowed),
      rejectedHeld: num(row?.rejected_held),
      voidedUnroutable: num(row?.voided_unroutable),
      superseded: num(row?.superseded),
    };
  };

  /**
   * The scan window rotates every tick.
   *
   * The seed is computed lazily rather than at module load because it needs the
   * population size, i.e. a db handle — and doing it here means it runs inside
   * the advisory lock on the production path, so two replicas cannot seed off
   * two different counts in the same instant.
   */
  const resolveOffset = async (exec: typeof defaultDb): Promise<number> => {
    // ⭐ #1034. The census runs on EVERY tick, because `shadowed` is a property
    // of the tick that prints it, not of the tick that seeded the cursor.
    const census = await censusCandidates(exec);
    result.shadowed = census.shadowed;
    // ⭐ Same rule, one exclusion over: the rejected-hold set is a property of the
    // tick that PRINTS it.
    result.rejectedHeld = census.rejectedHeld;
    // ⭐ Same rule, one exclusion further over.
    result.voidedUnroutable = census.voidedUnroutable;
    // ⭐ #1144. Same rule, one exclusion further over.
    result.superseded = census.superseded;
    if (scanOffset === null) scanOffset = seedScanOffset(nowMs, census.visible);
    return scanOffset;
  };

  /**
   * Resolve a card to the NAME of the list it is in right now, or THROW.
   *
   * ⛔ IT NEVER RETURNS null, AND THAT IS THE FIX FOR A DEFECT THIS WORKER
   * SHIPPED WITH. It used to return null whenever `detail.item.listId` was falsy
   * or `list.name` was null — its own comment called that "deleted, 404, Planka
   * down". But a null RETURN takes the happy path: it walks past the catch that
   * counts a strike, satisfies `!isBlockedList(null)`, and reaches `resolveRow`.
   * For any row already acked (i.e. every row we have ever sent for) that writes
   * `callback_resolution = 'moved'` AND `callback_delivered_at = now()` — an
   * affirmative claim that the card left BLOCKED, manufactured out of a read
   * that returned NOTHING. On origin/main the same null merely incremented
   * `notBlocked` and the row was retried next tick; the regression was mine.
   *
   * A read that produced no answer is UNREADABLE. It is now a throw, so there is
   * exactly one path out of here for "we do not know", and it is the strike
   * path.
   *
   * ⛔ AND NOTHING FAILING IS EVER CACHED. `listNameCache` memoises SUCCESSFUL
   * names only. Caching a null was an amplifier: one degraded `lists.get`
   * answered for every subsequent row on that list, so a single bad read could
   * retire EVERY candidate on the BLOCKED list in one tick — the blast radius of
   * a blip multiplied by the size of the backlog. The cache exists to spare
   * Planka reads on the happy path (a backlog is overwhelmingly one board's
   * BLOCKED list, so it is ~1 read + 1 per distinct list); a failure is not a
   * fact worth remembering, and re-reading it costs one call per row for as long
   * as Planka is unwell, which is the correct trade.
   */
  const listNameCache = new Map<string, string>();
  /**
   * ⭐ #1104 — THE CROSS-ROW TERM'S EVIDENCE, GATHERED FOR FREE.
   *
   * How many times THIS TICK `GET /api/cards/:id` came back 200 carrying a listId.
   * One of these is positive proof that the base URL, the agent token, the route and
   * the card path all work right now — so an answerless read on some OTHER row in
   * the same tick is a property of that row rather than of Planka, and may be
   * charged a degraded strike. Zero of them means the tick has no standing to charge
   * anything. See `applyDegradedStrikes`.
   *
   * ⛔ IT IS NOT `result.successfulReads`, AND THE DIFFERENCE IS THE WHOLE FIX.
   * That counter is incremented only when the LIST name was also resolved, which is
   * exactly what the #1104 population never achieves — all 18 measured rows read
   * their card 200 and then 404 on an archived list, so `successful_reads` printed 0
   * on every tick. Keying the new bound on it would have made the fix INERT in the
   * one condition it was written for, which is the trap this file names elsewhere
   * ("a guarantee that holds in the happy path and fails in the condition it was
   * written for is worse than no guarantee").
   *
   * ⚠️ A 200 WITH NO `listId` DOES NOT COUNT, DELIBERATELY. It is the one 200 whose
   * body may not be Planka's at all (a proxy error page parses to no `item`), so
   * treating it as proof of health would arm the bound on the weakest evidence
   * available. ⛔ THE RESIDUAL, STATED RATHER THAN HIDDEN: a tick whose ONLY
   * candidate reads 200-with-no-listId charges nothing and that row never retires.
   * It is the same shape of exposure the breaker's `<BREAKER_MIN_READS` tail has,
   * and it fails in the safe direction — a row left as a candidate, not a row
   * retired on evidence nobody gathered.
   */
  let cardReadsOk = 0;
  /** ⭐ MERGE-QUEUE fr row 12. cardId → boardId from this tick's own card reads. */
  const cardBoardIds = new Map<string, string>();
  const currentListName = async (cardId: string): Promise<string> => {
    let detail: Awaited<ReturnType<ReturnType<typeof planka.asAgent>['cards']['get']>> | undefined;
    try {
      detail = await planka.asAgent().cards.get(cardId);
    } catch (err) {
      // ⭐ THE ONLY CALL SITE THAT MAY PRODUCE A STRIKE, and it says so by
      // passing the card's own read path. See `classifyReadFailure`.
      // ⭐ #1104: labelled `card_read` — the CALLER knows which read it made, and
      // `classifyReadFailure` cannot. The label changes no verdict; see
      // `withDegradedCause`.
      throw withDegradedCause(
        classifyReadFailure(err, `card ${cardId}`, cardReadPath(cardId), cardId),
        'card_read',
      );
    }
    const listId = detail?.item?.listId ?? null;
    // ⭐ MERGE-QUEUE fr row 12. Remembered from the read we ALREADY made, so the
    // signoff tenant refusal costs no extra Planka call. Absent ⇒ the refusal
    // defers rather than guessing a tenant.
    const boardId = (detail?.item as { boardId?: unknown } | undefined)?.boardId;
    if (typeof boardId === 'string' && boardId) cardBoardIds.set(cardId, boardId);
    else cardBoardIds.delete(cardId);
    // A 200 with no listId is Planka answering without answering. It is NOT
    // "the card is in no list, therefore not blocked".
    if (!listId) {
      throw new CardReadFailure(
        'degraded',
        `card ${cardId} came back with no listId`,
        undefined,
        'empty_read',
      );
    }
    // ⭐ #1104. Planka answered 200 and named a list: the card path demonstrably
    // works. Counted HERE, before the list read, precisely because the measured
    // population fails AFTER this point — see `cardReadsOk`.
    cardReadsOk += 1;
    const cached = listNameCache.get(listId);
    if (cached !== undefined) return cached;
    let list: Awaited<ReturnType<ReturnType<typeof planka.asAgent>['lists']['get']>> | undefined;
    try {
      list = await planka.asAgent().lists.get(listId);
    } catch (err) {
      // ⛔ NO `definitivePath` — DELIBERATELY, AND THIS IS NOT AN OMISSION.
      // We only get here because `cards.get` returned 200 WITH a listId, i.e.
      // Planka has just told us the card EXISTS. Whatever `/api/lists/:id`
      // answers — 404 included — cannot be evidence that the card is deleted.
      // Passing a path here would re-open the defect: a deleted LIST would
      // retire every approval whose card pointed at it.
      throw withDegradedCause(
        classifyReadFailure(err, `list ${listId} of card ${cardId}`),
        'list_read',
      );
    }
    const name = list?.name ?? null;
    if (!name) {
      throw new CardReadFailure(
        'degraded',
        `list ${listId} came back with no name`,
        undefined,
        'empty_read',
      );
    }
    listNameCache.set(listId, name);
    return name;
  };

  /**
   * ⚠️ DELETED HERE 2026-09-07: `canReadBoard` (`GET /api/boards/:id`, memoised)
   * and `knownBoardIds` (one `GET /api/projects` per tick, the estate-wide board
   * list). They implemented a board gate that turns out to be a NO-OP — see
   * "FOUR DISCRIMINATORS WERE TRIED" at `applyStrikes`. The measurements they
   * carried are preserved there; nothing else about them is worth keeping.
   */

  // ⚠️ EVERY WRITE BELOW GOES THROUGH `db`, NEVER THROUGH THE TICK'S `tx`. Same
  // reason `deliverDecisionCallback` is handed `{ db }`: a later row throwing
  // must not roll back an earlier row's terminal state and re-select it forever.

  /**
   * Retire a row. `moved` is the ONLY resolution that also stamps
   * `callback_delivered_at`, which since 113 means "the card actually left
   * BLOCKED" — see the header. The other three retire the row WITHOUT claiming a
   * delivery, which is the whole point of them being separate values.
   *
   * ⛔ `moved` MAY ONLY BE PASSED WHERE A REAL LIST NAME WAS READ. It is an
   * affirmative claim about the world, and `currentListName` throws rather than
   * returning null precisely so a read that produced nothing can never reach
   * here as one.
   */
  const resolveRow = async (id: string, resolution: CallbackResolution): Promise<void> => {
    await db.execute(sql`
      UPDATE approvals
         SET callback_resolution = ${resolution},
             callback_resolved_at = now(),
             callback_delivered_at = ${resolution === 'moved' ? sql`now()` : sql`callback_delivered_at`},
             updated_at = now()
       WHERE id = ${id}::uuid
    `);
  };

  /**
   * ⭐ MERGE-QUEUE fr row 12 — THE SIGNOFF REFUSALS. Run for an APPROVED row on
   * `execution-ready-signoff-callback`, AFTER the live gate has seen the card in
   * BLOCKED and BEFORE anything is sent.
   *
   * Why: the signoff receiver moves a card to DOING from ANY list on a late
   * approval. "The card is in BLOCKED now" is therefore not enough — a card the
   * approval was raised on can leave BLOCKED, and a QA verdict can BLOCK it again;
   * re-sending the old approval would free a card QA just blocked. The same refusal
   * the ncn receiver is gaining, applied on fr's own re-send path.
   *
   *   • tenant not in PLATFORM_TENANT_IDS      → retire `card_tenant_not_platform`
   *   • journey shows a move OUT of BLOCKED at
   *     or after the approval's created_at      → retire `card_left_blocked_since_approval`
   *   • journey or tenant cannot be established → DEFER: not sent, not retired, logged
   *   • otherwise                               → proceed (send exactly as before)
   *
   * ⛔ UNKNOWN IS NEVER "STAYED". An unreadable action log, a page window that does
   * not reach back to `created_at`, a move with no timestamp or no from-list name —
   * each is a defer, never a send and never a retirement. A retirement is permanent
   * (`callback_resolution IS NULL` is a candidate clause), so it is written only on
   * evidence actually read.
   */
  const SIGNOFF_JOURNEY_MAX_PAGES = 5;
  const resolveTenant = (boardId: string) => resolveBoardTenant(boardId, db);
  type SignoffVerdict =
    | { verdict: 'proceed' }
    | { verdict: 'retire'; resolution: 'card_left_blocked_since_approval' | 'card_tenant_not_platform'; detail: string }
    | { verdict: 'defer'; reason: string };
  const isSignoffApproval = (row: CandidateRow): boolean =>
    row.approval_status === 'approved' &&
    typeof row.callback_path === 'string' &&
    row.callback_path.replace(/^\/+/, '') === SIGNOFF_CALLBACK_PATH;
  /**
   * Read the card's Planka action log back to the approval's `created_at`. Planka
   * pages it (`beforeId`, newest first), so ONE page is not "the history": the
   * window is covered only once a `createCard` action is seen or the oldest action
   * read is at or before `createdAtMs`. Returns null when it never gets there.
   */
  const loadActionsSince = async (cardId: string, createdAtMs: number): Promise<RawCardAction[] | null> => {
    // Paging is the card GET's own (`readCardActionHistory`), so this check and the
    // `phase_journey` ncn reads see the same pages. A page is "enough" once it holds
    // an undatable action (→ null below) or reaches back to `createdAtMs`.
    const pageReachesWindowOrIsUndatable = (items: RawCardAction[]): boolean =>
      items.some((a) => {
        const ms = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
        return Number.isNaN(ms) || ms <= createdAtMs;
      });
    const history = await readCardActionHistory(
      (beforeId) => loadCardActionsViaPlanka(planka.asAgent(), cardId, beforeId),
      { maxPages: SIGNOFF_JOURNEY_MAX_PAGES, stopWhen: pageReachesWindowOrIsUndatable },
    );
    const all = history.actions;
    if (all.length === 0) return null;
    if (all.some((a) => a.type === 'createCard')) return all;
    let oldestMs = Number.POSITIVE_INFINITY;
    for (const a of all) {
      const ms = a.createdAt ? Date.parse(a.createdAt) : Number.NaN;
      if (Number.isNaN(ms)) return null;
      if (ms < oldestMs) oldestMs = ms;
    }
    return oldestMs <= createdAtMs ? all : null;
  };
  const checkSignoffRefusals = async (row: CandidateRow, cardId: string): Promise<SignoffVerdict> => {
    // 1. Tenant. The boardId comes from the card read the live gate just made.
    const boardId = cardBoardIds.get(cardId);
    if (!boardId) return { verdict: 'defer', reason: 'card read carried no boardId; tenant unknown' };
    let tenant: string | null;
    try {
      tenant = await resolveTenant(boardId);
    } catch (err) {
      return { verdict: 'defer', reason: `tenant lookup failed: ${errMessage(err)}` };
    }
    if (!isPlatformTenant(tenant)) {
      return {
        verdict: 'retire',
        resolution: 'card_tenant_not_platform',
        detail: `board ${boardId} resolves to tenant ${tenant ?? 'NONE'}, not a platform tenant`,
      };
    }
    // 2. Journey since the approval was created.
    const createdAtMs = row.approval_created_at ? new Date(row.approval_created_at).getTime() : Number.NaN;
    if (Number.isNaN(createdAtMs)) return { verdict: 'defer', reason: 'approval created_at unreadable' };
    let actions: RawCardAction[] | null;
    try {
      actions = await loadActionsSince(cardId, createdAtMs);
    } catch (err) {
      return { verdict: 'defer', reason: `card actions unreadable: ${errMessage(err)}` };
    }
    if (actions === null) {
      return { verdict: 'defer', reason: 'card action log does not reach back to the approval created_at' };
    }
    for (const t of buildPhaseJourney(actions)) {
      if (t.type !== 'moveCard') continue;
      const atMs = t.at ? Date.parse(t.at) : Number.NaN;
      if (Number.isNaN(atMs)) return { verdict: 'defer', reason: `move ${t.action_id} has no timestamp` };
      if (atMs < createdAtMs) continue;
      if (t.from_list === null) return { verdict: 'defer', reason: `move ${t.action_id} has no from-list name` };
      if (isBlockedList(t.from_list) && !isBlockedList(t.to_list)) {
        return {
          verdict: 'retire',
          resolution: 'card_left_blocked_since_approval',
          detail: `moved ${t.from_list} → ${t.to_list ?? '?'} at ${t.at}, after the approval was created`,
        };
      }
    }
    return { verdict: 'proceed' };
  };

  /**
   * Count one DEFINITIVE miss, and retire the row only once the run reaches
   * UNREADABLE_STRIKES *and* spans UNREADABLE_MIN_SPAN_MS. One statement so the
   * increment, the clock and the threshold test cannot disagree under
   * concurrency — and so `callback_unreadable_first_at` is set by the same write
   * that makes the first strike, never by a second one that could be skipped.
   *
   * ⛔ ONLY EVER CALLED FOR A 'gone' FAILURE. A degraded read must not reach
   * here: see `classifyReadFailure` and the call site.
   *
   * ⚠️ THE WALL-CLOCK TERM READS THE *EXISTING* first_at, not the coalesced one.
   * `COALESCE(callback_unreadable_first_at, now())` is now() on the first strike,
   * so `<= now() - span` is false — a row can never be retired by the same write
   * that opens its run, however large the strike count already was.
   */
  const recordUnreadable = async (id: string): Promise<boolean> => {
    const rows = await db.execute<{ callback_resolution: string | null }>(sql`
      UPDATE approvals
         SET callback_unreadable_reads = callback_unreadable_reads + 1,
             callback_unreadable_first_at = COALESCE(callback_unreadable_first_at, now()),
             callback_resolution = CASE
               WHEN callback_unreadable_reads + 1 >= ${UNREADABLE_STRIKES}
                AND COALESCE(callback_unreadable_first_at, now())
                    <= now() - (${UNREADABLE_MIN_SPAN_MS / 1000} * interval '1 second')
               THEN 'card_unreadable' ELSE callback_resolution END,
             callback_resolved_at = CASE
               WHEN callback_unreadable_reads + 1 >= ${UNREADABLE_STRIKES}
                AND COALESCE(callback_unreadable_first_at, now())
                    <= now() - (${UNREADABLE_MIN_SPAN_MS / 1000} * interval '1 second')
               THEN now() ELSE callback_resolved_at END,
             updated_at = now()
       WHERE id = ${id}::uuid
      RETURNING callback_resolution
    `);
    const list = Array.isArray(rows) ? (rows as { callback_resolution: string | null }[]) : [];
    return list[0]?.callback_resolution === 'card_unreadable';
  };

  /**
   * ⭐ #1104. Count one ANSWERLESS read, and retire the row only once the run reaches
   * DEGRADED_STRIKES *and* spans DEGRADED_MIN_SPAN_MS.
   *
   * ⛔ IT IS `recordUnreadable`'S SHAPE, NOT ITS COLUMNS, AND THE SEPARATION IS THE
   * POINT. One statement, so the increment, the clock and the threshold test cannot
   * disagree under concurrency, and so `callback_degraded_first_at` is set by the
   * same write that makes the first strike. But it touches ONLY the two `degraded`
   * columns and it can write ONLY `read_degraded` — it can never produce
   * `card_unreadable`, which still means what it always meant: Planka answered 404
   * on the card's own read path.
   *
   * ⛔ ONLY EVER CALLED FROM `applyDegradedStrikes`, i.e. only for a 'degraded'
   * failure AND only on a tick that read some other card successfully. Calling it
   * from the read site would delete the cross-row guard, which is the only term that
   * can see the difference between one unreadable card and an unwell Planka.
   *
   * ⚠️ THE WALL-CLOCK TERM READS THE *EXISTING* first_at, not the coalesced one —
   * same construction, and same reason, as `recordUnreadable`:
   * `COALESCE(callback_degraded_first_at, now())` is now() on the first strike, so
   * `<= now() - span` is false and a row can never be retired by the same write that
   * opens its run, however large the count already was.
   */
  const recordDegraded = async (id: string): Promise<boolean> => {
    const rows = await db.execute<{ callback_resolution: string | null }>(sql`
      UPDATE approvals
         SET callback_degraded_reads = callback_degraded_reads + 1,
             callback_degraded_first_at = COALESCE(callback_degraded_first_at, now()),
             callback_resolution = CASE
               WHEN callback_degraded_reads + 1 >= ${DEGRADED_STRIKES}
                AND COALESCE(callback_degraded_first_at, now())
                    <= now() - (${DEGRADED_MIN_SPAN_MS / 1000} * interval '1 second')
               THEN 'read_degraded' ELSE callback_resolution END,
             callback_resolved_at = CASE
               WHEN callback_degraded_reads + 1 >= ${DEGRADED_STRIKES}
                AND COALESCE(callback_degraded_first_at, now())
                    <= now() - (${DEGRADED_MIN_SPAN_MS / 1000} * interval '1 second')
               THEN now() ELSE callback_resolved_at END,
             updated_at = now()
       WHERE id = ${id}::uuid
      RETURNING callback_resolution
    `);
    const list = Array.isArray(rows) ? (rows as { callback_resolution: string | null }[]) : [];
    return list[0]?.callback_resolution === 'read_degraded';
  };

  /**
   * CONSECUTIVE means consecutive: any read that RESOLVED THE CARD'S LIST clears both
   * runs — the definitive-miss run and the answerless run — count and clock alike.
   *
   * ⚠️ RENAMED FROM `clearUnreadableStrikes` (#1104) BECAUSE IT NOW CLEARS TWO RUNS.
   * The old name would have been a lie about half of what it does, and this file's
   * standing complaint about itself is names and comments that outlive their code.
   *
   * ⛔ THE CLEAR POINT IS UNCHANGED AND MUST STAY THE FULL READ. It is called only
   * where `currentListName` RETURNED a name — Planka answered about the card AND
   * about its list. A card read that succeeds and a list read that then fails is NOT
   * a success and must not clear anything, which is exactly the shape of the #1104
   * population: clearing on the card read alone would reset the run on every tick and
   * make the new bound unreachable.
   *
   * ⚠️ A DEGRADED READ CLEARS NOTHING AND COUNTS NOTHING *HERE*. It is not a success
   * (so it cannot end a run of real misses) and it is not evidence about the card (so
   * it cannot extend one). It leaves the unreadable run exactly as it found it; its
   * own run is advanced later, by `applyDegradedStrikes`, once the tick's evidence is
   * in.
   */
  const clearReadFailureRuns = async (row: CandidateRow): Promise<void> => {
    if (
      !row.callback_unreadable_reads &&
      !row.callback_unreadable_first_at &&
      !row.callback_degraded_reads &&
      !row.callback_degraded_first_at
    ) {
      return;
    }
    await db.execute(sql`
      UPDATE approvals
         SET callback_unreadable_reads = 0,
             callback_unreadable_first_at = NULL,
             callback_degraded_reads = 0,
             callback_degraded_first_at = NULL,
             updated_at = now()
       WHERE id = ${row.id}::uuid
         AND (callback_unreadable_reads <> 0 OR callback_unreadable_first_at IS NOT NULL
           OR callback_degraded_reads <> 0 OR callback_degraded_first_at IS NOT NULL)
    `);
  };

  /** One send attempt, counted before it is made. Bounded by MAX_SEND_ATTEMPTS. */
  const countSendAttempt = async (id: string): Promise<void> => {
    await db.execute(sql`
      UPDATE approvals
         SET callback_send_attempts = callback_send_attempts + 1,
             updated_at = now()
       WHERE id = ${id}::uuid
    `);
  };

  /**
   * ⭐ #1029 — GIVE BACK AN ATTEMPT FOR A SEND THAT PROVABLY NEVER HAPPENED.
   *
   * ⛔ THIS IS NOT A RETREAT FROM THE OVER-COUNTING RULE. `countSendAttempt` is
   * still called BEFORE the call and still charges every outcome where a request
   * MAY have left the process — a throw, a timeout, a socket that died
   * mid-flight. "Over-counting bounds the damage; under-counting removes the
   * bound entirely" is unchanged and must stay unchanged. Do not generalise this
   * refund to `outcome !== 'sent'`.
   *
   * ⚠️ EXACTLY ONE OUTCOME IS DIFFERENT IN KIND, and the difference is that it
   * involves NO I/O AT ALL. `services/n8n-callback.ts` returns
   * `skipped-unsupported-receiver` for a `voided` decision whose `callback_path`
   * is not in `VOIDED_CALLBACK_PATHS`: fr refuses BEFORE any request is built,
   * so there is no ambiguity about whether something was delivered, and no bound
   * is lost by not charging it — a row that cannot be sent is not being retried
   * against the receiver.
   *
   * ⛔ WHAT IT COST TO CHARGE IT. Five ticks retired such a row as
   * `send_exhausted`, and `AND a.callback_resolution IS NULL` in the candidate
   * predicate then excluded it PERMANENTLY. That directly falsified the refusal's
   * own promise one file away (`n8n-callback.ts`: the withheld rows "are still
   * there to be delivered" the day the receiver is taught `voided`) — they would
   * not have been. It also made `send_exhausted`'s own documentation
   * ("MAX_SEND_ATTEMPTS acked sends") false about the row, which had ZERO sends
   * and zero acks.
   *
   * ⚠️ BLAST RADIUS AT THE TIME OF THE FIX WAS 0 ROWS, MEASURED, and this comment
   * must not be read as a live-data-loss report. All 108 prod `send_exhausted`
   * rows were on `kanban/approval-callback`, which IS in the allowlist, so they
   * were genuinely sent. `max(callback_send_attempts)` on the at-risk path
   * (`execution-ready-signoff-callback`) was 0 in every status. This was a trap
   * armed to spring on whoever performed the recovery the refusal promises.
   *
   * The refund is a decrement, not a reset: the row may legitimately carry
   * attempts from earlier ticks that DID reach the wire. `GREATEST(…, 0)` floors
   * it rather than trusting the arithmetic.
   */
  const refundSendAttempt = async (id: string): Promise<void> => {
    await db.execute(sql`
      UPDATE approvals
         SET callback_send_attempts = GREATEST(callback_send_attempts - 1, 0),
             updated_at = now()
       WHERE id = ${id}::uuid
    `);
  };

  /**
   * ⭐ THE CIRCUIT BREAKER. Apply (or withhold) this tick's strikes once the
   * WHOLE tick's evidence is in.
   *
   * ⛔ THIS IS WHY STRIKES ARE DEFERRED RATHER THAN WRITTEN INLINE. Whether a
   * given 404 is "this card was deleted" or "Planka is 404ing everything" is not
   * knowable from that row — it is only knowable from the shape of the tick, and
   * the shape of the tick does not exist until the tick is over. Striking as we
   * went made the question unanswerable by construction.
   *
   * `verdicts` is the number of rows this tick got a DEFINITIVE ANSWER about: a
   * real list name, or a 404 on the card's OWN read path. Not
   * `result.candidates` — a tick cut short by the deadline or MAX_PER_RUN read
   * fewer rows than it selected, and the denominator must be what we measured,
   * not what we intended to measure.
   *
   * ⚠️ AND NOT EVERY READ *ATTEMPTED*, WHICH IS WHAT IT USED TO BE. CORRECTED
   * 2026-09-06. This file insists everywhere else that a 504 is "evidence about
   * Planka, not about the card" — it may not strike, and it may not clear a
   * per-row run. It is not evidence about the TICK's gone-ness either, but the
   * old denominator counted it anyway, so a degraded read DILUTED the ratio and
   * disarmed the breaker in precisely the condition the breaker exists for:
   *
   *   20 gone + 20 degraded, old: 20/40 = 0.50 < ratio → 20 wrong strikes.
   *   20 gone + 20 degraded, now: 20/20 = 1.00 ≥ ratio → breaker trips.
   *
   * ⚠️ THE DENOMINATOR IS STILL NOT THE NUMERATOR. A successful read is a
   * verdict too, so a healthy tick has a full denominator and a near-zero ratio.
   * Only reads that answered NOTHING are excluded, and they are excluded from
   * both sides.
   *
   * ⭐ AND THAT EXCLUSION SURVIVES THE 2026-09-07 CHANGE BELOW UNTOUCHED — the
   * test built on this denominator changed, the denominator did not. The worked
   * example above still reaches the same verdict under the new test: 20 gone + 20
   * degraded is 20 verdicts and ZERO successful reads, so the breaker trips.
   * Counting those 20 degraded reads as anything would break it again.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⛔ THE TEST USED TO BE `pending.length >= verdicts * 0.6` — HOW MANY CARDS
   *    WERE GONE — AND IT WAS INVERTED. CORRECTED 2026-09-07. Read this before
   *    reintroducing a gone-ratio.
   * ═══════════════════════════════════════════════════════════════════════════
   * ⚠️ THE DENOMINATOR IS UNCHANGED AND MUST STAY UNCHANGED — the paragraph above
   * is still correct and a degraded read is still counted on NEITHER side. What
   * was wrong is the PREMISE the old test rested on, printed in its own log line:
   * "A whole population does not vanish at once."
   *
   * IT DOES HERE. Every card that reads 404 is 24-85 days old against a
   * healthy-population mean of 11.3 days (n=270), clustered in two tenants and
   * minted 2026-06-14 to 2026-08-13 — Planka reaping old cards by retention, in
   * AGE ORDER. And `selectBacklogCandidates` pages `ORDER BY a.completed_at NULLS
   * LAST`, oldest first, with `advanceScan` wrapping to offset 0 on a short scan,
   * so the
   * reaped cohort is concentrated exactly in the page the breaker judges. A high
   * gone-ratio is the EXPECTED shape of a healthy tick here. Measured: it tripped
   * twice in 102 minutes (22 of 35 verdicts, then 22 of 27) while nginx served
   * Planka 2704 × 200 against 58 × 404.
   *
   * ⛔ AND WITHHOLDING IS NOT FREE, WHICH IS WHY A FALSE TRIP IS A BUG AND NOT
   * CAUTION. `recordUnreadable` is the ONLY writer of
   * `callback_resolution='card_unreadable'`, so a withheld strike leaves the row
   * NULL, still matching `candidateWhere`, re-read next tick, forever — there is
   * no age cap and no max-read cap. ~667 approved rows carry an `updated_at` up to
   * 119h after `decided_at` from exactly that loop.
   *
   * ⭐ THE REPLACEMENT IS THE AUTHOR'S OWN THREAT MODEL, TESTED DIRECTLY. That
   * log line named three failures — a lost agent token, a bad deploy, a misrouted
   * `PLANKA_BASE_URL` — and EVERY ONE OF THEM PRODUCES ZERO SUCCESSFUL CARD
   * READS. Retention does not: the two tripping ticks read 13 and 5 cards
   * correctly. A token that is lost cannot read 13 cards.
   *
   * So the discriminator was already inside the old denominator:
   *
   *   successfulReads = verdicts − pending.length
   *
   * and the breaker trips only when that is ZERO over a window of at least
   * BREAKER_MIN_READS verdicts. ⭐ ONE successful read refutes the whole class:
   * it proves the base URL, the token and the card path all work, which makes a
   * 404 on a sibling card an answer ABOUT THAT CARD, and it must strike.
   *
   * ═══════════════════════════════════════════════════════════════════════════
   * ⛔ FOUR DISCRIMINATORS WERE TRIED, 2026-09-07, AND ALL FOUR COLLAPSE TO THE
   *    SAME PREDICATE. DO NOT ADD A FIFTH PROBE — IT WILL REDUCE TO THIS ONE.
   * ═══════════════════════════════════════════════════════════════════════════
   * The question every one of them was trying to answer: when a card 404s, is it
   * DELETED or merely INVISIBLE TO US? Read out of the running
   * `registry.example.com:5000/planka-private:latest` container, not reasoned about:
   *
   *   1. THE CARD READ cannot say. `cards/show.js`:
   *        if (!boardMembership) { throw Errors.CARD_NOT_FOUND; }
   *        exits: { cardNotFound: { responseType: 'notFound' } }   // HTTP 404
   *      A live card on a board we cannot see is byte-identical to a deleted one.
   *      ⚠️ This file used to assert the opposite ("a token that lost board access
   *      answers 403") and TWO strike rules were built on that false premise.
   *   2. PROBING THE BOARD fails identically. `boards/show.js` returns 200 iff
   *      `isProjectManager(project) OR boardMembership` — the same access
   *      predicate, so a `boards.get` 404 is exactly as ambiguous. Measured: for
   *      21 of 27 deletable rows the board 404s too, because deleting a project
   *      deletes its board. "Board unreadable" is USUALLY proof the card is gone.
   *   3. ENUMERATING BOARDS fails identically. `projects/index.js` builds its list
   *      from `fullyVisibleProjectIds` (manager + shared) plus `membershipBoards`,
   *      and the admin branch `getShared` (`api/hooks/query-methods/models/Project.js:36`) has criteria
   *      `{ ownerProjectManagerId: null }` — which matches 0 of 790 projects here.
   *      So the enumeration is just the same membership set under another name:
   *      `known.has(id)` ⟺ `canReadBoard(id)`, making the withhold branch dead
   *      code and routing a genuine access loss straight to "strike".
   *   4. `role=admin` BUYS NOTHING while every project has an owner PM. Measured:
   *      agent manages 790/790 projects, is a member of 771/771 boards, and the
   *      enumeration returns 790/771 — complete by configuration, not privilege.
   *
   * ⭐ EVERY READ fr CAN MAKE OF PLANKA IS SCOPED BY THE AGENT'S OWN ACCESS, SO fr
   * CANNOT DISTINGUISH "this card is gone" FROM "I can no longer see it". Do not
   * add another probe; it will reduce to this one. What WOULD work is a signal not
   * derived from the agent's access — an admin endpoint bypassing
   * `isProjectManager`/`boardMembership`, or an authoritative deletion feed.
   *
   * ⚠️ Population figures above oscillate with ACK_GRACE_MS; two measurements a few
   * hours apart gave 97/70/27 and 100/70/30. Cite the shape, not a single number.
   *
   * ⭐ THE ACCEPTED TRADE, STATED PLAINLY RATHER THAN IMPLIED:
   *   • On a card-404 we STRIKE. That is exactly what `origin/main` does.
   *   • The pre-filter above covers TOTAL access loss (bad token, bad deploy,
   *     misrouted base URL) — every one of those reads zero cards successfully.
   *   • A PARTIAL access loss — some boards lost, others intact — will retire live
   *     rows after UNREADABLE_STRIKES misses spanning ≥UNREADABLE_MIN_SPAN_MS.
   *     ⛔ THAT EXPOSURE IS REAL. It is UNCHANGED from main rather than introduced
   *     here, and no probe available to fr closes it.
   */
  const applyStrikes = async (
    verdicts: number,
    pending: Array<{ row: CandidateRow; cardId: string }>,
  ): Promise<void> => {
    const successfulReads = verdicts - pending.length;
    result.successfulReads = successfulReads;

    // ⭐ THE WHOLE-TICK PRE-FILTER, AND THE ONLY GUARD THERE IS. Zero requests,
    // purely additive, and it catches every TOTAL-loss shape — see the block
    // above for why no per-row probe can catch a partial one.
    if (verdicts >= BREAKER_MIN_READS && successfulReads === 0) {
      result.breakerTripped = true;
      result.strikesWithheld = pending.length;
      console.error(
        `[deblock-redelivery] ⛔ BREAKER TRIPPED — ${verdicts} card reads answered, ` +
          `all ${pending.length} of them 404, and NOT ONE READ SUCCEEDED ` +
          `(window ≥${BREAKER_MIN_READS} verdicts). WITHHOLDING ALL ` +
          `${pending.length} STRIKES; no row was retired and no callback_resolution ` +
          `was written. ⚠️ THIS LINE NAMES NO CAUSE, because the tick cannot ` +
          `know one. What it says is only this: a working, correctly-routed, ` +
          `authenticated client with membership somewhere would have read at least ` +
          `one of these ${verdicts} cards, and none was read. Consistent with a ` +
          `misrouted PLANKA_BASE_URL, a bad deploy, a Planka that lost its data, or ` +
          `an agent token with no board membership left at all — the card path ` +
          `answers 404 for all of them (see classifyReadFailure). ⚠️ ALSO NOT a ` +
          `claim that a large number of 404s is itself suspicious: this population ` +
          `is reaped by Planka retention in age order and the scan pages ` +
          `oldest-first, so a page of genuinely deleted cards is normal and DOES ` +
          `strike, as long as one read succeeds. Open ANY ONE of these card ids in ` +
          `Planka: if it is there, this is a configuration or membership fault. The ` +
          `breaker holds no state, so a single successful read next tick clears it.`,
      );
      return;
    }

    // ⛔ AND THAT IS THE ENTIRE GATE. Past the pre-filter, EVERY definitive 404 is
    // struck — exactly as `origin/main` strikes it. No board probe, no board
    // enumeration, no per-row question of any kind, because there is none that
    // answers anything: see the four-discriminators block above.
    for (const { row, cardId } of pending) {
      const retired = await recordUnreadable(row.id);
      if (retired) {
        result.resolvedUnreadable += 1;
        console.error(
          `[deblock-redelivery] approval ${row.id}: card ${cardId} retired as ` +
            `card_unreadable after ${UNREADABLE_STRIKES} definitive misses spanning ` +
            `≥${UNREADABLE_MIN_SPAN_MS / 3_600_000}h. ⚠️ THIS DOES NOT CERTIFY ` +
            `that any read succeeded on those ticks. The pre-filter only judges a ` +
            `tick carrying ≥${BREAKER_MIN_READS} verdicts; a SMALLER tick strikes ` +
            `with zero successful reads, so on a backlog already drained below that ` +
            `window a misrouted PLANKA_BASE_URL can mature a row to here — the ` +
            `≤${BREAKER_MIN_READS - 1}-row residual this file bounds above. And no ` +
            `read available to this service distinguishes a deleted card from one ` +
            `this agent can no longer see (see applyStrikes).`,
        );
      }
    }
  };

  /**
   * ⭐ #1104 — THE OTHER HALF OF THE TICK'S DEFERRED JUDGEMENT. Apply (or withhold)
   * this tick's ANSWERLESS-read strikes once the whole tick's evidence is in.
   *
   * ⛔ THE ONE TERM THAT MATTERS IS `cardReadsOk > 0`, AND IT IS THE ANSWER TO THE
   * QUESTION #1104 ACTUALLY POSES: a permanent failure and a transient one look
   * IDENTICAL on any single read, so what tells them apart?
   * ═══════════════════════════════════════════════════════════════════════════
   * Not the status, not the body, not the row. What tells them apart is that a
   * TRANSIENT failure is SHARED. When Planka is unwell every read degrades, so the
   * tick obtains no successful card read at all and NOT ONE STRIKE IS CHARGED —
   * the counter does not move and the clock does not even start. When ONE card is
   * permanently unreadable its siblings still read 200, and that success is positive
   * proof — of the base URL, the token, the route and the card path, all at once —
   * that the failure belongs to the row and not to Planka.
   *
   * ⭐ SO A TRANSIENT OUTAGE CANNOT RETIRE A RECOVERABLE CARD. Not "is unlikely to":
   * cannot. The bound is INERT for the whole duration of an outage however long it
   * lasts, and the wall-clock term restarts from the first strike after it.
   *
   * ⛔ NOTE THE DELIBERATE ASYMMETRY WITH `applyStrikes`'S BREAKER, WHICH LOOKS AT
   * THE SAME NUMBER AND USES IT THE OPPOSITE WAY ROUND. That guard WITHHOLDS on the
   * ABSENCE of successful reads, and an absence only means something over a sample —
   * hence BREAKER_MIN_READS, and hence its own stated `<20`-verdict residual. This
   * guard ARMS on the PRESENCE of one, and one successful read is evidence on its
   * own, so it needs no floor and has no such tail. ⚠️ Do not "harmonise" the two by
   * giving this one a minimum read count: that would reintroduce exactly the residual
   * the asymmetry avoids, and it would disarm the guard on the measured shape
   * (`candidates=18`, a single-page tick).
   *
   * ⛔ AND IT USES `cardReadsOk`, NOT `result.successfulReads`. The latter counts
   * reads that ALSO resolved the list name — which the #1104 population never does,
   * so it printed 0 on every one of the 12 measured ticks. Keying on it would make
   * this whole mechanism inert in the one condition it was written for. See
   * `cardReadsOk`.
   */
  const applyDegradedStrikes = async (
    pending: Array<{ row: CandidateRow; cardId: string; cause: ReadDegradedCause }>,
  ): Promise<void> => {
    if (pending.length === 0) return;
    if (cardReadsOk === 0) {
      result.degradedStrikesWithheld = pending.length;
      // ⚠️ NOT `console.error`, and not a per-row line. Unlike the breaker, this is
      // the EXPECTED shape of a small tick whose only candidate is the unreadable
      // row, so shouting would train a reader to ignore it. The number is carried on
      // the tick result and printed with the tick line, where it is interpretable
      // beside `candidates` and `successful_reads`.
      console.warn(
        `[deblock-redelivery] ⚠️ ${pending.length} answerless read(s) charged NO ` +
          `degraded strike: this tick resolved ZERO cards successfully, so it has no ` +
          `standing to call any of them a property of a row rather than of Planka. ` +
          `No counter moved and no clock started — see applyDegradedStrikes.`,
      );
      return;
    }

    for (const { row, cardId, cause } of pending) {
      const retired = await recordDegraded(row.id);
      if (!retired) continue;
      result.resolvedReadDegraded += 1;
      result.readDegradedByCause[cause] += 1;
      recordReadDegraded(cause);
      console.error(
        `[deblock-redelivery] approval ${row.id}: card ${cardId} retired as ` +
          `read_degraded cause=${cause} after ${DEGRADED_STRIKES} consecutive ` +
          `answerless reads spanning ≥${DEGRADED_MIN_SPAN_MS / 3_600_000}h, every one ` +
          `of them on a tick that read other cards successfully. ⛔ THIS CLAIMS ` +
          `NOTHING ABOUT THE CARD — it was never sent for, no callback_delivered_at ` +
          `was stamped, and this is NOT card_unreadable (Planka never answered 404 on ` +
          `the card's own read path). It says only that fr could not establish which ` +
          `list this card is in, for two days, while Planka was answering about other ` +
          `cards. Open the card in Planka: if it is there, read the list it is in — ` +
          `an archived list answers 404 on /api/lists/:id while its board's active ` +
          `lists answer 200.`,
      );
    }
  };

  /**
   * ⭐ `freshCount` IS THE LANE BOUNDARY, AND IT IS PASSED RATHER THAN INFERRED.
   * `scanAndDeliver` hands this function ONE ordered list, `[...fresh,
   * ...backlog]`, so rows `[0, freshCount)` are the fast lane and the rest are
   * the backlog walk. The loop needs to know which lane a row is in because the
   * two lanes have DIFFERENT DEADLINES — see FAST_LANE_DEADLINE_SHARE.
   *
   * ⛔ NOT re-derived from the row's `completed_at` inside the loop. `isFresh` is
   * evaluated in SQL against the DB clock at SELECT time; re-deciding it here
   * against `Date.now()` would let a row that the fast-lane query returned be
   * judged "backlog" a few seconds later, i.e. the two lanes could disagree about
   * which rows they contain. The boundary is an INDEX because the concat that
   * created it is the only thing that defines it.
   */
  const deliverAll = async (rows: CandidateRow[], freshCount: number): Promise<void> => {
    let first = true;
    // The circuit breaker's two inputs: `verdicts` counts reads that ANSWERED,
    // `pendingStrikes` holds the subset that answered 404, and the difference is
    // the successful reads the breaker actually keys on. See `applyStrikes`.
    let verdicts = 0;
    const pendingStrikes: Array<{ row: CandidateRow; cardId: string }> = [];
    /**
     * ⭐ #1104. The tick's ANSWERLESS reads, queued for the same reason the
     * definitive ones above are queued rather than written inline: whether a given
     * answerless read is "this card cannot be read" or "Planka answered nothing to
     * anybody" is not knowable from the row, only from the shape of the tick, and
     * the shape of the tick does not exist until the tick is over. See
     * `applyDegradedStrikes`.
     */
    const pendingDegraded: Array<{
      row: CandidateRow;
      cardId: string;
      cause: ReadDegradedCause;
    }> = [];
    // ⭐ HOW A MID-LOOP THROW STILL REACHES THE FLUSH. `null` on every normal
    // exit, and the thrown value on an abnormal one, so the block below the loop
    // has exactly one entry point and there is exactly one path to
    // `applyStrikes`. See the note there — this used to be an unguarded fall
    // through and the comment claiming otherwise was false.
    let loopError: { thrown: unknown } | null = null;
    try {
      for (let i = 0; i < rows.length; i += 1) {
        const row = rows[i]!;
        const inFastLane = i < freshCount;
        /**
         * ⛔ THE DEADLINE IS PER-LANE, AND THIS IS THE WHOLE FIX. Before this the
         * loop tested one `deadline` for both lanes; because the fresh rows run
         * FIRST, a Planka slow enough to need repairs (≈11 s/read measured) let 5
         * fresh rows spend the entire 60s budget and the backlog page — 815 rows
         * — was never reached AT ALL. The count reserve (FAST_LANE_READS <
         * MAX_PER_RUN) said nothing about this, because an unclaimed SEND slot is
         * worthless to a lane the loop never enters.
         */
        const laneDeadline = inFastLane ? fastLaneDeadline : deadline;
        /**
         * ⭐ THE PER-LANE FLOOR. The first row of each lane is attempted whatever
         * the clock says, so NEITHER lane can be driven to zero attempts — not by
         * the other lane overshooting its own deadline on one hung read (the
         * deadline is checked BEFORE a row, never during it), and not by a budget
         * already spent by the pre-loop census on a slow database.
         *
         * ⚠️ IT COSTS ONE EXTRA ROW OF LOCK HOLD IN THE WORST CASE — two rows of
         * overshoot instead of one, ~131s each per the client-timeout note on
         * runDeblockRedeliveryTick, against a 900s interval. Stated because it is
         * the price of the guarantee, not hidden because it is small.
         */
        const isLaneFirstRow = i === (inFastLane ? 0 : freshCount);
        if (!isLaneFirstRow && Date.now() >= laneDeadline) {
          if (inFastLane) {
            // ⛔ `continue`, NOT `break`: the fast lane is out of time, the TICK
            // is not. Breaking here would hand the remaining budget back to
            // nobody and re-create the starvation one lane over. The skipped
            // fresh rows are not lost — they are still inside FRESH_WINDOW_MS
            // (four intervals) and `ORDER BY completed_at DESC` puts them at the
            // head of the fast lane on the next tick, ahead of every backlog row.
            result.fastLaneDeferred += 1;
            continue;
          }
          result.more = true;
          // ⛔ `break`, NOT `return` — an early exit must still reach
          // `applyStrikes` below. A `return` here would silently drop every strike
          // the tick had earned, which is a different bug in the other direction.
          break;
        }
        if (!first && paceMs > 0) await sleep(paceMs);
        first = false;

        const cardId = row.card_id;
        if (!cardId) {
          result.cardUnreadable += 1;
          continue;
        }

        let listName: string;
        try {
          listName = await currentListName(cardId);
        } catch (err) {
          // We have NOT established that this card is blocked, so we must not
          // send. Fail CLOSED — the opposite of the fail-open choices elsewhere in
          // this repo, because the cost here is moving somebody's card.
          result.cardUnreadable += 1;
          // ⛔ NO `definitivePath` HERE. `currentListName` has already classified
          // this failure — every throw out of it is a CardReadFailure, which this
          // call returns unchanged. Anything else reaching here is unrecognised
          // and must degrade. Passing a path would re-decide a verdict that was
          // already made at the read site with the right information.
          const failure = classifyReadFailure(err, `card ${cardId}`);
          // ⭐ MIGRATION 113, DEFECT 2. Before this, an unreadable row was counted
          // and forgotten, so the same dead cards were re-read every cycle forever
          // and ate the scan window. It is now a STRIKE — but ONLY for a
          // DEFINITIVE miss.
          //
          // ⛔ A 'degraded' READ MUST NOT STRIKE. `currentListName` cannot tell a
          // deleted card from a Planka that is merely unwell unless Planka says so
          // with a 404 ON THE CARD'S OWN READ, and this repo's own headers cite 20
          // measured Planka 504s and an n8n queue that gave up. Counting a 504 as
          // evidence the card is gone is how a 30-minute outage writes off a whole
          // backlog — silently, at 45 minutes per row (see UNREADABLE_STRIKES).
          //
          // ⛔ AND A 'gone' READ IS QUEUED, NOT STRUCK. Whether this 404 means the
          // card was deleted or that Planka is 404ing everything is a property of
          // the TICK, not of this row — see `applyStrikes`.
          if (failure.kind === 'gone') {
            // ⭐ A VERDICT — and, being a 404, one that does NOT count towards
            // the successful reads the breaker keys on. ⚠️ A 'degraded' read is
            // counted on NEITHER side; see `applyStrikes` for why counting one as
            // a verdict disarms the breaker in the one condition it exists for.
            verdicts += 1;
            pendingStrikes.push({ row, cardId });
          } else {
            // ⭐ #1104. STILL NOT A VERDICT AND STILL NOT A STRIKE — `verdicts` is
            // untouched above and below, so the breaker's denominator is exactly
            // what it was. This queues the row for the SEPARATE, much longer bound
            // that stops an answerless read meaning nothing at all forever.
            pendingDegraded.push({ row, cardId, cause: failure.degradedCause });
          }
          console.error(
            `[deblock-redelivery] approval ${row.id}: cannot read card ${cardId} ` +
              `(${failure.kind}) — NOT sending` +
              `${
                failure.kind === 'degraded'
                  ? ' (no strike: this is evidence about Planka, not about the card)'
                  : ''
              }:`,
            failure.message,
          );
          continue;
        }

        // ⭐ A VERDICT the other way: Planka named the list this card is in.
        // ⛔ THIS LINE IS THE BREAKER. A verdict that is not in `pendingStrikes`
        // is a SUCCESSFUL READ, and one of them is proof that the base URL, the
        // agent token and the card path all work — which is the entire evidence
        // `applyStrikes` uses to decide whether this tick's 404s are answers.
        verdicts += 1;

        // The card WAS readable — card AND list — so whatever strikes it had, of
        // either kind, are not consecutive.
        await clearReadFailureRuns(row);

        if (!isBlockedList(listName)) {
          // The whole point of the worker. This is the branch that would have
          // spared 110 DONE cards.
          result.notBlocked += 1;
          // ⭐ MIGRATION 113. Terminal, and the value says WHICH of the two very
          // different situations this is. `callback_acked_at` is the discriminator
          // and it is not a guess: if we sent for this row and the card is now out
          // of BLOCKED, we are the reason it moved. If we never sent, the card was
          // already off the board and there was nothing here to repair.
          const resolution: CallbackResolution = row.callback_acked_at ? 'moved' : 'not_blocked';
          await resolveRow(row.id, resolution);
          if (resolution === 'moved') result.resolvedMoved += 1;
          else result.resolvedNotBlocked += 1;
          continue;
        }

        // ⭐ MERGE-QUEUE fr row 12. In BLOCKED is necessary, not sufficient, for an
        // approved signoff: see `checkSignoffRefusals`. Before the send ceiling and
        // MAX_PER_RUN — a refused row must not consume a send slot.
        if (isSignoffApproval(row)) {
          const v = await checkSignoffRefusals(row, cardId);
          if (v.verdict === 'retire') {
            await resolveRow(row.id, v.resolution);
            if (v.resolution === 'card_left_blocked_since_approval') result.resolvedLeftBlocked += 1;
            else result.resolvedTenantNotPlatform += 1;
            console.warn(
              `[deblock-redelivery] approval ${row.id}: card ${cardId} NOT re-sent — retired as ` +
                `${v.resolution}: ${v.detail}`,
            );
            continue;
          }
          if (v.verdict === 'defer') {
            result.signoffDeferred += 1;
            console.warn(
              `[deblock-redelivery] approval ${row.id}: card ${cardId} NOT re-sent and NOT retired ` +
                `this tick — ${v.reason}; left for the next tick`,
            );
            continue;
          }
        }

        result.eligible += 1;

        // ⛔ THE SEND CEILING. Checked BEFORE the MAX_PER_RUN gate on purpose: an
        // exhausted row must not consume one of the ten send slots a healthy row
        // could have used. Without this the row below re-enters the population
        // every ACK_GRACE_MS and is re-sent for the life of the deployment; the
        // receiver does not dedupe, so each of those sends is a card move.
        if ((row.callback_send_attempts ?? 0) >= MAX_SEND_ATTEMPTS) {
          await resolveRow(row.id, 'send_exhausted');
          result.resolvedSendExhausted += 1;
          // ⛔ THE RULE ABOVE IS UNTOUCHED. The classification below happens AFTER the row
          // has already exhausted and been resolved; it cannot change whether, or when, a
          // row retires. It changes only who the log line sends the reader to.
          //
          // ⚠️ TWO INDEPENDENT DISCRIMINATORS, COMPOSED — see `describeSendExhaustion`.
          // #1023 established the first (did ANY receiver ack?) and this adds the second
          // (was there anything in the payload to act on?). Neither subsumes the other and
          // the ack test runs first, because a receiver that never saw the request cannot
          // be judged on what the request contained.
          const { cause, blame } = describeSendExhaustion(row);
          result.sendExhaustedByCause[cause] += 1;
          recordSendExhaustion(cause);
          console.error(
            `[deblock-redelivery] approval ${row.id}: card ${cardId} still BLOCKED after ` +
              `${row.callback_send_attempts} sends — retiring as send_exhausted ` +
              `cause=${cause}. ${blame}`,
          );
          continue;
        }

        // ⛔ MAX_PER_RUN bounds SENDS, not the scan. Before the head-of-line fix it
        // was the LIMIT on the query, which conflated "how many Planka 504s can we
        // risk" with "how far into the backlog may we look" — and let 10 dead rows
        // block the other 716 forever.
        if (result.delivered + result.failed >= MAX_PER_RUN) {
          result.more = true;
          // `break`, not `return` — same reason as the deadline exit above: the
          // strikes this tick earned must still reach `applyStrikes`.
          break;
        }
        try {
          // Counted BEFORE the call, so a send that crashes mid-flight still costs
          // an attempt. Over-counting bounds the damage; under-counting removes the
          // bound entirely.
          await countSendAttempt(row.id);
          // ⭐ `redelivery: true` — THE SENDER HALF OF THE RECEIVER'S GUARD. This worker
          // is the only re-sender in the estate. Without this flag that guard is inert
          // and a re-send moves the card unconditionally, which is how a blind re-send
          // would have dragged 244 cards out of the state they had legitimately reached,
          // 88 of them out of DONE (measured 2026-09-04).
          const outcome = await deliverDecisionCallback(row.id, { db, redelivery: true });
          if (outcome.outcome !== 'sent') {
            // ⭐ #1029. The ONE outcome that performs no network I/O whatsoever
            // gets its attempt back — see `refundSendAttempt` for why this single
            // exemption does not weaken the over-counting rule for anything else.
            if (outcome.outcome === 'skipped-unsupported-receiver') {
              await refundSendAttempt(row.id);
            }
            // ⚠️ STILL COUNTED AS `failed`, DELIBERATELY. `failed` bounds the
            // per-tick work via MAX_PER_RUN; the row did consume a slot's worth
            // of the tick. It is the PERSISTED attempt counter, the one that
            // retires the row forever, that must not be charged.
            result.failed += 1;
            // ⭐ #1089 — THE OUTCOME NOW REACHES THE LOG, AND IT IS THE EXCLUSION
            // ABOVE THAT MAKES THAT AFFORDABLE. This `continue` logged NOTHING, so a
            // tick printing `failed=10` named neither a row nor a reason and the
            // whole population was undiagnosable from the outside — which is a large
            // part of why the deadlock survived as long as it did.
            //
            // ⛔ IT WAS NOT SAFE TO LOG THIS BEFORE, AND THE ORDER OF THE TWO CHANGES
            // IS THE ARGUMENT. `skipped-unsupported-receiver` WAS this population: 10
            // lines per tick, every 15 minutes, forever, saying the same thing about
            // the same 18 rows — spam that would have buried the real failures and
            // been switched off within a week. `notAnUnroutableVoid` removes those
            // rows from the population, so what is left here is a genuine refusal or
            // a non-2xx: bounded by MAX_PER_RUN=10, and expected to be 0 on a healthy
            // tick. ⚠️ IF A NEW STRUCTURALLY-UNSENDABLE CLASS EVER APPEARS, IT WILL
            // SHOW UP HERE AS EXACTLY THAT SPAM. That is the correct signal — it means
            // a new exclusion is owed — not a reason to delete this line.
            console.error(
              `[deblock-redelivery] approval ${row.id}: card ${cardId} not sent — ` +
                `outcome=${outcome.outcome}. Attempt ${
                  outcome.outcome === 'skipped-unsupported-receiver' ? 'refunded' : 'charged'
                }; row stays a candidate.`,
            );
            continue;
          }
          // n8n ACCEPTED it. `deliverDecisionCallback` has stamped
          // `callback_acked_at` and NOTHING ELSE — an ack is not a repair.
          result.delivered += 1;

          // ⭐ MIGRATION 113, DEFECT 1 — STAMP ON EFFECT, NOT ON ACK. Ask Planka
          // again, with the SAME notion of blockedness the gate above used
          // (currentListName + isBlockedList — there is deliberately no second
          // definition anywhere in this file). Only a card that has actually left
          // BLOCKED is recorded as delivered.
          //
          // ⚠️ Usually this still says BLOCKED, because n8n's move is
          // asynchronous. That is EXPECTED and it is not a failure: the row stays
          // acked, unresolved and un-retired, and the next tick past ACK_GRACE_MS
          // resolves it — as `moved` if the card has gone, or by re-sending if it
          // has not. The old code's mistake was treating "no answer yet" as "done".
          let resolvedAsMoved = false;
          try {
            const after = await currentListName(cardId);
            // `after` is a real list name or this line was never reached — a read
            // that produced nothing throws, and lands in the catch below rather
            // than being laundered into "not blocked, therefore moved".
            if (!isBlockedList(after)) {
              await resolveRow(row.id, 'moved');
              result.resolvedMoved += 1;
              resolvedAsMoved = true;
            }
          } catch (err) {
            // Cannot see the effect — so do not claim one. NOT a strike either:
            // the read before the send succeeded, so this is a fresh blip, and
            // punishing the row for it would retire cards we just repaired.
            console.error(
              `[deblock-redelivery] approval ${row.id}: sent, but could not re-read ` +
                `card ${cardId} to confirm it left BLOCKED — leaving it unresolved:`,
              errMessage(err),
            );
          }

          // ⭐ READ WHAT THE RECEIVER ANSWERED. The whole reason
          // `deliverDecisionCallback` now returns its 200 body — see
          // `classifyReceiverHold` for the measurement (five acked sends, retired
          // `receiver_unresponsive`, against a receiver that reported
          // `deliberate_hold: true` on the FIRST one).
          //
          // ⛔ ORDER IS LOAD-BEARING AND IT IS NOT A STYLE CHOICE. The Planka
          // re-read runs FIRST and `moved` wins: `moved` is a claim about the WORLD
          // (the card is out of BLOCKED, verified against Planka) and a hold is a
          // claim about an INTENTION. The receiver sets `deliberate_hold` for its
          // own idempotence guard too, so a body alone cannot tell "held" from "the
          // card already left" — the read can, and it is the authority when it
          // answers. `classifyReceiverHold` refuses the moved-on DIAGNOSTIC as a
          // second line of defence for the tick where that read throws.
          //
          // ⛔ AND IT RETIRES ON THE FIRST SEND, ON PURPOSE. That is the entire
          // repair: the other four sends carry the SAME payload to the SAME
          // receiver, which has already said what it will do with it, and the row is
          // SPENT — fr accepts no second decision on a decided approval — so no
          // answer can ever ride on them.
          //
          // ⛔ IT DOES NOT MOVE THE CARD AND MUST NEVER LEARN TO. The hold is
          // load-bearing and defended in n8n's `blocked-sweep.json :: Classify +
          // Plan:76` ("DO NOT 'FIX' approval_hold BY MAKING A DECIDED HOLD
          // MOVABLE"). This branch makes fr's RECORD honest; release comes from a
          // real answer, elsewhere.
          if (!resolvedAsMoved) {
            const holdCause = classifyReceiverHold(outcome.response);
            if (holdCause !== null) {
              await resolveRow(row.id, 'hold_acknowledged');
              result.resolvedHoldAcknowledged += 1;
              result.holdAcknowledgedByCause[holdCause] += 1;
              // ⭐ #1115 — THE SAME PLACE, RELATIVE TO ITS CLASSIFIER, THAT
              // `recordSendExhaustion(cause)` sits above: after the row has retired and
              // after the per-tick counter, before the log line. It cannot change
              // whether or when a row retires; it changes only whether the reason
              // outlives the process. The per-tick counter above is returned to the
              // caller and discarded; this one survives to the pushgateway.
              recordHoldAcknowledged(holdCause);
              console.log(
                `[deblock-redelivery] approval ${row.id}: card ${cardId} is held by the ` +
                  `receiver ON PURPOSE (cause=${holdCause}) — retiring as ` +
                  'hold_acknowledged after 1 send. The card STAYS in BLOCKED by design; ' +
                  'only a real answer releases it, and no re-send can supply one.',
              );
            }
          }
        } catch (err) {
          result.failed += 1;
          console.error(
            `[deblock-redelivery] approval ${row.id}: callback failed:`,
            errMessage(err),
          );
        }
      }
    } catch (err) {
      // ⛔ CAUGHT, NOT SWALLOWED — it is re-thrown below, AFTER the flush, so the
      // tick still reports outcome:'failed' exactly as it did before.
      loopError = { thrown: err };
    }
    // ⭐ EVERY exit from the loop above reaches this line — AND IT IS NOW TRUE.
    //
    // ⚠️ CORRECTED 2026-09-06. IT WAS NOT TRUE, AND THIS COMMENT ASSERTED IT
    // ANYWAY. The two `break`s cover only the two DELIBERATE early exits;
    // `clearUnreadableStrikes` and both `resolveRow` calls in the loop body sit
    // OUTSIDE every try, so any throw from them unwound straight past
    // `applyStrikes`. MEASURED: a 40-row tick with 5 genuine card-404 strikes
    // queued, row 12's `resolveRow('not_blocked')` hitting a statement timeout
    // — all 5 strikes silently discarded, tick reported outcome:'failed'.
    //
    // The DIRECTION was safe (work lost, nothing wrongly retired), which is why
    // the fix is the code and not the comment: a claim this file leans on
    // elsewhere — "this is the only place a strike is ever written" — is worth
    // more as an invariant than as an aspiration. The two `break`s stay; they
    // are still the right shape for a deliberate early exit.
    //
    // This is the only place a strike is ever written.
    if (loopError === null) {
      // Normal exit. A failure to write strikes is a real failure and must fail
      // the tick, exactly as it always did — the guard below is NOT applied here.
      await applyStrikes(verdicts, pendingStrikes);
      // ⭐ #1104. The second flush, and it reaches this line by EVERY path the
      // first one does, for the same reason — see the block above.
      await applyDegradedStrikes(pendingDegraded);
    } else {
      // ⛔ THE FLUSH MUST NOT MASK THE ERROR THAT TRIGGERED IT. On this path the
      // loop has ALREADY failed, and a throw out of `applyStrikes` here would
      // replace the diagnosis with a symptom (this is also why the flush is not
      // in a `finally`: a throw from a `finally` silently supplants the
      // in-flight exception). Logged, dropped, and the ORIGINAL error is the one
      // that reaches the caller and `result.error`.
      try {
        await applyStrikes(verdicts, pendingStrikes);
        await applyDegradedStrikes(pendingDegraded);
      } catch (flushErr) {
        console.error(
          '[deblock-redelivery] the tick threw AND flushing its strikes threw too; ' +
            'reporting the first, which is the one that explains the tick. Flush error:',
          errMessage(flushErr),
        );
      }
      throw loopError.thrown;
    }
  };

  /**
   * ⭐ THE TWO-LANE SCAN. Read the fast lane, then the backlog page, deliver them
   * as ONE ordered list with the fresh rows FIRST, and advance the cursor on the
   * BACKLOG's result alone.
   *
   * ⛔ `advanceScan` IS CALLED WITH `backlog.length`, NEVER WITH THE COMBINED
   * COUNT, AND GETTING THAT WRONG IS THE SUBTLE BUG IN THIS CHANGE. Its rule is
   * `rowsSeen < MAX_READS_PER_RUN ? 0 : usedOffset + MAX_READS_PER_RUN` — "a
   * short page means we reached the end of the population, so wrap". A combined
   * count would let up to FAST_LANE_READS rows from a lane that has NO cursor
   * pad a genuinely short backlog page up to the window size, so the walk would
   * step PAST the end of the population instead of wrapping, scan an empty
   * window, and only wrap a tick later — a slow leak of coverage at exactly the
   * moment the queue is nearly drained. The cursor belongs to one lane; only
   * that lane may move it.
   *
   * ⚠️ `result.more` is likewise the BACKLOG's page-full test. The fast lane is
   * capped at FAST_LANE_READS by design and a full fast lane is not evidence of
   * an unscanned remainder — `more` means "the walk did not reach the end".
   *
   * ⛔ FRESH ROWS ARE CONCATENATED FIRST AND `deliverAll` PROCESSES IN ORDER, so
   * the fast lane also gets FIRST CLAIM on the tick's MAX_PER_RUN send slots.
   * Reversing the concat would leave the ordering fix in place and delete the
   * repair fix: a fresh row would be read promptly and then wait behind ten
   * backlog sends for its callback.
   *
   * ⚠️ AND FIRST CLAIM IS NOT UNLIMITED CLAIM — `fresh.length` IS PASSED AS THE
   * LANE BOUNDARY FOR EXACTLY THAT REASON. Going first is only safe for the
   * backlog while the fast lane cannot spend the whole tick, and the SEND-slot
   * reserve (FAST_LANE_READS < MAX_PER_RUN) does not bound spending: a tick also
   * ends on the WALL CLOCK, and 5 fresh rows against an 11 s/read Planka ate all
   * 60s of it before this boundary existed. `deliverAll` stops STARTING fresh
   * rows at FAST_LANE_DEADLINE_SHARE of the budget and gives the remainder to the
   * backlog. ⛔ Pass a wrong `freshCount` here — 0, or the combined length — and
   * the whole time reserve silently applies to the wrong rows or to none.
   */
  const scanAndDeliver = async (exec: typeof defaultDb, offset: number): Promise<void> => {
    const fresh = await selectFreshCandidates(exec);
    const backlog = await selectBacklogCandidates(exec, offset);
    result.fastLane = fresh.length;
    result.candidates = fresh.length + backlog.length;
    result.more = result.more || backlog.length >= MAX_READS_PER_RUN;
    await deliverAll([...fresh, ...backlog], fresh.length);
    advanceScan(backlog.length, offset);
  };

  try {
    await db.transaction(async (tx) => {
      const lockRows = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
      );
      const acquired =
        Array.isArray(lockRows) && lockRows.length > 0 ? Boolean(lockRows[0]!.locked) : false;
      result.acquiredLock = acquired;
      if (!acquired) {
        result.outcome = 'skipped';
        return;
      }
      const exec = tx as unknown as typeof defaultDb;
      const offset = await resolveOffset(exec);
      result.scanOffset = offset;
      // deliverDecisionCallback opens its own reads/writes on `db`, NOT on tx,
      // so the stamp commits independently of this transaction. That is what
      // we want: a later row throwing must not roll back an earlier row's
      // successful stamp and re-send it next tick.
      await scanAndDeliver(exec, offset);
    });
  } catch (err) {
    result.outcome = 'failed';
    result.error = errMessage(err);
    return result;
  }

  return result;
}

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * ⭐ IT NOW FIRES ON BOOT, AND THE OLD REFUSAL TO DO SO IS RETRACTED — MEASURED,
 * NOT ARGUED.
 * =========================================================================
 * This docblock used to read: "⛔ DOES NOT FIRE ON BOOT … on a fresh deploy the
 * backlog is 282 cards, and firing at boot means every pod roll starts an
 * outbound burst at Planka — the exact load that produced the 504s this worker
 * repairs. Waiting one interval costs 15 minutes on a backlog that has been stuck
 * for days." Both halves are wrong, and the second one is wrong in a way that
 * made the worker do NOTHING AT ALL on most pods.
 *
 * THE DEFECT. `setInterval` does not run its callback until one full interval has
 * elapsed, and the interval here is 900_000 ms. A pod that does not live 15
 * minutes therefore completes ZERO ticks. Measured on prod 2026-09-06:
 *
 *   fr ReplicaSets created that morning     3  at 06:34:47Z, 07:02:31Z, 07:15:18Z
 *                                              — three rollouts in 41 minutes
 *   longest observed pod uptime            28  minutes
 *   fr Deployment metadata.generation     781
 *   worker interval                   900_000  ms = 15 minutes
 *
 * So a pod frequently manages ZERO or ONE tick in its whole lifetime — which is
 * why an observed tick moved 2 rows while 261 `voided` approvals, whose cards sit
 * in BLOCKED, had never been delivered at all. "Waiting one interval costs 15
 * minutes" assumed the pod is still alive at the end of that interval. At
 * generation 781 it usually is not. Note this is the SAME expired premise that
 * `scanOffset`'s docblock records: frequent rollouts are normal here, so anything
 * that needs uptime to start working does not start working.
 *
 * THE PRECEDENT. `src/workers/approval-redelivery.ts` already does exactly this,
 * for the same reason, in the same shape: `void runOnce();` immediately before
 * `setInterval`, commented "Kick off immediately: on a fresh deploy the backlog is
 * the whole history." That sibling is the pattern being mirrored here, not a new
 * invention.
 *
 * ⚠️ THE STAMPEDE OBJECTION, AND WHY IT DOES NOT HOLD. The retracted comment's
 * real worry was several replicas rolling at once and all POSTing at Planka on
 * boot. Verified against the code rather than assumed:
 *
 *   • ONE REPLICA PER TICK. `runOnce` calls `runDeblockRedeliveryTick()` with no
 *     options, so `skipAdvisoryLock` is falsy and the tick runs inside
 *     `pg_try_advisory_xact_lock(LOCK_KEYS.deblockCallbackRedelivery)`. Every
 *     loser takes the `outcome: 'skipped'` branch and sends nothing. See
 *     db/advisory-lock-keys.ts, whose entry for this key is explicitly "one
 *     replica per de-block callback re-delivery tick" and which records that this
 *     owner holds its key ACROSS the outbound HTTP precisely so two replicas
 *     cannot move the same card twice.
 *   • AND THE WINNER'S BURST IS BOUNDED. MAX_PER_RUN (10) caps the sends and
 *     PACE_MS (500) spaces them, so the worst boot tick in the whole fleet is 10
 *     POSTs over ~4.5 s. The incident being guarded against was 727 decisions in
 *     ~7 seconds — three orders of magnitude away. `tickInFlight` additionally
 *     stops the boot tick and the first interval tick overlapping in-process.
 *
 * So the boot tick is one bounded, serialised, paced tick — and it is the ONLY
 * tick a 28-minute pod ever gets. It is also what makes `seedScanOffset` mean
 * anything: seeding the cursor from the fleet clock is pointless on a pod that
 * never reaches its first tick.
 *
 * ⛔ THE GUARD BELOW STILL GATES THE IMMEDIATE TICK. A worker refused for a bad
 * interval must fire nothing at all, so `void runOnce()` sits AFTER both early
 * returns. Hoisting it above them would turn every mis-configured start into one
 * un-scheduled, un-repeatable send burst — pinned by a test.
 */
export function startDeblockRedeliveryWorker(intervalMs: number = DEFAULT_INTERVAL_MS): void {
  if (timer !== null) return;
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) return;

  const runOnce = async (): Promise<void> => {

    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runDeblockRedeliveryTick();
      if (r.outcome === 'failed') {
        console.error('[deblock-redelivery] tick failed:', r.error);
      } else if (shouldLogTick(r)) {
        console.log(
          // ⚠️ `acked` and `moved` are DIFFERENT NUMBERS and both are printed on
          // purpose. The old line printed only `delivered`, which was an ack
          // count wearing an effect's name — 373 acks, 0 cards off the board,
          // and every tick read healthy. A tick with acked>0 and moved=0 for
          // several cycles running is the signal that n8n is accepting and not
          // moving.
          `[deblock-redelivery] offset=${r.scanOffset} candidates=${r.candidates} ` +
            // ⭐ #1034 — PRINTED IMMEDIATELY BESIDE `candidates` AND THAT IS THE
            // POINT. `candidates=1` alone was read as a drained queue for hours
            // while 452 rows sat withheld by the shadow clause. The two numbers
            // are only interpretable together: candidates is what this page saw,
            // shadowed is what the predicate declined to show it.
            `shadowed=${r.shadowed} ` +
            // ⭐ THE FAST LANE, PRINTED BESIDE `offset` AND `candidates` BECAUSE
            // IT IS THE ONLY WAY TO TELL IT IS ALIVE. `offset` says which page of
            // the BACKLOG this pod is walking; `fast_lane` says how many rows
            // skipped that walk entirely. A lane whose window or predicate has
            // quietly stopped matching prints `fast_lane=0` forever and is
            // otherwise indistinguishable from a lane with nothing fresh to do —
            // so the number has to be visible to be auditable.
            `fast_lane=${r.fastLane} ` +
            // ⭐ PRINTED BESIDE `fast_lane` AND ONLY INTERPRETABLE WITH IT.
            // `fast_lane` counts rows SELECTED; this counts the ones the tick ran
            // out of fast-lane budget before attempting (FAST_LANE_DEADLINE_SHARE).
            // Sustained non-zero is a PLANKA LATENCY signal, not a redelivery
            // fault — it is the time reserve working, and it is the only place a
            // reader can see that the fast lane was cut rather than idle.
            `fast_lane_deferred=${r.fastLaneDeferred} ` +
            // ⭐ THE REJECTED ROWS THIS WORKER DELIBERATELY HOLDS. Same reason as
            // `shadowed` beside `candidates`: a suppressed population that is
            // never printed is indistinguishable from a population that does not
            // exist, and that is exactly how 16 rejected rows read as unrepaired
            // work. Non-zero here is NOT a backlog — see `notARejectedHold`.
            `rejected_held=${r.rejectedHeld} ` +
            // ⭐ #1089. THE VOIDED ROWS WHOSE RECEIVER CANNOT ROUTE `voided`. Printed
            // for the `shadowed`/`rejected_held` reason — a suppressed population that
            // is never printed is indistinguishable from one that does not exist — and
            // for one more: this set is the QUEUE for a change to n8n, so a reader who
            // cannot see it cannot know the change is still owed. Non-zero is NOT a
            // backlog this worker can drain — see `notAnUnroutableVoid`.
            `voided_unroutable=${r.voidedUnroutable} ` +
            // ⭐ #1144. THE ROWS A NEWER TERMINAL DECISION ON THE SAME CARD HAS
            // OVERTAKEN. Printed beside its three siblings for the `shadowed`
            // reason — a suppressed population that is never printed is
            // indistinguishable from one that does not exist — and, uniquely among
            // the four, THIS IS THE ONLY PLACE IT IS RECORDED AT ALL: `notSuperseded`
            // is deliberately a filter and stamps no `callback_resolution`, so there
            // is no `WHERE` an operator could run instead of reading this number.
            // Non-zero is NOT a backlog: these rows are correctly withheld because
            // replaying them would drive a card on a superseded instruction.
            `superseded=${r.superseded} ` +
            `eligible=${r.eligible} ` +
            `acked=${r.delivered} moved=${r.resolvedMoved} not_blocked=${r.notBlocked} ` +
            `resolved_not_blocked=${r.resolvedNotBlocked} unreadable=${r.cardUnreadable} ` +
            `retired_unreadable=${r.resolvedUnreadable} send_exhausted=${r.resolvedSendExhausted} ` +
            // ⭐ PRINTED BESIDE THE TOTAL AND THAT IS THE POINT. `send_exhausted=N` alone
            // is the same shape of defect as the old `delivered` count: it names an
            // outcome and implies a cause. Measured on prod 2026-09-07, 86% of that total
            // was rows fr never gave n8n anything to act on, so a reader who saw only the
            // total drew the wrong conclusion 86% of the time. ⚠️ ALL FIVE causes print —
            // this comment said "four" while the loop below has always iterated the whole
            // of SEND_EXHAUSTION_CAUSES, `never_acked` included — at zero when absent, so
            // "no such rows" is distinguishable from "not measured".
            `send_exhausted_cause={${SEND_EXHAUSTION_CAUSES.map(
              (c) => `${c}=${r.sendExhaustedByCause[c]}`,
            ).join(',')}} ` +
            // ⭐ PRINTED BESIDE `send_exhausted` BECAUSE IT IS THE POPULATION THAT
            // USED TO BE COUNTED THERE, WRONGLY. Before this, a receiver reporting
            // `deliberate_hold: true` on the first send was re-sent four more times
            // and retired `send_exhausted / receiver_unresponsive` — so the two
            // numbers moving in opposite directions after this shipped is the fix
            // WORKING, not a regression. The causes print at zero when absent, same
            // rule as the line above.
            `hold_acknowledged=${r.resolvedHoldAcknowledged} ` +
            `hold_cause={${HOLD_CAUSES.map(
              (c) => `${c}=${r.holdAcknowledgedByCause[c]}`,
            ).join(',')}} ` +
            // ⭐ #1104. PRINTED BESIDE `unreadable`, AND THE TWO ARE ONLY
            // INTERPRETABLE TOGETHER. `unreadable=N` counts rows this tick could not
            // read AT ALL — it was 18 on every one of the 12 measured ticks and
            // meant nothing was happening. These two say what the tick DID about
            // them: `retired_read_degraded` is rows that finally reached the bound,
            // and `degraded_withheld` is rows whose answerless read was NOT charged
            // because the tick resolved zero cards and had no standing to charge it.
            // ⚠️ `degraded_withheld` equal to `unreadable`, tick after tick, is the
            // signal that Planka is answering nothing — NOT that the bound is broken.
            `retired_read_degraded=${r.resolvedReadDegraded} ` +
            // ⭐ MERGE-QUEUE fr row 12 — the approved-signoff refusals.
            `signoff_left_blocked=${r.resolvedLeftBlocked} ` +
            `signoff_tenant_not_platform=${r.resolvedTenantNotPlatform} ` +
            `signoff_deferred=${r.signoffDeferred} ` +
            `read_degraded_cause={${READ_DEGRADED_CAUSES.map(
              (c) => `${c}=${r.readDegradedByCause[c]}`,
            ).join(',')}} ` +
            `degraded_withheld=${r.degradedStrikesWithheld} ` +
            // ⚠️ PRINTED WHENEVER THIS LINE IS PRINTED — which is NOT every tick.
            // The enclosing log is gated on delivered||failed||cardUnreadable > 0,
            // so a tick that only retires `not_blocked` rows logs nothing at all.
            // A tripped breaker is always visible in practice (tripping requires
            // >= BREAKER_MIN_READS 404 reads, which satisfies the gate), but do
            // not read this as an unconditional heartbeat: an earlier version of
            // this comment claimed "every tick" and that was simply false. A
            // breaker whose state is invisible is indistinguishable from one that
            // is not wired up.
            //
            // ⭐ `successful_reads` IS PRINTED BESIDE IT AND IS THE POINT. It is
            // the breaker's entire discriminator, so it is also the number that
            // lets an operator audit the breaker rather than trust it:
            // successful_reads>0 with retired_unreadable>0 is Planka reaping old
            // cards and us recording it, which is healthy; successful_reads=0 with
            // strikes_withheld>0 is a broken client and nothing was written. The
            // old line printed `degraded_tick`, which named a condition (mostly-404)
            // that turned out to be the normal shape of a healthy page here.
            //
            // ⚠️ A BOARD-GATE EXPERIMENT BRIEFLY ADDED `board_reads`,
            // `board_enumerations`, `board_adjudicated`, `board_unadjudicated`,
            // `strikes_board_absent` and `unreadable_boards` HERE. All six are
            // gone with the gate — see the four-discriminators block at
            // `applyStrikes`. A metric named for a guarantee the code does not
            // provide is worse than no metric, and `strikes_board_absent` was
            // exactly that: it read as proof of deletion while being equally
            // proof of lost access.
            `breaker_tripped=${r.breakerTripped} strikes_withheld=${r.strikesWithheld} ` +
            `successful_reads=${r.successfulReads} ` +
            `failed=${r.failed} more=${r.more}`,
        );
      }
    } catch (err) {
      console.error('[deblock-redelivery] tick threw:', errMessage(err));
    } finally {
      tickInFlight = false;
    }
  };

  // Kick off immediately: at generation 781 a pod often does not live to see its
  // first interval, so a worker that waits 900_000 ms does no work at all. Mirrors
  // src/workers/approval-redelivery.ts. Reached only past the guard above.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
}

export function stopDeblockRedeliveryWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
