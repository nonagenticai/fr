// src/workers/approval-expiry.ts
//
// Reaper for approvals that have passed `expires_at` while still `pending`.
//
// THE DEADLOCK THIS FIXES
//
// `approvals.expires_at` has been written on every row since the table
// existed, and NOTHING has ever read it except a guard in
// routes/approvals.ts handleUpdateApproval:
//
//     if (approval.status !== 'pending')            -> 422 'no longer pending'
//     if (new Date() > new Date(approval.expires_at)) -> 422 'Approval has expired'
//
// Those two guards together are a trap. A row that is `pending` AND past
// `expires_at` fails the second guard, so no human can decide it; and no
// process transitions it, so it can never stop being `pending`. It is
// permanently undecidable and permanently counted as outstanding work.
//
// Measured on prod (worker4, db `fr`, 2026-08-08): **116 of 116 pending
// approvals were past `expires_at`** — every single one. 20 of them are
// `execution.ready_signoff` rows; 15 of those 20 cards are still sitting in a
// Planka BLOCKED list, the oldest 12 expired 2026-07-03 (35 days). This is not
// an execution-gate quirk, it is generic to every approval kind, so this worker
// is deliberately kind-agnostic.
//
// WHAT EXPIRY MEANS — and what it deliberately does NOT do
//
//   * NOT auto-approve. The gate's entire purpose is to require a human. An
//     approval that grants itself because nobody looked is worse than one that
//     hangs: it releases work under a sign-off that never happened.
//
//   * NOT auto-reject. `rejected` is the record of a human decision, and
//     `approval_decisions` holds the per-approver rows that back it. Writing
//     `rejected` for a timeout would manufacture a decision nobody made and
//     leave a rejection with no decider — the same "looks decided, proves
//     nothing" disease this work exists to remove.
//
//   * `expired` — honest and fail-CLOSED. The approval stops being outstanding.
//     No sign-off occurred and none is inferred.
//
// THE THIRD OUTCOME: A RE-QUEUE NOTICE (added 2026-08-31)
//
// ⚠️ This section REPLACES an earlier line that read "No n8n callback is
// fired". That line was true when written and is no longer true, and leaving it
// standing would have made this header lie about the code beneath it.
//
// The reason it said so is still correct and still binding: the DECISION
// callback (`deliverDecisionCallback`) is what moves a card BLOCKED->DOING on approval,
// and expiry must NEVER do that. So expiry does not call it. What expiry now
// sends is a different thing entirely, through a different, narrower sender
// (`sendN8nExpiryCallback`):
//
//     decision: 'expired'  ==  "the window lapsed, nobody answered,
//                               put the card back in TODO to be re-raised"
//
// That is a RE-QUEUE, not a verdict. It approves nothing, rejects nothing,
// records no decider (`decided_by: 'system'`), writes no
// `approval_decisions` row, and never lands a card in DOING or QA. Every
// refusal above survives intact.
//
// WHY IT HAD TO BE ADDED. Terminal-on-expiry stranded the card forever: the
// approval left `pending` and nothing downstream was ever told. Measured on
// prod (worker4, db `fr`): **324 expired vs 68 pending, ZERO overlap** — not
// one expired approval ever produced a re-raise. The AA conveyor's
// DOING->QA->DONE segment died behind exactly this for ~34h.
//
// SCOPE, deliberately narrow:
//   * ONLY rows this tick just expired (the batch's RETURNING ids). There is no
//     backfill of the historical expired rows — they can never re-match
//     `status='pending'`, and re-notifying hundreds at once would flood the
//     conveyor.
//   * ONLY rows with a `callback_path` (a web-only approval has no n8n side).
//   * ONLY receivers that can actually ROUTE `expired`, per
//     `EXPIRY_CALLBACK_PATHS` in services/n8n-callback.ts. A receiver outside
//     that set is counted as `callbacksUnsupported` and reported, not fired at.
//   * BEST-EFFORT, and never silent. The send happens AFTER the transaction
//     commits (an HTTP call must not run inside the advisory-locked write, and
//     the receiver must be able to read the row as `expired`). A failure is
//     counted, logged, and APPENDED TO THE ROW'S `error_message` — a send that
//     vanished into a log line would recreate the stranding defect in a new
//     place.
//   * TIME-BOUNDED, twice. ⚠️ The notice phase does network I/O inside a worker
//     tick, so it MUST NOT be able to outrun the tick interval. Each send is
//     abandoned after `expiryCallbackTimeoutMs()` (30s), and the whole phase
//     stops at NOTIFY_DEADLINE_MS (300s — DEFAULT_NOTIFY_DEADLINE_MS below;
//     ⛔ CORRECTED 2026-09-13, this said 60s, which #1096 superseded. A stale 60
//     here is where the fictitious "66 s vs 60 s cliff" figure came from), after
//     which the remaining rows are counted as `callbacksDeferred`, stamped, and
//     reported. Unbounded, an
//     unreachable receiver would hold a 15-MINUTE worker for up to 83 minutes
//     (500 rows x the client's 10s ceiling) — measured in miniature during
//     development, where an unresolvable webhook host cost ~5s per row and blew
//     a caller's budget outright.
//     ⛔ CORRECTED 2026-09-11. The per-send ceiling above used to be 2s, and
//     this paragraph used to say "the deadline only ever bites when the
//     receiver is dead ... a healthy receiver answers in tens of milliseconds".
//     BOTH halves were wrong, and the second is what made the first look safe.
//     Measured on worker4 db `n8n` (`execution_entity`; all three receivers in
//     EXPIRY_CALLBACK_PATHS are `responseMode: lastNode`, so the execution
//     duration is exactly what fr waits on): real `expired` notices run p50
//     732ms, p95 17.5s, max 19.2s. A 2s ceiling was therefore not catching dead
//     receivers, it was aborting LIVE ones — 59 of 61 recorded failures on this
//     path read `abandoned after 2000ms`. Full distribution and the two budgets
//     that bound the new value from above: DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS in
//     services/n8n-callback.ts.
//     ⛔ CORRECTED 2026-09-14. This sentence read "At the measured p50 a full
//     500-row batch still finishes well inside the 60s phase deadline", and BOTH
//     halves were wrong — the surviving `60s` is the same stale value :85 above
//     already corrects, and the arithmetic does not close at EITHER number, so
//     changing only the digit would have left a false claim behind. The sends are
//     STRICTLY SEQUENTIAL (`await send(...)` inside `for (const row of rows)` in
//     `notifyExpired` below), so phase cost is additive: BATCH_SIZE 500 x the
//     732ms p50 is ~366s, which OVERRUNS the 300s budget, and at the dominant
//     receiver's measured mean (26.4s — see DEFAULT_NOTIFY_DEADLINE_MS below)
//     only ~11 rows fit in a tick. ⭐ A full batch therefore never drains in one
//     tick at any of these numbers. That is not a defect in the budget; it is the
//     premise the redrive exists to cover, stated in BATCH_SIZE's own comment
//     ("BATCH_SIZE x the per-send ceiling is the quantity the notify budget
//     CANNOT cover"). What the per-send ceiling has to be sized against is the
//     receiver's latency, not the batch.
//
// ⚠️ RECEIVER-SIDE DEPENDENCY — SCOPED TO THE KANBAN RAIL, NOT TO EVERY MEMBER OF
// `EXPIRY_CALLBACK_PATHS`. n8n_custom_nodes #1187 is what teaches the
// `kanban/approval-callback` receivers to accept and route `expired`; before it is
// merged and imported, THOSE answer `bad_request`.
//
// ⛔ CORRECTED 2026-09-14. This used to say "#1187 is what teaches those receivers
// to accept and route `expired` … they answer `bad_request` to every one of these"
// — unscoped, i.e. asserted over all three receivers. That is the same
// universal-inferred-from-one-rail shape the block ~40 lines below removes, and
// leaving it made this header contradict itself. It is refuted for the SIGNOFF rail
// by this branch's own measurement: `uoMx5WYBrxR4TPYT`
// (`exec::ready-signoff-callback`, live and active) ALREADY routes `expired`, from a
// TOP-LEVEL `n8n-nodes-base.switch` typeVersion 3 output (index 3) into `Planka:
// move card to TODO` — no #1187 import required. Detail and provenance: the
// `uoMx5WYBrxR4TPYT` paragraph below. ⚠️ Note the old wording UNDER-claimed rather
// than over-claimed (it made the file look more gated than it is), so nothing built
// on it was inflated — it is corrected because it is false and self-contradicting,
// not because it flattered anything. ⚠️ UNVERIFIED either way:
// `improvement-approval-callback`, the third member, was not measured here; do not
// read this correction as a claim about it.
//
// ⛔⛔ ON THE KANBAN RAIL THE DEPENDENCY IS STRICTER THAN "accept and route" — READ
// THIS BEFORE DEPLOYING ANY WIDENING OF THIS PHASE. ⚠️ EVERY SENTENCE IN THIS
// PARAGRAPH IS SCOPED TO `kanban/approval-callback` AND TO NOTHING ELSE; the
// paragraph after it is why that scope is load-bearing. Measured on the LIVE ACTIVE
// workflow `yG1N9K2hTswEZNTq` (`AA Pattern - Approval Callback`, `active=t`, updatedAt
// 2026-09-13T17:23:55Z), node `Resolve Target List`: the `expired` re-queue branch
// is `} else if (ctx.decision === 'expired' && todoListId) {` at jsCode :163, and it
// sits INSIDE the else chain BELOW `if (action) {` at :134. Prod fr shows **367/367**
// of the 09-22 KANBAN-RAIL cohort carry a `deblock_action` (RETRY 198, INFRASTRUCTURE
// 147, QUESTION 16, SPLIT 6), so `action` is ALWAYS truthy and the `expired` branch is
// UNREACHABLE for that population. ⚠️ 367 is the `kanban/approval-callback`
// subset, NOT the whole date: 448 rows are pending on 2026-09-22 (367 on that rail, 81
// on others), re-derived 2026-09-13T20:57:43Z. Do not quote 367 as the date's total. An `expired` decision is instead handled by
// the rejected-proposition arm at :136-137 (`target_list_kind = null`) and comes out
// `targetListId: ''`, `shouldMoveCard: false`, `deliberate_hold: true` -> "Add Comment
// Only" -> **HTTP 200**. n8n holds 638 retained executions of that workflow and ZERO
// contain `"expired"`: on the kanban rail the branch has never once run.
//
// ⛔⛔ CORRECTED 2026-09-13 — THE BLOCK ABOVE USED TO END IN A UNIVERSAL, AND THE
// UNIVERSAL WAS INFERRED FROM THAT ONE RAIL. It read: "⇒ ⛔ SO NOTHING IN THIS FILE
// UNSTRANDS A CARD, RELEASES A HOLD, OR MAKES THE 09-22 POPULATION RECOVERABLE, AND
// NO COMMENT OR TEST HERE MAY SAY OTHERWISE", and it instructed the reader to ship
// this BEHIND the kanban receiver fix. Both halves are refuted by the population
// this file's redrive actually admits. Measured on prod (worker4, db `fr`,
// 2026-09-13, GROUP BY rather than a guessed literal, so an absence cannot be a
// mistyped marker):
//
//   NOTIFY_DEFERRED_MARKER   0 of 4077  (exact AND loosened '%ran out of time%')
//   NOTIFY_FAILED_MARKER    61          all `status='expired'`,
//                                       `callback_resolution IS NULL`,
//                                       `callback_send_attempts = 0`,
//                                       stamped 2026-09-01..09-02
//   GROUP BY callback_path: execution-ready-signoff-callback  61 / 61  (100%)
//                           kanban/approval-callback           0
//   full redriveCandidateSql: 61 -> **54 admitted** over **49 distinct cards**; the
//                           7 that drop go at `NOT EXISTS sibling pending`, and
//                           every admitted row is on the SIGNOFF rail
//   those 49 cards in Planka (db `kanban`): BLOCKED **33** (37 rows) ·
//                           DONE 15 (15 rows) · TODO 1 (2 rows) · absent 0
//
// ⇒ SO THE KANBAN MEASUREMENT DOES NOT GOVERN THIS FILE'S POPULATION, BECAUSE THIS
//   FILE'S POPULATION IS NOT ON THAT RAIL. The signoff receiver is a different
//   machine, not a variant of the same one. Measured on the LIVE ACTIVE workflow
//   `uoMx5WYBrxR4TPYT` (`exec::ready-signoff-callback`, `active=t`, webhook path
//   `execution-ready-signoff-callback`, `responseMode: lastNode`): `Route by
//   decision` is an `n8n-nodes-base.switch` typeVersion 3 with FOUR TOP-LEVEL
//   outputs, and `expired` is one of them (`is_duplicate == false AND
//   decision == 'expired'`, `fallbackOutput: none`). There is no `action` check
//   anywhere in it and no jsCode else-chain to be buried under. Output 3 is wired
//   `Planka: move card to TODO` -> `Planka: add expired comment` -> `Build success
//   response`, the move is `listId = {{ $json.todo_list_id }}`, and `Validate
//   payload` sets `todo_list_id: body.todoListId || null` — ⛔ the `|| null` was
//   missing from this quote until 2026-09-14; immaterial to behaviour, but a quote
//   must be the code. Re-read verbatim from the live jsCode on worker4 db `n8n`
//   (`workflow_entity` id `uoMx5WYBrxR4TPYT`, node `Validate payload`) rather than
//   from the repo file. The hard-fail on a missing value is real and is a separate
//   statement earlier in the same node:
//   `if (body.decision === 'expired' && !body.todoListId) { missing.push('todoListId
//   (required to re-queue an expired signoff)'); }` — non-blank on 54 of 54
//   admitted rows.
//
// ⇒ **THIS IS THEREFORE A ~33-CARD CHANGE, NOT A NO-OP.** 33 of the 49 admitted
//   cards are in BLOCKED and get a notice a receiver that routes `expired` will act
//   on; the other 16 (15 DONE, 1 TODO) are retired `not_blocked` by the live
//   `isBlockedList` read and never sent at all.
//
// ⚠️ BUT "REACHABLE" IS NOT "EXERCISED" — DO NOT UPGRADE IT, AND DO NOT LET THE NEXT
//   READER EITHER. 0 of 117 retained executions of `uoMx5WYBrxR4TPYT` mention
//   `"expired"` and 0 touched `Planka: move card to TODO`. ⚠️ That 0 is NOT the
//   kanban 638/0: the retained window starts 2026-09-10 and these 61 rows were
//   stamped 09-01/02, so it CANNOT speak to this cohort in either direction. The
//   card-side effect above is PREDICTED FROM TOPOLOGY and UNOBSERVED.
//
// ⛔ AND THE "NO COMMENT OR TEST HERE MAY SAY OTHERWISE" PROHIBITION IS REMOVED,
//   DELIBERATELY, NOT TIDIED AWAY. A universal generalised from a single rail binds
//   every future editor to a falsehood they cannot argue with; and this one forbade
//   the ONE acceptance instrument the change has — send, then re-read the card's
//   Planka list. A rule that forbids the measurement which would refute it is not a
//   safety rail. Scope a claim to the rail it was measured on, or do not write it.
//
// ⛔ THE "LAND BEHIND THE KANBAN RECEIVER FIX" HOLD IS DROPPED, AND THE REASON WORTH
//   KEEPING IS THAT IT WAS ON THE WRONG DEPENDENCY — not that it has since become
//   moot. n8n_custom_nodes #1187, #1193 and the `fix/expired-decided-before-
//   proposition` / #1403 work all repair the KANBAN receiver, which holds **0 of 54**
//   admitted rows. Gating a signoff-rail change on a kanban-rail receiver is a
//   dependency on a rail this population never touches, and it would have held a
//   ~33-card repair indefinitely for a reason that never applied to it. ⚠️ For the
//   record it is moot as well: #1403 merged 2026-09-13T21:34:24Z
//   (`b36865a087574a4c692925b7707c55f47cce13e0`) and its workflow is imported into
//   the running n8n. Both facts belong here; the wrong-dependency one is the lesson.
//
// ⚠️ PROVENANCE, so the next reader knows what to re-verify and what not to trust:
// the four `Resolve Target List` jsCode line numbers and the 638/0 execution count
// are the peer session's measurement of the KANBAN receiver — this file's sessions
// have never read that jsCode, ncn being out of lane. The `uoMx5WYBrxR4TPYT` switch
// topology and wiring, the marker/rail/attempt/Planka counts above, and every
// constant below were measured from this worktree against prod on 2026-09-13 and
// are the ones an fr session can and should re-measure.
//
// The rest of the point is unchanged: an expired approval becomes *legible* —
// it leaves `pending`, drops out of every "outstanding approvals" count,
// carries `error_message` saying why, and shows up in the stranded view
// (routes/execution-approvals.ts handleListStrandedSignoffs) where a human can
// see it needs re-raising.
//
// Concurrency: fr runs multiple replicas, so the UPDATE is singleton-per-tick
// behind a Postgres *transaction-scoped* advisory lock — same reasoning as
// workers/idempotency-sweep.ts and workers/analytics-rollup.ts (postgres.js
// hands a different pooled connection per statement, so a session-scoped
// pg_advisory_unlock lands on the wrong backend and leaks the lock forever
// through pgbouncer's transaction-mode pool).

import { sql } from 'drizzle-orm';

import { LOCK_KEYS } from '../db/advisory-lock-keys';
import { db as defaultDb } from '../db/client';
import { publishDeblockActionMetrics } from '../lib/deblock-action-metrics';
import { publishProjectIdEmitMetrics } from '../lib/project-id-emit-metrics';
import { publishRosterDischargeMetrics } from '../lib/roster-discharge-metrics';
import {
  EXPIRY_CALLBACK_PATHS,
  expiryCallbackTimeoutMs,
  normalizeCallbackPath,
  sendN8nExpiryCallback,
  deliverApprovalCallbackUrls,
} from '../services/n8n-callback';
import { plankaClient } from '../services/planka';
import { plankaReaderFrom, type PlankaReader } from '../services/planka-card-state';
import { isBlockedList } from '../services/toc-hooks';

// Advisory-lock key. Registered in src/db/advisory-lock-keys.ts — the only
// place one may be declared. Do not restate the keyspace here.
const ADVISORY_LOCK_KEY = LOCK_KEYS.approvalExpiry;

/** Every 15 minutes. Expiry horizons are hours-to-days; this is precise enough
 *  and cheap (one indexed UPDATE against a small table). */
// ⭐ EXPORTED so the budget invariants below can be asserted as RELATIONSHIPS
// rather than as remembered numbers. A test that hardcodes 900_000 stops being
// true the moment this moves, and says nothing about what it must stay above.
export const DEFAULT_INTERVAL_MS = 900_000;

/**
 * Rows per tick. The first tick after deploy faces the entire historical
 * backlog (116 rows on prod today, but this must stay bounded for a database
 * that has accumulated more), and a bounded UPDATE keeps the write transaction
 * short. Remaining rows are taken on the next tick.
 */
// ⭐ EXPORTED for the same reason as DEFAULT_INTERVAL_MS: BATCH_SIZE x the
// per-send ceiling is the quantity the notify budget CANNOT cover, which is why
// the redrive has to exist. That is a relationship, not a constant.
export const BATCH_SIZE = 500;

/**
 * Wall-clock ceiling for the whole re-queue-notice phase of one tick.
 *
 * Sized against the tick interval, not against the batch: at 15 min per tick,
 * a phase that can run for 83 min is a worker that never ticks again. Rows past
 * the deadline are DEFERRED — counted, stamped and reported, never silently
 * dropped. Env: APPROVAL_EXPIRY_NOTIFY_DEADLINE_MS.
 *
 * ⭐ RAISED 60_000 -> 300_000 (#1096). THE BUDGET IS THE HALF THAT COULD MOVE;
 * THE PER-SEND TIMEOUT IS NOT.
 *
 * The 09-22 cohort is 449 rows in ONE tick (measured on worker4 2026-09-11) and
 * the dominant receiver's mean is 26.4 s, so a 60 s budget reached TWO of them and
 * deferred 447 — which, before the redrive below existed, was permanent.
 *
 * ⛔ THE OTHER CONSTANT MUST NOT MOVE WITH IT. Raising
 * `DEFAULT_EXPIRY_CALLBACK_TIMEOUT_MS` (30 s) above the receiver's p95 (81.8 s)
 * looks like the same fix and is the opposite one: its own comment says "30_000 IS
 * A CEILING, NOT A PREFERENCE … anything above that loses the race to the client's
 * own AbortSignal every time", and a per-send timeout at or above the phase budget
 * makes the pre-send deadline check pass EXACTLY ONCE — one send per tick, worse
 * than today. The per-send bound must stay strictly below the budget, and this
 * change widens the gap between them rather than closing it.
 *
 * ⚠️ WHAT 300_000 BUYS, STATED SO IT CAN BE FALSIFIED: ~10 sends/tick at the
 * dominant receiver's mean, so 449 rows drain in ~11 h of 15-minute ticks instead
 * of ~45 h. It is 1/3 of the 900 s interval, and it is the FIRST of two budgets
 * that must both fit inside one tick (see DEFAULT_REDRIVE_DEADLINE_MS: 300 + 300
 * < 900).
 *
 * ⚠️ AND IT IS NOT INERT: `APPROVAL_EXPIRY_NOTIFY_DEADLINE_MS` is UNSET on the live
 * deployment (checked 2026-09-11 — neither the `fr` container env nor the `fr-env`
 * secret carries it), so this default is the value in force.
 */
export const DEFAULT_NOTIFY_DEADLINE_MS = 300_000;

function notifyDeadlineMs(): number {
  const raw = Number(
    process.env.APPROVAL_EXPIRY_NOTIFY_DEADLINE_MS ?? DEFAULT_NOTIFY_DEADLINE_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_NOTIFY_DEADLINE_MS;
}

/** Terminal status written for a timed-out approval. */
export const EXPIRED_STATUS = 'expired';

export type ExpiryOutcome = 'ok' | 'skipped' | 'failed';

export interface ExpiryTickResult {
  outcome: ExpiryOutcome;
  /** True if this replica won the advisory lock for this tick. */
  acquiredLock: boolean;
  /** Rows transitioned pending -> expired this tick. */
  expired: number;
  /** True when BATCH_SIZE was exhausted and rows probably remain. */
  more: boolean;
  /** Re-queue notices accepted by n8n this tick. */
  callbacksSent: number;
  /** Re-queue notices the receiver refused or that never reached it. */
  callbacksFailed: number;
  /**
   * Re-queue notices the receiver answered 409/410 — the waiting execution is
   * GONE, so the notice was moot and its row was retired. Deliberately NOT
   * folded into `callbacksFailed`: nothing was refused and there is nothing to
   * repair, and an alert on `failed` must not fire for it.
   */
  callbacksAlreadyTerminal: number;
  /** Expired rows with no `callback_path` — web-only, nothing to notify. */
  callbacksSkipped: number;
  /**
   * Expired rows whose `callback_path` points at a receiver that cannot route
   * `expired` (today: `kanban/approval-callback`). These are NOT fired at —
   * see EXPIRY_CALLBACK_PATHS — but they ARE counted and logged, because a
   * card that silently fails to be re-queued is the whole defect.
   */
  callbacksUnsupported: number;
  /**
   * Expired rows the tick ran out of time to notify (see NOTIFY_DEADLINE_MS).
   * Non-zero here means the receiver is not answering — the rows ARE expired
   * and ARE stamped, but nothing re-queued them.
   */
  callbacksDeferred: number;
  // ── THE REDRIVE (#1096). Every field is per-tick and describes the redrive
  // phase ONLY; none of them is folded into the six counters above, because
  // `fr_approval_expiry_callback_last_tick`'s label set is pinned by tests and a
  // notice sent for the first time is not a notice re-sent. ──────────────────
  /** Rows the redrive selector returned this tick. */
  redriveCandidates: number;
  /** Redrive notices n8n accepted. */
  redriveSent: number;
  /** Redrive sends the receiver refused or that never reached it. */
  redriveFailed: number;
  /** Rows the sender refused on one of its own guards (the selector was wrong). */
  redriveRefused: number;
  /** Rows RETIRED `not_blocked` — the card had already moved, so nothing was sent. */
  redriveNotBlocked: number;
  /** Rows whose card could not be read. NOT sent and NOT retired. */
  redriveUnreadable: number;
  /** Rows RETIRED `send_exhausted` — the attempt cap is spent. */
  redriveExhausted: number;
  /** Candidates the redrive budget did not reach. Selected again next tick. */
  redriveDeferred: number;
  /**
   * ⭐ THE EFFECT COUNTERS (#1098). Per rail, and NOT folded into the eight
   * result counters above — see `REDRIVE_ACK_EFFECT_LABELS` for why mixing them
   * would break `sum by(result)`.
   *
   * Every counter above this line reports DELIVERY. These two report EFFECT: did
   * the card actually leave BLOCKED after a receiver said it took the notice.
   */
  redriveAckEffects: ApprovalRedriveAckEffects;
  error?: string;
}

/**
 * One row the batch just transitioned, with only what the notice needs.
 * The index signature is what `db.execute<T>` requires of its row type.
 */
interface ExpiredRow extends Record<string, unknown> {
  id: string;
  callback_path: string | null;
  /** D17: at least one `approval_callback_urls` row is attached (migration 191). */
  has_callback_url?: boolean;
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Run one expiry pass.
 *
 * The predicate is `status = 'pending' AND expires_at <= now()`, evaluated by
 * Postgres — `now()` and the stored timestamp are compared in the database so a
 * clock-skewed replica cannot expire a live approval early.
 */
export async function runApprovalExpiryTick(): Promise<ExpiryTickResult> {
  const db = defaultDb;
  const result: ExpiryTickResult = {
    outcome: 'ok',
    acquiredLock: false,
    expired: 0,
    more: false,
    callbacksSent: 0,
    callbacksFailed: 0,
    callbacksAlreadyTerminal: 0,
    callbacksSkipped: 0,
    callbacksUnsupported: 0,
    callbacksDeferred: 0,
    redriveCandidates: 0,
    redriveSent: 0,
    redriveFailed: 0,
    redriveRefused: 0,
    redriveNotBlocked: 0,
    redriveUnreadable: 0,
    redriveExhausted: 0,
    redriveDeferred: 0,
    redriveAckEffects: {},
  };

  // A single statement: pick the batch and transition it atomically. The
  // `status = 'pending'` predicate is re-checked inside the UPDATE, so two
  // replicas racing past the lock could not double-count a row.
  const expireBatch = async (exec: typeof defaultDb): Promise<ExpiredRow[]> => {
    const rows = await exec.execute<ExpiredRow>(sql`
      UPDATE approvals
         SET status        = ${EXPIRED_STATUS},
             completed_at  = now(),
             updated_at    = now(),
             -- ⚠️ TWO DIFFERENT FAILURES WEAR THE SAME STATUS.
             -- "the human did not answer" and "nobody was ever told" both end as
             -- expired, and conflating them is how 335 undelivered approvals read
             -- as George's decisions. notified_at (migration 101) is the only
             -- evidence that a push channel actually accepted the request, so the
             -- message names which failure this was. NULL is the SYSTEM's fault and
             -- the row needs re-raising, not chasing the person.
             error_message = CASE
               WHEN notified_at IS NULL
                 THEN 'expired: NOBODY WAS EVER NOTIFIED (no push-channel delivery was confirmed) — this is a routing failure, not an unanswered request; re-raise it'
               ELSE 'expired: no decision was recorded before expires_at'
             END
       WHERE id IN (
             SELECT id
               FROM approvals
              WHERE status = 'pending'
                AND expires_at <= now()
              ORDER BY expires_at
              LIMIT ${BATCH_SIZE}
              FOR UPDATE SKIP LOCKED
       )
      -- callback_path comes back with the id so the re-queue notice does not
      -- need a second read per row to decide whether to fire at all. D17: so does
      -- whether any n8n Wait-node callback_url is attached (migration 191).
      RETURNING id, callback_path,
                EXISTS (SELECT 1 FROM approval_callback_urls c WHERE c.approval_id = approvals.id)
                  AS has_callback_url
    `);
    return Array.isArray(rows) ? (rows as ExpiredRow[]) : [];
  };

  let expiredRows: ExpiredRow[] = [];

  try {
    await db.transaction(async (tx) => {
      const lockRows = await tx.execute<{ locked: boolean }>(
        sql`SELECT pg_try_advisory_xact_lock(${ADVISORY_LOCK_KEY}) AS locked`,
      );
      const acquired =
        Array.isArray(lockRows) && lockRows.length > 0
          ? Boolean(lockRows[0]!.locked)
          : false;
      result.acquiredLock = acquired;
      if (!acquired) {
        // Another replica owns this tick. Do nothing — it will report.
        result.outcome = 'skipped';
        return;
      }
      expiredRows = await expireBatch(tx as unknown as typeof defaultDb);
    });

    result.expired = expiredRows.length;
    result.more = result.expired >= BATCH_SIZE;
  } catch (err) {
    result.outcome = 'failed';
    result.error = errMessage(err);
    return result;
  }

  // ⚠️ AFTER the write, deliberately. Two reasons: an outbound HTTP call inside
  // the advisory-locked transaction would hold the lock for the length of a
  // network round trip per row; and the receiver may read the approval back, so
  // it has to see the committed `expired` status, not an uncommitted one.
  //
  // Best-effort: this block cannot make the tick fail. The rows are already
  // expired and that is the durable half of the fix.
  await notifyExpired(db, expiredRows, result);

  // ⭐ THE REDRIVE, AFTER THE NOTICE PHASE AND ONLY ON A LOCK-WINNING TICK.
  //
  // AFTER, because the rows this tick just expired deserve their first notice
  // before any row gets its second — a backlog must never starve fresh work, and
  // the notice phase's own budget bounds how long it may hold the redrive up.
  //
  // ⛔ `acquiredLock` IS A COARSE FILTER, NOT A MUTEX, AND THIS COMMENT USED TO SAY
  // OTHERWISE. It read "a replica that lost the lock must not select it too", which
  // states a serialisation this code does not have: `pg_try_advisory_xact_lock`
  // releases AT COMMIT, and every line below runs AFTER that commit (it must — it
  // does network I/O). So `result.acquiredLock` is the memory of a lock that is
  // already gone, and two replicas ticking a few seconds apart can each win it, each
  // commit, and each be inside `redriveExpiredCallbacks` at the same moment. The
  // cooldown docblock on REDRIVE_ROW_COOLDOWN_SECONDS has always described this
  // honestly ("a damper, not a lock"); this comment contradicted it, and the
  // reassuring version was the wrong one.
  //
  // ⭐ WHAT ACTUALLY KEEPS TWO REPLICAS OFF ONE ROW, in the order it bites:
  //   1. `FOR UPDATE SKIP LOCKED` in `redriveCandidateSql`. Two selects racing at the
  //      same instant cannot return the same row — the loser skips it and takes the
  //      next one. This is the only genuine mutual exclusion in the phase.
  //   2. The `updated_at <= now() - REDRIVE_ROW_COOLDOWN_SECONDS` term. Every write
  //      on the path — the attempt increment, `recordCallbackFailure`, both retires —
  //      sets `updated_at = now()`, so a row one replica has touched is invisible to
  //      the other for 600 s, which is longer than the whole redrive budget (300 s).
  //   3. `callback_send_attempts < MAX_REDRIVE_SEND_ATTEMPTS`, which bounds the worst
  //      case at 5 sends per row NO MATTER HOW MANY replicas make them.
  // What the lock gate does buy is cheaper: on a tick where another replica already
  // owns the expiry write, this one does not also pay for a Planka read per candidate.
  //
  // ⚠️ AND THE GAP IS INERT ONLY BECAUSE OF A DEPLOYMENT FACT, NOT A CODE PROPERTY.
  // `deploy/fr` runs `replicas: 1` (measured live 2026-09-11: `kubectl get deploy fr
  // -n fr -o jsonpath='{.spec.replicas}'` -> `1`), so nothing above is exercised
  // today. ⛔ Do not scale fr out on the strength of this gate: the guarantee then
  // rests entirely on 1–3, and 1 protects only the SELECT, not the sends after it.
  //
  // Never throws by contract; the guard is here anyway because a redrive that can
  // fail the tick would take the reaper down with it, and the reaper is the half
  // that must not stop.
  if (result.acquiredLock && result.outcome !== 'failed') {
    try {
      await redriveExpiredCallbacks(db, result);
    } catch (err) {
      console.error(
        '[approval-expiry] redrive threw (it is documented never to):',
        errMessage(err),
      );
    }
  }

  return result;
}

/**
 * Fire one re-queue notice per newly-expired row that has a receiver able to
 * take it. Never throws.
 */
export async function notifyExpired(
  db: typeof defaultDb,
  rows: ExpiredRow[],
  result: ExpiryTickResult,
): Promise<void> {
  const deadline = Date.now() + notifyDeadlineMs();
  const deferred: string[] = [];

  for (const row of rows) {
    // ── D17: resume every attached n8n Wait node with decision `expired` ──────
    // Same payload shape (buildCallbackPayload, decided_by 'system') and the same
    // X-Approval-Callback-Secret as a decision; each URL claimed + retried on its
    // own row. Past the deadline it is left to the approval-redelivery callback
    // lane (an unattempted row is due there), never marked deferred here — the
    // deferred marker feeds the callback_path redrive, which these rows are not in.
    if (row.has_callback_url && Date.now() < deadline) {
      const r = await deliverApprovalCallbackUrls(row.id, { db });
      if (r.outcome === 'sent') result.callbacksSent += 1;
      else if (r.outcome === 'failed' || r.outcome === 'timeout-unknown') result.callbacksFailed += 1;
      // The waiting execution is gone (HTTP 409/410): the row was retired and
      // there is nothing to retry or repair. NOT `failed` — see the tick's
      // `callbacksAlreadyTerminal`.
      else if (r.outcome === 'already-terminal') result.callbacksAlreadyTerminal += 1;
      else result.callbacksSkipped += 1;
      // A minted-with-callback_url gate has no callback_path; a legacy gate a
      // dedupe attached a URL to still gets its own re-queue notice below.
      if (!row.callback_path) continue;
    }
    if (!row.callback_path) {
      result.callbacksSkipped += 1;
      continue;
    }
    // Checked BEFORE the send, not after: crossing the deadline mid-send would
    // still cost a full per-send timeout for every remaining row.
    if (Date.now() >= deadline) {
      deferred.push(row.id);
      continue;
    }
    let outcome: Awaited<ReturnType<typeof sendN8nExpiryCallback>>;
    try {
      outcome = await sendN8nExpiryCallback(row.id, { db });
    } catch (err) {
      // sendN8nExpiryCallback is documented not to throw; if it ever does, the
      // batch still must not abort.
      outcome = { outcome: 'failed', error: errMessage(err) };
    }

    switch (outcome.outcome) {
      case 'sent':
        result.callbacksSent += 1;
        break;
      case 'skipped-unsupported-receiver':
        result.callbacksUnsupported += 1;
        break;
      case 'failed':
        result.callbacksFailed += 1;
        await recordCallbackFailure(db, row.id, outcome.error ?? 'unknown error');
        break;
      default:
        // no-callback-path / not-expired / not-found — nothing to notify.
        result.callbacksSkipped += 1;
        break;
    }
  }

  if (deferred.length > 0) {
    result.callbacksDeferred = deferred.length;
    // One statement, not one per row: the deferred set is by definition the
    // large one, and it exists precisely because the tick is already slow.
    await recordCallbacksDeferred(db, deferred);
    console.error(
      `[approval-expiry] ran out of time after ${notifyDeadlineMs()}ms — ` +
        `${deferred.length} expired row(s) were NOT notified and are NOT ` +
        're-queued. The receiver is not answering; each send was abandoned ' +
        `after ${expiryCallbackTimeoutMs()}ms.`,
    );
  }

  if (result.callbacksFailed > 0) {
    console.error(
      `[approval-expiry] ${result.callbacksFailed} re-queue callback(s) FAILED — ` +
        'those cards are still parked; see approvals.error_message for the reason. ' +
        'They are now REDRIVE CANDIDATES (NOTIFY_FAILED_MARKER), bounded at ' +
        `${MAX_REDRIVE_SEND_ATTEMPTS} attempts and gated on a live card-state read.`,
    );
  }
  if (result.callbacksUnsupported > 0) {
    console.warn(
      `[approval-expiry] ${result.callbacksUnsupported} expired row(s) carry a ` +
        'callback_path whose receiver cannot route decision=expired — NOT fired ' +
        'at, and NOT re-queued. They need the receiver taught, not a retry.',
    );
  }
}

/**
 * Append the send failure to the row's `error_message`.
 *
 * Visibility is the entire point: the defect being fixed is a card stranded
 * because nothing downstream was told. A notice that failed and left no trace
 * on the row would strand it exactly the same way, one layer further in.
 * Additive — the original expiry reason (including the "NOBODY WAS EVER
 * NOTIFIED" routing-failure variant) is preserved.
 */
/** Stamp every row the tick had no time to notify. Same visibility rule. */
async function recordCallbacksDeferred(
  db: typeof defaultDb,
  approvalIds: string[],
): Promise<void> {
  if (approvalIds.length === 0) return;
  try {
    await db.execute(sql`
      UPDATE approvals
         SET error_message = coalesce(error_message, '')
                             || ' | n8n re-queue callback NOT SENT: the expiry tick '
                             -- ⛔ ONE CONSTANT. The redrive selector below matches on
                             -- this exact substring; spelled twice, editing this
                             -- sentence would silently empty its population.
                             || ${NOTIFY_DEFERRED_MARKER},
             updated_at    = now()
       WHERE id IN (${sql.join(
         approvalIds.map((id) => sql`${id}::uuid`),
         sql`, `,
       )})
    `);
  } catch (err) {
    console.error('[approval-expiry] could not record deferred callbacks:', err);
  }
}

async function recordCallbackFailure(
  db: typeof defaultDb,
  approvalId: string,
  message: string,
): Promise<void> {
  // Bounded: an upstream error body can be arbitrarily long and this column is
  // read by humans in the stranded view.
  const trimmed = message.slice(0, 300);
  try {
    await db.execute(sql`
      UPDATE approvals
         SET error_message = coalesce(error_message, '')
                             -- ⛔ ONE CONSTANT, same rule as NOTIFY_DEFERRED_MARKER
                             -- above: the redrive selector matches this substring, so
                             -- spelling it here would let an edit to the sentence
                             -- silently empty half the redrive's population.
                             || ${' | ' + NOTIFY_FAILED_MARKER + ': '}
                             || ${trimmed},
             updated_at    = now()
       WHERE id = ${approvalId}::uuid
    `);
  } catch (err) {
    console.error(
      `[approval-expiry] could not record callback failure on ${approvalId}:`,
      err,
    );
  }
}

// ---------------------------------------------------------------------------
// THE REDRIVE — a deferred re-queue notice used to be TERMINAL
// ---------------------------------------------------------------------------
//
// THE DEADLOCK, restated for this half of the file (#1096)
//
// `notifyExpired` above fires one notice per row, SEQUENTIALLY, against ONE
// budget. Rows it cannot reach are counted `callbacksDeferred` and stamped by
// `recordCallbacksDeferred`, which appends to `error_message` and NOTHING ELSE
// — no status change, no requeue flag. `expireBatch` selects `status='pending'`,
// so an already-`expired` row can never be re-selected, and
// `routes/approvals.ts handleUpdateApproval` 422s any decision on a non-pending
// row.
//
//   ⇒ DEFERRED WAS TERMINAL, AND THE APPROVAL WAS THEN UNDECIDABLE BY ANYONE.
//
// THE DATED EXPOSURE. Measured on prod (worker4, db `fr`) 2026-09-11 by this
// author, re-deriving rather than quoting #1096:
//
//   SELECT callback_path, count(*) FROM approvals
//    WHERE status='pending' AND expires_at::date='2026-09-22' GROUP BY 1;
//     kanban/approval-callback          367   (81.7%)
//     execution-ready-signoff-callback   82   (18.3%)   -> total 449
//
// 449 rows lapse inside ONE tick. At the dominant receiver's measured 26.4 s
// mean, the old 60 s budget reached 2 of them; the other 447 were stranded
// permanently on their first and only tick.
//
// ⛔ WHY THE OBVIOUS FIX IS THE WRONG ONE, AND WHY PR #1093 WAS CLOSED FOR IT.
//
//   `callback_acked_at IS NULL` DOES NOT MEAN "NOT DELIVERED".
//
// All three receivers are `responseMode: lastNode`, so fr's send races the
// RECEIVER'S WHOLE EXECUTION. fr abandons at `expiryCallbackTimeoutMs()` (30 s)
// while n8n runs on to ~42 s — HAVING MOVED THE CARD. The ack is never recorded.
// 649 of 1,970 executions (33%) on `yG1N9K2hTswEZNTq` exceed that abort. And the
// receiver is NOT idempotent: `deblock-callback-redelivery.ts:11-24` records that
// `Move Card` is an unconditional `card.update{listId}`.
//
//   ⇒ SQL ALONE CAN NEVER DECIDE WHETHER TO RE-SEND. #1093 selected on
//     `callback_acked_at IS NULL` with no cap and would have moved real cards up
//     to ~672 times each. It was audited NO, twice, and closed unmerged.
//
// ⭐ SO THE LIVE CARD-STATE JOIN IS NOT A REFINEMENT — IT IS THE PRECONDITION.
// `deblock-callback-redelivery.ts`'s own refusal names the exit condition: "either
// an idempotent receiver OR a live card-state join before it may send anything."
// This path now has the second. For EVERY selected row,
// `isBlockedList(await reader.currentListName(card_id))` must be TRUE before any
// send, and the three outcomes are kept apart in all three directions:
//
//     true   -> the card is still parked in BLOCKED. Send.
//     false  -> the card has already moved. RETIRE as `not_blocked`, NEVER send.
//     throw  -> we do not know. SKIP: no send, NO retire, counted `unreadable`.
//
// ⛔ THE THROW ARM IS THE ONE THAT MATTERS. Folding "Planka did not answer" into
// "not blocked" would retire a stuck card in silence; folding it into "blocked"
// would send blind. It is neither, and it is not an error either — it is a row we
// look at again next tick.

/**
 * The EXACT substring `recordCallbacksDeferred` writes and the redrive's selector
 * matches on.
 *
 * ⛔ ONE CONSTANT, TWO CALL SITES, DELIBERATELY. The writer and the reader of this
 * marker are 200 lines apart; spelled twice, an edit to the sentence would silently
 * empty the redrive's population and nothing would fail. The population is 0 today
 * (measured on prod 2026-09-11: `error_message LIKE '%ran out of time before
 * reaching this row%'` returns ZERO rows — the notice path has never once run out
 * of budget), so a drifted spelling would look exactly like a healthy worker.
 */
export const NOTIFY_DEFERRED_MARKER = 'ran out of time before reaching this row';

/**
 * The EXACT substring `recordCallbackFailure` writes — the redrive's OTHER half of
 * the population.
 *
 * ⭐ ADDED BECAUSE THE REDRIVE WAS POINTED AT THE EMPTY SET. #1096 defined the
 * population as "a row a tick RAN OUT OF TIME on", and its own docblock on
 * NOTIFY_DEFERRED_MARKER records the measurement that makes that population zero:
 * `error_message LIKE '%ran out of time before reaching this row%'` returned ZERO
 * rows on prod 2026-09-11 — "the notice path has never once run out of budget".
 * Meanwhile the file header measures the arm that IS non-empty: **61 recorded
 * failures on this path, 59 of them `abandoned after 2000ms`**. So the redrive
 * covered the population that does not exist and skipped the one that does.
 *
 * ⛔ AND THE SKIPPED ARM IS THE UNRECOVERABLE ONE, which is why this is a defect and
 * not a tuning preference. `recordCallbackFailure` appends a reason and changes
 * NOTHING else: no status change, no `callback_resolution`, no requeue flag.
 * `expireBatch` selects `status='pending'`, so the row can never be re-expired;
 * `routes/approvals.ts handleUpdateApproval` 422s any decision on a non-pending row;
 * and grep confirms this substring had exactly ZERO production readers — the only
 * other occurrences were three assertions in the test suite. A reached-and-refused
 * row was therefore expired AND un-notified AND un-re-queued, with no repair path in
 * any worker, route or script. That is the precise combination the whole
 * terminal-on-expiry fix exists to make impossible.
 *
 * ⚠️ READ `un-re-queued` AS `un-NOTICED`. fr owns whether the notice is sent and
 * re-sent; it does not own whether the receiver acts on it. ⛔ CORRECTED 2026-09-13 —
 * this used to continue "and today the receiver provably does not", which is a KANBAN
 * measurement stated as a universal. The signoff receiver that serves 61 of 61 rows
 * on this marker routes `expired` from a top-level switch output into a card move
 * (header). The property this file can establish on its own is still "expiry no
 * longer terminates a row it could not notify" — fr's half — but on this rail that
 * precondition has a live consumer, so do not call it a precondition to nothing.
 *
 * ⛔ WHY RE-DRIVING A *FAILED* ROW IS SAFE ON EXACTLY THE ARGUMENT #1093 FAILED.
 * A `failed` outcome does NOT mean "not delivered" — fr abandons at
 * `expiryCallbackTimeoutMs()` (30 s) while a `responseMode: lastNode` receiver runs
 * on to ~42 s HAVING MOVED THE CARD, and 59 of those 61 failures are exactly that
 * shape. #1093 was closed for re-sending on that ambiguity with no live join and no
 * cap. ⭐ But this path's four guards are OUTCOME-AGNOSTIC, not deferral-specific,
 * and every one of them is a term of the single selector or the single loop:
 *   1. the live `isBlockedList(reader.currentListName(card_id))` read — an
 *      already-moved card reads `false` and is RETIRED `not_blocked`, never sent;
 *   2. `callback_send_attempts < MAX_REDRIVE_SEND_ATTEMPTS`, checked before each
 *      send and incremented BEFORE it (services/n8n-callback.ts:513), so the loop
 *      is bounded at 5 sends per row no matter what the receiver does.
 *      ⛔ CORRECTED 2026-09-13 — THE ARITHMETIC THIS USED TO OFFER AS THE SAFETY
 *      ARGUMENT IS FALSE FOR THE WHOLE LIVE POPULATION, AND THE CONCLUSION SURVIVES
 *      ANYWAY. SAY IT THAT WAY ROUND. It read: "the abandoned attempt that produced
 *      this very marker ALREADY counts toward the cap of 5." Measured on prod
 *      2026-09-13: **61 of 61** rows carrying this marker sit at
 *      `callback_send_attempts = 0`, because the increment only landed 2026-09-09
 *      (`ecffff41`, #1070) while those rows were last written 09-01/02. Nothing is
 *      pre-charged: the cap gives them 5 redrive sends, not 4. The BOUND is what
 *      makes the re-send safe, and the bound is intact; the pre-charge was never
 *      true and was never needed;
 *   3. `REDRIVE_ACK_GRACE_SECONDS`; 4. `REDRIVE_ROW_COOLDOWN_SECONDS`.
 * A failed row meets the same four gates a deferred row does, with no per-arm
 * branch — the same rail-agnostic argument #1098 used to widen
 * DEFAULT_REDRIVE_CALLBACK_PATHS.
 *
 * ⚠️ WHAT IT COSTS WHEN THE RECEIVER GENUINELY REFUSES (not a timeout): up to 5
 * bounded sends, then `send_exhausted` with an error_message that says a human is
 * needed. That is strictly better than the status quo, which is the same permanent
 * strand with NO resolution stamped and nothing to find it by.
 *
 * ⛔ WHAT THE BENEFIT ACTUALLY IS — CORRECTED 2026-09-13, AND IT IS BIGGER THAN THIS
 * USED TO SAY. The previous text read: "Admitting this arm makes the row LEGIBLE AND
 * RETRYABLE. It does not move the card, release the hold, or recover the 09-22
 * cohort, because the receiver's `expired` branch is unreachable for every row in it
 * and answers 200 with `deliberate_hold: true`." That is TRUE OF THE KANBAN RAIL AND
 * FALSE OF THE ROWS THIS SELECTOR ADMITS: 61 of 61 marker rows are on
 * `execution-ready-signoff-callback` (0 on kanban), 54 survive the full predicate
 * over 49 cards, 33 of those cards are in BLOCKED, and that rail's receiver
 * (`uoMx5WYBrxR4TPYT`, active) routes `expired` from a TOP-LEVEL switch output into
 * `Planka: move card to TODO`. So admitting this arm makes the row legible, retryable
 * AND — on the rail it has rows on — recoverable.
 * ⚠️ TWO THINGS STILL HOLD AND MUST NOT BE DROPPED WITH THE FALSEHOOD: an ACK is
 * still not a card move, so `sent` -> resolved on fr's side is not by itself evidence
 * of an outcome (a counter is not an outcome); and the card-side effect is predicted
 * from the receiver's topology, not yet observed in an execution. The full
 * measurement, and the rail scoping, are in the header block.
 *
 * ⛔ `skipped-unsupported-receiver` IS STILL NOT ADMITTED, and must not be. It never
 * increments a counter and never writes this marker, and `redriveCallbackPaths()`
 * intersects with `EXPIRY_CALLBACK_PATHS` anyway, so such a row could only ever be
 * refused again. Those rows need the receiver taught, not a retry — which is what
 * `callbacksUnsupported` and its `console.warn` already say.
 */
export const NOTIFY_FAILED_MARKER = 'n8n re-queue callback FAILED';

/**
 * The rails the redrive may send to by default.
 *
 * ⚠️ CORRECTED 2026-09-13 (#1098) — THIS LIST USED TO HOLD ONLY THE SIGNOFF RAIL,
 * AND THE SECOND OF ITS TWO REASONS WAS FALSE. The old docblock said, of
 * `kanban/approval-callback`: "The receiver taught by n8n_custom_nodes #1193 THROWS
 * when `expired && !todo_list_id` — deliberately, so a null listId cannot no-op
 * into a fake success. So every send to that rail today is a guaranteed refusal."
 *
 * ⛔ IT DOES NOT THROW, AND IT NEVER READ THE CALLER'S FIELD ALONE. MEASURED
 * 2026-09-13 against the LIVE, ACTIVE workflow (`yG1N9K2hTswEZNTq`, `active=t`,
 * `versionId = activeVersionId`, updated 2026-09-10 18:25 — i.e. the deployed copy,
 * not the repo file), `Resolve Target List` computes
 *
 *     const todoListId = ctx.todoListId || resolved.TODO || '';
 *
 * from a LIVE `Planka: Get Board Lists` call, and its own comment reads
 * "DELIBERATELY DOES NOT THROW. An unresolvable list still falls through to 'Add
 * Comment Only' … Visibly broken beats silently nothing." So a blank
 * `metadata.todoListId` is not a guaranteed refusal — it is the NORMAL shape, and
 * the receiver derives the target from the board.
 *
 * ⭐ AND THE MINTER NEVER SET THE FIELD AT ALL, so the old guard was not protecting
 * a population, it was defining one. `blocked-escalate.json :: Build Notification`
 * hardcodes `todoListId: ''`; measured on prod, 367 of 367 rows on this rail carry a
 * blank one and 0 of 82 on the signoff rail do. The guard therefore excluded exactly
 * and only this rail, permanently, on a premise about a receiver that has behaved the
 * other way since 2026-09-10.
 *
 * WHAT THE EXCLUSION COST: the 367 rows expiring 2026-09-22 (82% of that cohort)
 * would never be re-driven, so their cards stay BLOCKED for ever.
 *
 * ⛔ WIDENING IS SAFE ONLY BECAUSE THE GUARDS THAT MATTER ARE RAIL-AGNOSTIC, AND THAT
 * IS THE CLAIM TO RE-CHECK BEFORE TOUCHING THIS — NOT THIS SENTENCE. PR #1093 was
 * closed unmerged for selecting on `callback_acked_at IS NULL` alone against a
 * NON-IDEMPOTENT receiver; it would have re-moved real cards up to ~672 times. What
 * makes #1096's redrive safe is `redriveExpiredCallbacks`'s per-row LIVE Planka read
 * (`isBlockedList(await reader.currentListName(row.card_id))`) plus
 * `callback_send_attempts < MAX_REDRIVE_SEND_ATTEMPTS`, the ack grace and the
 * cooldown. Every one of those is applied in the single loop over `rows` with NO
 * per-path branch, and the cap/grace/cooldown are terms of the one selector. So a row
 * on this rail meets exactly the same four gates a signoff row does.
 *
 * ⇒ Both live rails, by default. `APPROVAL_EXPIRY_REDRIVE_PATHS` remains the
 *   operator's off switch and narrowing knob.
 */
export const DEFAULT_REDRIVE_CALLBACK_PATHS: readonly string[] = [
  'execution-ready-signoff-callback',
  'kanban/approval-callback',
];

/**
 * Rails whose RECEIVER resolves its own target list from the board, so a blank
 * `metadata.todoListId` on the row is not a missing target.
 *
 * ⛔ THIS IS WHY THE `todoListId` TERM IN THE SELECTOR IS NARROWED RATHER THAN
 * DELETED. "Never send without a target" is still the right rule for a receiver that
 * can only use what fr hands it; it is simply the wrong QUESTION to ask of one that
 * looks the target up itself. Deleting the term outright would lift the requirement
 * for every future rail too, silently, on evidence gathered about one of them.
 *
 * MEASURED on the deployed `yG1N9K2hTswEZNTq` (see DEFAULT_REDRIVE_CALLBACK_PATHS):
 * `todoListId = ctx.todoListId || resolved.TODO || ''`, where `resolved.TODO` comes
 * from a live `Planka: Get Board Lists` normalised through the router's KIND set
 * (TODO / TO DO / BACKLOG). An unresolvable list falls through to 'Add Comment Only'
 * and reports `cardMoved:false` honestly — a visible no-move, not a fake success.
 *
 * ⚠️ MEMBERSHIP IS A MEASUREMENT OF A DEPLOYED WORKFLOW, NOT A GUESS FROM ITS NAME.
 * Before adding a rail here, read its `Resolve Target List` equivalent on the ACTIVE
 * version in n8n's `workflow_entity` and confirm it derives the list itself. A rail
 * listed here wrongly gets its whole attempt cap burned against a receiver that
 * cannot route it.
 */
export const RECEIVERS_RESOLVING_OWN_TARGET_LIST: ReadonlySet<string> = new Set([
  'kanban/approval-callback',
]);

/**
 * The allow-list in force, normalised the same way `sendN8nExpiryCallback`
 * normalises the stored value.
 *
 * ⛔ AN EMPTY ENV DISABLES THE REDRIVE RATHER THAN RESTORING THE DEFAULT.
 * `APPROVAL_EXPIRY_REDRIVE_PATHS=''` must mean "send to nobody" — the operator's
 * off switch. Falling back to the default there would make the off switch arm the
 * thing it was set to disarm.
 *
 * ⛔ AND A PATH OUTSIDE `EXPIRY_CALLBACK_PATHS` IS DROPPED, LOUDLY.
 * `sendN8nExpiryCallback` refuses such a path with `skipped-unsupported-receiver`,
 * so admitting it here would select rows that can only ever be refused — a config
 * change that reads as armed and delivers nothing.
 */
export function redriveCallbackPaths(): string[] {
  const raw = process.env.APPROVAL_EXPIRY_REDRIVE_PATHS;
  const requested =
    raw === undefined
      ? [...DEFAULT_REDRIVE_CALLBACK_PATHS]
      : raw
          .split(',')
          .map((p) => normalizeCallbackPath(p.trim()))
          .filter((p) => p.length > 0);
  const admitted = requested.filter((p) => EXPIRY_CALLBACK_PATHS.has(p));
  for (const p of requested) {
    if (!admitted.includes(p)) {
      console.error(
        `[approval-expiry] APPROVAL_EXPIRY_REDRIVE_PATHS names "${p}", which is not in ` +
          'EXPIRY_CALLBACK_PATHS (services/n8n-callback.ts) — sends to it would be refused ' +
          'as skipped-unsupported-receiver, so it is DROPPED from the redrive allow-list. ' +
          'Teach the receiver and add it there first.',
      );
    }
  }
  return admitted;
}

/**
 * Rows per redrive pass.
 *
 * Deliberately the same 10 as `MAX_PER_RUN` in workers/deblock-callback-redelivery.ts
 * and for the same reason stated there: every row costs a Planka read plus an
 * outbound send, and 20 of the original failures on that path were Planka 504s
 * under load.
 */
export const REDRIVE_LIMIT = 10;

/**
 * The ATTEMPT CAP. The bound that makes a redrive safe against a NON-IDEMPOTENT
 * receiver at all.
 *
 * ⭐ IT WORKS BECAUSE OF WHERE THE COUNTER IS INCREMENTED, NOT BECAUSE OF ITS
 * VALUE. `sendN8nExpiryCallback` (services/n8n-callback.ts:498) increments
 * `callback_send_attempts` IMMEDIATELY BEFORE the send, not after a 2xx. So an
 * ABANDONED send still counts — which is exactly the case a receiver that hangs
 * past the 30 s abort produces, and exactly the case a cap keyed on success would
 * fail to bound. A hanging receiver therefore cannot loop.
 *
 * 5, matching MAX_SEND_ATTEMPTS in the de-block worker. ⚠️ NO INTERFERENCE
 * between the two: that worker's population is `status IN ('approved','voided')`
 * and this one's is `status='expired'`. Statuses are terminal and disjoint, so no
 * row is ever counted by both — the same argument services/n8n-callback.ts already
 * makes about this counter.
 */
export const MAX_REDRIVE_SEND_ATTEMPTS = 5;

/**
 * How long after an ACK a row may be re-sent.
 *
 * The ack is NOT proof of delivery (see the header) but it IS proof the receiver
 * took the notice, and a receiver measured at p95 81.8 s deserves more than a tick
 * to act on it. 30 minutes is the same grace `ACK_GRACE_MS` gives the de-block
 * worker, for the same reason.
 */
export const REDRIVE_ACK_GRACE_SECONDS = 1_800;

/**
 * How long a row rests after ANY write to it before the redrive may pick it up.
 *
 * ⭐ THIS IS THE CROSS-REPLICA DE-DUP, and it is the reason a row deferred by THIS
 * tick's `notifyExpired` is redriven on the NEXT tick rather than seconds later in
 * the same one. `recordCallbacksDeferred`, `recordCallbackFailure` and
 * `sendN8nExpiryCallback`'s attempt increment all set `updated_at = now()`, so the
 * row rests after each.
 *
 * ⚠️ IT IS A DAMPER, NOT A LOCK, AND THIS FILE DOES NOT PRETEND OTHERWISE. The
 * redrive runs AFTER the tick's advisory-locked transaction has committed (it must:
 * it does network I/O), so two replicas could in principle select one row inside one
 * cooldown. fr runs ONE replica today (measured 2026-09-11: `kubectl get deploy fr
 * -n fr` -> `spec.replicas: 1`), and the attempt cap above bounds the worst case to
 * 5 sends per row no matter how many replicas make them. Holding the lock across the
 * sends — which workers/deblock-callback-redelivery.ts does — would mean restructuring
 * the reaper's transaction, which is out of scope and NOT free (see the cost note on
 * FAST_LANE_DEADLINE_SHARE there).
 *
 * 600 s < the 900 s tick interval, so the damper can never make a row skip a tick.
 */
export const REDRIVE_ROW_COOLDOWN_SECONDS = 600;

/** Pace between sends. The same 500 ms the de-block worker paces at. */
export const REDRIVE_PACE_MS = 500;

/**
 * Wall-clock ceiling for the whole redrive phase of one tick.
 *
 * Sized against the WORK, and it is the second of two budgets that must both fit
 * inside the 900 s interval: `notifyDeadlineMs()` (300 s) then this (300 s), worst
 * case 600 s. REDRIVE_LIMIT (10) rows x (one Planka read + one send abandoned at
 * `expiryCallbackTimeoutMs()`, 30 s) is ~310 s, so this bound is right-sized for the
 * limit rather than picked round.
 *
 * Checked BEFORE a row, never during, so a hung row always overshoots by one — the
 * same property, and the same bounded cost, as the notice phase above.
 * Env: APPROVAL_EXPIRY_REDRIVE_DEADLINE_MS.
 */
export const DEFAULT_REDRIVE_DEADLINE_MS = 300_000;

export function redriveDeadlineMs(): number {
  const raw = Number(
    process.env.APPROVAL_EXPIRY_REDRIVE_DEADLINE_MS ?? DEFAULT_REDRIVE_DEADLINE_MS,
  );
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_REDRIVE_DEADLINE_MS;
}

/** One redrive candidate. The index signature is what `db.execute<T>` requires. */
export interface RedriveRow extends Record<string, unknown> {
  id: string;
  card_id: string;
  callback_path: string;
  callback_send_attempts: number;
  callback_acked_at: Date | string | null;
}

/**
 * THE SELECTOR. Every term is load-bearing and none is decorative; the comment
 * beside each one is why it cannot be dropped.
 *
 * ⛔ AND IT IS STILL NOT SUFFICIENT ON ITS OWN. It narrows the population to rows
 * that COULD need a re-send; whether one is actually sent is decided AFTER this, by
 * the live Planka read in `redriveExpiredCallbacks`. SQL cannot see where a card is.
 */
export function redriveCandidateSql(paths: readonly string[], limit: number) {
  // ⛔ REFUSED RATHER THAN RENDERED. An empty allow-list would emit `IN ()`, which is a
  // syntax error, and a caller reaching here with one has already lost the property the
  // allow-list exists for. `redriveExpiredCallbacks` returns before calling this; the
  // throw is for anyone else.
  if (paths.length === 0) {
    throw new Error('redriveCandidateSql: the callback_path allow-list is empty');
  }
  // ⛔ INTERSECTED WITH THE ALLOW-LIST IN FORCE, NOT USED RAW. The relaxation below
  // may only ever apply to a rail this query is already admitting; taking the set
  // directly would let a path the operator has REMOVED from
  // `APPROVAL_EXPIRY_REDRIVE_PATHS` still widen a predicate, which is the off switch
  // arming the thing it was set to disarm — the same trap `redriveCallbackPaths`
  // names about an empty env.
  const resolvingPaths = paths.filter((p) => RECEIVERS_RESOLVING_OWN_TARGET_LIST.has(p));
  return sql`
    SELECT a.id,
           a.card_id,
           a.callback_path,
           a.callback_send_attempts,
           a.callback_acked_at
      FROM approvals a
     -- ⛔ THE STATUS CLAUSE IS THE HARD SEPARATOR FROM THE DE-BLOCK REDELIVERY
     -- WORKER, AND IT IS LOAD-BEARING — DO NOT DROP IT, AND DO NOT REPLACE IT WITH
     -- A DATE PREDICATE.
     --
     -- workers/deblock-callback-redelivery.ts :: candidateWhereBase selects
     -- a.status IN ('approved','voided','rejected') AND a.callback_delivered_at IS
     -- NULL. Those rows carry a DECISION, and a decision can be STALE relative to
     -- the card's CURRENT block — re-delivering one moves a live card against an
     -- obsolete answer. That is precisely the population PR #1093 was closed for
     -- reaching. Measured 2026-09-13 on prod: 238 such rows
     -- (callback_delivered_at IS NOT NULL AND callback_resolution IS NULL), 176
     -- approved + 62 voided, ALL of them already decided, and 224 of the 238 are
     -- already PAST their expires_at.
     --
     -- ⚠️ SO THE DISCRIMINATOR IS status, NEVER THE DATE. A selector keyed on
     -- expires_at < now() without a status term would sweep 224 of those 238 onto
     -- this rail. 'expired' admits ONLY rows that expired WITHOUT a decision — an
     -- expired row has no approval_decisions row at all, so there is no decision
     -- here that could be stale. The notice this path sends is decision:'expired',
     -- a RE-QUEUE, not a verdict.
     --
     -- VERIFIED 2026-09-13: SELECT count(*) FROM approvals WHERE status='expired'
     -- AND status IN ('approved','voided','rejected') = 0. The statuses are terminal
     -- and disjoint, so no row can be a candidate for both workers. There is also no
     -- shared helper or query: redriveCandidateSql has exactly ONE production call
     -- site (redriveExpiredCallbacks), neither module imports the other, and this
     -- path never reads or writes callback_delivered_at.
     WHERE a.status = 'expired'
       -- No card ⇒ no live join is possible ⇒ this path may never send for it.
       AND a.card_id IS NOT NULL
       AND a.callback_path IS NOT NULL
       -- ltrim, because callback_path is stored with or without a leading slash;
       -- this is the SQL spelling of normalizeCallbackPath, which the allow-list
       -- has already been put through.
       --
       -- ⚠️ AN IN LIST OF BOUND SCALARS, NOT = ANY($1::text[]). Drizzle binds a JS
       -- array as ONE parameter, so the array form reached Postgres as the scalar
       -- 'execution-ready-signoff-callback' and raised 22P02 malformed array literal —
       -- caught by the integration suite, not by tsc. Same sql.join shape
       -- recordCallbacksDeferred above already uses for its id list.
       AND ltrim(a.callback_path, '/') IN (${sql.join(
         paths.map((p) => sql`${p}`),
         sql`, `,
       )})
       -- Terminal already: retired by this path as not_blocked / send_exhausted,
       -- or by anything else. NULL is the only non-terminal value.
       AND a.callback_resolution IS NULL
       -- The attempt cap. See MAX_REDRIVE_SEND_ATTEMPTS: the counter moves BEFORE
       -- the send, so an abandoned send still bounds the loop.
       AND a.callback_send_attempts < ${MAX_REDRIVE_SEND_ATTEMPTS}
       -- ⭐ THE POPULATION: a row THIS PATH TRIED AND DID NOT DELIVER. Not every
       -- expired row and not every unacked row — #1093 selected on
       -- callback_acked_at IS NULL alone and that is what made it unsafe.
       --
       -- ⚠️ CORRECTED — THIS TERM USED TO BE THE DEFERRED MARKER ALONE, AND ITS
       -- STATED REASON WAS WRONG. It read "A row that was reached and refused is a
       -- different defect and is not this path's to re-drive." It is the SAME
       -- defect (expired + un-notified + un-re-queued + 422 on any decision), it
       -- has no other repair path anywhere in the repo, and it is the only one of
       -- the two arms with rows in it: the deferred marker matched ZERO rows on
       -- prod 2026-09-11 while 61 failures were recorded on this path, 59 of them
       -- "abandoned after 2000ms". The full refutation, and why the four guards
       -- bound a failed row exactly as they bound a deferred one, is on
       -- NOTIFY_FAILED_MARKER above.
       AND (a.error_message LIKE ${'%' + NOTIFY_DEFERRED_MARKER + '%'}
            OR a.error_message LIKE ${'%' + NOTIFY_FAILED_MARKER + '%'})
       -- An ack is not delivery, but it IS the receiver saying it took the notice.
       -- Give it the grace window before assuming it did nothing with it.
       AND (a.callback_acked_at IS NULL
            OR a.callback_acked_at < now() - make_interval(secs => ${REDRIVE_ACK_GRACE_SECONDS}))
       -- The damper. See REDRIVE_ROW_COOLDOWN_SECONDS.
       AND a.updated_at <= now() - make_interval(secs => ${REDRIVE_ROW_COOLDOWN_SECONDS})
       -- ⛔ NEVER SEND WITHOUT A TARGET — UNLESS THE RECEIVER FINDS ITS OWN.
       --
       -- ⚠️ CORRECTED 2026-09-13 (#1098). This term used to be unconditional, and
       -- its stated premise was FALSE: "a null/blank listId makes that a silent
       -- no-op the receiver reports as success". Measured against the LIVE ACTIVE
       -- workflow, kanban/approval-callback :: Resolve Target List computes
       -- todoListId = ctx.todoListId || resolved.TODO || '' from a live board
       -- read, and DELIBERATELY does not throw. The full refutation, with the
       -- deploy check, is on DEFAULT_REDRIVE_CALLBACK_PATHS above.
       --
       -- The rule is KEPT for every rail that can only use what fr hands it, and
       -- lifted ONLY for the measured set in RECEIVERS_RESOLVING_OWN_TARGET_LIST.
       -- Measured: 0 of 82 blank on the signoff rail (so this is inert there) and
       -- 367 of 367 blank on the kanban rail, whose minter
       -- (blocked-escalate.json :: Build Notification) hardcodes todoListId: ''
       -- and has never once populated it. The term was not protecting a
       -- population; it was defining one.
       AND (coalesce(a.metadata->>'todoListId', '') <> ''${
         resolvingPaths.length === 0
           ? sql``
           : sql` OR ltrim(a.callback_path, '/') IN (${sql.join(
               resolvingPaths.map((p) => sql`${p}`),
               sql`, `,
             )})`
       })
       -- ⛔ DO NOT YANK A CARD OUT FROM UNDER A LIVE GATE. A card carrying a pending
       -- approval is waiting on a human; moving it to TODO strands the gate instead of
       -- the card. Same refusal as GUARD 3 in scripts/backfill-expired-signoff-requeue.ts.
       AND NOT EXISTS (SELECT 1 FROM approvals p
                        WHERE p.card_id = a.card_id AND p.status = 'pending')
     -- ⚠️ , a.id IS NOT NOISE. expireBatch sets completed_at = now() and the whole
     -- 09-22 cohort shares one expires_at, so ORDER BY that column ALONE is a total tie
     -- inside a bolus and the LIMIT takes an arbitrary subset with no tiebreaker — the
     -- non-blocking finding on PR #1093. The id makes the order total and the walk
     -- deterministic across ticks.
     ORDER BY a.expires_at, a.id
     LIMIT ${limit}
     FOR UPDATE SKIP LOCKED
  `;
}

/**
 * The terminal values this path may write into `callback_resolution`.
 *
 * ⭐ REUSED FROM workers/deblock-callback-redelivery.ts — NOT new values, and no
 * migration. `approvals_callback_resolution_check` (verified live on worker4
 * 2026-09-11) admits exactly `moved | not_blocked | card_unreadable |
 * send_exhausted | hold_acknowledged`, and two of those mean here precisely what
 * they mean there:
 *
 *   `not_blocked`     the live read said the card is not in BLOCKED. Identical
 *                     measurement, identical wording, same gate (`isBlockedList`).
 *   `send_exhausted`  the attempt counter hit its ceiling and the card never moved.
 *
 * ⛔ AND `card_unreadable` IS DELIBERATELY NOT AMONG THEM. That value is the OUTPUT
 * OF A STRIKE MACHINE in the sibling worker — consecutive definitive 404s, a minimum
 * wall-clock span, and a Planka-wide breaker — and none of those inputs exist here.
 * An unreadable card on this path is a SKIP, counted and looked at again next tick.
 * Writing the sibling's conclusion without the sibling's evidence is how one Planka
 * blip retires a backlog.
 *
 * ⚠️ WRITING THIS COLUMN ON AN `expired` ROW IS NEW, AND services/n8n-callback.ts
 * REFUSES TO DO IT — read that refusal before assuming this contradicts it. It
 * refuses to classify a row merely because a notice was SENT, because that would
 * pre-retire the whole cohort if the de-block worker's predicate were ever widened
 * to `expired`. This writes only when the row is genuinely FINISHED — the card has
 * moved, or five attempts are spent — which is the conclusion a widened predicate
 * would itself have to reach. Recording the attempt would have pre-empted that
 * decision; recording the outcome does not.
 */
export type RedriveResolution = 'not_blocked' | 'send_exhausted';

/**
 * Retire a row as `not_blocked`.
 *
 * Guarded on `callback_resolution IS NULL` so a concurrent writer cannot be
 * overwritten, and `RETURNING id` is the answer to "was I the one who retired it".
 * Never throws: the read that justified it already happened and losing the stamp
 * costs one wasted read next tick, not a wrong send.
 */
async function retireRedriveRowNotBlocked(
  db: typeof defaultDb,
  approvalId: string,
  listName: string,
): Promise<boolean> {
  try {
    const rows = await db.execute<{ id: string }>(sql`
      UPDATE approvals
         SET callback_resolution = 'not_blocked',
             error_message = coalesce(error_message, '')
                             || ${' | n8n re-queue redrive RETIRED: card is in "' +
                                  listName.slice(0, 120) +
                                  '", not BLOCKED — nothing to re-queue, NOT sent'},
             updated_at = now()
       WHERE id = ${approvalId}::uuid
         AND callback_resolution IS NULL
      RETURNING id
    `);
    return Array.isArray(rows) && rows.length > 0;
  } catch (err) {
    console.error(
      `[approval-expiry] could not retire ${approvalId} as not_blocked:`,
      errMessage(err),
    );
    return false;
  }
}

/**
 * Retire a row as `send_exhausted` — but ONLY if the counter really is at the
 * ceiling.
 *
 * ⭐ THE PREDICATE IS IN THE UPDATE, NOT IN TYPESCRIPT, AND THAT IS THE POINT. The
 * increment inside `sendN8nExpiryCallback` is best-effort and SWALLOWS ITS OWN
 * FAILURE, so `row.callback_send_attempts + 1` computed locally is a guess about a
 * write that may not have landed. Asking Postgres for the real value makes it
 * impossible to retire a row that still has attempts left — the direction that
 * matters, because a wrongly-retired row is one this path can never look at again.
 *
 * `RETURNING callback_send_attempts` so the caller can say the number out loud
 * instead of restating the constant.
 */
async function retireRedriveRowExhausted(
  db: typeof defaultDb,
  approvalId: string,
): Promise<{ attempts: number; everAcked: boolean } | null> {
  try {
    const rows = await db.execute<{
      callback_send_attempts: number;
      callback_acked_at: Date | string | null;
    }>(sql`
      UPDATE approvals
         SET callback_resolution = 'send_exhausted',
             error_message = coalesce(error_message, '')
                             || ${' | n8n re-queue redrive EXHAUSTED after ' +
                                  String(MAX_REDRIVE_SEND_ATTEMPTS) +
                                  ' send attempts; the card is still BLOCKED and needs a human'},
             updated_at = now()
       WHERE id = ${approvalId}::uuid
         AND callback_resolution IS NULL
         AND callback_send_attempts >= ${MAX_REDRIVE_SEND_ATTEMPTS}
      -- ⚠️ callback_acked_at COMES BACK FROM THE UPDATE, NOT FROM THE SELECTED ROW.
      -- The candidate was read BEFORE this tick's send, so its ack column is one send
      -- out of date: a row that acked for the first time on the attempt that exhausted
      -- it would be reported as "NO receiver ever acked it" while the column says
      -- otherwise. The retire is the last write, so its RETURNING is the only value
      -- that cannot already be stale.
      RETURNING callback_send_attempts, callback_acked_at
    `);
    const list = Array.isArray(rows)
      ? (rows as { callback_send_attempts: number; callback_acked_at: Date | string | null }[])
      : [];
    if (list.length === 0) return null;
    return {
      attempts: Number(list[0]!.callback_send_attempts),
      everAcked: list[0]!.callback_acked_at !== null,
    };
  } catch (err) {
    console.error(
      `[approval-expiry] could not retire ${approvalId} as send_exhausted:`,
      errMessage(err),
    );
    return null;
  }
}

/**
 * Build the production reader, or `null` if it cannot be built.
 *
 * ⛔ NO NEW CREDENTIALS ARE INTRODUCED BY THIS PATH. `startApprovalExpiryWorker`
 * (server.ts) runs in the SAME PROCESS as `startDeblockRedeliveryWorker`, which
 * already calls `plankaClient.asAgent()` on every tick; PLANKA_BASE_URL and
 * PLANKA_AGENT_EMAIL are on `deploy/fr` today (verified 2026-09-11).
 *
 * Never throws: a redrive that cannot read Planka must degrade to doing nothing,
 * loudly, rather than take the reaper down with it.
 */
function safeCardStateReader(): PlankaReader | null {
  try {
    return plankaReaderFrom(plankaClient);
  } catch (err) {
    console.error(
      '[approval-expiry] could not build the Planka card-state reader; the redrive ' +
        'phase is SKIPPED this tick (no send can be justified without it):',
      errMessage(err),
    );
    return null;
  }
}

/**
 * Re-drive expiry notices for rows a previous tick ran out of time on.
 *
 * Never throws. The rows are already expired and already stamped; this phase is
 * repair, and a repair that can fail the tick is worse than one that does nothing.
 */
export async function redriveExpiredCallbacks(
  db: typeof defaultDb,
  result: ExpiryTickResult,
): Promise<void> {
  const paths = redriveCallbackPaths();
  if (paths.length === 0) return;

  // ⭐ SEEDED AT ZERO FOR EVERY CONFIGURED RAIL, AND SEEDED HERE — BEFORE the
  // reader check, before the select, before anything that can return early.
  // Same unconditional rule the horizon gauges are held to: a rail that vanishes
  // at 0 is indistinguishable from a rail nobody is producing, and for THIS
  // metric that is the difference between "the new rail moved every card" and
  // "the redrive never ran". Both would otherwise render as an absent series.
  for (const p of paths) {
    result.redriveAckEffects[p] ??= emptyRedriveAckEffectCounts();
  }

  const reader = safeCardStateReader();
  if (reader === null) return;

  const send = sendN8nExpiryCallback;
  const pace = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  let rows: RedriveRow[];
  try {
    rows = (await db.execute<RedriveRow>(
      redriveCandidateSql(paths, REDRIVE_LIMIT),
    )) as unknown as RedriveRow[];
    if (!Array.isArray(rows)) rows = [];
  } catch (err) {
    console.error('[approval-expiry] redrive candidate select failed:', errMessage(err));
    return;
  }

  result.redriveCandidates = rows.length;
  if (rows.length === 0) return;

  const deadline = Date.now() + redriveDeadlineMs();

  for (const row of rows) {
    // Checked BEFORE the row, not during: crossing it mid-row would still cost a
    // full Planka read plus a full per-send timeout for every remaining row.
    // ⛔ NOT STAMPED. These rows already carry the deferred marker and are still
    // selectable; appending a second notice every tick would grow `error_message`
    // without bound and tell a reader nothing the counter does not.
    if (Date.now() >= deadline) {
      result.redriveDeferred += 1;
      continue;
    }

    // ── THE EFFECT OBSERVATION (#1098). READ-ONLY, AND IT DECIDES NOTHING. ───
    //
    // ⛔ NOTHING BELOW THIS LINE BRANCHES ON `ackedOnAnEarlierTick`. It is read
    // by two counter increments and by nothing else — no predicate, no cap, no
    // send, no write. Grep it: the only two uses are the `+= 1`s below.
    //
    // ⭐ "ON AN EARLIER TICK" IS THE SELECTOR'S GUARANTEE, NOT AN ASSUMPTION OF
    // MINE. `redriveCandidateSql` admits a row only when `callback_acked_at IS
    // NULL OR callback_acked_at < now() - REDRIVE_ACK_GRACE_SECONDS`. So a
    // non-null value here is necessarily ≥1800 s old — the receiver acked, the
    // grace window elapsed, and the row is STILL unresolved and still selectable.
    // That is exactly the population whose effect we cannot otherwise see.
    const rail = normalizeCallbackPath(row.callback_path);
    const effects = (result.redriveAckEffects[rail] ??= emptyRedriveAckEffectCounts());
    const ackedOnAnEarlierTick =
      row.callback_acked_at !== null && row.callback_acked_at !== undefined;

    // ── THE LIVE JOIN. The ONLY authority on whether to send. ────────────────
    let listName: string;
    try {
      listName = await reader.currentListName(row.card_id);
    } catch (err) {
      // ⛔ UNREADABLE IS NOT "NOT BLOCKED" AND IT IS NOT "BLOCKED". No send, no
      // retire, no strike. Evidence about Planka, not about this row.
      result.redriveUnreadable += 1;
      console.warn(
        `[approval-expiry] redrive could not read card ${row.card_id} for approval ` +
          `${row.id}; NOT sent and NOT retired: ${errMessage(err)}`,
      );
      continue;
    }

    if (!isBlockedList(listName)) {
      // ⭐ COUNTED ON THE OBSERVATION, NOT ON THE RETIRE. Deliberately BEFORE the
      // UPDATE and outside its `if`: whether the card moved is a fact about the
      // card, and `retireRedriveRowNotBlocked` returning false (another tick got
      // there first) does not un-move it. Counting inside the `if` would
      // under-report the success bucket and inflate the apparent failure rate.
      if (ackedOnAnEarlierTick) effects.moved += 1;
      // The card already moved. There is nothing to re-queue, and sending would
      // move a card that is where it belongs — the "110 DONE cards dragged back"
      // shape this whole design exists to refuse.
      if (await retireRedriveRowNotBlocked(db, row.id, listName)) {
        result.redriveNotBlocked += 1;
      }
      continue;
    }

    // ⚠️ THE SIGNAL. A receiver acked this row ≥REDRIVE_ACK_GRACE_SECONDS ago and
    // the card is STILL parked. On the `kanban/approval-callback` rail that is
    // the "Add Comment Only" arm: 200 back, `redriveSent` up, card unmoved.
    //
    // ⛔ INDEPENDENT OF `effects.moved` ABOVE — two conditions over the same live
    // read, never one derived from the other. `unreadable` rows `continue`d
    // before reaching either, so they are in NEITHER bucket, which is the honest
    // answer: a Planka blip is evidence about Planka, not about this card.
    if (ackedOnAnEarlierTick) effects.still_blocked += 1;

    // ── THE CARD IS STILL PARKED. Send. ─────────────────────────────────────
    let outcome: Awaited<ReturnType<typeof sendN8nExpiryCallback>>;
    try {
      outcome = await send(row.id, { db });
    } catch (err) {
      // Documented never to throw; if it ever does, the phase must not abort.
      outcome = { outcome: 'failed', error: errMessage(err) };
    }

    switch (outcome.outcome) {
      case 'sent':
        result.redriveSent += 1;
        break;
      case 'failed':
        result.redriveFailed += 1;
        // Append-only, and BOUNDED by the attempt cap above — at most 5 of these
        // can ever be written onto one row.
        await recordCallbackFailure(db, row.id, outcome.error ?? 'unknown error');
        break;
      default:
        // skipped-*: the sender refused on a guard the selector should have made
        // unreachable. A wrong premise is a reason to look again, never to retire.
        result.redriveRefused += 1;
        console.warn(
          `[approval-expiry] redrive sender refused ${row.id} with ` +
            `"${outcome.outcome}" — the selector admitted a row the sender will not ` +
            'take; the premise is wrong, not the row',
        );
        break;
    }

    // ── THE CAP, CHECKED AFTER THE ATTEMPT ──────────────────────────────────
    //
    // ⛔ EVERY OUTCOME EXCEPT `sent`. This used to be unconditional, and that was a
    // DEFECT, not a simplification: a row sitting at MAX-1 whose last permitted send
    // returned 2xx and ACKED was retired `send_exhausted`, which wrote
    //   "EXHAUSTED after 5 send attempts; the card is still BLOCKED and needs a human"
    // into its DURABLE `error_message` and onto a `console.error` a human triages —
    // and NEITHER CLAUSE WAS TRUE AT THAT INSTANT. The send had just succeeded and the
    // receiver was moving the card. The integration suite pinned it as the spec
    // (`redriveSent: 2` and `redriveExhausted: 1` asserted in one block, both sends
    // 2xx), so nothing could ever have caught it.
    //
    // ⭐ THE BOUND IS UNCHANGED, AND THAT IS WHY THIS IS SAFE. What bounds the loop is
    // the COUNTER, not this write: `sendN8nExpiryCallback` increments BEFORE the send,
    // and the selector excludes on `callback_send_attempts < MAX_REDRIVE_SEND_ATTEMPTS`
    // alone. A row at the ceiling is unselectable with or without a
    // `callback_resolution`, so no sixth send is reachable either way. The retire is a
    // VERDICT, not the fuse.
    //
    // ⭐ AND `failed` / `skipped-*` STILL RETIRE, deliberately — that is the property
    // the old unconditional call was reaching for and it survives verbatim. The counter
    // moved before the send, so a send ABANDONED at the 30 s timeout (reported `failed`)
    // has spent an attempt exactly like a refused one, and a hanging receiver therefore
    // still terminates at 5. Only a 2xx is excluded, and only a 2xx is a non-failure.
    //
    // ⛔ SO WHAT IS THE TERMINAL STATE OF A SUCCESSFUL FINAL ATTEMPT? THERE IS NONE, AND
    // THAT IS THE DECISION. `callback_resolution` stays NULL, and `callback_acked_at`
    // (already stamped by the sender) IS the outcome. Both of the values
    // `approvals_callback_resolution_check` could admit here would be a claim this path
    // cannot support one millisecond after a 2xx:
    //   `send_exhausted`  false on its face — the send succeeded.
    //   `moved`           needs a live Planka re-read, and re-reading HERE would RACE
    //                     the receiver (measured ~26 s mean, 33% of executions past
    //                     fr's own 30 s abort), so it would mostly answer "still
    //                     BLOCKED" and pin the wrong verdict permanently.
    // A NULL that means "fr handed the notice over and does not yet know what came of
    // it" is the honest reading, and it is what the row already said before this tick.
    // The cost is that the row leaves the queue with no verdict, so it is said OUT LOUD
    // below rather than left to be inferred from an absence.
    const spent =
      outcome.outcome === 'sent' ? null : await retireRedriveRowExhausted(db, row.id);
    if (outcome.outcome === 'sent' && row.callback_send_attempts + 1 >= MAX_REDRIVE_SEND_ATTEMPTS) {
      // ⚠️ THE COUNT IS THE SELECTOR'S PRE-SEND VALUE PLUS ONE, i.e. a LOCAL ESTIMATE —
      // the increment swallows its own failure, so this can overstate. It gates a LOG
      // LINE ONLY; every write above is gated by the UPDATE's own `>=` predicate against
      // the real column, which is the distinction `retireRedriveRowExhausted`'s docblock
      // draws and this must not erode.
      console.warn(
        `[approval-expiry] redrive spent the LAST permitted attempt on approval ${row.id} ` +
          `(card ${row.card_id}) and n8n ACKED it — this is NOT an exhaustion and the row is ` +
          'NOT retired. It carries no callback_resolution because an ack is not a delivery: ' +
          'fr handed the notice over and cannot see whether the card left BLOCKED. The ' +
          'attempt cap makes it unselectable from here, so if the card is still in BLOCKED ' +
          'later, that is the receiver to check — not this worker.',
      );
    }
    if (spent !== null) {
      result.redriveExhausted += 1;
      // ⛔ `describeSendExhaustion` / `recordSendExhaustion` (the de-block worker's
      // pair) are NOT reused here, and the reason is measured rather than stylistic.
      //   1. `fr_deblock_redelivery_exhausted_total`'s own HELP text says
      //      "retired as send_exhausted BY workers/deblock-callback-redelivery.ts".
      //      Folding a second worker into it with no distinguishing label makes one
      //      metric name mean two things — the objection HOLD_CAUSES already raises
      //      about reusing that counter for holds. This phase reports its own series.
      //   2. `causeOfSendExhaustion` is a re-labelling of `classifyDeblockExit`, and
      //      `execution.ready_signoff` is a WHOLE-KIND carve-out there — so every
      //      acked row on the default allow-list (measured: 82 of 82 are that kind)
      //      would be labelled `exempt_lane`, whose docblock reads "this row's exit
      //      was never a card move in the first place". On the expiry rail the exit
      //      IS the move to TODO. A constant, wrong label is worse than none.
      // What is left is the one discriminator that IS true here, and it is stated
      // rather than encoded: did any receiver ever ack this row.
      console.error(
        `[approval-expiry] redrive EXHAUSTED approval ${row.id} (card ${row.card_id}) ` +
          `after ${spent.attempts} send attempt(s): the card is still in BLOCKED and no ` +
          'further send will be made. ' +
          (spent.everAcked
            ? 'n8n ACKED at least one of those sends and the card still did not move — ' +
              'check the receiver.'
            : 'NO receiver ever acked it — check fr and the callback_path before n8n.') +
          ' Queue: callback_resolution = \'send_exhausted\'.',
      );
    }

    await pace(REDRIVE_PACE_MS);
  }

  if (result.redriveDeferred > 0) {
    console.warn(
      `[approval-expiry] redrive ran out of its ${redriveDeadlineMs()}ms budget with ` +
        `${result.redriveDeferred} candidate(s) unexamined — they keep their marker and ` +
        'are selected again next tick.',
    );
  }
}

// ---------------------------------------------------------------------------
// Expiry-horizon telemetry  (OBSERVATION ONLY — writes nothing, defers nothing)
// ---------------------------------------------------------------------------
//
// THE GAP THIS CLOSES
//
// Everything above this line is the reaper: it makes a lapsed approval legible
// AFTER the fact. Nothing anywhere warned BEFORE the fact. Measured on prod
// (worker4, db `fr`, 2026-09-04): **925 pending approvals expire inside 7 days**
// — 86 on 2026-09-09 and 839 on 2026-09-10 — and not one alert, log line or
// metric said so. Expiry is one-way (routes/approvals.ts handleUpdateApproval
// 422s any decision on a non-pending row), so every one of those 925 becomes
// permanently undecidable the moment the reaper reaches it.
//
// WHY THE WIDEST HORIZON IS 7d AND NOT 72h
//
// The TTL is bimodal, not uniformly 14 days: 591 rows carry 8d and 564 carry
// 14d. Rolling-window counts on prod the day this was written were 1-4d = 0,
// 5d = 437, 6d = 925, 7d = 925. A 72h window therefore reads **0 today** and
// first goes non-zero at 2026-09-06 22:34 — ~2.5 days of notice for a 925-row
// bolus, from an alert that looks healthy right up until it is too late to act.
// The 24h and 72h buckets are kept because they are the ones that say "this is
// now urgent"; 7d is the one that can actually be acted on.
//
// WHY IT PUSHES INSTEAD OF BEING SCRAPED
//
// Same reason as workers/scheduled-trigger-health.ts, and that reasoning is not
// reopened here: fr has an exporter (routes/metrics.ts handlePromMetrics) that
// is never scraped — the `fr` pod carries no `prometheus.io/*` annotations, and
// the namespace is ambient-meshed, so scraping it would mean
// `portLevelMtls: PERMISSIVE` on the port that serves the whole authenticated
// API. Every live `fr_*` series comes from the pushgateway instead, and
// `PUSHGATEWAY_URL` is already on `deploy/fr`.
//
// WHY IT LIVES IN THIS FILE
//
// Deliberate. A new worker would need registering in server.ts; this hangs off
// a tick that already runs in fr-backend on the same 15-minute cadence and
// already holds the DB connection, and it touches no file any other open change
// touches. It runs AFTER the reaper in the same tick, so the counts it reports
// are the post-reap truth rather than a snapshot that disagrees with the log
// line printed beside it.
//
// ⚠️ IT MUST NOT BE ABLE TO LIE. Two rules follow from that and both are pinned
// by tests:
//   * every horizon is emitted on every push INCLUDING when the count is 0. A
//     gauge that vanishes at 0 is indistinguishable from a gauge nobody is
//     producing, which makes the alert unfalsifiable in exactly the direction
//     that matters.
//   * `fr_approval_horizon_push_timestamp_seconds` is the `absent()`/staleness
//     partner. Without it, "fr stopped reporting" reads as "nothing is
//     expiring".
//
// The paired alert rule is a separate gitops change and is NOT in this repo.

/** Pushgateway grouping key. One group per job; each push REPLACES it. */
export const APPROVAL_HORIZON_PUSHGATEWAY_JOB = 'fr-approval-horizon';

/**
 * Wall-clock bound on the pushgateway POST.
 *
 * ⛔ NOT a retry budget and NOT tuning — it is the difference between a failure
 * and a HANG. `fetch` with no signal waits for the socket forever, and this
 * estate drops packets silently at a FORWARD chain rule (no RST, no FIN), so
 * "the connection never settles" is a shape that has actually happened here.
 * An untimed observability POST is therefore a way for a worker to stop
 * existing with zero log lines. 10 s is far above any healthy pushgateway POST
 * (single-digit ms in-cluster) and far below the 15-minute tick interval.
 */
export const PUSHGATEWAY_PUSH_TIMEOUT_MS = 10_000;

/**
 * The horizons reported, as CUMULATIVE windows from `now`: a row expiring in
 * 20 hours is counted in all three, not only in `24h`. Cumulative is what an
 * alert can threshold without needing to sum buckets, and it is why the
 * sequence must stay strictly increasing — a test pins that.
 *
 * `seconds` is the wire value: it is what the query interpolates and what the
 * boundary test asserts against, so a horizon cannot be relabelled without the
 * window moving with it.
 */
export const HORIZON_BUCKETS = [
  { label: '24h', seconds: 86_400 },
  { label: '72h', seconds: 259_200 },
  { label: '7d', seconds: 604_800 },
] as const;

export type HorizonLabel = (typeof HORIZON_BUCKETS)[number]['label'];

/** One count per horizon. Always fully populated — there is no absent bucket. */
export type ApprovalHorizonCounts = Record<HorizonLabel, number>;

/** Zero for every horizon. The shape a push falls back to, never `{}`. */
export function emptyApprovalHorizonCounts(): ApprovalHorizonCounts {
  return Object.fromEntries(
    HORIZON_BUCKETS.map((b) => [b.label, 0]),
  ) as ApprovalHorizonCounts;
}

// ---------------------------------------------------------------------------
//
// THE SECOND GAP: THE RE-QUEUE NOTICE HAS NO SUCCESS RECORD
//
// The reaper above already knows, per tick, exactly what happened to every
// re-queue notice — `notifyExpired` counts `callbacksSent`, `callbacksFailed`,
// `callbacksSkipped`, `callbacksUnsupported` and `callbacksDeferred` into the
// tick result. That result then escapes through ONE `console.log` in `runOnce`
// and is otherwise thrown away.
//
// Only FAILURE was durable. `recordCallbackFailure` / `recordCallbacksDeferred`
// append to `approvals.error_message`. Measured on prod (worker4, db `fr`,
// 2026-09-08): of 120 expired rows, 61 carry a recorded failure and **59 carry
// nothing** — and for those 59 `sent`, `skipped-unsupported-receiver` and
// `skipped-no-callback-path` were indistinguishable from each other FOREVER.
// "We re-queued it", "we refused to fire at a receiver that cannot route
// `expired`" and "it was web-only, there was nothing to fire at" are three very
// different operational states that shared one blank column.
//
// ⭐ THE PER-ROW HALF IS NOW CLOSED, AND THE GAUGE BELOW IS THE OTHER HALF —
// they measure different things and neither replaces the other. This family is
// PER TICK and aggregate: it says six numbers about the last tick that reaped
// and cannot name a row. `sendN8nExpiryCallback` now also writes PER ROW —
// `callback_send_attempts` incremented immediately BEFORE the send, and
// `callback_acked_at` stamped on the receiver's 2xx. Read together with the
// columns already on the row, every outcome is recoverable after the fact:
//
//   sent                          attempts >= 1, callback_acked_at NOT NULL
//   failed (incl. timeout)        attempts >= 1, acked NULL, error_message set
//   skipped-unsupported-receiver  attempts  = 0, acked NULL, callback_path NOT NULL
//   skipped-no-callback-path      callback_path IS NULL
//
// ⚠️ THE 59 HISTORICAL ROWS STAY AMBIGUOUS. Nothing can reconstruct what was
// never recorded; this fixes the instrument from here on. A backfill would be
// fabrication, not repair.
//
// ⛔ WHAT THIS DOES NOT ESTABLISH. `sent` means `sendApprovalDecision` returned
// without throwing, i.e. a 2xx from the receiver. It does NOT prove the card was
// re-queued: services/n8n-callback.ts is itself the evidence that a 2xx is not an
// effect. This family measures the LOCAL outcome of an attempt, nothing beyond
// the wire.
//
// ⛔ IT ALSO DOES NOT SAY THE RE-QUEUE HAS NEVER WORKED. `callback_delivered_at`
// — which since 113 means THE CARD MOVED — is written only by
// workers/deblock-callback-redelivery.ts, whose predicate is
// `WHERE a.status IN ('approved','voided')`, so it excludes `expired` by
// construction, as that file's own comment says. That is still true and is NOT
// changed here: whether an expired card-blocking approval should be re-raised is
// the open question named in that worker, and widening its predicate needs its
// own decision. So a blank `callback_delivered_at` on an expired row remains
// evidence of NOTHING, and the ack columns above must not be read as delivery.
//
// ⚖️ GAUGE, NOT COUNTER — deliberate, and the name says so.
//
// A `_total` here would be a lie in the Prometheus sense. Making it cumulative
// needs per-process state, and the grouping key for this push is `job` ALONE
// (see APPROVAL_HORIZON_PUSHGATEWAY_JOB and the URL built below — there is no
// `instance`). Two fr pods, which is exactly what a rolling update produces,
// would then push two different partial running totals into ONE series and the
// result is arithmetic garbage rather than a counter with an honest reset. Both
// series already in this push are gauges; this is the third.
//
// So it reports the LAST TICK THAT ACTUALLY REAPED, and is named
// `..._last_tick` so no reader can mistake it for a cumulative count.
// `lastCallbackOutcomes` below is why a tick that lost the advisory lock (all
// counters legitimately 0) does not erase the numbers from the tick that won it.
//
// The paired alert rule is a separate gitops change and is NOT in this repo.

/**
 * The `outcome` label values, one per branch of the switch in `notifyExpired`.
 *
 * ⚠️ This is a METRIC label, never part of the grouping key. A grouping-key
 * label would create one immortal pushgateway group per value that ordinary
 * reaping cannot delete; as a metric label the six series live inside the one
 * `job="fr-approval-horizon"` group and are replaced wholesale on every push.
 */
export const CALLBACK_OUTCOME_LABELS = [
  'sent',
  'failed',
  // The receiver answered 409/410 — the waiting execution is gone, so the
  // notice was moot and its row was retired. A SIXTH value, not a re-use of
  // `failed`: the alert filters `outcome="failed"` and must not fire here.
  'already-terminal',
  'unsupported',
  'skipped',
  'deferred',
] as const;

export type CallbackOutcomeLabel = (typeof CALLBACK_OUTCOME_LABELS)[number];

/** One count per outcome. Always fully populated — there is no absent outcome. */
export type ApprovalCallbackOutcomeCounts = Record<CallbackOutcomeLabel, number>;

/** Zero for every outcome. The shape a push falls back to, never `{}`. */
export function emptyApprovalCallbackOutcomeCounts(): ApprovalCallbackOutcomeCounts {
  return Object.fromEntries(
    CALLBACK_OUTCOME_LABELS.map((l) => [l, 0]),
  ) as ApprovalCallbackOutcomeCounts;
}

/**
 * Project a tick result onto the label set.
 *
 * Pure, exported, and asserted directly by tests: this is the ONLY place the
 * worker's six field names are mapped to the six wire label values, so a
 * field renamed on one side without the other is a test failure rather than a
 * silently-zero series.
 */
export function callbackOutcomesFromTick(
  result: Pick<
    ExpiryTickResult,
    | 'callbacksSent'
    | 'callbacksFailed'
    | 'callbacksAlreadyTerminal'
    | 'callbacksSkipped'
    | 'callbacksUnsupported'
    | 'callbacksDeferred'
  >,
): ApprovalCallbackOutcomeCounts {
  return {
    sent: result.callbacksSent,
    failed: result.callbacksFailed,
    'already-terminal': result.callbacksAlreadyTerminal,
    unsupported: result.callbacksUnsupported,
    skipped: result.callbacksSkipped,
    deferred: result.callbacksDeferred,
  };
}

/**
 * The redrive's per-tick label values.
 *
 * ⛔ A SEPARATE FAMILY, NOT EXTRA LABELS ON `CALLBACK_OUTCOME_LABELS`. That set is
 * pinned by tests and describes NOTICES SENT FOR THE FIRST TIME; a re-send is a
 * different measurement and three of the values below (`not_blocked`,
 * `unreadable`, `exhausted`) have no counterpart there at all. The label KEY also
 * differs (`result=` vs `outcome=`) so a query cannot silently match both.
 *
 * ⚖️ GAUGE, for the reason the family above states at length: the grouping key for
 * this push is `job` ALONE, so two fr pods pushing partial running totals into one
 * series is arithmetic garbage rather than a counter with an honest reset.
 */
export const REDRIVE_RESULT_LABELS = [
  'candidates',
  'sent',
  'failed',
  'refused',
  'not_blocked',
  'unreadable',
  'exhausted',
  'deferred',
] as const;

export type RedriveResultLabel = (typeof REDRIVE_RESULT_LABELS)[number];

/** One count per label. Always fully populated — there is no absent result. */
export type ApprovalRedriveCounts = Record<RedriveResultLabel, number>;

/** Zero for every label. The shape a push falls back to, never `{}`. */
export function emptyApprovalRedriveCounts(): ApprovalRedriveCounts {
  return Object.fromEntries(
    REDRIVE_RESULT_LABELS.map((l) => [l, 0]),
  ) as ApprovalRedriveCounts;
}

// ---------------------------------------------------------------------------
// THE EFFECT COUNTERS (#1098) — "the receiver said yes" vs "the card moved"
// ---------------------------------------------------------------------------
//
// ⛔ EVERY COUNTER ABOVE THIS LINE REPORTS DELIVERY, AND DELIVERY IS THE THING
// THAT LIES IN THIS FAILURE MODE.
//
// #1110 widened the redrive onto `kanban/approval-callback`, a rail with ZERO
// prior production executions. Its first real run is the 2026-09-22 cohort:
// measured on worker4 `fr`, 367 rows on that rail plus 82 on the pre-existing
// `execution-ready-signoff-callback` rail = 449 in one tick.
//
// The degradation that rail can produce is invisible to all eight counters
// above. A board with no TODO-normalising list falls through the receiver's
// "Add Comment Only" arm. n8n answers 200. `redriveSent` increments. The row
// posts a comment, comes back next tick, burns another of its five
// `callback_send_attempts`, and retires `send_exhausted` WITH THE CARD STILL
// BLOCKED. Every number reads healthy while 367 cards end where they started.
//
// The sibling worker has already measured this exact shape on its own rail:
// deblock-callback-redelivery reported healthy throughput while `moved` sat at
// 15 of 119 processed. Delivery counters are precisely the ones that lie here.
//
// ⭐ SO THE LOAD-BEARING QUESTION IS NOT "DID THE SEND SUCCEED" BUT "DID THE CARD
// LEAVE BLOCKED AFTER A RECEIVER ALREADY SAID IT TOOK THE NOTICE" — and that can
// only be answered on a LATER TICK than the ack.
//
// ⛔ AND IT MUST NOT BE ANSWERED BY RE-READING PLANKA HERE. The retire docblock
// in `redriveExpiredCallbacks` settles that: a read taken right after a 2xx
// RACES the receiver (~26 s mean, 33% of executions past fr's own 30 s abort),
// so it would mostly answer "still BLOCKED" and pin a verdict that is wrong.
//
// ⭐ THE OBSERVATION IS THEREFORE FREE, AND THAT IS THE WHOLE DESIGN. The redrive
// selector ALREADY excludes any row acked inside `REDRIVE_ACK_GRACE_SECONDS`
// (1800 s, two ticks at the 15-minute cadence). So a candidate that reaches the
// loop CARRYING a non-null `callback_acked_at` is, by the selector's own
// predicate, a row some receiver acked at least half an hour ago and which is
// STILL unresolved. The loop then performs the live Planka read anyway, because
// that read is what decides whether to send. Reading the answer twice costs
// nothing: ZERO new queries, ZERO new HTTP, ZERO new failure modes.
//
//   acked earlier + live read says BLOCKED     -> still_blocked  ⚠️ THE SIGNAL
//   acked earlier + live read says NOT blocked -> moved          ✅ it worked
//
// ⛔ COUNTED BY TWO INDEPENDENT CONDITIONS, NEVER ONE MINUS THE OTHER — the same
// rule deblock-callback-redelivery's census states for its `COUNT(*) FILTER`
// clauses. `unreadable` is neither, and a subtraction would silently attribute
// every Planka blip to whichever bucket it was derived from.
//
// ⛔ AND THEY ARE A SEPARATE METRIC FAMILY, NOT TWO MORE `result` LABELS. The
// eight labels above PARTITION the candidates — `sum by(result)` equals
// `candidates`. These two are an ORTHOGONAL dimension: a row counted
// `still_blocked` is ALSO counted `sent` on the very same tick. Folding them in
// would break that sum and make one metric name mean two things.
//
// ⚠️ PER RAIL, AND THAT IS LOAD-BEARING TOO. 367 of the 449 rows travel the new
// rail and 82 the proven one. An aggregate number hides the case this whole
// change exists for: the new rail failing while the old one works.

/** The two effects. `still_blocked` is the one an operator acts on. */
export const REDRIVE_ACK_EFFECT_LABELS = ['still_blocked', 'moved'] as const;

export type RedriveAckEffectLabel = (typeof REDRIVE_ACK_EFFECT_LABELS)[number];

/** One count per effect, for ONE rail. Always fully populated, never `{}`. */
export type RedriveAckEffectCounts = Record<RedriveAckEffectLabel, number>;

/** Per-rail effect counts, keyed by NORMALIZED `callback_path`. */
export type ApprovalRedriveAckEffects = Record<string, RedriveAckEffectCounts>;

/** Zero for both effects. The shape a rail falls back to, never absent. */
export function emptyRedriveAckEffectCounts(): RedriveAckEffectCounts {
  return Object.fromEntries(
    REDRIVE_ACK_EFFECT_LABELS.map((l) => [l, 0]),
  ) as RedriveAckEffectCounts;
}

/**
 * Sum one effect across every rail. For the log line only — the metric keeps the
 * rails apart, because the aggregate is what hides a single-rail failure.
 */
export function totalRedriveAckEffect(
  effects: ApprovalRedriveAckEffects,
  label: RedriveAckEffectLabel,
): number {
  return Object.values(effects).reduce((n, counts) => n + (counts[label] ?? 0), 0);
}

/**
 * Project a tick result onto the redrive label set. Pure, exported, asserted
 * directly — the ONLY place the eight field names are mapped to the eight wire
 * values, so a field renamed on one side is a test failure rather than a silently
 * zero series.
 */
export function redriveOutcomesFromTick(
  result: Pick<
    ExpiryTickResult,
    | 'redriveCandidates'
    | 'redriveSent'
    | 'redriveFailed'
    | 'redriveRefused'
    | 'redriveNotBlocked'
    | 'redriveUnreadable'
    | 'redriveExhausted'
    | 'redriveDeferred'
  >,
): ApprovalRedriveCounts {
  return {
    candidates: result.redriveCandidates,
    sent: result.redriveSent,
    failed: result.redriveFailed,
    refused: result.redriveRefused,
    not_blocked: result.redriveNotBlocked,
    unreadable: result.redriveUnreadable,
    exhausted: result.redriveExhausted,
    deferred: result.redriveDeferred,
  };
}

/**
 * Bucket a set of expiry instants into the cumulative horizons.
 *
 * PRODUCTION USES THIS — the query below returns one raw `expires_at` per
 * pending row inside the widest horizon and this decides the counts. That is
 * the point: bucketing done in SQL could only be boundary-tested against a live
 * database, and a boundary test that skips when Postgres is unreachable is not
 * a boundary test. Here the rule is one pure function, asserted directly.
 *
 * The comparison is INCLUSIVE (`<=`): a row expiring at exactly `now + 24h` is
 * inside the 24h window. Exclusive would put the single most urgent row in a
 * boundary tick into the wrong bucket, which is the one row an operator most
 * needs to see.
 *
 * Rows already past `now` are counted in every horizon. In steady state the
 * reaper has just cleared them so this is 0; when it is not, the 24h bucket
 * rising is a true signal that the reaper is not keeping up — not noise.
 */
export function bucketApprovalsByHorizon(
  expiresAt: readonly Date[],
  now: Date,
): ApprovalHorizonCounts {
  const counts = emptyApprovalHorizonCounts();
  const nowMs = now.getTime();
  for (const at of expiresAt) {
    const deltaSeconds = (at.getTime() - nowMs) / 1000;
    for (const bucket of HORIZON_BUCKETS) {
      if (deltaSeconds <= bucket.seconds) counts[bucket.label] += 1;
    }
  }
  return counts;
}

/** A row of the horizon query. The index signature is what `db.execute<T>` wants. */
interface HorizonRow extends Record<string, unknown> {
  expires_at: string | Date;
  /**
   * Postgres's `now()`, carried on every row so the bucketing uses the SAME
   * clock as the predicate that selected the row. `now()` is the statement
   * timestamp, so it is identical across the result set. Without it a replica
   * whose clock runs fast would fetch on DB time and bucket on local time, and
   * a row could be selected by the 7d predicate yet bucketed into none of the
   * three — a silent undercount in the direction of "nothing is expiring".
   */
  ref_now: string | Date;
}

function toDate(v: string | Date): Date {
  return v instanceof Date ? v : new Date(v);
}

/**
 * Read every pending approval whose deadline falls inside the WIDEST horizon,
 * in ONE query.
 *
 * One round-trip, not one per bucket: three separate reads at 15-minute cadence
 * against prod would be wasteful and — worse — could disagree with each other,
 * producing a `24h` count larger than the `7d` count it is nested inside. One
 * SELECT means one snapshot and the nesting cannot be violated.
 *
 * ⛔ READ-ONLY. A single SELECT. No row is written, no expiry is deferred, and
 * nothing here can influence what the reaper above does.
 *
 * ⚖️ WHY IT RETURNS ROWS RATHER THAN THREE `count(*) FILTER` AGGREGATES — this
 * is a deliberate trade, not an oversight. Aggregating in SQL returns three
 * integers instead of N timestamps, which is cheaper on the wire. But it also
 * puts the entire boundary rule (`<=` vs `<`, cumulative vs disjoint) inside a
 * string that can only be checked against a live database, and a boundary test
 * that skips when Postgres is unreachable is not a boundary test. Bucketing in
 * `bucketApprovalsByHorizon` puts that rule in a pure function the tests assert
 * directly, on the same code path production runs.
 *
 * The cost of that choice is bounded by construction: the predicate IS the
 * widest horizon, so the result is exactly the population the metric describes
 * — 925 rows on prod today, one `timestamptz` each, roughly 30 KB once every 15
 * minutes. For this to become expensive, the number of approvals about to lapse
 * would have to grow by orders of magnitude, which is the condition the metric
 * exists to shout about.
 *
 * `now()` is evaluated by Postgres for the same reason the reaper does it — a
 * clock-skewed replica must not shift the window.
 */
export async function collectApprovalExpiryHorizon(
  db: typeof defaultDb = defaultDb,
): Promise<ApprovalHorizonCounts> {
  const widestSeconds = HORIZON_BUCKETS[HORIZON_BUCKETS.length - 1]!.seconds;
  const rows = await db.execute<HorizonRow>(sql`
    SELECT expires_at,
           now() AS ref_now
      FROM approvals
     WHERE status = 'pending'
       AND expires_at <= now() + make_interval(secs => ${widestSeconds})
  `);
  const list = Array.isArray(rows) ? (rows as HorizonRow[]) : [];
  // Zero rows means zero in every horizon whatever the reference instant is, so
  // falling back to the local clock there cannot change the answer.
  const reference = list.length > 0 ? toDate(list[0]!.ref_now) : new Date();
  return bucketApprovalsByHorizon(
    list.map((r) => toDate(r.expires_at)),
    reference,
  );
}

// ---------------------------------------------------------------------------
// fr_approvals_pending_total / fr_approvals_pending_oldest_age_seconds
//
// `collectApprovalExpiryHorizon` above answers "how many are about to lapse".
// It is NOT a backlog gauge and was never meant to be read as one: it counts
// only rows with a non-null `expires_at` inside the widest horizon, so it
// misses every NULL-expiry row (a card-blocking approval never expires, by
// design — see the `expires_at` column comment) and every row expiring
// further out than 7d. Measured on prod 2026-09-11: the horizon's 7d bucket
// read 161 while the true pending count was 1,267 — 12.7% of the backlog.
// These two metrics report the WHOLE population instead, independent of any
// expiry window, which is what makes "the queue stopped moving" expressible
// even when nothing is about to expire.
// ---------------------------------------------------------------------------

/**
 * Canonical `approval_kind` enum values (`db/schema.ts::approvalKindEnum`),
 * mirrored here — not imported from the schema — so this file can emit every
 * kind on every push, including at 0, the same falsifiability rule the
 * horizon buckets and callback/redrive outcomes above already follow. ⚠️ KEEP
 * IN SYNC WITH THE ENUM: a kind added to `approval_kind` and not here is still
 * counted correctly in `fr_approvals_pending_total`'s total (see
 * `collectApprovalBacklog`), it simply will not get its own labelled series
 * until this list is updated.
 */
export const APPROVAL_KIND_LABELS = [
  'generic',
  'improvement.design',
  'improvement.release',
  'execution.ready_signoff',
  'improvement.canary_action',
] as const;

export type ApprovalKindLabel = (typeof APPROVAL_KIND_LABELS)[number];

/** One pending count per kind. Always fully populated — no absent kind. */
export type ApprovalBacklogByKind = Record<ApprovalKindLabel, number>;

/** Zero for every kind. The shape a push falls back to, never `{}`. */
export function emptyApprovalBacklogByKind(): ApprovalBacklogByKind {
  return Object.fromEntries(
    APPROVAL_KIND_LABELS.map((k) => [k, 0]),
  ) as ApprovalBacklogByKind;
}

export interface ApprovalBacklogSnapshot {
  /** Pending count by kind. `total` is the sum; use it, do not re-sum this. */
  byKind: ApprovalBacklogByKind;
  /** The WHOLE pending backlog, every kind, every expiry (or none). */
  total: number;
  /**
   * Age, in seconds, of the oldest pending row (`min(created_at)`), against
   * the SAME statement `now()` the query read — see `collectApprovalExpiryHorizon`
   * on why the reference clock must come from Postgres, not the local clock.
   * 0 when the queue is empty (there is no "oldest" of nothing).
   */
  oldestAgeSeconds: number;
}

/** Zero backlog snapshot. The shape a push falls back to, never partially populated. */
export function emptyApprovalBacklogSnapshot(): ApprovalBacklogSnapshot {
  return { byKind: emptyApprovalBacklogByKind(), total: 0, oldestAgeSeconds: 0 };
}

/** A row of the backlog query. The index signature is what `db.execute<T>` wants. */
interface BacklogRow extends Record<string, unknown> {
  kind: string;
  pending_count: string | number;
  oldest_created_at: string | Date | null;
  ref_now: string | Date;
}

/**
 * Read the WHOLE pending backlog, grouped by kind, in ONE query — the whole
 * population this time, not a horizon slice. See the file header above this
 * section for why the horizon query cannot stand in for this.
 *
 * ⛔ READ-ONLY. A single SELECT, `GROUP BY kind`. No row is written and
 * nothing here can influence what the reaper does.
 */
export async function collectApprovalBacklog(
  db: typeof defaultDb = defaultDb,
): Promise<ApprovalBacklogSnapshot> {
  const rows = await db.execute<BacklogRow>(sql`
    SELECT kind::text AS kind,
           count(*) AS pending_count,
           min(created_at) AS oldest_created_at,
           now() AS ref_now
      FROM approvals
     WHERE status = 'pending'
     GROUP BY kind
  `);
  const list = Array.isArray(rows) ? (rows as BacklogRow[]) : [];
  const byKind = emptyApprovalBacklogByKind();
  let total = 0;
  let oldest: Date | null = null;
  const reference = list.length > 0 ? toDate(list[0]!.ref_now) : new Date();
  for (const r of list) {
    const count = Number(r.pending_count);
    total += count;
    if ((r.kind as ApprovalKindLabel) in byKind) {
      byKind[r.kind as ApprovalKindLabel] = count;
    }
    if (r.oldest_created_at != null) {
      const at = toDate(r.oldest_created_at);
      if (oldest === null || at.getTime() < oldest.getTime()) oldest = at;
    }
  }
  const oldestAgeSeconds =
    oldest === null ? 0 : Math.max(0, (reference.getTime() - oldest.getTime()) / 1000);
  return { byKind, total, oldestAgeSeconds };
}

// ---------------------------------------------------------------------------
// fr_approval_decisions_total
//
// The numerator `approval_callback_received_total` cannot be: that counter
// only moves AFTER a human decides, so during any quiet period (the reaper
// stalled 07:00Z 2026-09-11 onward, measured) it is a permanent false alarm
// of its own — it cannot distinguish "nobody has decided anything in hours"
// from "there was nothing to decide". This counts DECISIONS, from the table
// that records them, so throughput has a real denominator-free numerator.
// ---------------------------------------------------------------------------

/** The only two values the application ever writes to `approval_decisions.decision`. */
export const DECISION_LABELS = ['approved', 'rejected'] as const;

export type DecisionLabel = (typeof DECISION_LABELS)[number];

export type ApprovalDecisionCounts = Record<DecisionLabel, number>;

/** Zero for every decision label. The shape a push falls back to, never `{}`. */
export function emptyApprovalDecisionCounts(): ApprovalDecisionCounts {
  return Object.fromEntries(DECISION_LABELS.map((d) => [d, 0])) as ApprovalDecisionCounts;
}

/** A row of the decision-count query. */
interface DecisionCountRow extends Record<string, unknown> {
  decision: string;
  n: string | number;
}

/**
 * Read the TOTAL decisions ever recorded, by decision, in ONE query.
 *
 * ⚠️ THIS IS A COUNTER BUILT FROM A COUNT(*), AND `COUNT(*)` IS ONLY MONOTONIC
 * WHILE ROWS ARE NEVER REMOVED. `approval_decisions` rows cascade-delete with
 * their parent `approvals` row (`ON DELETE CASCADE`); today nothing in this
 * codebase hard-deletes an approval, but an approval hard-delete, a future
 * retention/purge job, or a tenant-offboarding purge would each make this read
 * go backwards. That is a property of CURRENT POLICY, not of this function —
 * do not assume it stays true without re-reading this comment. Because the
 * assumption cannot be trusted blindly, the caller (`publishApprovalExpiryHorizon`)
 * clamps the raw read against the highest value this process has ever
 * published (`clampDecisionTotalsMonotonic`) rather than publishing it as-is.
 *
 * ⛔ READ-ONLY. A single SELECT, `GROUP BY decision`. Never called from any
 * decide/reject/void code path — this must not be able to influence a
 * decision, only count ones already made.
 */
export async function collectApprovalDecisionTotals(
  db: typeof defaultDb = defaultDb,
): Promise<ApprovalDecisionCounts> {
  const rows = await db.execute<DecisionCountRow>(sql`
    SELECT decision, count(*) AS n
      FROM approval_decisions
     GROUP BY decision
  `);
  const list = Array.isArray(rows) ? (rows as DecisionCountRow[]) : [];
  const counts = emptyApprovalDecisionCounts();
  for (const r of list) {
    if (r.decision === 'approved' || r.decision === 'rejected') {
      counts[r.decision] = Number(r.n);
    }
  }
  return counts;
}

/**
 * Clamp a freshly read decision-total snapshot against the highest values
 * THIS PROCESS has ever published, per label, and log loudly on a regression
 * instead of letting it reach Prometheus.
 *
 * Pure function so the regression rule is asserted directly rather than only
 * observable through a live counter's process lifetime. See
 * `collectApprovalDecisionTotals` for why the raw read can go backwards at
 * all: a `COUNT(*)` is monotonic only while rows are never removed, and that
 * is a policy fact this code cannot verify, only defend against. A pushed
 * Prometheus counter that decreases makes every `rate()`/`increase()` over it
 * wrong for the WHOLE window it spans, not only the one tick that regressed —
 * publishing the last-known floor instead turns a silent lie into, at worst, a
 * stale-but-monotonic series plus a loud log line.
 */
export function clampDecisionTotalsMonotonic(
  raw: ApprovalDecisionCounts,
  floor: ApprovalDecisionCounts,
): ApprovalDecisionCounts {
  const out = emptyApprovalDecisionCounts();
  for (const label of DECISION_LABELS) {
    const rawVal = raw[label] ?? 0;
    const floorVal = floor[label] ?? 0;
    if (rawVal < floorVal) {
      console.error(
        `[approval-horizon] fr_approval_decisions_total{decision="${label}"} went BACKWARDS ` +
          `(${floorVal} -> ${rawVal}). approval_decisions rows were removed — an approval ` +
          `hard-delete, a retention job, or a tenant purge. Publishing the last-known floor ` +
          `instead of the regressed read to keep the counter monotonic; investigate the removal.`,
      );
      out[label] = floorVal;
    } else {
      out[label] = rawVal;
    }
  }
  return out;
}

/**
 * Render the pushgateway body (exposition format 0.0.4).
 *
 * Both families are emitted UNCONDITIONALLY — every horizon even at 0, and the
 * heartbeat even when nothing is expiring at all. See the ⚠️ above: this is the
 * property that makes the alert falsifiable, and it is asserted by tests rather
 * than left to a reviewer to notice.
 */
export function renderApprovalHorizonMetrics(
  counts: ApprovalHorizonCounts,
  nowSeconds: number,
  callbackOutcomes: ApprovalCallbackOutcomeCounts = emptyApprovalCallbackOutcomeCounts(),
  redriveCounts: ApprovalRedriveCounts = emptyApprovalRedriveCounts(),
  backlog: ApprovalBacklogSnapshot = emptyApprovalBacklogSnapshot(),
  decisionTotals: ApprovalDecisionCounts = emptyApprovalDecisionCounts(),
  redriveAckEffects: ApprovalRedriveAckEffects = {},
): string {
  const lines: string[] = [];

  lines.push(
    '# HELP fr_approvals_pending_expiring Pending approvals whose expires_at falls within the horizon (cumulative).',
  );
  lines.push('# TYPE fr_approvals_pending_expiring gauge');
  for (const bucket of HORIZON_BUCKETS) {
    lines.push(
      `fr_approvals_pending_expiring{horizon="${bucket.label}"} ${counts[bucket.label] ?? 0}`,
    );
  }

  // Same unconditional rule as the horizons above, for the same reason: an
  // outcome that vanishes at 0 is indistinguishable from an outcome nobody is
  // producing. `failed` and `unsupported` are the two an operator acts on, and
  // both are 0 in the healthy case — so 0 has to be emitted, not implied.
  lines.push(
    '# HELP fr_approval_expiry_callback_last_tick Re-queue notices by local outcome on the last expiry tick that ACQUIRED THE LOCK, whether or not it reaped anything — a lock-winning tick that expired nothing reports all-zero. Gauge, NOT cumulative; outcome=sent means the receiver returned 2xx, which does not prove the card was re-queued.',
  );
  lines.push('# TYPE fr_approval_expiry_callback_last_tick gauge');
  for (const label of CALLBACK_OUTCOME_LABELS) {
    lines.push(
      `fr_approval_expiry_callback_last_tick{outcome="${label}"} ${callbackOutcomes[label] ?? 0}`,
    );
  }

  // Same unconditional rule again, and here it is what makes the exhaustion signal
  // falsifiable: `exhausted` and `unreadable` are 0 in the healthy case, so 0 has to
  // be emitted rather than implied. `candidates` is the denominator — without it a
  // zero `sent` cannot be told apart from a zero population, which is the state the
  // redrive is in TODAY (measured on prod 2026-09-11: 0 rows carry the deferred
  // marker, because the notice phase has never once run out of budget).
  lines.push(
    '# HELP fr_approval_expiry_redrive_last_tick Re-drive of expiry re-queue notices a PREVIOUS tick ran out of time on, by result, on the last expiry tick that ACQUIRED THE LOCK. Gauge, NOT cumulative. candidates is the denominator. sent means the receiver returned 2xx, which does not prove the card was re-queued. not_blocked and exhausted are TERMINAL (callback_resolution written); unreadable and deferred are not, and those rows are selected again next tick.',
  );
  lines.push('# TYPE fr_approval_expiry_redrive_last_tick gauge');
  for (const label of REDRIVE_RESULT_LABELS) {
    lines.push(
      `fr_approval_expiry_redrive_last_tick{result="${label}"} ${redriveCounts[label] ?? 0}`,
    );
  }

  // ⭐ THE EFFECT FAMILY (#1098). SEPARATE FROM THE `result` FAMILY ABOVE, because
  // those labels partition the candidates and these do not — a row here is also
  // counted `sent` there. Same unconditional-zero rule, applied PER RAIL: a rail
  // configured but silent must render as 0, not vanish, or "the new rail moved
  // every card" and "the redrive never ran" become the same reading.
  lines.push(
    '# HELP fr_approval_expiry_redrive_ack_effect_last_tick EFFECT, not delivery: redrive candidates that a receiver ALREADY ACKED on an earlier tick (>=REDRIVE_ACK_GRACE_SECONDS ago) and that are still unresolved, split by where the LIVE Planka read found the card on this tick. still_blocked means the ack did NOT move the card — n8n returned 2xx and the card stayed put, which is the one failure fr_approval_expiry_redrive_last_tick{result="sent"} cannot show. moved means it did. Rows whose card could not be read are in NEITHER bucket. Gauge, NOT cumulative, per callback_path rail.',
  );
  lines.push('# TYPE fr_approval_expiry_redrive_ack_effect_last_tick gauge');
  for (const rail of Object.keys(redriveAckEffects).sort()) {
    const counts = redriveAckEffects[rail] ?? emptyRedriveAckEffectCounts();
    for (const label of REDRIVE_ACK_EFFECT_LABELS) {
      lines.push(
        `fr_approval_expiry_redrive_ack_effect_last_tick{rail="${rail}",effect="${label}"} ` +
          `${counts[label] ?? 0}`,
      );
    }
  }

  // The WHOLE pending backlog by kind, independent of any expiry window — see
  // the section header above `collectApprovalBacklog` for why
  // `fr_approvals_pending_expiring` cannot answer this. Same unconditional
  // rule: every kind emitted even at 0.
  lines.push(
    '# HELP fr_approvals_pending_total The WHOLE pending-approval backlog by kind — every pending row, not an expiry-horizon slice (includes NULL-expiry rows and rows expiring beyond any horizon). Gauge, not cumulative-over-time; sum across kind for the total.',
  );
  lines.push('# TYPE fr_approvals_pending_total gauge');
  for (const kind of APPROVAL_KIND_LABELS) {
    lines.push(`fr_approvals_pending_total{kind="${kind}"} ${backlog.byKind[kind] ?? 0}`);
  }

  // Independent of rate: a stalled queue shows this climbing even while
  // `fr_approval_decisions_total` stays flat, which is exactly the failure
  // this metric exists to make visible (measured 2026-09-11: oldest pending
  // row dated 2026-08-28 while decisions had gone to ~0/hour).
  lines.push(
    '# HELP fr_approvals_pending_oldest_age_seconds Age, in seconds, of the oldest pending approval (by created_at). 0 when the queue is empty.',
  );
  lines.push('# TYPE fr_approvals_pending_oldest_age_seconds gauge');
  lines.push(
    `fr_approvals_pending_oldest_age_seconds ${Math.floor(backlog.oldestAgeSeconds)}`,
  );

  // The throughput numerator. See `collectApprovalDecisionTotals` for why this
  // is a DB-derived total rather than a per-process increment, and
  // `clampDecisionTotalsMonotonic` for why the raw read is clamped before it
  // ever reaches here.
  lines.push(
    '# HELP fr_approval_decisions_total Approval decisions ever recorded in approval_decisions, by decision. Counter, re-derived from a full-table count on every push (not a per-process increment), so a pod restart does not reset it. Monotonic only while approval_decisions rows are never removed; a regression is clamped and logged rather than published — see clampDecisionTotalsMonotonic.',
  );
  lines.push('# TYPE fr_approval_decisions_total counter');
  for (const decision of DECISION_LABELS) {
    lines.push(
      `fr_approval_decisions_total{decision="${decision}"} ${decisionTotals[decision] ?? 0}`,
    );
  }

  lines.push(
    '# HELP fr_approval_horizon_push_timestamp_seconds Unix time fr-backend last published approval expiry horizons.',
  );
  lines.push('# TYPE fr_approval_horizon_push_timestamp_seconds gauge');
  lines.push(`fr_approval_horizon_push_timestamp_seconds ${Math.floor(nowSeconds)}`);

  return lines.join('\n') + '\n';
}

/**
 * Collect and push the expiry horizons.
 *
 * NEVER throws: this is observability hanging off the reaper loop, and a
 * pushgateway outage or a slow read must not stop approvals from expiring.
 *
 * NEVER HANGS either, and that is a SEPARATE property from "never throws" — the
 * two were conflated here until #1083. A throw is caught below; a socket that
 * never settles is not, because the catch sits AFTER the await. The POST
 * therefore carries `AbortSignal.timeout(PUSHGATEWAY_PUSH_TIMEOUT_MS)`, which
 * turns the hang into an `AbortError` the existing catch already handles and
 * logs.
 *
 * NEVER silent either. Every failure path logs a line carrying the
 * `[approval-horizon]` prefix and the reason, because the failure mode this
 * whole change exists to remove is "nothing said anything" — recreating it one
 * layer in would be worse than not shipping it. A snapshot that fails still
 * pushes ZEROS with a fresh timestamp only if it succeeded; a failed snapshot
 * pushes nothing, so the heartbeat goes stale and `absent()` fires. That is the
 * honest signal: "fr cannot count its approvals", not "there are none".
 */
export async function publishApprovalExpiryHorizon(
  opts: {
    /**
     * Outcomes of the last tick that won the advisory lock — which may have
     * reaped nothing. Supplied by the scheduler
     * from its own tick result — this function must NOT re-derive them, because
     * the numbers only exist in the process that ran `notifyExpired`.
     */
    callbackOutcomes?: ApprovalCallbackOutcomeCounts;
    /** Same rule and same reason as `callbackOutcomes`: supplied by the scheduler. */
    redriveOutcomes?: ApprovalRedriveCounts;
    /**
     * Same rule again. ⛔ And this one CANNOT be re-derived here even in
     * principle: the effect split comes from the LIVE Planka read the redrive
     * loop already took, and re-reading it from this function would be a second
     * round of Planka traffic answering a question about a moment that has passed.
     */
    redriveAckEffects?: ApprovalRedriveAckEffects;
  } = {},
): Promise<void> {
  const nowSeconds = Date.now() / 1000;
  const logger = console;
  const collect = () => collectApprovalExpiryHorizon(defaultDb);
  const collectBacklog = () => collectApprovalBacklog(defaultDb);
  const collectDecisionTotals = () => collectApprovalDecisionTotals(defaultDb);

  // ⚠️ ALL THREE READS SHARE ONE try/catch, DELIBERATELY. Publishing the
  // backlog while the decisions read failed (or vice versa) would render
  // `fr_approvals_pending_total` climbing beside a `fr_approval_decisions_total`
  // that looks frozen — i.e. it would MANUFACTURE the exact "queue stalled,
  // zero throughput" alarm these metrics exist to report honestly, out of an
  // unrelated read failure. One failure means NO push this tick, same as the
  // horizon-only failure mode already documented below: the heartbeat goes
  // stale and `absent()` fires, instead of a false signal reaching Prometheus.
  let counts: ApprovalHorizonCounts;
  let backlog: ApprovalBacklogSnapshot;
  let decisionTotals: ApprovalDecisionCounts;
  try {
    counts = await collect();
    backlog = await collectBacklog();
    const rawDecisionTotals = await collectDecisionTotals();
    decisionTotals = clampDecisionTotalsMonotonic(rawDecisionTotals, decisionTotalsFloor);
    decisionTotalsFloor = decisionTotals;
  } catch (err) {
    logger.error(
      `[approval-horizon] snapshot failed, NO horizon metrics published this tick: ${errMessage(err)}`,
    );
    return;
  }

  const pushgatewayUrl = process.env.PUSHGATEWAY_URL ?? '';
  if (!pushgatewayUrl) {
    // No hardcoded fallback, per config-externalization-policy.md. The
    // `absent()` half of the alert pair is what catches this where the push
    // was expected.
    return;
  }

  const body = renderApprovalHorizonMetrics(
    counts,
    nowSeconds,
    opts.callbackOutcomes,
    opts.redriveOutcomes,
    backlog,
    decisionTotals,
    opts.redriveAckEffects,
  );
  try {
    const resp = await fetch(
      `${pushgatewayUrl.replace(/\/+$/, '')}/metrics/job/${APPROVAL_HORIZON_PUSHGATEWAY_JOB}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
        // See the docblock: without this the catch below is unreachable on a
        // silent drop and the tick never returns.
        signal: AbortSignal.timeout(PUSHGATEWAY_PUSH_TIMEOUT_MS),
      },
    );
    if (!resp.ok) {
      logger.error(
        `[approval-horizon] pushgateway returned ${resp.status}; horizon metrics NOT updated ` +
          `(24h=${counts['24h']} 72h=${counts['72h']} 7d=${counts['7d']})`,
      );
    }
  } catch (err) {
    logger.error(
      `[approval-horizon] push failed, horizon metrics NOT updated ` +
        `(24h=${counts['24h']} 72h=${counts['72h']} 7d=${counts['7d']}): ${errMessage(err)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Outcomes of the last tick on THIS process that WON THE ADVISORY LOCK.
 *
 * Note the guard is `acquiredLock`, not `expired > 0`: a lock-winning tick that
 * found nothing to expire legitimately publishes all-zero. Those are honest
 * zeros — "this replica looked and there was nothing" — and the HELP text says
 * so, because "the last tick that reaped" would have described a narrower
 * update rule than the code implements.
 *
 * Held across ticks for one reason: a tick that did not win the advisory lock
 * reports 0 for all five counters not because nothing happened but because this
 * replica did not look. Pushing those zeros would erase the real numbers from
 * the replica that did — so only a lock-winning tick updates this, and every
 * push re-sends whatever it last held. Null until this process wins the lock
 * once, which renders as zeros; `runOnce` ticks BEFORE it publishes, so the
 * first push of a healthy process already carries real data.
 */
let lastCallbackOutcomes: ApprovalCallbackOutcomeCounts | null = null;

/** The redrive half of the same rule. Same guard (`acquiredLock`), same reason. */
let lastRedriveOutcomes: ApprovalRedriveCounts | null = null;

/**
 * The EFFECT half (#1098). Same guard (`acquiredLock`), same held-across-ticks
 * rule, and the reason bites harder here: this is the only series that can show
 * a receiver acking without moving the card, so letting a lock-losing replica
 * overwrite it with zeros would erase precisely the signal it exists to carry.
 */
let lastRedriveAckEffects: ApprovalRedriveAckEffects | null = null;

/**
 * The last-published floor for `fr_approval_decisions_total`, per label. See
 * `clampDecisionTotalsMonotonic` and `collectApprovalDecisionTotals` for why
 * the raw DB read is not trusted directly. Starts at 0/0 on process start —
 * deliberately: the DB total is not a per-process increment, so a fresh
 * process's first real read is expected to exceed a 0 floor and must not be
 * clamped down to it.
 */
let decisionTotalsFloor: ApprovalDecisionCounts = emptyApprovalDecisionCounts();

/**
 * Start the periodic reaper. Idempotent — calling twice is a no-op.
 * Interval override: `APPROVAL_EXPIRY_INTERVAL_MS`.
 */
export function startApprovalExpiryWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.APPROVAL_EXPIRY_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[approval-expiry] interval invalid, refusing to start');
    return;
  }

  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runApprovalExpiryTick();
      // Only a tick that WON the lock actually ran `notifyExpired`, so only that
      // tick's counters describe reality. See `lastCallbackOutcomes`.
      if (r.acquiredLock) {
        lastCallbackOutcomes = callbackOutcomesFromTick(r);
        lastRedriveOutcomes = redriveOutcomesFromTick(r);
        lastRedriveAckEffects = r.redriveAckEffects;
      }
      // Log every non-skipped tick that DID something, and every failure. A
      // silent worker that has quietly stopped working is the failure mode
      // this whole change is about, so a failed tick is always loud.
      if (r.outcome === 'failed') {
        console.error(`[approval-expiry] tick failed: ${r.error}`);
      } else if (r.expired > 0) {
        console.log(
          `[approval-expiry] expired=${r.expired} more=${r.more} ` +
            `requeued=${r.callbacksSent} requeue_failed=${r.callbacksFailed} ` +
            `requeue_already_terminal=${r.callbacksAlreadyTerminal} ` +
            `no_callback=${r.callbacksSkipped} unsupported_receiver=${r.callbacksUnsupported} ` +
            `deferred=${r.callbacksDeferred} ` +
            `redrive_candidates=${r.redriveCandidates} redrive_sent=${r.redriveSent} ` +
            `redrive_failed=${r.redriveFailed} redrive_not_blocked=${r.redriveNotBlocked} ` +
            `redrive_unreadable=${r.redriveUnreadable} redrive_exhausted=${r.redriveExhausted} ` +
            // ⭐ EFFECT, PRINTED BESIDE DELIVERY ON PURPOSE. `redrive_sent` high
            // with `redrive_acked_still_blocked` high is the "n8n said 200 and the
            // card never moved" shape — the two numbers only accuse when read
            // together. Per-rail, because 367 of the 449 rows in the 2026-09-22
            // cohort travel a rail that has never run in production and an
            // aggregate would hide it failing alone. Same `{k=v,...}` spelling
            // deblock-callback-redelivery uses for its cause buckets.
            `redrive_acked_still_blocked=${totalRedriveAckEffect(r.redriveAckEffects, 'still_blocked')} ` +
            `redrive_acked_moved=${totalRedriveAckEffect(r.redriveAckEffects, 'moved')} ` +
            `redrive_ack_effect_by_rail={${Object.keys(r.redriveAckEffects)
              .sort()
              .map(
                (rail) =>
                  `${rail}:still_blocked=${r.redriveAckEffects[rail]?.still_blocked ?? 0},` +
                  `moved=${r.redriveAckEffects[rail]?.moved ?? 0}`,
              )
              .join(' ')}} ` +
            '(pending approvals past expires_at -> status=expired, ' +
            'newly-expired rows notified as decision=expired for re-queue)',
        );
      }
    } catch (err) {
      console.error('[approval-expiry] tick threw:', err);
    } finally {
      // ⭐ THE GUARD IS RELEASED HERE, BEFORE ANY PUBLISHING.
      //
      // ⛔ The three publishes below used to run INSIDE this guarded window,
      // under a comment asserting they "cannot throw, so [they] can neither
      // suppress the two pushes that ran before [them] nor stop `tickInFlight`
      // being cleared". That assertion was TRUE FOR A THROW AND FALSE FOR A
      // HANG, and the hang is the case that matters: the `finally` that cleared
      // the guard sat AFTER the awaits, so one pushgateway socket that never
      // settled left `tickInFlight === true` for the life of the pod. Every
      // later tick then hit `if (tickInFlight) return` — no reap, no re-queue,
      // and not one log line, because the early return is silent by design.
      // fr's ONLY pending→expired reaper would have been dead and green.
      //
      // Structural fix, chosen over "just add a timeout": an observability call
      // must not be able to hold a worker's mutual-exclusion guard AT ALL. The
      // guard exists to stop two REAPS overlapping; it was never about the
      // pushes. Releasing it first makes a hung push cost at most a stale
      // gauge — which `absent()` already alerts on — instead of a dead reaper.
      // The bounded timeout inside each publisher is the second layer, not the
      // first. This is the same shape `runScheduledTriggerTickCycle` already
      // uses: guard cleared in the finally, publish afterwards.
      tickInFlight = false;
    }

    // Observation only, and deliberately OUTSIDE the try above so a reaper
    // failure still gets a horizon reading — "the reaper is broken AND 925
    // approvals lapse in 6 days" is precisely when the number is needed most.
    //
    // Each of the three swallows its own errors and each bounds its own POST
    // with `AbortSignal.timeout`. The `allSettled` below is what keeps a dep
    // that breaks the never-throws contract from escaping as an unhandled
    // rejection on the `void runOnce()` call site.
    //
    // ⚠️ If a publisher hangs anyway (its own DB snapshot, say), THIS await
    // never returns and the tick's promise is retained. That is deliberate and
    // it is cheap: the guard is already released, so the cost is one pending
    // promise per tick rather than a dead worker. It is not the same bug.
    //
    // ⛔ `allSettled`, NOT three sequential awaits. Sequentially, a horizon
    // publish that hung on its DB snapshot (`collect()` is a query, and a query
    // can hang too) suppressed the deblock and roster pushes that had nothing
    // wrong with them — one dead upstream silently erasing two unrelated
    // signals. Independent concerns must fail independently.
    const published = await Promise.allSettled([
      publishApprovalExpiryHorizon({
        callbackOutcomes: lastCallbackOutcomes ?? emptyApprovalCallbackOutcomeCounts(),
        redriveOutcomes: lastRedriveOutcomes ?? emptyApprovalRedriveCounts(),
        redriveAckEffects: lastRedriveAckEffects ?? {},
      }),
      // Retention for `lib/deblock-action-metrics.ts`. It rides THIS tick for the
      // reason the horizon emitter documents above: a new worker would need
      // registering in server.ts, whereas this tick already runs in fr-backend on
      // the same 15-minute cadence and already talks to the pushgateway.
      publishDeblockActionMetrics(),
      // Retention for `lib/roster-discharge-metrics.ts` (#1059), for exactly the
      // reason stated above. Its own pushgateway group (`job=fr-roster-discharge`),
      // never folded into the deblock group — see that file on why one group must
      // not carry two concerns.
      publishRosterDischargeMetrics(),
      // Retention for `lib/project-id-emit-metrics.ts` (fr #1143's owner guard),
      // for exactly the reason stated above. Its own pushgateway group
      // (`job=fr-project-id-emit`) — never folded into an existing group, same
      // "one concern per group" rule the roster/deblock split already states.
      publishProjectIdEmitMetrics(),
    ]);
    const PUBLISHER_NAMES = ['horizon', 'deblock', 'roster', 'project-id-emit'] as const;
    published.forEach((outcome, i) => {
      // Each publisher documents that it swallows its own errors, so reaching
      // here means one broke that contract. Loud, never silent.
      if (outcome.status === 'rejected') {
        console.error(
          `[approval-expiry] ${PUBLISHER_NAMES[i]} metrics publish threw ` +
            `(it is documented never to): ${errMessage(outcome.reason)}`,
        );
      }
    });
  };

  // Kick off immediately: on a fresh deploy the backlog is the whole history.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  console.log(`[approval-expiry] scheduler started, interval=${intervalMs}ms`);
}

export function stopApprovalExpiryWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
