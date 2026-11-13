// src/services/conveyor-failures.ts
//
// R311 PR 5 — fr's half of the kanban coach's two failure callbacks and of the
// conveyor start retry (n8n-workflows design/choices/v4/kanban-coach-errors.md
// §2.5, §4.1, §7 item 5, R-2, R-8; migration 199).
//
//   * `project.start_failed` (§2.5): the conveyor's start trigger failed AFTER it
//     answered fr 200 (its `Coach error`, or the `err.kanban_coach` backstop for a
//     timeout or a crash). Idempotent on (fr project, execution id): both senders
//     may report one failed start.
//   * `project.coach_failed` (§4.1): a coach could neither act nor comment on the
//     card (Planka down, usually the same outage that failed the source). fr is the
//     one channel that depends on neither Planka nor RM. Idempotent on the coach's
//     execution id (per tenant: n8n execution ids are per-instance counters).
//   * START ATTEMPTS: every conveyor start fr sends is recorded per project.
//     Attempt 0 (the create) keeps the bare `Idempotency-Key: <fr id>`; attempt
//     n >= 1 sends `<fr id>:retry-<n>`, n = the number of earlier attempts. The
//     conveyor's Dedupe store has no per-value delete, so a fresh key is the only
//     release (§2.5); the conveyor reads the project from the body, never the key.
//
// ⛔ fr IS A FACILITATOR, NEVER A JUDGE (George 2026-10-12). A notice is recorded
// and shown to every member of the project's tenant (George 2026-10-15); it never
// triggers a start, a move or anything else. The retry is OFFERED from recorded
// facts only (`computeRetryOffer`) and runs only when a member asks; fr never
// retries on its own.

import { and, desc, eq, isNotNull, or, sql } from 'drizzle-orm';

import { config } from '../config';
import {
  approvalDecisions,
  approvals,
  db as defaultDb,
  projectConveyorFailures,
  projectConveyorStartAttempts,
  projects,
} from '../db/client';
import type { ConveyorStartOutcomeName } from '../db/schema';
import { notificationService, type ExecutionEvent } from '../domain/engagement/notifications';
import { executionEventRecipients } from '../domain/engagement/tenant-member-event-recipients';
import { isIntegrationError, reportSwallowedFailure } from '../integrations/_lib/errors';
import { getPmProjectInTenant } from '../integrations/pm';
import { isGlobalAndonEngaged } from '../lib/global-andon-gate';
import { isLiveProjectStatus } from '../lib/project-live-status';
import { isUuidShape } from '../lib/uuid-shape';
import { voidApprovals } from '../lib/void-approvals';
import { AppError, pgErrorCode } from '../utils/errors';
import { CONVEYOR_START_REFUSAL_CODES, isBadRequestDetail } from './conveyor-start-webhook';
import {
  STALLABLE_LISTS,
  hasProgressed,
  rememberProgressed,
  startCardProgressed,
  type StartProgress,
} from './conveyor-start-progress';
import { readProjectAndon } from './project-andon';

export type AttemptRow = typeof projectConveyorStartAttempts.$inferSelect;
export type FailureRow = typeof projectConveyorFailures.$inferSelect;

/** A `pending` attempt older than this is treated as lost (fr's detached delivery is at most ~75 s). */
export const STALE_PENDING_MS = 10 * 60_000;

/**
 * R319: a delivered start whose start card is still in TODO this long after the delivery
 * shows no progress, and a member may start it again.
 */
export const NO_PROGRESS_MS = 10 * 60_000;

/**
 * R320: a start card in READY or DOING whose list has not changed, and whose latest start
 * answer is, at least this old has STALLED, and a member may start it again (behind
 * CONVEYOR_START_STALLED_RETRY).
 */
export const STALLED_MS = 30 * 60_000;

/**
 * R320: the marker fr appends to a `stalled` retry's `outcome_detail`
 * (services/rm-board-link.ts `attemptDetail`), so the next offer knows the conveyor was asked
 * to RESTART: a refusal or a plain/duplicate answer to it means nothing was restarted.
 */
export const STALLED_RETRY_MARK = 'stalled_retry';

/**
 * R319: what fr read about a delivered start's progress. `null`/absent = not read or unknown
 * (board unreadable, no start card on it): nothing new is offered.
 */
interface StartProgressFacts {
  /** The project's start card has left TODO (services/conveyor-start-progress.ts). */
  startCardLeftTodo: boolean;
  /** A project hold is engaged (the project's cord, or the global andon). */
  onHold: boolean;
  /** R320: the start card's list name (READY/DOING can stall). Absent = not read. */
  list?: string;
  /** R320: the start card's last list move (Planka `listChangedAt`), when known. */
  listChangedAt?: Date | string | null;
  /** R320: a pending approval is recorded on the start card (it is waiting for a person, not stalled). */
  pendingApproval?: boolean;
}

/** The error text stored and shown: the conveyor already clips it to 1000; fr enforces 2000. */
export const ERROR_TEXT_MAX = 2000;

/** `<fr id>` for the first start, `<fr id>:retry-<n>` for retry n (§2.5). */
export function startIdempotencyKey(frProjectId: string, attemptN: number): string {
  return attemptN === 0 ? frProjectId : `${frProjectId}:retry-${attemptN}`;
}

/** `<fr id>:restart-<n>` for a member's project or phase restart n (George 2026-10-31). */
export function restartIdempotencyKey(frProjectId: string, attemptN: number): string {
  return `${frProjectId}:restart-${attemptN}`;
}

/** True for an attempt that was a project or phase RESTART (its key is `<fr id>:restart-<n>`). */
export function isRestartAttempt(a: Pick<AttemptRow, 'idempotency_key'>): boolean {
  return /:restart-\d+$/.test(a.idempotency_key);
}

/**
 * The attempt the start-card retry offer reads: the newest, except a restart that is neither
 * being sent (`pending`) nor delivered. A refused, failed or unlinked restart is the answer to
 * the RESTART, not to the start; the member is offered the restart again, and the start-card
 * retry reads the attempt before it.
 */
function latestStartAttempt(attempts: ReadonlyArray<AttemptRow>): AttemptRow | undefined {
  return [...attempts]
    .sort((a, b) => b.attempt_n - a.attempt_n)
    .find((a) => !isRestartAttempt(a) || a.outcome === 'pending' || a.outcome === 'delivered');
}

// ---------------------------------------------------------------------------
// The retry offer — computed from recorded facts, never a judgement
// ---------------------------------------------------------------------------

type RetryOfferReason =
  /** A `project.start_failed` was recorded for the latest attempt (or for a project with no recorded attempt). */
  | 'start_failed'
  /** The latest attempt never reached n8n: the RM board link failed, so no start was sent (R-8). */
  | 'no_board_link'
  /** The latest attempt's start webhook was not delivered (a final failure, or a `pending` lost for >10 min). */
  | 'not_delivered'
  /**
   * R319: the latest start was delivered (200) at least {@link NO_PROGRESS_MS} ago, yet the
   * project's start card is still in TODO on its board (services/conveyor-start-progress.ts).
   * The conveyor resumes such a start (R317: a new key re-pulls the unpulled start card).
   */
  | 'no_progress'
  /**
   * R320: the latest start was delivered, its start card sits in READY or DOING, and neither
   * the card's list nor the start's answer has changed for {@link STALLED_MS}; no approval is
   * pending on it and the project is not on hold. The conveyor restarts such a start card
   * (200 restarted) or says it is still running (200 running). Behind CONVEYOR_START_STALLED_RETRY.
   */
  | 'stalled';

type RetryRefusalReason =
  /** The latest attempt is being sent right now. */
  | 'start_in_flight'
  /** n8n accepted the latest start and no failure was reported for it. */
  | 'started'
  /**
   * R319: the start shows no progress, but the project is on hold (an operator pause).
   * The hold comes first; nothing is offered until it is released.
   */
  | 'on_hold'
  /** CONVEYOR_START_WEBHOOK_URL was unset when fr tried: a retry would send nothing either. */
  | 'conveyor_not_configured'
  /** fr has no start attempt and no start failure on record for this project (created before migration 199). */
  | 'no_start_recorded'
  /**
   * The conveyor answered the latest start `400`: fr sent a malformed start (a
   * programming error). The same start would be rejected again, so none is offered.
   */
  | 'start_request_invalid';

/**
 * The latest start was REFUSED by the conveyor (`409 {code}`, migration 203): it
 * will refuse a retry for the same reason, so none is offered. `code` is what
 * the conveyor said; `message` is the member's text for it (customer copy — no
 * internal system names), and is what the Execution hub and the agent show.
 */
type RetryRefusedByConveyor = {
  available: false;
  reason: 'refused_by_conveyor';
  code: string;
  message: string;
};

/**
 * R320: the member asked to start a stalled project again and the conveyor did not restart it
 * (it answered as before R320: `duplicate`, or `409 psra_exists`). fr reported it; `message`
 * is the member's text. Offered again once the start card has stalled for another
 * {@link STALLED_MS}.
 */
type RetryRestartNotDone = { available: false; reason: 'restart_not_done'; message: string };

/** R320: the member's text when a stalled start was not restarted (customer copy). */
export const RESTART_NOT_DONE_MESSAGE =
  "We could not restart this project's work. The team has been told and will look into it.";

type RetryOffer =
  | { available: true; reason: RetryOfferReason; next_attempt_n: number; next_idempotency_key: string }
  | { available: false; reason: RetryRefusalReason }
  | RetryRefusedByConveyor
  | RetryRestartNotDone;

/**
 * The member's text for each conveyor refusal code. Customer copy: plain words,
 * never the name of an internal system or card type.
 */
export const REFUSAL_MESSAGES: Readonly<Record<(typeof CONVEYOR_START_REFUSAL_CODES)[number], string>> = Object.freeze({
  project_mismatch:
    "This project's start was declined because its records do not match this project. Retrying will not help; please contact support.",
  tenant_mismatch:
    'This project\'s start was declined because the project belongs to a different workspace. Retrying will not help; please contact support.',
  phase_not_setup: 'This project\'s start was declined because the project has already moved past its setup phase.',
  psra_exists: 'This project has already started, so it cannot be started again.',
});
/** A refusal whose code fr does not know. */
export const REFUSAL_MESSAGE_UNKNOWN =
  "This project's start was declined, and retrying will not help. Please contact support.";

function refusalMessage(code: string | null | undefined): string {
  return (REFUSAL_MESSAGES as Record<string, string>)[code ?? ''] ?? REFUSAL_MESSAGE_UNKNOWN;
}

const ms = (v: Date | string): number => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** True when `f` reports the start of `attempt`: by its key, or (no key) by being recorded after it. */
function failureIsForAttempt(f: Pick<FailureRow, 'idempotency_key' | 'created_at'>, attempt: AttemptRow): boolean {
  if (f.idempotency_key) return f.idempotency_key === attempt.idempotency_key;
  return ms(f.created_at) >= ms(attempt.created_at);
}

/**
 * Whether a member may retry the project's conveyor start, and why — from the
 * recorded attempts and `start_failed` notices alone (one clock: fr's database).
 */
export function computeRetryOffer(input: {
  frProjectId: string;
  attempts: ReadonlyArray<AttemptRow>;
  startFailures: ReadonlyArray<Pick<FailureRow, 'idempotency_key' | 'created_at'>>;
  now: Date;
  /** R319: the delivered start's progress, when read (see {@link needsProgressFacts}). */
  progress?: StartProgressFacts | null;
  /** R320: CONVEYOR_START_STALLED_RETRY — offer `stalled`. Default off. */
  stalledRetry?: boolean;
}): RetryOffer {
  const newest = [...input.attempts].sort((a, b) => b.attempt_n - a.attempt_n)[0];
  const nextN = newest ? newest.attempt_n + 1 : 0;
  const latest = latestStartAttempt(input.attempts);
  const offer = (reason: RetryOfferReason): RetryOffer => ({
    available: true,
    reason,
    // A project with no recorded attempt was started (if at all) under the bare key
    // before attempts were recorded, so its first recorded retry is still retry 1.
    next_attempt_n: Math.max(nextN, 1),
    next_idempotency_key: startIdempotencyKey(input.frProjectId, Math.max(nextN, 1)),
  });
  if (!latest) {
    return input.startFailures.length > 0 ? offer('start_failed') : { available: false, reason: 'no_start_recorded' };
  }
  // A refusal is the conveyor's final word on this start: checked BEFORE the
  // notices, since a retry would be refused for the same reason whatever else was reported.
  if (latest.outcome === 'refused') {
    // R320: a 409 psra_exists to a start sent while the start card sat in READY/DOING (the
    // conveyor before R320 answers that for a start card outside TODO) is not final: the
    // restart may be offered again. Which offer reason produced the attempt does not matter —
    // the mark is set at SEND time from the card's position (beginRetryStartAttempt).
    if (input.stalledRetry && isStalledRestartRefusal(latest)) {
      const p = progressOffer(input, latest, offer);
      if (p) return p;
    }
    const code = refusalCodeOfDetail(latest.outcome_detail);
    return { available: false, reason: 'refused_by_conveyor', code, message: refusalMessage(code) };
  }
  if (input.startFailures.some((f) => failureIsForAttempt(f, latest))) return offer('start_failed');
  switch (latest.outcome) {
    case 'board_link_failed':
      return offer('no_board_link');
    case 'failed':
      return isBadRequestDetail(latest.outcome_detail)
        ? { available: false, reason: 'start_request_invalid' }
        : offer('not_delivered');
    case 'pending':
      return input.now.getTime() - ms(latest.created_at) > STALE_PENDING_MS
        ? offer('not_delivered')
        : { available: false, reason: 'start_in_flight' };
    case 'inert':
      return { available: false, reason: 'conveyor_not_configured' };
    case 'delivered':
      return progressOffer(input, latest, offer) ?? { available: false, reason: 'started' };
    default:
      return { available: false, reason: 'started' };
  }
}

/** R319: the delivered attempt's answer is at least NO_PROGRESS_MS old (completed_at, else created_at). */
function deliveredLongAgo(a: AttemptRow, now: Date): boolean {
  return now.getTime() - ms(a.completed_at ?? a.created_at) >= NO_PROGRESS_MS;
}

/** The refusal code stored on a refused attempt: its first word (R320 may append {@link STALLED_RETRY_MARK}). */
function refusalCodeOfDetail(detail: string | null | undefined): string {
  return (detail ?? '').trim().split(/\s+/)[0] || 'unrecognised';
}

/** R320: the attempt was a `stalled` retry (its detail carries {@link STALLED_RETRY_MARK}). */
export function isStalledRetry(a: Pick<AttemptRow, 'outcome_detail'>): boolean {
  return (a.outcome_detail ?? '').split(/\s+/).includes(STALLED_RETRY_MARK);
}

/**
 * R320: a 409 psra_exists to a marked attempt (sent while the start card sat in READY/DOING,
 * flag on). Never final on its own: the card's position decides (progressOffer). Any other
 * refusal code is the conveyor's final word, marked or not.
 */
export function isStalledRestartRefusal(a: Pick<AttemptRow, 'outcome' | 'outcome_detail'>): boolean {
  return a.outcome === 'refused' && isStalledRetry(a) && refusalCodeOfDetail(a.outcome_detail) === 'psra_exists';
}

/**
 * R320: a `stalled` retry the conveyor did NOT act on — refused, or delivered without
 * `restarted` / `running` / `resumed` (the conveyor before R320 answers `duplicate`).
 */
export function restartNotDone(a: Pick<AttemptRow, 'outcome' | 'outcome_detail'>): boolean {
  if (!isStalledRetry(a)) return false;
  if (a.outcome === 'refused') return isStalledRestartRefusal(a);
  if (a.outcome !== 'delivered') return false;
  const words = (a.outcome_detail ?? '').split(/\s+/);
  return !words.some((w) => w === 'restarted' || w === 'running' || w === 'resumed');
}

/**
 * R319 + R320: what the start card's progress offers for a delivered start (or a refused
 * stalled restart), or null when it decides nothing.
 */
function progressOffer(
  input: { now: Date; progress?: StartProgressFacts | null; stalledRetry?: boolean },
  latest: AttemptRow,
  offer: (reason: RetryOfferReason) => RetryOffer,
): RetryOffer | null {
  const p = input.progress;
  if (!p) return null;
  if (!p.startCardLeftTodo) {
    if (latest.outcome !== 'delivered' || !deliveredLongAgo(latest, input.now)) return null;
    return p.onHold ? { available: false, reason: 'on_hold' } : offer('no_progress');
  }
  // R320 (flag on only): exactly one start card, in READY or DOING (more than one start card
  // reads list '' — conveyor-start-progress.ts — so it never stalls).
  if (!input.stalledRetry || !p.list || !STALLABLE_LISTS.has(p.list)) return null;
  if (!p.pendingApproval && stalledLongEnough(latest, p, input.now)) {
    return p.onHold ? { available: false, reason: 'on_hold' } : offer('stalled');
  }
  return restartNotDone(latest) ? { available: false, reason: 'restart_not_done', message: RESTART_NOT_DONE_MESSAGE } : null;
}

/** R320: the id of the ONE start card when it sits in READY or DOING (it may stall), else null. */
function stallableCardOf(p: StartProgress): string | null {
  return p.startCardLeftTodo && p.cardId != null && STALLABLE_LISTS.has(p.list) ? p.cardId : null;
}

/** R320: now − max(card listChangedAt, latest answer) ≥ STALLED_MS. An unreadable stamp counts as absent. */
function stalledLongEnough(latest: AttemptRow, p: StartProgressFacts, now: Date): boolean {
  const answered = ms(latest.completed_at ?? latest.created_at);
  const moved = p.listChangedAt ? ms(p.listChangedAt) : Number.NaN;
  const last = Number.isFinite(moved) ? Math.max(answered, moved) : answered;
  return now.getTime() - last >= STALLED_MS;
}

/**
 * R319: whether the offer depends on the start's progress — the latest attempt was delivered
 * long enough ago and nothing else decides the offer. Only then is the board read (one
 * Planka read; never for a fresh, failed, pending or refused start).
 * R320: with CONVEYOR_START_STALLED_RETRY on, a stalled restart's answer is also read at once
 * (so "could not restart" shows), and a refused stalled restart may be offered again. With it
 * off this is R319's rule exactly.
 */
export function needsProgressFacts(input: {
  frProjectId: string;
  attempts: ReadonlyArray<AttemptRow>;
  startFailures: ReadonlyArray<Pick<FailureRow, 'idempotency_key' | 'created_at'>>;
  now: Date;
  stalledRetry?: boolean;
}): boolean {
  const latest = latestStartAttempt(input.attempts);
  if (!latest) return false;
  const stalledAnswer =
    input.stalledRetry === true &&
    isStalledRetry(latest) &&
    (latest.outcome === 'delivered' || isStalledRestartRefusal(latest));
  if (!stalledAnswer && (latest.outcome !== 'delivered' || !deliveredLongAgo(latest, input.now))) return false;
  const base = computeRetryOffer({ ...input, progress: null });
  return !base.available && (base.reason === 'started' || (stalledAnswer && base.reason === 'refused_by_conveyor'));
}

// ---------------------------------------------------------------------------
// Hold / pending-approval reads (R319 / R320; each throws when unreadable)
// ---------------------------------------------------------------------------

/** The project's hold (project cord or the global andon). Throws when unreadable. */
export async function readProjectOnHold(projectId: string): Promise<boolean> {
  return await readOnHold(projectId, defaultDb);
}

async function readOnHold(projectId: string, executor: typeof defaultDb): Promise<boolean> {
  const view = await readProjectAndon(projectId, executor);
  if (!view) throw new Error(`project ${projectId}: hold state unreadable (no project row)`);
  if (view.engaged) return true;
  return await isGlobalAndonEngaged(executor);
}

async function readPendingApprovalOnCard(
  input: { projectId: string; tenantId: string; cardId: string },
  executor: typeof defaultDb,
): Promise<boolean> {
  const rows = await executor
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, input.tenantId),
        eq(approvals.project_id, input.projectId),
        eq(approvals.card_id, input.cardId),
        eq(approvals.status, 'pending'),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

// ---------------------------------------------------------------------------
// Start attempts
// ---------------------------------------------------------------------------

export interface BegunAttempt {
  id: string;
  attempt_n: number;
  idempotency_key: string;
}

const CONVEYOR_START_IN_PROGRESS_CODE = 'conveyor_start_in_progress' as const;
const CONVEYOR_RETRY_NOT_OFFERED_CODE = 'conveyor_retry_not_offered' as const;

/**
 * Record the CREATE's start (attempt 0, the bare key). Called by the detached
 * link-then-start chain; a project that already has an attempt keeps its numbers
 * (the next free n is used), so this never collides with a retry.
 */
export async function beginCreateStartAttempt(input: { projectId: string; tenantId: string }): Promise<BegunAttempt> {
  return await insertNextAttempt(defaultDb, { ...input, requestedBy: null });
}

async function insertNextAttempt(
  executor: Pick<typeof defaultDb, 'execute'>,
  input: { projectId: string; tenantId: string; requestedBy: string | null; attemptN?: number; restart?: boolean },
): Promise<BegunAttempt> {
  const nextN =
    input.attemptN !== undefined
      ? sql`${input.attemptN}::int`
      : sql`(SELECT COALESCE(MAX(attempt_n) + 1, 0) FROM project_conveyor_start_attempts WHERE project_id = ${input.projectId}::uuid)`;
  // A restart (George 2026-10-31) is keyed `<fr id>:restart-<n>`, in the same attempt numbering.
  const keyPart = input.restart ? ':restart-' : ':retry-';
  try {
    const res = (await executor.execute(sql`
      INSERT INTO project_conveyor_start_attempts (project_id, tenant_id, attempt_n, idempotency_key, requested_by)
      SELECT ${input.projectId}::uuid, ${input.tenantId}::uuid, n.v,
             CASE WHEN n.v = 0 THEN ${input.projectId} ELSE ${input.projectId} || ${keyPart} || n.v::text END,
             ${input.requestedBy}
        FROM (SELECT ${nextN} AS v) n
      RETURNING id, attempt_n, idempotency_key
    `)) as unknown as Array<{ id: string; attempt_n: number; idempotency_key: string }> | { rows: Array<{ id: string; attempt_n: number; idempotency_key: string }> };
    const rows = Array.isArray(res) ? res : res.rows;
    const row = rows[0];
    if (!row) throw new Error('project_conveyor_start_attempts insert returned no row');
    return { id: String(row.id), attempt_n: Number(row.attempt_n), idempotency_key: String(row.idempotency_key) };
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new AppError(409, 'Another conveyor start for this project is being recorded right now; nothing was sent').withCode(
        CONVEYOR_START_IN_PROGRESS_CODE,
      );
    }
    throw err;
  }
}

/** Stamp an attempt's outcome. Never throws (the start already happened or did not; the record is best effort). */
export async function completeStartAttempt(
  attemptId: string,
  outcome: Exclude<ConveyorStartOutcomeName, 'pending'>,
  detail: string | null,
): Promise<void> {
  try {
    await defaultDb
      .update(projectConveyorStartAttempts)
      .set({ outcome, outcome_detail: detail ? detail.slice(0, ERROR_TEXT_MAX) : null, completed_at: new Date() })
      .where(eq(projectConveyorStartAttempts.id, attemptId));
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'UPDATE',
      path: 'project_conveyor_start_attempts',
      degradedTo: `start attempt ${attemptId} keeps outcome 'pending' (it reads as lost after ${STALE_PENDING_MS / 60_000} min)`,
    });
  }
}

/**
 * A member's RETRY: under the project row lock, read what is recorded, refuse
 * unless a retry is offered (409 `conveyor_retry_not_offered`, with the reason),
 * and record the next attempt. Returns the attempt to send. Two members clicking
 * at once: the lock serialises them; the second sees the first's `pending` and is
 * refused `start_in_flight`.
 */
export async function beginRetryStartAttempt(input: {
  projectId: string;
  tenantId: string;
  requestedBy: string;
  /**
   * R319: the start card's progress, read from the board BEFORE the lock (no network call
   * under it). `null`/absent = unknown: a delivered start is then never offered again.
   */
  startProgress?: StartProgress | null;
}): Promise<BegunAttempt & { reason: RetryOfferReason; stalled_retry?: true }> {
  return await defaultDb.transaction(async (tx) => {
    await tx.execute(sql`SELECT id FROM projects WHERE id = ${input.projectId}::uuid FOR UPDATE`);
    const attempts = await tx
      .select()
      .from(projectConveyorStartAttempts)
      .where(
        and(
          eq(projectConveyorStartAttempts.project_id, input.projectId),
          eq(projectConveyorStartAttempts.tenant_id, input.tenantId),
        ),
      );
    const startFailures = await tx
      .select({ idempotency_key: projectConveyorFailures.idempotency_key, created_at: projectConveyorFailures.created_at })
      .from(projectConveyorFailures)
      .where(
        and(
          eq(projectConveyorFailures.project_id, input.projectId),
          eq(projectConveyorFailures.tenant_id, input.tenantId),
          eq(projectConveyorFailures.kind, 'start_failed'),
        ),
      );
    const base = { frProjectId: input.projectId, attempts, startFailures, now: new Date() };
    const stalledRetry = config.services.n8n.conveyorStartStalledRetry;
    // R319: the hold is read under the same lock, so a cord pulled before this retry is seen.
    // R320: so is a pending approval on the start card.
    const sp = input.startProgress;
    const executor = tx as unknown as typeof defaultDb;
    // With CONVEYOR_START_STALLED_RETRY off these are R319's facts exactly.
    const stalledCard = stalledRetry && sp ? stallableCardOf(sp) : null;
    const progress: StartProgressFacts | null =
      sp && needsProgressFacts({ ...base, stalledRetry })
        ? stalledRetry
          ? {
              startCardLeftTodo: sp.startCardLeftTodo,
              list: sp.list,
              listChangedAt: sp.listChangedAt,
              onHold: await readOnHold(input.projectId, executor),
              pendingApproval: stalledCard
                ? await readPendingApprovalOnCard({ projectId: input.projectId, tenantId: input.tenantId, cardId: stalledCard }, executor)
                : false,
            }
          : { startCardLeftTodo: sp.startCardLeftTodo, onHold: await readOnHold(input.projectId, executor) }
        : null;
    const offer = computeRetryOffer({ ...base, progress, stalledRetry });
    if (!offer.available) {
      throw new AppError(409, `A conveyor start retry is not offered for this project (${offer.reason}); nothing was sent`, {
        reason: offer.reason,
        ...('code' in offer ? { code: offer.code } : {}),
        ...('message' in offer ? { message: offer.message } : {}),
      }).withCode(CONVEYOR_RETRY_NOT_OFFERED_CODE);
    }
    const begun = await insertNextAttempt(tx, {
      projectId: input.projectId,
      tenantId: input.tenantId,
      requestedBy: input.requestedBy,
      attemptN: offer.next_attempt_n,
    });
    // R320 (flag on): mark the attempt `stalled_retry` whenever it is SENT while the one start
    // card sits in READY/DOING — whatever the offer reason (a retry after a failed, lost or
    // unlinked stalled restart is still a restart). The conveyor before R320 answers such a
    // start 409 psra_exists, and only a marked refusal is non-final, so the decision never
    // depends on which reason produced the attempt. Flag off: never set (main's shape exactly).
    return { ...begun, reason: offer.reason, ...(stalledCard ? { stalled_retry: true as const } : {}) };
  });
}

// ---------------------------------------------------------------------------
// "Start again" as a RESTART (George 2026-10-31)
// ---------------------------------------------------------------------------
//
// A member may restart ANY active project — the whole project, or its current RM phase. The
// conveyor then runs every card in that scope again, finished ones included. This is offered
// alongside (never instead of) the start-card retry above. fr decides nothing: it offers the
// restart for every active project and records what was asked; the conveyor and RM do the rest.

export type RestartScope = 'project' | 'phase';
export const RESTART_SCOPES: readonly RestartScope[] = ['project', 'phase'] as const;

type RestartRefusalReason =
  /** The project is not active work (archived, pending, cancelled). */
  | 'not_active'
  /** The project was delivered (RM closed it). */
  | 'delivered'
  /** A start or restart for this project is being sent right now. */
  | 'start_in_flight'
  /** CONVEYOR_START_WEBHOOK_URL is unset: a restart would send nothing. */
  | 'conveyor_not_configured'
  /** The project has no requirements_management project or no board: the conveyor cannot run it. */
  | 'not_on_conveyor'
  /**
   * The project is on hold (its cord or the global andon) —
   * as for the start retry, the hold comes first: nothing is offered until it is released.
   */
  | 'on_hold';

/**
 * Whether a restart is offered. `phase` is the project's current RM phase name (null = RM names
 * none, or it could not be read): a PHASE restart needs it, a PROJECT restart does not.
 */
export type RestartOffer =
  | { available: true; phase: string | null; next_attempt_n: number; next_idempotency_key: string }
  | { available: false; reason: RestartRefusalReason; phase: string | null };

export function computeRestartOffer(input: {
  frProjectId: string;
  attempts: ReadonlyArray<Pick<AttemptRow, 'attempt_n' | 'outcome' | 'created_at'>>;
  now: Date;
  /** `projects.status` is live work (lib/project-live-status.ts). */
  live: boolean;
  /** RM closed the project (services/project-delivered.ts). */
  delivered: boolean;
  phase: string | null;
  configured: boolean;
  /** The project has its RM project and its board (absent ⇒ true: the POST checks both first). */
  onConveyor?: boolean;
  /** The project or the whole estate is on hold (read like the start retry's `readOnHold`). */
  onHold: boolean;
}): RestartOffer {
  const refuse = (reason: RestartRefusalReason): RestartOffer => ({ available: false, reason, phase: input.phase });
  if (input.delivered) return refuse('delivered');
  if (!input.live) return refuse('not_active');
  if (input.onConveyor === false) return refuse('not_on_conveyor');
  // The hold comes first (as for the start retry): released before anything is offered.
  if (input.onHold) return refuse('on_hold');
  if (!input.configured) return refuse('conveyor_not_configured');
  const newest = [...input.attempts].sort((a, b) => b.attempt_n - a.attempt_n)[0];
  if (newest?.outcome === 'pending' && input.now.getTime() - ms(newest.created_at) <= STALE_PENDING_MS) {
    return refuse('start_in_flight');
  }
  const n = Math.max(newest ? newest.attempt_n + 1 : 1, 1);
  return { available: true, phase: input.phase, next_attempt_n: n, next_idempotency_key: restartIdempotencyKey(input.frProjectId, n) };
}

const RESTART_NOT_OFFERED_CODE = 'conveyor_restart_not_offered' as const;
const RESTART_PHASE_UNKNOWN_CODE = 'restart_phase_unknown' as const;
export const RESTART_PHASE_INVALID_CODE = 'restart_phase_invalid' as const;
/** The longest restart comment fr forwards (R349). */
export const RESTART_COMMENT_MAX = 2000;

/**
 * R349 (George 2026-11-04): the phases a member may restart — the project type's ordered phases
 * (RM) up to AND including the current one. The current phase not in the list (or unknown) ⇒
 * none: fr never guesses an order. Pure.
 */
export function restartablePhases<P extends { name: string }>(phases: readonly P[], current: string | null): P[] {
  if (!current) return [];
  const at = phases.findIndex((p) => p.name === current);
  return at < 0 ? [] : phases.slice(0, at + 1);
}

/**
 * The board card id → its `phase` custom field (the conveyor stamps it; the cockpit spine places
 * cards by the same exact field). Pure.
 */
export function cardPhaseFieldsOf(board: {
  included?: {
    customFields?: Array<{ id: string; name?: string | null }>;
    customFieldValues?: Array<{ cardId: string; customFieldId: string; content?: unknown }>;
  };
} | null): Map<string, string> {
  const out = new Map<string, string>();
  const ids = new Set((board?.included?.customFields ?? []).filter((f) => f.name === 'phase').map((f) => f.id));
  for (const v of board?.included?.customFieldValues ?? []) {
    const c = typeof v.content === 'string' ? v.content.trim() : '';
    if (c && ids.has(v.customFieldId)) out.set(v.cardId, c);
  }
  return out;
}

/**
 * R349: per phase, the comment of the LATEST decided phase-start sign-off of this project — the
 * approval the conveyor raised on the phase's `project_phase_start` card (`metadata.card_type`
 * 'project_phase_start', `metadata.ask_kind` 'signoff', status approved/rejected). Its phase is
 * the card's own `phase` field (`cardPhases`); a sign-off on a card with no phase field is
 * placed nowhere. The comment is that approval's latest decision's, trimmed; null when it had
 * none. A phase with no decided sign-off is absent from the map.
 */
export async function phaseStartSignoffComments(input: {
  projectId: string;
  tenantId: string;
  cardPhases: ReadonlyMap<string, string>;
}): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (input.cardPhases.size === 0 || !isUuidShape(input.projectId) || !isUuidShape(input.tenantId)) return out;
  const rows = await defaultDb
    .select({ approval_id: approvals.id, card_id: approvals.card_id, comment: approvalDecisions.comment, decided_at: approvalDecisions.decided_at })
    .from(approvals)
    .innerJoin(approvalDecisions, eq(approvalDecisions.approval_id, approvals.id))
    .where(
      and(
        eq(approvals.project_id, input.projectId),
        eq(approvals.tenant_id, input.tenantId),
        isNotNull(approvals.card_id),
        sql`${approvals.status} IN ('approved', 'rejected')`,
        sql`${approvals.metadata}->>'card_type' = 'project_phase_start'`,
        sql`${approvals.metadata}->>'ask_kind' = 'signoff'`,
      ),
    )
    .orderBy(desc(approvalDecisions.decided_at), desc(approvalDecisions.id));
  for (const r of rows) {
    const phase = r.card_id ? input.cardPhases.get(r.card_id) : undefined;
    if (!phase || out.has(phase)) continue;
    const c = typeof r.comment === 'string' ? r.comment.trim() : '';
    out.set(phase, c === '' ? null : c);
  }
  return out;
}

/**
 * A member's RESTART: under the project row lock, re-read the project's status and attempts,
 * refuse unless a restart is offered (409 `conveyor_restart_not_offered`, with the reason), and
 * record the next attempt under `<fr id>:restart-<n>`. A PHASE restart needs the RM phase
 * (409 `restart_phase_unknown`) and names a phase at or before it (R349: `selectable`, from
 * `restartablePhases`; anything else is 409 `restart_phase_invalid`).
 */
export async function beginRestartAttempt(input: {
  projectId: string;
  tenantId: string;
  requestedBy: string;
  scope: RestartScope;
  /** The project's current RM phase, read BEFORE the lock (no network call under it). */
  rmPhase: string | null;
  /** RM closed the project (read with the phase). */
  delivered: boolean;
  /** Scope phase: the phase the member chose to restart. */
  phase?: string | null;
  /** Scope phase: the phase names the member may choose (the current one and earlier). */
  selectable?: readonly string[];
}): Promise<BegunAttempt & { scope: RestartScope; phase: string | null }> {
  if (input.scope === 'phase') {
    if (!input.rmPhase) {
      throw new AppError(409, "This project's current phase is not known, so it cannot be restarted; nothing was sent").withCode(
        RESTART_PHASE_UNKNOWN_CODE,
      );
    }
    const allowed = input.selectable ?? [];
    if (!input.phase || !allowed.includes(input.phase)) {
      throw new AppError(
        409,
        `Only the current phase (${input.rmPhase}) or an earlier one can be restarted; nothing was sent`,
        { phase: input.rmPhase, allowed: [...allowed] },
      ).withCode(RESTART_PHASE_INVALID_CODE);
    }
  }
  return await defaultDb.transaction(async (tx) => {
    const locked = (await tx.execute(
      sql`SELECT status FROM projects WHERE id = ${input.projectId}::uuid FOR UPDATE`,
    )) as unknown as Array<{ status: string }> | { rows: Array<{ status: string }> };
    const row = (Array.isArray(locked) ? locked : locked.rows)[0];
    const attempts = await tx
      .select()
      .from(projectConveyorStartAttempts)
      .where(
        and(
          eq(projectConveyorStartAttempts.project_id, input.projectId),
          eq(projectConveyorStartAttempts.tenant_id, input.tenantId),
        ),
      );
    const offer = computeRestartOffer({
      frProjectId: input.projectId,
      attempts,
      now: new Date(),
      live: isLiveProjectStatus(row?.status),
      delivered: input.delivered,
      phase: input.rmPhase,
      configured: !!config.services.n8n.conveyorStartWebhookUrl,
      // Read under the same lock, so a cord pulled before this restart is seen (as for the retry).
      onHold: await readOnHold(input.projectId, tx as unknown as typeof defaultDb),
    });
    if (!offer.available) {
      throw new AppError(409, `A restart is not offered for this project (${offer.reason}); nothing was sent`, {
        reason: offer.reason,
      }).withCode(RESTART_NOT_OFFERED_CODE);
    }
    const begun = await insertNextAttempt(tx, {
      projectId: input.projectId,
      tenantId: input.tenantId,
      requestedBy: input.requestedBy,
      attemptN: offer.next_attempt_n,
      restart: true,
    });
    return { ...begun, scope: input.scope, phase: input.scope === 'phase' ? input.phase! : null };
  });
}

/**
 * The restart's void step (routes/project-conveyor-start.ts): withdraw the project's open
 * conveyor questions and card requests for restart `attempt`. When the void fails the attempt is
 * marked `failed` with why, and the error is rethrown — the caller then sends NOTHING, because
 * a stale ask could swallow the re-run's.
 */
export async function withdrawAsksForRestart(input: {
  attempt: BegunAttempt & { scope: RestartScope; phase: string | null };
  projectId: string;
  tenantId: string;
  actor: string;
}): Promise<{ pending: number; voided: number }> {
  const { attempt } = input;
  const what = attempt.scope === 'phase' ? `phase ${attempt.phase}` : 'project';
  try {
    return await voidOpenConveyorAsks({
      projectId: input.projectId,
      tenantId: input.tenantId,
      actor: input.actor,
      reason: `project restarted (${what}, attempt ${attempt.attempt_n}): every card in scope runs again, so this ask is withdrawn`,
    });
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    await completeStartAttempt(attempt.id, 'failed', `open asks could not be voided, restart not sent: ${why}`);
    throw err;
  }
}

/** `voidApprovals` takes at most 500 ids per call. */
const VOID_CHUNK = 500;

/**
 * VOID every OPEN ask of the project before a restart is sent: the pending approvals the
 * conveyor minted (`source = 'n8n'`), and a person's pending web request on one of the
 * project's CARDS (`source = 'web'` with a `card_id`: a card action and the like).
 * A web approval that targets no card is left alone. fr keeps ONE open gate per card
 * (domain/approvals/one-open-gate.ts): a stale open ask would swallow the re-run's own ask.
 * The void is lib/void-approvals.ts — never a decision; each row records `voided_reason`
 * ("project restarted …") and `voided_by`, and every waiting n8n execution is resumed with
 * decision `voided`. Throws when the void fails: the restart is then NOT sent.
 */
export async function voidOpenConveyorAsks(input: {
  projectId: string;
  tenantId: string;
  actor: string;
  reason: string;
}): Promise<{ pending: number; voided: number }> {
  const rows = await defaultDb
    .select({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, input.tenantId),
        eq(approvals.project_id, input.projectId),
        eq(approvals.status, 'pending'),
        or(eq(approvals.source, 'n8n'), and(eq(approvals.source, 'web'), isNotNull(approvals.card_id))),
      ),
    );
  const ids = rows.map((r) => r.id);
  // ⚠️ NOT under the project row lock, and it cannot usefully be: voidApprovals opens its own
  // transaction on the module pool (lib/void-approvals.ts), and the conveyor mints asks without
  // taking that lock anyway (domain/approvals/one-open-gate.ts). So an ask the OLD run mints
  // after this select and before the conveyor stops it survives; closing that needs the
  // conveyor to stop the old run's asks when it restarts.
  let voided = 0;
  for (let i = 0; i < ids.length; i += VOID_CHUNK) {
    const outcomes = await voidApprovals({ ids: ids.slice(i, i + VOID_CHUNK), reason: input.reason, actor: input.actor, dryRun: false });
    for (const o of outcomes.values()) if (o === 'voided') voided += 1;
  }
  return { pending: ids.length, voided };
}

// ---------------------------------------------------------------------------
// The two n8n notices
// ---------------------------------------------------------------------------

/** The kinds fr records (migration 207's move kinds were retired by R349; the column keeps them as history). */
type FailureNoticeKind = 'start_failed' | 'coach_failed';

interface FailureNoticeInput {
  kind: FailureNoticeKind;
  /** null ⇒ an UNATTACHED coach notice (only an RM id was sent and RM could not resolve it). */
  projectId: string | null;
  projectName: string | null;
  tenantId: string;
  executionId: string;
  idempotencyKey?: string | null;
  rmProjectId?: string | null;
  cardId?: string | null;
  flow?: string | null;
  node?: string | null;
  errorClass?: string | null;
  errorText: string;
}

const TITLES: Record<FailureNoticeKind, (name: string) => string> = {
  start_failed: (n) => `Conveyor start failed: ${n}`,
  coach_failed: (n) => `The kanban coach could not act: ${n}`,
};

/** The project as a notice names it; an unattached notice names the RM id it was sent. */
function noticeSubject(n: FailureNoticeInput): string {
  return n.projectName ?? `RM project ${n.rmProjectId ?? '(unknown)'} (not matched to an fr project)`;
}

function bodyOf(n: FailureNoticeInput): string {
  if (n.kind === 'start_failed') {
    return (
      `The conveyor accepted this project's start but failed at "${n.node ?? 'unknown'}": ${n.errorText} ` +
      'You can retry the start from the project\'s Execution hub.'
    );
  }
  return (
    `The kanban coach could not act or comment on card ${n.cardId ?? '(unknown)'} after a failure in ` +
    `${n.flow ?? 'a conveyor flow'} / ${n.node ?? 'unknown node'} (${n.errorClass ?? 'unknown'}): ${n.errorText} ` +
    'Nothing was retried: please move or re-run the card by hand.'
  );
}

/**
 * Record one notice (idempotent) and, the FIRST time only, tell every member of
 * the project's tenant. Returns the stored row and whether it was new.
 */
export async function recordConveyorFailure(n: FailureNoticeInput): Promise<{ row: FailureRow; created: boolean }> {
  const values = {
    project_id: n.projectId,
    tenant_id: n.tenantId,
    kind: n.kind,
    execution_id: n.executionId,
    idempotency_key: n.idempotencyKey ?? null,
    rm_project_id: n.rmProjectId ?? null,
    card_id: n.cardId ?? null,
    flow: n.flow ?? null,
    node: n.node ?? null,
    error_class: n.errorClass ?? null,
    error_text: n.errorText.slice(0, ERROR_TEXT_MAX),
  };
  const inserted = await defaultDb.insert(projectConveyorFailures).values(values).onConflictDoNothing().returning();
  let row = inserted[0];
  const created = row !== undefined;
  if (!row) {
    const key =
      n.kind === 'start_failed'
        ? and(eq(projectConveyorFailures.project_id, n.projectId!), eq(projectConveyorFailures.execution_id, n.executionId))
        : and(eq(projectConveyorFailures.tenant_id, n.tenantId), eq(projectConveyorFailures.execution_id, n.executionId));
    const [existing] = await defaultDb
      .select()
      .from(projectConveyorFailures)
      .where(and(eq(projectConveyorFailures.kind, n.kind), key))
      .limit(1);
    if (!existing) throw new Error(`project_conveyor_failures: conflict on ${n.kind} ${n.executionId} but no row found`);
    row = existing;
  }
  if (created) await notifyMembers(n, row);
  return { row, created };
}

async function notifyMembers(n: FailureNoticeInput, row: FailureRow): Promise<void> {
  const context = `${n.kind} project ${n.projectId ?? `unattached rm ${n.rmProjectId ?? '?'}`}`;
  let recipients: string[];
  try {
    recipients = (await executionEventRecipients({ tenantId: n.tenantId, explicitUserIds: [], context })).recipientIds;
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      degradedTo: `[${context}] notice ${row.id} recorded, but nobody was notified (member list unreadable); it is shown on the project`,
    });
    return;
  }
  const event: ExecutionEvent = {
    event_type: `project.${n.kind}` as ExecutionEvent['event_type'],
    tenant_id: n.tenantId,
    severity: 'error',
    title: TITLES[n.kind](noticeSubject(n)),
    body: bodyOf(n),
    link: n.projectId ? `/projects/${n.projectId}/flow-runs` : '/projects',
    project_id: n.projectId,
    card_id: n.cardId ?? null,
    execution_id: n.executionId,
    source: 'n8n',
    correlation_id: row.id,
    metadata: { notice_id: row.id, kind: n.kind },
  };
  // Each call is internally fail-safe; one bad recipient never sinks the rest.
  await Promise.allSettled(recipients.map((uid) => notificationService.fanOutEventToUser(event, uid)));
}

// ---------------------------------------------------------------------------
// The read model (the Execution hub's panel and the agent's tool)
// ---------------------------------------------------------------------------

const NOTICES_LIMIT = 50;
const ATTEMPTS_LIMIT = 20;

interface ConveyorStartState {
  attempts: AttemptRow[];
  failures: FailureRow[];
  retry: RetryOffer;
}

/**
 * The project's recorded attempts and notices, pinned to (project, tenant). A
 * tenant that is not a uuid reads nothing (fail closed, never a cast error).
 */
export async function readConveyorStartState(
  projectId: string,
  tenantId: string,
  opts: {
    /**
     * R319: read the project's start-card progress from its board (only called when the
     * offer depends on it). Absent, throwing, or `null` ⇒ unknown ⇒ nothing new offered.
     */
    readProgress?: () => Promise<StartProgress | null>;
  } = {},
): Promise<ConveyorStartState> {
  if (!isUuidShape(tenantId)) {
    return { attempts: [], failures: [], retry: { available: false, reason: 'no_start_recorded' } };
  }
  const attempts = await defaultDb
    .select()
    .from(projectConveyorStartAttempts)
    .where(and(eq(projectConveyorStartAttempts.project_id, projectId), eq(projectConveyorStartAttempts.tenant_id, tenantId)))
    .orderBy(desc(projectConveyorStartAttempts.attempt_n))
    .limit(ATTEMPTS_LIMIT);
  const failures = await defaultDb
    .select()
    .from(projectConveyorFailures)
    .where(and(eq(projectConveyorFailures.project_id, projectId), eq(projectConveyorFailures.tenant_id, tenantId)))
    .orderBy(desc(projectConveyorFailures.created_at))
    .limit(NOTICES_LIMIT);
  // The offer reads only the latest attempt; the newest ATTEMPTS_LIMIT always include it.
  const base = {
    frProjectId: projectId,
    attempts,
    startFailures: failures.filter((f) => f.kind === 'start_failed'),
    now: new Date(),
  };
  const stalledRetry = config.services.n8n.conveyorStartStalledRetry;
  const progress = needsProgressFacts({ ...base, stalledRetry })
    ? await readProgressFacts({ projectId, tenantId, stalledRetry }, opts.readProgress)
    : null;
  const retry = computeRetryOffer({ ...base, progress, stalledRetry });
  return { attempts, failures, retry };
}

/**
 * R319: the progress facts of a delivered start, or null when any of them is unknown.
 * With CONVEYOR_START_STALLED_RETRY off this is R319 exactly: a project whose start card has
 * left TODO is remembered (monotone) and its board never read again.
 * R320 (flag on): only a start card in QA or DONE is remembered; one in READY or DOING is read
 * on every offer, since it may stall.
 */
async function readProgressFacts(
  scope: { projectId: string; tenantId: string; stalledRetry: boolean },
  readProgress: (() => Promise<StartProgress | null>) | undefined,
): Promise<StartProgressFacts | null> {
  const { projectId } = scope;
  if (!readProgress || hasProgressed(projectId)) return null;
  try {
    const p = await readProgress();
    if (!p) return null;
    if (!scope.stalledRetry) {
      if (p.startCardLeftTodo) {
        rememberProgressed(projectId);
        return null;
      }
      return { startCardLeftTodo: false, onHold: await readOnHold(projectId, defaultDb) };
    }
    if (startCardProgressed(p)) {
      rememberProgressed(projectId);
      return null;
    }
    const stalledCard = stallableCardOf(p);
    if (p.startCardLeftTodo && !stalledCard) return null;
    return {
      startCardLeftTodo: p.startCardLeftTodo,
      list: p.list,
      listChangedAt: p.listChangedAt,
      onHold: await readOnHold(projectId, defaultDb),
      pendingApproval: stalledCard
        ? await readPendingApprovalOnCard({ projectId, tenantId: scope.tenantId, cardId: stalledCard }, defaultDb)
        : false,
    };
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'planka',
      method: 'GET',
      path: 'boards/:id',
      degradedTo: `project ${projectId}: start progress unknown, so "Start again" is not offered`,
    });
    return null;
  }
}

/**
 * The fr project an RM pm_project id names, inside `tenantId`: RM's answer (the row's
 * `origin_project_id`, R345 — fr keeps no RM id), confirmed against fr's own row in that tenant.
 * RM 404 (no such pm_project in the tenant) or no fr row ⇒ null; an RM outage throws.
 */
export async function findProjectIdByRmId(tenantId: string, rmProjectId: string): Promise<string | null> {
  if (!isUuidShape(rmProjectId)) return null;
  let origin: string | null | undefined;
  try {
    origin = (await getPmProjectInTenant(tenantId, rmProjectId)).origin_project_id;
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 404) return null;
    throw err;
  }
  if (!origin || !isUuidShape(origin)) return null;
  const [row] = await defaultDb
    .select({ id: projects.id })
    .from(projects)
    .where(and(eq(projects.id, origin), sql`${projects.project_data}->>'keycloak_tenant_id' = ${tenantId}`))
    .limit(1);
  return row?.id ?? null;
}
