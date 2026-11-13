// src/services/rm-board-link.ts
//
// D20 (George 2026-10-13, v4 R73), fr half: fr writes the project ↔ board link
// to RM (`PUT /pm/projects/{eid}/planka-board`, rm#220) and ONLY THEN fires the
// conveyor start webhook.
//
//   * THE CREATE links INSIDE its transaction (`linkBoardInRm`, R345/R351):
//     one attempt, and a failure fails the create (502 rm_project_link_failed,
//     the fr row rolls back, the board is torn down) — never log-and-continue.
//     After the commit it runs the start alone (`boardLinked: true`).
//   * A MEMBER'S RETRY (routes/project-conveyor-start.ts) re-sends the link
//     (RM answers the identical link 200 `changed: false`), then starts. n8n resolves every
// Planka webhook (which names only Planka ids) to the RM project through that
// link, so a start event for a project whose board is not linked would start a
// conveyor that cannot find its own project.
//
//   * The link is retried up to 3 times (4 attempts) on a network error, a
//     timeout or a 5xx. RM's 4xx answers are final: 403
//     `project_writes_are_pm_only` (a DIFFERENT link already stored), 409
//     `planka_board_in_use` (the board belongs to another project of the tenant
//     — never "success": RM's idempotent case is the SAME link re-sent, which
//     answers 200 `changed: false`), 404, 422.
//   * Final failure: the start webhook is NOT sent; the failure is logged at
//     error level with the fr project id (and reported through
//     reportSwallowedFailure, exactly like a failed start webhook). The create
//     itself never fails — it has already answered: this whole chain is
//     detached (trackDetached), like emitConveyorStart always was.
//   * R311 PR 5 (kanban-coach-errors.md §2.5): every run is ONE recorded start
//     attempt (services/conveyor-failures.ts). The create records attempt 0 here
//     (the bare `Idempotency-Key: <fr id>`); a member's retry records attempt n
//     under the project lock BEFORE calling this and passes it in
//     (`Idempotency-Key: <fr id>:retry-<n>`). The outcome is stamped on the row:
//     `board_link_failed` (no start sent), else the start webhook's
//     `delivered` / `failed` / `inert`. Recording is best effort: a failed
//     attempt insert is reported and the start still goes out under the bare key.

import { isIntegrationError, reportSwallowedFailure } from '../integrations/_lib/errors';
import { PM_CONVEYOR_LISTS, type PmConveyorList, type PmProjectBoardLinkIn } from '../integrations/pm';
import { trackDetached } from '../lib/detached-work';
import { linkRmProjectPlankaBoard } from './catalogue/project-state';
import { startConveyor, type ConveyorRestart, type ConveyorStartOutcome } from './conveyor-start-webhook';
import {
  RESTART_NOT_DONE_MESSAGE,
  STALLED_RETRY_MARK,
  beginCreateStartAttempt,
  completeStartAttempt,
  restartNotDone,
  type BegunAttempt,
} from './conveyor-failures';

/** 1 attempt + up to 3 retries. */
const RM_BOARD_LINK_MAX_ATTEMPTS = 4;
/** Wait before retry 1, 2 and 3. */
const RM_BOARD_LINK_BACKOFF_MS: readonly number[] = Object.freeze([500, 1_000, 2_000]);

export interface BoardLinkInput {
  tenantId: string;
  rmPmProjectId: string;
  frProjectId: string;
  plankaProjectId: string | null | undefined;
  plankaBoardId: string;
  /** list name → Planka list id, as the board builder returned them. */
  listIds: Readonly<Record<string, string>>;
  /**
   * The start attempt this run is (a member's retry, recorded under the project
   * lock by the retry route). Absent ⇒ the create's start: attempt 0 is recorded here.
   * `reason` is why the retry was offered. R320: `stalled_retry` (set by beginRetryStartAttempt
   * when the start card sat in READY/DOING at send time, flag on) marks the answer's detail.
   */
  attempt?: BegunAttempt & { reason?: string; stalled_retry?: true };
  /** George 2026-10-31: a member's project or phase restart (sent in the start body's `restart`). */
  restart?: ConveyorRestart;
  /**
   * false ⇒ link the board ONLY: no start attempt is recorded and the conveyor start webhook is
   * never sent. A kata project (services/katas/open.ts) — fr creates its first card itself, so a
   * conveyor start would make a second first card. Absent ⇒ true (every other project).
   */
  startConveyor?: boolean;
  /** true ⇒ the create already linked the board in its transaction (`linkBoardInRm`): start only. */
  boardLinked?: boolean;
}

type BoardLinkOutcome =
  | { kind: 'linked'; attempts: number; changed: boolean }
  | { kind: 'failed'; attempts: number; status: number | null; reason: string };

/**
 * The PUT body: the board, its Planka project and the id of each of the six
 * conveyor lists. Returns the missing list names instead when the board lacks
 * any of them (RM requires all six — a partial body would be a 422).
 */
type BoardLinkTarget = Pick<BoardLinkInput, 'tenantId' | 'rmPmProjectId' | 'plankaProjectId' | 'plankaBoardId' | 'listIds'>;

function boardLinkBody(input: BoardLinkTarget): { body: PmProjectBoardLinkIn } | { missing: PmConveyorList[] } {
  const missing = PM_CONVEYOR_LISTS.filter((name) => !input.listIds[name]);
  if (missing.length) return { missing };
  const planka_list_ids = Object.fromEntries(PM_CONVEYOR_LISTS.map((name) => [name, input.listIds[name]!])) as Record<
    PmConveyorList,
    string
  >;
  return {
    body: {
      planka_board_id: input.plankaBoardId,
      planka_project_id: input.plankaProjectId || null,
      planka_list_ids,
    },
  };
}

function retriable(err: unknown): { retry: boolean; status: number | null } {
  if (isIntegrationError(err)) {
    const status = err.upstreamStatus ?? null;
    if (status !== null) return { retry: status >= 500, status };
    // No upstream status: unreachable / timeout / a bad body — transient.
    return { retry: err.code === 'UPSTREAM_UNREACHABLE' || err.code === 'UPSTREAM_TIMEOUT' || err.code === 'UPSTREAM_BAD_STATUS', status };
  }
  // A raw network error (TypeError: fetch failed) — transient.
  return { retry: true, status: null };
}

/**
 * THE CREATE'S board link: ONE attempt, inside the create's transaction. Throws
 * when the board lacks a conveyor list, when RM refuses or is unreachable, and
 * when RM's answer names a different board — the caller fails the create.
 * Returns RM's answer: the only source of fr's `projects.planka_board_id` cache.
 */
export async function linkBoardInRm(
  input: BoardLinkTarget,
): Promise<{ planka_board_id: string; planka_project_id: string | null }> {
  assertBoardLinkable(input);
  const built = boardLinkBody(input);
  if ('missing' in built) throw new Error('unreachable: assertBoardLinkable passed');
  const out = await linkRmProjectPlankaBoard(input.tenantId, input.rmPmProjectId, built.body);
  if (out?.planka_board_id !== input.plankaBoardId) {
    throw new Error(
      `requirements_management linked pm_project ${input.rmPmProjectId} to board ${out?.planka_board_id ?? '(none)'}, ` +
        `not to board ${input.plankaBoardId}`,
    );
  }
  return { planka_board_id: out.planka_board_id, planka_project_id: out.planka_project_id ?? null };
}

/**
 * Throws unless the board carries all six conveyor lists RM's link needs. The create calls it BEFORE
 * its RM POST, so a board fr cannot link never leaves an RM row behind.
 */
export function assertBoardLinkable(input: Pick<BoardLinkTarget, 'plankaBoardId' | 'listIds'>): void {
  const missing = PM_CONVEYOR_LISTS.filter((name) => !input.listIds[name]);
  if (missing.length) {
    throw new Error(`board ${input.plankaBoardId} has no ${missing.join(', ')} list(s); RM needs all six conveyor lists`);
  }
}

/** One link with retries. Never throws. */
async function linkBoardWithRetry(input: BoardLinkInput): Promise<BoardLinkOutcome> {
  if (input.boardLinked) return { kind: 'linked', attempts: 0, changed: false };
  const built = boardLinkBody(input);
  if ('missing' in built) {
    return {
      kind: 'failed',
      attempts: 0,
      status: null,
      reason: `board ${input.plankaBoardId} has no ${built.missing.join(', ')} list(s); RM needs all six conveyor lists`,
    };
  }
  let last: { status: number | null; reason: string } = { status: null, reason: 'not attempted' };
  for (let attempt = 1; attempt <= RM_BOARD_LINK_MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise((r) => setTimeout(r, RM_BOARD_LINK_BACKOFF_MS[attempt - 2] ?? 2_000));
    try {
      const out = await linkRmProjectPlankaBoard(input.tenantId, input.rmPmProjectId, built.body);
      return { kind: 'linked', attempts: attempt, changed: out?.changed !== false };
    } catch (err) {
      const r = retriable(err);
      last = { status: r.status, reason: err instanceof Error ? err.message : String(err) };
      if (!r.retry) return { kind: 'failed', attempts: attempt, ...last };
    }
  }
  return { kind: 'failed', attempts: RM_BOARD_LINK_MAX_ATTEMPTS, ...last };
}

/**
 * Link the board, then (only on success) start the conveyor. Awaitable for
 * tests; production calls {@link linkBoardThenStartConveyor}. Never throws.
 */
async function runBoardLinkThenStart(input: BoardLinkInput): Promise<BoardLinkOutcome> {
  if (input.startConveyor === false) return runBoardLinkOnly(input);
  const attempt = input.attempt ?? (await recordCreateAttempt(input));
  const outcome = await linkBoardWithRetry(input);
  if (outcome.kind === 'linked') {
    const started = await startConveyor({
      rm_project_id: input.rmPmProjectId,
      tenant_id: input.tenantId,
      fr_project_id: input.frProjectId,
      ...(attempt ? { idempotency_key: attempt.idempotency_key } : {}),
      ...(input.restart ? { restart: input.restart } : {}),
    });
    if (attempt && started) {
      const stalled = input.attempt?.stalled_retry === true;
      const detail = attemptDetail(started, { stalled });
      await completeStartAttempt(attempt.id, started.kind, detail);
      if (stalled && (started.kind === 'delivered' || started.kind === 'refused') && restartNotDone({ outcome: started.kind, outcome_detail: detail })) {
        // R320: fr sent a start for a stalled start card and the conveyor did not restart it (it answers
        // as before R320). The member is shown RESTART_NOT_DONE_MESSAGE; this tells the team.
        reportSwallowedFailure(new Error(`the conveyor did not restart a stalled start: ${detail}`), {
          service: 'n8n-conveyor-start',
          method: 'POST',
          path: 'CONVEYOR_START_WEBHOOK_URL',
          degradedTo: `project ${input.frProjectId} attempt ${attempt.attempt_n} recorded; the member sees "${RESTART_NOT_DONE_MESSAGE}"`,
        });
      }
    }
    return outcome;
  }
  if (attempt) await completeStartAttempt(attempt.id, 'board_link_failed', outcome.reason);
  console.error(
    `[projects.create] RM board link FAILED for project ${input.frProjectId} (RM pm_project ${input.rmPmProjectId}, ` +
      `board ${input.plankaBoardId}) after ${outcome.attempts} attempt(s): ${outcome.reason}. ` +
      'The conveyor start webhook was NOT sent; the project exists but its conveyor is not started.',
  );
  reportSwallowedFailure(new Error(`RM planka-board link failed: ${outcome.reason}`), {
    service: 'requirements_management',
    method: 'PUT',
    path: `/pm/projects/${input.rmPmProjectId}/planka-board`,
    degradedTo: `project ${input.frProjectId} created without a board link and without a project.created event`,
  });
  return outcome;
}

/** {@link BoardLinkInput.startConveyor} false: the RM board link alone, nothing sent to the conveyor. */
async function runBoardLinkOnly(input: BoardLinkInput): Promise<BoardLinkOutcome> {
  const outcome = await linkBoardWithRetry(input);
  if (outcome.kind === 'failed') {
    console.error(
      `[projects.create] RM board link FAILED for project ${input.frProjectId} (RM pm_project ${input.rmPmProjectId}, ` +
        `board ${input.plankaBoardId}) after ${outcome.attempts} attempt(s): ${outcome.reason} (no conveyor start: startConveyor=false).`,
    );
    reportSwallowedFailure(new Error(`RM planka-board link failed: ${outcome.reason}`), {
      service: 'requirements_management',
      method: 'PUT',
      path: `/pm/projects/${input.rmPmProjectId}/planka-board`,
      degradedTo: `project ${input.frProjectId} created without a board link`,
    });
  }
  return outcome;
}

/**
 * The attempt's `outcome_detail`. A refusal stores the conveyor's code ALONE
 * (computeRetryOffer maps it to the member's text); a delivery its status plus
 * whether the conveyor called it a duplicate or a resume (both are `delivered`:
 * the conveyor has the start).
 */
export function attemptDetail(started: ConveyorStartOutcome, opts: { stalled?: boolean } = {}): string | null {
  // R320: a `stalled` retry's answer carries STALLED_RETRY_MARK, so the offer can tell a
  // restart the conveyor did not make (refused / duplicate) from one it did (restarted / running).
  const mark = opts.stalled ? ` ${STALLED_RETRY_MARK}` : '';
  switch (started.kind) {
    case 'refused':
      return `${started.code}${mark}`;
    case 'failed':
      return started.reason;
    case 'delivered':
      return (
        `HTTP ${started.status}${started.duplicate ? ' duplicate' : ''}${started.resumed ? ' resumed' : ''}` +
        `${started.restarted ? ' restarted' : ''}${started.running ? ' running' : ''}` +
        `${started.restart_in_progress ? ' restart_in_progress' : ''}${mark}`
      );
    default:
      return null;
  }
}

/** Attempt 0 for the create's start; a recording failure is reported and the start still goes out (bare key). */
async function recordCreateAttempt(input: BoardLinkInput): Promise<BegunAttempt | null> {
  try {
    return await beginCreateStartAttempt({ projectId: input.frProjectId, tenantId: input.tenantId });
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'INSERT',
      path: 'project_conveyor_start_attempts',
      degradedTo: `project ${input.frProjectId}: conveyor start sent without a recorded attempt (bare Idempotency-Key)`,
    });
    return null;
  }
}

/** Fire-and-forget: synchronous `void`, never throws, never awaited by the create. */
export function linkBoardThenStartConveyor(input: BoardLinkInput): void {
  void trackDetached(
    runBoardLinkThenStart(input).catch((err: unknown) => {
      console.error(`[projects.create] RM board link crashed for project ${input.frProjectId}:`, err);
      return undefined;
    }),
  );
}
