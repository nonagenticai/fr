// src/routes/project-conveyor-start.ts
//
// R311 PR 5 (n8n-workflows design/choices/v4/kanban-coach-errors.md §2.5, §4.1,
// R-2, R-8) — what the conveyor reported went wrong for a project, and the start
// retry a member may ask for:
//
//   GET  /api/projects/:id/conveyor-notices        the recorded start attempts, the
//                                                  `project.start_failed` / `project.coach_failed`
//                                                  notices, and whether a start retry is offered
//   POST /api/projects/:id/conveyor-start/retry    a member retries the conveyor start
//
// GATES: GET — validateAuth → `loadProjectForRead` (any member of the project's
// tenant, P1-TEAM-a; the same 404 for every unreadable shape). POST — the project
// WRITE lane (`loadTenantScopedProject`: any member of the project's tenant;
// archived → 409). Not on the licence route allowlist: the conveyor seat can never
// ask for a retry — fr never retries on its own, and neither does n8n through fr.
//
// THE RETRY (fr is a facilitator: it decides nothing). It is OFFERED from recorded
// facts only (services/conveyor-failures.ts `computeRetryOffer`): after a recorded
// `start_failed`, after a start fr could not deliver, or for a project whose RM
// board link failed (R-8: "stays available for a project with no board link").
// Under the project row lock it records attempt n and sends the start with
// `Idempotency-Key: <fr id>:retry-<n>` — a key n8n's Dedupe has never seen (§2.5).
// The send is the create's own chain (services/rm-board-link.ts: link the board in
// RM — idempotent when the same link is stored — then the start webhook), run
// detached: the answer is 202 with the attempt, and its outcome is recorded on it.
//
// R319 "Start again" (Claude, 2026-10-21; program/v4-alignment/U1-brief.md): the same
// retry is also offered (`no_progress`) when the latest start was DELIVERED ≥ 10 min ago
// and the project's start card is still in TODO on its board
// (services/conveyor-start-progress.ts). Both handlers read the board for that; an
// unreadable board on the GET offers nothing new (and the POST answers the board error,
// as before). Never while the project is on hold (`on_hold`).
//
// R320 (program/v4-alignment/R320-start-again-stalled.md): behind CONVEYOR_START_STALLED_RETRY
// (default off) the same retry is also offered (`stalled`) for a start card in READY or DOING
// with no list change and no start answer for 30 min, no approval pending on it, not on hold.
// The same board read supplies the card's id/list/listChangedAt; the approval and the hold are
// read under the project row lock. No conveyor read.
//
// RESTART (George 2026-10-31): "Start again" is ALSO a real restart of ANY active project —
// the whole project (`scope: 'project'`) or its current RM phase (`scope: 'phase'`); the
// conveyor then runs every card in that scope again, finished ones included. The POST takes an
// optional JSON body `{scope, phase?, comment?}`; no body (or no scope) is the start-card retry
// above, unchanged. R349 (George 2026-11-04): a phase restart names ANY phase of the project
// type at or before the current RM phase (else 409 `restart_phase_invalid`), and the member may
// add a comment (trimmed, ≤ 2000) to steer that run. A restart: reads the RM phase fresh,
// records attempt n under `<fr id>:restart-<n>` under the project row lock, VOIDS the
// conveyor's open questions on this project plus open requests about its cards (fr keeps one
// open gate per card, so a stale ask would swallow the re-run's), then sends the start with
// `restart: {scope, phase (scope phase), comment (when given)}`. The GET reports `restart`
// (offered for every active, undelivered project; `phase` = the RM phase, null when unknown;
// `phases` = the restartable phases, each with `default_comment` — the comment of that phase's
// latest decided phase-start sign-off, services/conveyor-failures.ts phaseStartSignoffComments).
import { z } from 'zod';

import { config } from '../config';
import { db as defaultDb } from '../db/client';
import { redact } from '../capabilities/redact';
import { loadProjectForRead, loadTenantScopedProject } from '../lib/project-access';
import { isUuidShape } from '../lib/uuid-shape';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { isLiveProjectStatus } from '../lib/project-live-status';
import {
  freshProjectState,
  isRmProjectMissing,
  phasesOfState,
  projectTypeAndPhase,
  type RmProjectState,
} from '../services/catalogue/project-state';
import {
  RESTART_COMMENT_MAX,
  RESTART_SCOPES,
  beginRestartAttempt,
  beginRetryStartAttempt,
  cardPhaseFieldsOf,
  computeRestartOffer,
  isRestartAttempt,
  phaseStartSignoffComments,
  readConveyorStartState,
  readProjectOnHold,
  restartablePhases,
  withdrawAsksForRestart,
  type AttemptRow,
  type FailureRow,
  type RestartScope,
} from '../services/conveyor-failures';
import { forgetProgressed, startProgressOf, type StartProgressBoard } from '../services/conveyor-start-progress';
import { reportSwallowedFailure } from '../integrations/_lib/errors';
import { plankaClient } from '../services/planka';
import { deliveryFromRm } from '../services/project-delivered';
import { linkBoardThenStartConveyor } from '../services/rm-board-link';
import { AppError, ValidationError, handleError } from '../utils/errors';
import { jsonResponse } from '../utils/response';

type ProjectRow = Awaited<ReturnType<typeof loadProjectForRead>>;

type RawBoardLists = StartProgressBoard;

function readBoardLists(boardId: string): Promise<RawBoardLists> {
  return plankaClient.asAgent().boards.get(boardId) as Promise<RawBoardLists>;
}

const iso = (v: Date | string | null | undefined): string | null =>
  v == null ? null : v instanceof Date ? v.toISOString() : String(v);

function shapeAttempt(a: AttemptRow): Record<string, unknown> {
  return {
    attempt_n: a.attempt_n,
    idempotency_key: a.idempotency_key,
    trigger: a.requested_by === null ? 'create' : isRestartAttempt(a) ? 'restart' : 'retry',
    outcome: a.outcome,
    outcome_detail: a.outcome_detail,
    created_at: iso(a.created_at),
    completed_at: iso(a.completed_at),
  };
}

function shapeNotice(f: FailureRow): Record<string, unknown> {
  return {
    id: f.id,
    kind: f.kind,
    execution_id: f.execution_id,
    idempotency_key: f.idempotency_key,
    card_id: f.card_id,
    flow: f.flow,
    node: f.node,
    error_class: f.error_class,
    error_text: f.error_text,
    created_at: iso(f.created_at),
  };
}

function tenantTagOf(project: ProjectRow): string {
  const v = (project.project_data as Record<string, unknown> | null)?.keycloak_tenant_id;
  return typeof v === 'string' ? v : '';
}

/**
 * The restart offer for the GET (George 2026-10-31). The RM state is the 60 s cached read; an
 * unreadable RM leaves the phase unknown (a phase restart is then not offered) and the delivery
 * to the row's own status — the POST reads RM fresh and decides.
 */
async function restartOfferFor(project: ProjectRow, attempts: readonly AttemptRow[]) {
  // On the conveyor = RM holds the project's pm_project (R345: RM's answer, by origin_project_id) and
  // it has a board. No RM project or no board: nothing to restart.
  let rm: RmProjectState | null = null;
  let onConveyor = false;
  try {
    rm = await projectTypeAndPhase(project);
    onConveyor = !!(rm.pm.planka_board_id ?? project.planka_board_id);
  } catch (err) {
    if (!isRmProjectMissing(err)) {
      // RM unreadable: whether it holds the project is unknown; the board cache decides the offer.
      onConveyor = !!project.planka_board_id;
      reportSwallowedFailure(err, {
        service: 'requirements_management',
        method: 'GET',
        path: '/pm/projects/:id',
        degradedTo: `project ${project.id}: phase unknown, so a phase restart is not offered`,
      });
    }
  }
  const delivered = deliveryFromRm(project, rm).status === 'delivered';
  // An unreadable hold offers nothing (fail closed, as the start retry's progress facts do).
  let onHold = true;
  try {
    onHold = await readProjectOnHold(project.id);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'fr-db',
      method: 'SELECT',
      path: 'projects.andon',
      degradedTo: `project ${project.id}: hold unreadable, so "Start again" is not offered`,
    });
  }
  const offer = computeRestartOffer({
    frProjectId: project.id,
    attempts,
    now: new Date(),
    live: isLiveProjectStatus(project.status),
    delivered,
    phase: rm?.phase ?? null,
    configured: !!config.services.n8n.conveyorStartWebhookUrl,
    onConveyor,
    onHold,
  });
  return { ...offer, phases: offer.available && rm ? await restartPhaseOptions(project, rm) : [] };
}

/** One phase the member may restart (R349): RM's name and title, and the comment to prefill. */
export interface RestartPhaseOption {
  name: string;
  title: string;
  default_comment: string | null;
}

/**
 * R349: the phases a member may restart (the current one and earlier, RM order), each with the
 * comment of its latest decided phase-start sign-off. Best-effort for the GET: an unreadable
 * phase list offers no phase; an unreadable board or approvals read leaves the comments null.
 */
async function restartPhaseOptions(project: ProjectRow, rm: RmProjectState): Promise<RestartPhaseOption[]> {
  let phases: Array<{ name: string; title: string }>;
  try {
    phases = restartablePhases(await phasesOfState(rm), rm.phase);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'requirements_management',
      method: 'GET',
      path: '/project-types',
      degradedTo: `project ${project.id}: phase list unknown, so no phase restart is offered`,
    });
    return [];
  }
  let comments = new Map<string, string | null>();
  if (phases.length > 0 && project.planka_board_id) {
    try {
      comments = await phaseStartSignoffComments({
        projectId: project.id,
        tenantId: tenantTagOf(project),
        cardPhases: cardPhaseFieldsOf(await readBoardLists(project.planka_board_id)),
      });
    } catch (err) {
      reportSwallowedFailure(err, {
        service: 'planka',
        method: 'GET',
        path: '/boards/:id',
        degradedTo: `project ${project.id}: restart comments not prefilled`,
      });
    }
  }
  return phases.map((p) => ({ name: p.name, title: p.title, default_comment: comments.get(p.name) ?? null }));
}

/** GET /api/projects/:id/conveyor-notices */
export async function handleListProjectConveyorNotices(req: Request, projectId: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    const project = await loadProjectForRead(defaultDb, user, projectId);
    const boardId = project.planka_board_id;
    const state = await readConveyorStartState(project.id, ctxTenantId(user.tenantId), {
      // R319: read only when the offer depends on it (a delivered start ≥ 10 min old).
      readProgress: boardId ? async () => startProgressOf(await readBoardLists(boardId)) : undefined,
    });
    // Free text from n8n (error_text, node names) may carry a secret: scrubbed like every execution read.
    return jsonResponse({
      data: redact({
        project_id: project.id,
        retry: state.retry,
        restart: await restartOfferFor(project, state.attempts),
        notices: state.failures.map(shapeNotice),
        attempts: state.attempts.map(shapeAttempt),
      }),
    });
  } catch (err) {
    return handleError(err);
  }
}

/** The optional POST body: `{scope, phase?, comment?}` asks for a restart; no body is the start-card retry. */
const restartBody = z
  .object({
    scope: z.enum(RESTART_SCOPES as [RestartScope, ...RestartScope[]]),
    phase: z.string().trim().min(1).max(200).optional(),
    comment: z.string().trim().max(RESTART_COMMENT_MAX).optional(),
  })
  .strict();

/** A restart request as every channel passes it to `runStartAgain`. */
export type RestartRequest = { scope: RestartScope; phase?: string; comment?: string };

async function readRestartRequest(req: Request): Promise<z.infer<typeof restartBody> | null> {
  const text = await req.text().catch(() => '');
  if (text.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new ValidationError('The request body is not JSON').withCode('invalid_input');
  }
  // `{}` (no scope) is the start-card retry, as with no body.
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && Object.keys(parsed).length === 0) return null;
  const r = restartBody.safeParse(parsed);
  if (!r.success) {
    throw new ValidationError(
      `\`scope\` must be 'project' or 'phase' (\`phase\`, when sent, a phase name; \`comment\`, when sent, at most ${RESTART_COMMENT_MAX} characters)`,
      { issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) },
    ).withCode('invalid_input');
  }
  return r.data;
}

/** The member asking (the web route's verified user, or an agent action's caller on any channel). */
export type StartAgainCaller = Parameters<typeof loadTenantScopedProject>[1];

/** What a start retry or a restart answers (202). */
export type StartAgainAnswer = Record<string, unknown> & { project_id: string; status: 'pending' };

/**
 * THE ONE start-again path (George 2026-10-30/31: web, Telegram and the fr MCP are equivalent).
 * The web route and the agent action `projects.retry_conveyor_start` on every channel both run
 * it: the project WRITE lane (`loadTenantScopedProject`: any member of the project's tenant,
 * archived → 409), then the start-card retry (`restart` null) or a project/phase restart.
 * Throws the same AppErrors on every channel.
 */
export async function runStartAgain(
  caller: StartAgainCaller,
  projectId: string,
  restart: RestartRequest | null,
): Promise<StartAgainAnswer> {
  const project = await loadTenantScopedProject(defaultDb, caller, projectId);
  const tenantId = tenantTagOf(project);
  if (!isUuidShape(tenantId)) {
    throw new AppError(409, 'This project carries no tenant tag, so its conveyor start cannot be recorded; nothing was sent').withCode(
      'project_tenant_unknown',
    );
  }
  // R345: the RM project and its board are RM's answer (read fresh, by origin_project_id). RM holding
  // no board yet (a create from before the board link moved into the create's transaction, whose
  // detached link failed) ⇒ the board fr built for it: the link this retry sends completes it.
  let rm: RmProjectState;
  try {
    rm = await freshProjectState(project);
  } catch (err) {
    if (!isRmProjectMissing(err)) throw err;
    throw new AppError(409, 'This project has no requirements_management project, so the conveyor cannot be started; nothing was sent').withCode(
      'rm_project_missing',
    );
  }
  const rmPmProjectId = rm.rmPmProjectId;
  const plankaBoardId = rm.pm.planka_board_id ?? project.planka_board_id;
  if (!plankaBoardId) {
    throw new AppError(409, 'This project has no board, so the conveyor cannot be started; nothing was sent').withCode('board_missing');
  }
  // The six conveyor list ids the board link needs, read BEFORE anything is recorded:
  // an unreadable board answers its own error and records no attempt.
  const board = await readBoardLists(plankaBoardId);
  const listIds: Record<string, string> = {};
  for (const l of board.included?.lists ?? []) if (l.name) listIds[l.name] = l.id;
  if (restart) {
    return await restartProject({ user: caller, project, tenantId, rmPmProjectId, plankaBoardId, listIds, restart });
  }
  const attempt = await beginRetryStartAttempt({
    projectId: project.id,
    tenantId,
    requestedBy: caller.id,
    startProgress: startProgressOf(board),
  });
  linkBoardThenStartConveyor({
    tenantId,
    rmPmProjectId,
    frProjectId: project.id,
    plankaProjectId: rm.pm.planka_project_id ?? project.planka_project_id,
    plankaBoardId,
    listIds,
    attempt,
  });
  return {
    project_id: project.id,
    attempt_n: attempt.attempt_n,
    idempotency_key: attempt.idempotency_key,
    offered_because: attempt.reason,
    status: 'pending',
  };
}

/** POST /api/projects/:id/conveyor-start/retry */
export async function handleRetryProjectConveyorStart(req: Request, projectId: string): Promise<Response> {
  try {
    const user = await validateAuth(req);
    const restart = await readRestartRequest(req);
    return jsonResponse({ data: await runStartAgain(user, projectId, restart) }, 202);
  } catch (err) {
    return handleError(err);
  }
}

/** The restart half of the POST (George 2026-10-31). */
async function restartProject(input: {
  user: StartAgainCaller;
  project: Awaited<ReturnType<typeof loadTenantScopedProject>>;
  tenantId: string;
  rmPmProjectId: string;
  plankaBoardId: string;
  listIds: Record<string, string>;
  restart: RestartRequest;
}): Promise<StartAgainAnswer> {
  const { project, tenantId, restart } = input;
  // RM read fresh (never the 60 s cache): the phases restartable are judged against the phase RM holds NOW.
  const rm = await freshProjectState(project);
  const selectable =
    restart.scope === 'phase' && rm.phase ? restartablePhases(await phasesOfState(rm), rm.phase).map((p) => p.name) : [];
  const attempt = await beginRestartAttempt({
    projectId: project.id,
    tenantId,
    requestedBy: input.user.id,
    scope: restart.scope,
    rmPhase: rm.phase ?? null,
    delivered: deliveryFromRm(project, rm).status === 'delivered',
    phase: restart.phase ?? null,
    selectable,
  });
  const comment = restart.comment?.trim() ? restart.comment.trim() : undefined;
  // Throws (and marks the attempt failed) when the void fails: nothing below runs, nothing is sent.
  const voided = await withdrawAsksForRestart({ attempt, projectId: project.id, tenantId, actor: input.user.id });
  forgetProgressed(project.id);
  linkBoardThenStartConveyor({
    tenantId,
    rmPmProjectId: input.rmPmProjectId,
    frProjectId: project.id,
    plankaProjectId: rm.pm.planka_project_id ?? project.planka_project_id,
    plankaBoardId: input.plankaBoardId,
    listIds: input.listIds,
    attempt,
    restart: {
      ...(attempt.scope === 'phase' ? { scope: 'phase' as const, phase: attempt.phase! } : { scope: 'project' as const }),
      ...(comment ? { comment } : {}),
    },
  });
  return {
    project_id: project.id,
    attempt_n: attempt.attempt_n,
    idempotency_key: attempt.idempotency_key,
    restart: { scope: attempt.scope, phase: attempt.phase, comment: comment ?? null },
    voided_asks: voided.voided,
    status: 'pending',
  };
}
