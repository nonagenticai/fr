// src/workers/approval-redelivery.ts
//
// Re-delivery for approvals that were never delivered to anybody.
//
// THE DEFECT THIS FIXES
//
// Notification is ONE-SHOT, at mint. `routes/webhooks.ts` and
// `routes/execution-approvals.ts` each resolve an approver, fan out to their
// channels, and call `confirmPushDelivery` — once. If that attempt produced no
// push delivery, `notified_at` is correctly left NULL (it is a MEASUREMENT, not
// an intention) and NOTHING EVER TRIES AGAIN. `workers/approval-expiry.ts` reads
// that column to decide which failure a row records, but it never re-sends.
// Grep `backend/src` for a re-delivery path before this file and there is none.
//
// WHY A WHOLE POPULATION IS IN THAT STATE. `resolveApprover` returns
// `approver: null` when no candidate has an enabled PUSH channel. Until
// 2026-08-19 there was no last-resort human: `APPROVAL_FALLBACK_APPROVER_USER_ID`
// was introduced by gitops #2883, and only 1 of the 8 approval-raising tenants
// has a reachable workspace-admin of its own. So for the other seven, routing
// resolved NOBODY and the approval was minted addressed to no one.
//
// ⛔ `notified_at IS NULL` IS NOT THE DEFECT POPULATION. It is a measurement of
// PUSH delivery, so a row that was successfully delivered by another channel also
// carries NULL. Measured on prod 2026-09-02, the 274 rows it selects are three
// unrelated populations:
//
//    241  no `required_approvers` row AND no `engagement_deliveries` row at all —
//         minted addressed to nobody, never attempted.  ⛔ THIS is the defect.
//      2  an approver exists but every channel is disabled (`skipped_disabled`) —
//         genuinely unreachable, and correctly still in the population.
//     31  DELIVERED — `status='sent'` on channel `inapp`, to the exact human who
//         is on their roster as `execution_signoff`. Visible in the UI already.
//         Re-pushing them is a duplicate aimed at a DIFFERENT human.
//
// So every query below tests for the absence of a CONFIRMED DELIVERY, not merely
// for `notified_at IS NULL`. Without that clause the retry arm's live population on
// the day this shipped was exactly **4 rows, all 4 already delivered in-app**.
//
// The fallback approver does not close this either: 4 of the 274 were minted on
// 2026-08-28, well AFTER `APPROVAL_FALLBACK_APPROVER_USER_ID` landed (gitops #2883,
// 2026-08-19). It names one user, who is workspace-admin of tenant …0003 — while
// tenant …0001, which holds 925 of the 1066 pending rows, has no push-reachable
// admin at all.
//
// ⚠️ AND THEY ARE NOW IMMORTAL. Migration 105 made `expires_at` nullable ("a
// card-blocking approval must not expire") and 106 restored the wrongly-expired
// rows. Both are correct and neither is being second-guessed here — but together
// they removed the 24-hour timer that used to sweep an undelivered approval out of
// `pending`. The result is the worst of both: a request no human has ever seen,
// which will now stay outstanding forever. Expiry was the only thing that made
// these rows legible, and it was deliberately taken away without a re-delivery
// path to replace it. This file is that path.
//
// TWO ARMS, SPLIT BY AGE
//
//   * RETRY (age <= APPROVAL_REDELIVERY_MAX_AGE_DAYS, default 7). Re-resolves the
//     approver and delivers individually, oldest first, capped per tick. This is
//     the durable fix: any approval whose mint-time delivery fails is retried
//     until it lands or ages out.
//
//   * DIGEST (older than that). Never delivered per row. ONE message naming the
//     backlog and its gate_terms breakdown, at most once per
//     APPROVAL_REDELIVERY_DIGEST_INTERVAL_HOURS. The 190-row backlog routes to a
//     single human; re-delivering it row-by-row would put 190 pushes on one
//     person's phone to tell them about work that is 2-6 weeks old. A list is the
//     honest shape for a backlog, and it is what the owner asked for.
//
// The age split is ALSO a retry bound, but on its own it was not enough: the
// retry arm selected `created_at ASC LIMIT <cap>`, so a head-of-queue set of
// permanently unroutable / unconfirmable rows re-occupied the whole batch on
// every tick for MAX_AGE_DAYS, starving every younger approval. Migration 186
// therefore adds an attempt counter and a backoff: after each attempt that did
// not confirm delivery the row is bumped and not re-eligible for
// min(15min * 2^attempts, 24h); at MAX_ATTEMPTS (default 10) it is skipped and
// logged once, and it reaches the human through the digest once it ages out.
//
// WHAT THIS WORKER MUST NEVER DO — each pinned by a test
//
//   * NEVER writes `status`. A re-delivery is not a decision. fr #916 states the
//     principle for the triage route and it binds here identically: a path that
//     can flip status is an approval path that bypasses the roster, the
//     per-approver decision rows and the quorum rule in handleUpdateApproval.
//   * NEVER touches `required_approvers`. ⛔ THIS IS THE IMPORTANT ONE. Quorum is
//     roster CARDINALITY, unanimous (routes/approvals.ts: `allDecisions.length ===
//     allRequiredApprovers.length && every(approved)`), and the estate has exactly
//     ONE push-reachable human. Adding a second approver to "give the row an
//     escalation path" converts every 1-of-1 gate into a 2-of-2 that can never be
//     satisfied — it would read as an improvement in every "is this row
//     actionable" instrument while making the approval permanently undecidable.
//     fr #886 ruled on the mirror image of this: "keep the roster WHOLE — its
//     cardinality is the quorum."
//   * NEVER writes `expires_at`. Non-expiry is deliberate (105/106).
//   * NEVER stamps `notified_at` itself. It calls the shared
//     `confirmPushDelivery`, which stamps only against a real
//     `engagement_deliveries` row with `status='sent'` on a PUSH channel. An
//     optimistic stamp here would recreate the exact ambiguity that made 335
//     undelivered approvals read as somebody's decisions.
//
// CONCURRENCY — and a deliberate departure from workers/approval-expiry.ts.
//
// That worker takes its advisory lock, writes, COMMITS, and only then does network
// I/O, because its batch is 500 rows and an unreachable receiver could hold the
// lock for 83 minutes. This worker holds the transaction-scoped lock across the
// whole tick instead, for a reason that does not apply there: expiry's write is
// idempotent (a row already `expired` cannot re-match `status='pending'`), so a
// duplicated tick is harmless. Re-delivery's effect is a MESSAGE TO A HUMAN, which
// is not idempotent — two replicas racing would double-page. Serialisation is
// therefore worth more here than lock-hold time, and the hold is bounded twice:
// MAX_PER_RUN rows (default 20) and a hard TICK_DEADLINE_MS wall clock, after
// which the remainder is deferred to the next tick rather than dropped.

import { and, desc, eq, sql } from 'drizzle-orm';

// `db` and every table come from db/client, which re-exports schema.ts — see the
// note in domain/engagement/approval-routing.ts. Importing straight from schema.ts
// would type-check and then diverge from the mock surface the tests install.
import { db as defaultDb, engagementDeliveries } from '../db/client';
import { LOCK_KEYS } from '../db/advisory-lock-keys';
import { config } from '../config';
import { confirmPushDelivery, resolveApprover } from '../domain/engagement/approval-routing';
import { fanOutApprovalToTenantMembers } from '../domain/engagement/tenant-member-fanout';
import {
  approvalNotificationCopy,
  notificationService,
  type NotifiableApprovalRow,
} from '../domain/engagement/notifications';
import { deliverApprovalCallbackUrls } from '../services/n8n-callback';

// Advisory-lock key. Registered in src/db/advisory-lock-keys.ts, which is the ONLY
// place fr-backend may declare one.
//
// The hand-copied keyspace registry that used to sit here has been deleted rather
// than updated: that comment form IS the defect mechanism it looked like
// documentation of. Two authors each copied it from a sibling, each read the
// highest listed slot as taken, and each claimed the next one — giving
// scheduled-trigger-run-prune and approval-expiry the same key, silently, with
// `pg_try_advisory_xact_lock` making the loser skip its entire tick with no error
// and no log naming the cause. See advisory-lock-keys.ts for the full account.
//
// 912351 is unchanged: main RESERVED it for this branch by name while the PR was
// open, precisely so the swap needs no renumber and no rolling-deploy window in
// which an old pod holds one key and a new pod holds another.
const ADVISORY_LOCK_KEY = LOCK_KEYS.approvalRedelivery;

/** Every 15 minutes — the same cadence as the expiry reaper it complements. */
const DEFAULT_INTERVAL_MS = 900_000;

/**
 * `engagement_deliveries.engagement_id` for the backlog digest.
 *
 * The column is `text` and nullable, so a sentinel is legal and no migration is
 * needed. It is what makes the digest's rate limit DURABLE: the interval is
 * enforced by querying for the last row with this id, not by an in-process
 * timestamp that a pod restart would reset. A worker that re-sends its digest on
 * every deploy is a worker that trains its reader to ignore it.
 */
export const DIGEST_ENGAGEMENT_ID = 'approval-backlog-digest';
export const DIGEST_ENGAGEMENT_TYPE = 'approval-backlog-digest';

/**
 * "Nobody has ever received this approval", expressed the only way the database
 * can actually answer it.
 *
 * ⚠️ NOT `notified_at IS NULL`. That column is stamped only by `confirmPushDelivery`,
 * i.e. it measures PUSH. A row delivered `inapp` — to a named recipient, recorded
 * `status='sent'` — still carries NULL. Selecting on the column alone made this
 * worker's live retry population 4 rows on 2026-09-02, and all 4 had been delivered
 * in-app to the human on their roster four days earlier.
 *
 * `status = 'sent'` is deliberate rather than `<> 'failed'`: it keeps the rows whose
 * only delivery row is `skipped_disabled` (an approver exists, every channel off) in
 * the population, because those genuinely never arrived.
 *
 * ⚠️ `engagement_deliveries.engagement_id` is TEXT and `approvals.id` is UUID — the
 * `::text` cast is load-bearing; without it Postgres raises
 * `operator does not exist: text = uuid`.
 *
 * Requires the approvals table to be aliased `a`.
 */
const NO_CONFIRMED_DELIVERY = sql`NOT EXISTS (
           SELECT 1
             FROM engagement_deliveries d
            WHERE d.engagement_id = a.id::text
              AND d.engagement_type = 'approval'
              AND d.status = 'sent'
         )`;

/** Rows the RETRY arm may deliver in one tick. Flood control, deliberately low. */
function maxPerRun(): number {
  const raw = Number(process.env.APPROVAL_REDELIVERY_MAX_PER_RUN ?? 20);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 20;
}

/**
 * Age boundary between the retry arm and the digest arm, in days.
 *
 * ⚠️ SIZED AGAINST THE ACTUAL BACKLOG, not picked round. Measured 2026-09-01 over the
 * undelivered rows (ages 14..57 days, median 19): a 14-day boundary leaves **11** of them in
 * the retry arm, so the first tick after deploy would fire 11 individual pushes at one human
 * — the exact burst the digest exists to prevent. At **7** it is one digest and no burst.
 *
 * ⚠️ AND THE BOUNDARY IS NOT WHAT MAKES IT SAFE. Re-measured 2026-09-02: at 7 days the
 * `notified_at IS NULL` population was 4 rows — and all 4 had been delivered `inapp` on
 * 2026-08-28 to the human on their roster. The boundary would have let every one of them
 * through; `NO_CONFIRMED_DELIVERY` is what stops them. Do not treat a small retry count as
 * evidence that the age split is doing the work.
 *
 * It stays generous for the case it is FOR: a genuinely new approval whose mint-time delivery
 * failed is retried every 15 min for a week before it falls back to the digest, and it never
 * stops being reported — only the shape of the report changes.
 */
function maxAgeDays(): number {
  const raw = Number(process.env.APPROVAL_REDELIVERY_MAX_AGE_DAYS ?? 7);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 7;
}

/** Minimum gap between two backlog digests. */
function digestIntervalHours(): number {
  const raw = Number(process.env.APPROVAL_REDELIVERY_DIGEST_INTERVAL_HOURS ?? 24);
  return Number.isFinite(raw) && raw > 0 ? raw : 24;
}

/**
 * Wall-clock ceiling for one tick's delivery phase. Sized against the tick
 * interval, not the batch: the phase holds the advisory lock, so a phase that can
 * outrun the interval is a worker that never ticks again.
 */
function tickDeadlineMs(): number {
  const raw = Number(process.env.APPROVAL_REDELIVERY_TICK_DEADLINE_MS ?? 60_000);
  return Number.isFinite(raw) && raw > 0 ? raw : 60_000;
}

/**
 * Reject after `ms` if `p` has not settled.
 *
 * ⛔ WHY A DEADLINE BETWEEN ROWS IS NOT A DEADLINE. The retry loop below checks
 * `Date.now() >= deadline` before each row, which bounds how many SENDS it
 * starts — it does not bound how long ONE send may run. A single outbound
 * channel (Telegram / e-mail, all real sockets) that never settles
 * therefore blows straight through the wall-clock ceiling `tickDeadlineMs`
 * documents, and it does so while HOLDING advisory lock 912351 inside the
 * tick's transaction. From then on every replica's tick finds the lock taken
 * and returns `outcome: 'skipped'` — which `runOnce` logs NOTHING for — so
 * re-delivery is dead fleet-wide with no error anywhere. The comment on the
 * digest arm already named this hazard and closed only the digest half of it;
 * this closes the retry half.
 *
 * ⚠️ It does not cancel `p`. The abandoned send may still complete, which is
 * why the row's `notified_at` is stamped from `confirmPushDelivery` — a
 * measurement of what the channels accepted — and never from this promise.
 *
 * Local rather than shared: the backend has no promise-timeout utility, and the
 * production idiom (`AbortSignal.timeout` on a `fetch`) does not reach through
 * `notificationService`'s adapter fan-out.
 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new Error(`${what} exceeded ${ms}ms`)), ms);
    if (typeof handle.unref === 'function') handle.unref();
  });
  return Promise.race([p, bell]).finally(() => {
    if (handle !== undefined) clearTimeout(handle);
  }) as Promise<T>;
}

/**
 * Milliseconds this tick may still spend, floored at 1 so a bound is always a
 * real bound. Callers reach here only after passing a `Date.now() >= deadline`
 * check, so the floor is a guard against clock jitter, not the normal path.
 */
function remainingBudgetMs(deadline: number): number {
  return Math.max(1, deadline - Date.now());
}

export type RedeliveryOutcome = 'ok' | 'skipped' | 'failed';

export interface RedeliveryTickResult {
  outcome: RedeliveryOutcome;
  /** True if this replica won the advisory lock for this tick. */
  acquiredLock: boolean;
  /** Rows the retry arm selected. */
  eligible: number;
  /** Rows whose push delivery was CONFIRMED and `notified_at` stamped. */
  delivered: number;
  /**
   * Rows where `resolveApprover` still returns nobody. NOT an error of this
   * worker — it is the routing gap itself, and it is reported rather than
   * silently skipped so it cannot go quiet again.
   */
  unroutable: number;
  /** Fan-out ran but no PUSH channel confirmed. `notified_at` stays NULL. */
  unconfirmed: number;
  /** True when the per-tick cap was exhausted and rows probably remain. */
  more: boolean;
  /** Rows the tick ran out of wall clock to attempt. Deferred, never dropped. */
  deferred: number;
  /** Undelivered rows older than the age boundary — the digest population. */
  backlog: number;
  digestSent: boolean;
  /**
   * D17 callback lane: TERMINAL approvals (approved / rejected / expired / voided)
   * with at least one undelivered, due `callback_url` row (side table, migration 191).
   */
  callbackEligible: number;
  callbackSent: number;
  callbackFailed: number;
  /**
   * Rows the receiver answered 409/410 for: the waiting execution is GONE, so
   * the row was retired and there is nothing to retry. NOT `callbackFailed` —
   * nothing was refused and nothing broke.
   */
  callbackAlreadyTerminal: number;
  /** Why no digest went out this tick (interval not elapsed, no backlog, ...). */
  digestSkipped?: string;
  error?: string;
}

/** A re-delivery candidate: the approval-row columns a notification reads. */
export type CandidateRow = NotifiableApprovalRow & Record<string, unknown>;

/** Re-delivery attempts after which a row is skipped (default 10). */
export function maxRedeliveryAttempts(): number {
  const raw = Number(process.env.APPROVAL_REDELIVERY_MAX_ATTEMPTS ?? 10);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 10;
}

/** Backoff base and ceiling: min(15min * 2^attempts, 24h). */
export const REDELIVERY_BACKOFF_BASE_MINUTES = 15;
export const REDELIVERY_BACKOFF_MAX_HOURS = 24;

/**
 * Record one re-delivery attempt that did NOT confirm delivery: bump the counter
 * and push `next_redelivery_at` out. The backoff is computed from the PRE-bump
 * count (SET reads the old row), so the first failure waits 15 min, the second
 * 30, ... capped at 24 h. Logs exactly once, at the attempt that hits the cap.
 */
async function recordFailedAttempt(
  exec: typeof defaultDb,
  approvalId: string,
  cap: number,
): Promise<void> {
  try {
    const rows = await exec.execute<{ redelivery_attempts: number }>(sql`
      UPDATE approvals
         SET redelivery_attempts = redelivery_attempts + 1,
             next_redelivery_at = now() + least(
               make_interval(mins => ${REDELIVERY_BACKOFF_BASE_MINUTES}) * power(2, redelivery_attempts),
               make_interval(hours => ${REDELIVERY_BACKOFF_MAX_HOURS})
             )
       WHERE id = ${approvalId}::uuid
       RETURNING redelivery_attempts
    `);
    const attempts = Array.isArray(rows) && rows.length > 0 ? Number(rows[0]!.redelivery_attempts) : 0;
    if (attempts === cap) {
      console.error(
        `[approval-redelivery] approval ${approvalId} reached ${cap} re-delivery attempts without a ` +
          'confirmed delivery; it is no longer retried per row and will surface in the backlog digest ' +
          'once it ages out.',
      );
    }
  } catch (err) {
    console.error(`[approval-redelivery] could not record attempt for ${approvalId}:`, err);
  }
}

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// ── D17 CALLBACK LANE ───────────────────────────────────────────────────────
// Re-POSTs an approval's terminal outcome to every attached `callback_url` (the
// n8n Wait nodes' resume URLs, side table `approval_callback_urls`, migration 191,
// 1:N) that has not been delivered. Each ROW carries its own state (`attempts`,
// `next_attempt_at`, `delivered_at`): a row is due when it is undelivered, under
// the attempt cap, and `next_attempt_at` is NULL (never attempted — e.g. an
// expiry/void the reaper had no time to notify) or past. Terminal approvals only
// — approved / rejected / expired / voided — so a pending gate's URLs wait for
// its outcome. The send itself CLAIMS each row (services/n8n-callback.ts
// deliverApprovalCallbackUrls), so this lane never races the decision path, the
// expiry notice or the void notice. Nothing here touches migration 186's
// `approvals.redelivery_attempts` (the notification lane below).
interface CallbackUrlLaneResult {
  /** Approvals with at least one due callback row. */
  eligible: number;
  sent: number;
  failed: number;
  /** Rows answered 409/410 and retired — the waiting execution is gone. */
  alreadyTerminal: number;
}

// `db` is the advisory-lock transaction runArms runs in (runApprovalRedeliveryTick).
async function runCallbackUrlLane(opts: {
  db: typeof defaultDb;
  maxAttempts: number;
  cap: number;
  deadline: number;
}): Promise<CallbackUrlLaneResult> {
  const { db: exec, maxAttempts, cap, deadline } = opts;
  const out: CallbackUrlLaneResult = { eligible: 0, sent: 0, failed: 0, alreadyTerminal: 0 };
  const due = await exec.execute<{ id: string }>(sql`
    SELECT a.id
      FROM approvals a
     WHERE a.status IN ('approved', 'rejected', 'expired', 'voided')
       AND EXISTS (
             SELECT 1 FROM approval_callback_urls c
              WHERE c.approval_id = a.id
                AND c.delivered_at IS NULL
                AND c.attempts < ${maxAttempts}
                AND (c.next_attempt_at IS NULL OR c.next_attempt_at <= now())
           )
     ORDER BY a.updated_at ASC
     LIMIT ${cap}
  `);
  const rows = Array.isArray(due) ? due : [];
  out.eligible = rows.length;
  for (const row of rows) {
    if (Date.now() >= deadline) break;
    const r = await deliverApprovalCallbackUrls(row.id, {
      db: exec,
      timeoutMs: remainingBudgetMs(deadline),
    });
    if (r.outcome === 'sent') {
      out.sent += 1;
      continue;
    }
    if (r.outcome === 'already-terminal') {
      // The receiver said the waiting execution is gone and the row was
      // retired. Nothing failed, so nothing is counted or announced as failed.
      out.alreadyTerminal += 1;
      continue;
    }
    out.failed += 1;
    // The send already scheduled each failed row's next attempt; the cap is only
    // announced here (the URL itself is never logged).
    const capped = await exec.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM approval_callback_urls
       WHERE approval_id = ${row.id}::uuid AND delivered_at IS NULL AND attempts >= ${maxAttempts}
    `);
    const n = Array.isArray(capped) && capped.length > 0 ? Number(capped[0]!.n) : 0;
    if (n > 0) {
      console.error(
        `[approval-redelivery] approval ${row.id}: ${n} callback_url(s) reached ${maxAttempts} ` +
          'attempts without a 2xx; they are no longer retried. Those n8n Wait nodes stay ' +
          'parked until their own timeout.',
      );
    }
  }
  return out;
}

/**
 * Run one re-delivery pass under the advisory lock.
 */
export async function runApprovalRedeliveryTick(): Promise<RedeliveryTickResult> {
  const database = defaultDb;
  const result: RedeliveryTickResult = {
    outcome: 'ok',
    acquiredLock: false,
    eligible: 0,
    delivered: 0,
    unroutable: 0,
    unconfirmed: 0,
    more: false,
    deferred: 0,
    backlog: 0,
    digestSent: false,
    callbackEligible: 0,
    callbackSent: 0,
    callbackFailed: 0,
    callbackAlreadyTerminal: 0,
  };

  const cap = maxPerRun();
  const maxAttempts = maxRedeliveryAttempts();
  const ageDays = maxAgeDays();
  const deadline = Date.now() + tickDeadlineMs();

  const runArms = async (exec: typeof defaultDb): Promise<void> => {
    try {
      const lane = await runCallbackUrlLane({ db: exec, maxAttempts, cap, deadline });
      result.callbackEligible = lane.eligible;
      result.callbackSent = lane.sent;
      result.callbackFailed = lane.failed;
      result.callbackAlreadyTerminal = lane.alreadyTerminal;
    } catch (err) {
      // Its own failure must not cost the notification lane its tick.
      console.error('[approval-redelivery] callback_url lane failed:', errMessage(err));
    }
    // ---- RETRY ARM ----------------------------------------------------------
    // `now()` and the stored timestamp are compared IN the database, so a
    // clock-skewed replica cannot mis-classify a row across the age boundary.
    const candidates = await exec.execute<CandidateRow>(sql`
      -- The WHOLE row, like every first-send path: a hand-listed column set dropped \`kind\`,
      -- then \`action_id\` (approvalNotificationCopy reads what it needs).
      SELECT a.*
        FROM approvals a
       WHERE a.status = 'pending'
         AND a.notified_at IS NULL
         AND a.created_at >= now() - make_interval(days => ${ageDays})
         AND ${NO_CONFIRMED_DELIVERY}
         AND a.redelivery_attempts < ${maxAttempts}
         AND (a.next_redelivery_at IS NULL OR a.next_redelivery_at <= now())
       ORDER BY a.next_redelivery_at ASC NULLS FIRST, a.created_at ASC
       LIMIT ${cap}
    `);

    const rows = Array.isArray(candidates) ? candidates : [];
    result.eligible = rows.length;
    result.more = rows.length >= cap;

    for (const row of rows) {
      if (Date.now() >= deadline) {
        // Bounded, and never silent: the remaining rows keep notified_at NULL
        // and are simply picked up by the next tick.
        result.deferred = rows.length - (result.delivered + result.unroutable + result.unconfirmed);
        break;
      }

      let routed;
      try {
        routed = await resolveApprover({
          tenantId: row.tenant_id,
          projectId: row.project_id,
        });
      } catch (err) {
        result.unroutable += 1;
        console.error(`[approval-redelivery] routing threw for ${row.id}:`, err);
        await recordFailedAttempt(exec, row.id, maxAttempts);
        continue;
      }

      if (!routed.approver) {
        // The routing gap itself. Loud, per fr #886 doctrine — an approval
        // addressed to nobody must never be a quiet no-op.
        result.unroutable += 1;
        console.error(
          `[approval-redelivery] approval ${row.id} (tenant ${row.tenant_id}) still has NO ` +
            'reachable approver: no candidate has an enabled push channel. Give the tenant a ' +
            'workspace-admin with a push channel, or set APPROVAL_FALLBACK_APPROVER_USER_ID.',
        );
        await recordFailedAttempt(exec, row.id, maxAttempts);
        continue;
      }

      try {
        // Bounded by whatever is LEFT of the tick budget, not by a fresh
        // per-send allowance: the thing that must never be exceeded is the
        // wall-clock hold on advisory lock 912351, and that is a property of
        // the tick, not of one row. See `withDeadline`.
        await withDeadline(
          notificationService.fanOutToUser(
            approvalNotificationCopy(row),
            routed.approver.userId,
            'approval',
          ),
          remainingBudgetMs(deadline),
          `fan-out for approval ${row.id}`,
        );
      } catch (err) {
        console.error(`[approval-redelivery] fan-out failed for ${row.id}:`, err);
      }

      // P1-TEAM-b (George 2026-10-15): the re-send goes to EVERY member of the row's
      // tenant too, as the first send now does — told, not enrolled. Bounded by the same
      // tick budget (advisory lock 912351); `fanOutApprovalToTenantMembers` never throws.
      try {
        await withDeadline(
          fanOutApprovalToTenantMembers({
            approval: approvalNotificationCopy(row),
            tenantId: row.tenant_id,
            alreadyNotified: [routed.approver.userId],
            context: 'approval-redelivery',
          }),
          remainingBudgetMs(deadline),
          `tenant-member fan-out for approval ${row.id}`,
        );
      } catch (err) {
        console.error(`[approval-redelivery] tenant-member fan-out failed for ${row.id}:`, err);
      }

      // The stamp is a measurement of what the channels actually accepted, and it
      // is the SHARED helper — never re-implemented here, or the two paths drift.
      const notified = await confirmPushDelivery(row.id, 'approval-redelivery');
      if (notified) {
        result.delivered += 1;
      } else {
        result.unconfirmed += 1;
        console.error(
          `[approval-redelivery] approval ${row.id} unconfirmed for ${routed.approver.userId} ` +
            `(channels: ${routed.approver.channels.join(',')}) — notified_at stays NULL`,
        );
        await recordFailedAttempt(exec, row.id, maxAttempts);
      }
    }

    // ---- DIGEST ARM ---------------------------------------------------------
    const backlogRows = await exec.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n
        FROM approvals a
       WHERE a.status = 'pending'
         AND a.notified_at IS NULL
         AND a.created_at < now() - make_interval(days => ${ageDays})
         AND ${NO_CONFIRMED_DELIVERY}
    `);
    result.backlog = Array.isArray(backlogRows) && backlogRows.length > 0
      ? Number(backlogRows[0]!.n ?? 0)
      : 0;

    if (result.backlog === 0) {
      result.digestSkipped = 'no backlog';
      return;
    }

    const recipient = config.services.approvals.fallbackApproverUserId;
    if (!recipient) {
      result.digestSkipped = 'APPROVAL_FALLBACK_APPROVER_USER_ID unset';
      console.error(
        `[approval-redelivery] ${result.backlog} approvals were never delivered and there is no ` +
          'fallback approver to tell. Set APPROVAL_FALLBACK_APPROVER_USER_ID.',
      );
      return;
    }

    const [lastDigest] = await database
      .select({ created_at: engagementDeliveries.created_at })
      .from(engagementDeliveries)
      .where(
        and(
          eq(engagementDeliveries.engagement_id, DIGEST_ENGAGEMENT_ID),
          eq(engagementDeliveries.engagement_type, DIGEST_ENGAGEMENT_TYPE),
        ),
      )
      .orderBy(desc(engagementDeliveries.created_at))
      .limit(1);

    if (lastDigest?.created_at) {
      const elapsedH = (Date.now() - new Date(lastDigest.created_at).getTime()) / 3_600_000;
      if (elapsedH < digestIntervalHours()) {
        result.digestSkipped = `last digest ${elapsedH.toFixed(1)}h ago`;
        return;
      }
    }

    // The gate_terms breakdown is the honest half of the message: most of this
    // backlog is machine defects wearing approval labels, and a digest that
    // implied N pending DECISIONS would overstate what is being asked of a human.
    const termRows = await exec.execute<{ term: string; n: number }>(sql`
      SELECT t.term AS term, count(*)::int AS n
        FROM approvals a
        CROSS JOIN LATERAL jsonb_array_elements_text(a.metadata->'gate_terms') AS t(term)
       WHERE a.status = 'pending'
         AND a.notified_at IS NULL
         AND a.created_at < now() - make_interval(days => ${ageDays})
         AND ${NO_CONFIRMED_DELIVERY}
         AND jsonb_typeof(a.metadata->'gate_terms') = 'array'
       GROUP BY t.term
       ORDER BY count(*) DESC
       LIMIT 12
    `);
    const terms = Array.isArray(termRows) ? termRows : [];
    const breakdown = terms.length > 0
      ? terms.map((t) => `  ${t.n} x ${t.term}`).join('\n')
      : '  (no gate_terms recorded)';

    // WHY they are undelivered — a different question from what they ask for, and the
    // one that says whether anything can be done about them. Measured 2026-09-02: 241
    // of the 243 have NO `required_approvers` row at all. They were minted addressed to
    // nobody by `handleN8nCardApproval`, which wrote no roster row until 8ea815c8 (#832,
    // 2026-08-19); the newest such row is 2026-08-18 and NONE has been minted since, so
    // this population is CLOSED. A digest reporting only a count would send a reader
    // hunting a live router bug that was fixed a fortnight ago.
    //
    // ⛔ AND THEY CANNOT SIMPLY BE RE-ROSTERED. `handleUpdateApproval` finalises on
    // `decisions.length === roster.length`, so inventing a placeholder approver forges a
    // quorum. They have to be re-raised or cancelled — a decision for a human, which is
    // why the worker reports them and does not touch them.
    //
    // The newest mint date is reported rather than hard-coded against 2026-08-19: if a
    // roster-less row EVER appears with a recent date, the mint regression is back and
    // this line is where it shows up.
    const causeRows = await exec.execute<{
      no_roster: number; rostered: number; newest_no_roster: string | null;
    }>(sql`
      SELECT count(*) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM required_approvers ra WHERE ra.approval_id = a.id)
             )::int AS no_roster,
             count(*) FILTER (
               WHERE EXISTS (SELECT 1 FROM required_approvers ra WHERE ra.approval_id = a.id)
             )::int AS rostered,
             max(a.created_at) FILTER (
               WHERE NOT EXISTS (SELECT 1 FROM required_approvers ra WHERE ra.approval_id = a.id)
             )::date::text AS newest_no_roster
        FROM approvals a
       WHERE a.status = 'pending'
         AND a.notified_at IS NULL
         AND a.created_at < now() - make_interval(days => ${ageDays})
         AND ${NO_CONFIRMED_DELIVERY}
    `);
    const cause = Array.isArray(causeRows) && causeRows.length > 0 ? causeRows[0]! : null;
    const noRoster = Number(cause?.no_roster ?? 0);
    const rostered = Number(cause?.rostered ?? 0);
    const causeLine = cause
      ? `Why:\n` +
        `  ${noRoster} name NO approver at all — minted with an empty roster` +
        (cause.newest_no_roster ? ` (newest ${cause.newest_no_roster})` : '') +
        '. The mint path that produced them was fixed on 2026-08-19, so nothing new ' +
        'joins this set. Re-delivery cannot reach them and a placeholder approver would ' +
        'forge a quorum: they need re-raising or cancelling, which is your call.\n' +
        `  ${rostered} DO name an approver, but no send has ever succeeded — every ` +
        'channel disabled, or every attempt failed. These are reachable if a channel ' +
        'is enabled.\n\n'
      : '';

    const text =
      `${result.backlog} approvals were never delivered to anyone and are older than ` +
      `${ageDays} days.\n\n` +
      'They were minted while approver routing could not resolve a reachable human, and ' +
      'nothing has retried them since. They no longer expire, so they will stay pending ' +
      'until answered.\n\n' +
      causeLine +
      `By gate term:\n${breakdown}\n\n` +
      'Not every one is a decision to make — evidence_gap / decision_authoring_gap / ' +
      'no_procedure rows are defects to fix, not approvals to grant.\n\n' +
      (config.publicBaseUrl ? `Review: ${config.publicBaseUrl}/approvals` : 'Review them on the approvals page.');

    // ⛔ THE TICK DEADLINE MUST BOUND THIS ARM TOO, not just the retry loop above.
    //
    // `deadline` was consulted only inside the per-row retry loop, so the digest
    // could start an unbounded outbound fan-out (Telegram / email) at any point
    // after the budget was already spent — and it does so while HOLDING advisory
    // lock 912351 inside the tick's transaction. A hung socket therefore does not
    // just delay this send: every later tick finds the lock taken, takes its
    // "another replica is already running" branch, and reports `outcome: 'skipped'`
    // with no error and no log line naming the real cause.
    //
    // That is the exact silent-serialisation shape src/db/advisory-lock-keys.ts was
    // written about, reached from the other direction — there by two owners sharing
    // one key, here by one owner holding its own key indefinitely. Centralising the
    // keyspace bounded the blast radius to this worker; it did not bound the hold.
    //
    // ⚠️ CORRECTED — this used to read as if the check below closed the hazard.
    // It closed HALF of it. A pre-send `Date.now()` check bounds when a send may
    // START; it says nothing about how long one may RUN, and the retry loop above
    // had the same half-fix (a check between rows, an unbounded await inside).
    // Both sends are now additionally wrapped in `withDeadline(...,
    // remainingBudgetMs(deadline))`, which is what actually bounds the lock hold.
    //
    // Skipping is the right call rather than sending late: the digest is rate-limited
    // to once per APPROVAL_REDELIVERY_DIGEST_INTERVAL_HOURS and its population is a
    // multi-week backlog, so deferring it one tick costs nothing a reader would notice.
    if (Date.now() >= deadline) {
      result.digestSkipped = 'tick deadline reached before the digest send';
      return;
    }

    try {
      // The `Date.now() >= deadline` check above stops this arm from STARTING
      // late; this stops it from RUNNING long. Both are needed — the check
      // alone left an unbounded outbound send inside the locked transaction,
      // which is precisely what the block comment above describes.
      await withDeadline(
        notificationService.fanOutMessageToUser(
          recipient,
          { kind: 'text', correlationId: DIGEST_ENGAGEMENT_ID, text },
          DIGEST_ENGAGEMENT_TYPE,
        ),
        remainingBudgetMs(deadline),
        'backlog digest send',
      );
      result.digestSent = true;
    } catch (err) {
      result.digestSkipped = `send failed: ${errMessage(err)}`;
      console.error('[approval-redelivery] backlog digest send failed:', err);
    }
  };

  try {
    await database.transaction(async (tx) => {
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
      await runArms(tx as unknown as typeof defaultDb);
    });
  } catch (err) {
    result.outcome = 'failed';
    result.error = errMessage(err);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Start the periodic re-delivery worker. Idempotent — calling twice is a no-op.
 * Interval override: `APPROVAL_REDELIVERY_INTERVAL_MS`.
 */
export function startApprovalRedeliveryWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.APPROVAL_REDELIVERY_INTERVAL_MS ?? DEFAULT_INTERVAL_MS,
  );
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[approval-redelivery] interval invalid, refusing to start');
    return;
  }

  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      const r = await runApprovalRedeliveryTick();
      if (r.outcome === 'failed') {
        console.error(`[approval-redelivery] tick failed: ${r.error}`);
      } else if (r.eligible > 0 || r.digestSent || r.callbackEligible > 0) {
        console.log(
          `[approval-redelivery] eligible=${r.eligible} delivered=${r.delivered} ` +
            `unroutable=${r.unroutable} unconfirmed=${r.unconfirmed} deferred=${r.deferred} ` +
            `more=${r.more} backlog=${r.backlog} digest_sent=${r.digestSent} ` +
            `callback_url eligible=${r.callbackEligible} sent=${r.callbackSent} failed=${r.callbackFailed} ` +
            `already_terminal=${r.callbackAlreadyTerminal} ` +
            '(pending approvals with notified_at NULL -> re-delivered to their approver)',
        );
      }
    } catch (err) {
      console.error('[approval-redelivery] tick threw:', err);
    } finally {
      tickInFlight = false;
    }
  };

  // Kick off immediately: on a fresh deploy the backlog is the whole history.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  console.log(`[approval-redelivery] scheduler started, interval=${intervalMs}ms`);
}

export function stopApprovalRedeliveryWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
