// src/routes/webhooks/conveyor-failures.ts
//
// R311 PR 5 — the kanban coach's two failure callbacks into fr
// (n8n-workflows design/choices/v4/kanban-coach-errors.md §2.5, §4.1, R-2):
//
//   POST /api/webhooks/n8n/project-start-failed   (`project.start_failed`, op project.startFailed)
//   POST /api/webhooks/n8n/project-coach-failed   (`project.coach_failed`, op project.coachFailed)
//
// AUTH — the conveyor seat ONLY: an fr licence token (lib/licence-door.ts
// `licenceOnly`), on the licence route allowlist (lib/licence-route-allowlist.ts).
// No X-Webhook-Secret door, no Keycloak user. The project must be the licence's
// tenant's: it is looked up by fr id INSIDE that tenant only, so a foreign or
// unknown project is one and the same 404 — never an oracle.
//
// RM ONLY WHEN ONLY AN RM ID IS SENT (R345: fr keeps no RM id). An fr id is
// resolved in fr's own DB with no RM call, so a notice is never lost to an RM
// outage. A coach notice naming ONLY an RM id asks RM for its fr project; when
// RM is down or cannot resolve it, the notice is STORED UNATTACHED (project_id
// NULL, the raw rm_project_id / card_id kept; migration 234), never refused.
//
// RECORD AND SHOW, NOTHING ELSE (fr is a facilitator, never a judge): each call
// stores one notice (services/conveyor-failures.ts) and, the first time only,
// tells every member of the project's tenant (in-app inbox + their channels;
// Telegram is the live one). Idempotent: a replay answers 200 with the stored
// notice and `created: false`, and notifies nobody again.
//   * start_failed: on (fr_project_id, execution_id) — the conveyor's
//     `Coach error` and its errorWorkflow backstop may both report one failure.
//     It makes fr OFFER the start retry; fr never retries on its own.
//   * coach_failed: on (licence tenant, coach_execution_id).
//
// Empty strings are absent: the conveyor's contract fields are `''` when unknown
// (§2.1), and an empty value is never a fact.
import { z } from 'zod';

import { db, projects } from '../../db/client';
import { licenceOnly } from '../../lib/licence-door';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { conveyorProjectScope } from '../../lib/project-access';
import { isUuidShape } from '../../lib/uuid-shape';
import { readJsonBody } from '../_lib/request';
import {
  ERROR_TEXT_MAX,
  findProjectIdByRmId,
  recordConveyorFailure,
  type FailureRow,
} from '../../services/conveyor-failures';
import { AppError, NotFoundError, handleError } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';

/** `''` (the contract's "unknown") → absent, before the schema. */
const opt = <T extends z.ZodTypeAny>(s: T): z.ZodOptional<T> =>
  z.preprocess((v) => (v === '' || v === null ? undefined : v), s.optional()) as unknown as z.ZodOptional<T>;
const id = (what: string) => z.string().min(1).max(200).describe(what);
/** Clipped, never refused for length: a long error text is still a failure worth recording. */
const errorText = z
  .string()
  .min(1)
  .transform((v) => v.slice(0, ERROR_TEXT_MAX))
  .describe(`The failure's text (error.message or description). Clipped to ${ERROR_TEXT_MAX} characters.`);

export const StartFailedSchema = z.object({
  fr_project_id: z.string().uuid().describe("The fr project whose conveyor start failed (the start body's fr_project_id)."),
  rm_project_id: opt(id("The RM pm_project id (the start body's rm_project_id); must be the project's when sent.")),
  execution_id: id('The n8n execution id of the FAILED start (trigger.conveyor_start). Idempotency: (fr_project_id, execution_id).'),
  stage: id("The failed node's name, or 'unknown' (the backstop's last node in the run data)."),
  error_text: errorText,
  idempotency_key: opt(
    z
      .string()
      .max(300)
      .describe("The start's Idempotency-Key header as the failed execution received it (`<fr id>` or `<fr id>:retry-<n>`). Binds the notice to that attempt."),
  ),
});

export const CoachFailedSchema = z.object({
  fr_project_id: opt(z.string().uuid().describe('The fr project (the contract\'s fr_project_id). One of fr_project_id / rm_project_id is required.')),
  rm_project_id: opt(id('The RM pm_project id (the contract\'s project_id). Used to find the project when fr_project_id is absent.')),
  card_id: opt(id('The target card the coach could not act on.')),
  flow: id('The source flow ($workflow.name of the failed execution).'),
  node: id("The source's failed node."),
  error_class: id('The computed error class (§3.1), e.g. planka_write_failed.'),
  error_text: errorText,
  coach_execution_id: id("The coach's own n8n execution id. Idempotency: (licence tenant, coach_execution_id)."),
});

export type StartFailedBody = z.infer<typeof StartFailedSchema>;
export type CoachFailedBody = z.infer<typeof CoachFailedSchema>;

/** The body: not JSON ⇒ 400 BAD_REQUEST (routes/_lib/request.ts); off-schema ⇒ 422 `validation_failed`. */
async function readBody<T>(req: Request, schema: z.ZodType<T>): Promise<T> {
  const body = await readJsonBody<unknown>(req);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new AppError(422, 'validation failed; nothing was written', parsed.error.issues).withCode('validation_failed');
  }
  return parsed.data;
}

type ProjectRow = typeof projects.$inferSelect;

/** The project, inside the licence's tenant only. Unknown and foreign read the same 404. */
async function projectInTenant(tenantId: string, frProjectId: string): Promise<ProjectRow> {
  if (!isUuidShape(frProjectId)) throw new NotFoundError('Project not found');
  const [row] = await db.select().from(projects).where(conveyorProjectScope(tenantId, frProjectId)).limit(1);
  if (!row) throw new NotFoundError('Project not found');
  return row;
}

/**
 * The fr project an RM-id-only notice belongs to, or null (store it unattached). An RM outage is
 * reported and read as "unresolved": the notice must not be lost.
 */
async function projectOfRmId(tenantId: string, rmProjectId: string): Promise<ProjectRow | null> {
  let frProjectId: string | null;
  try {
    frProjectId = await findProjectIdByRmId(tenantId, rmProjectId);
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'requirements_management',
      method: 'GET',
      path: '/pm/projects/:id',
      degradedTo: `coach_failed notice for RM project ${rmProjectId} stored unattached (RM could not resolve it)`,
    });
    return null;
  }
  if (!frProjectId) return null;
  const [row] = await db.select().from(projects).where(conveyorProjectScope(tenantId, frProjectId)).limit(1);
  return row ?? null;
}

function shape(row: FailureRow, created: boolean): Record<string, unknown> {
  return {
    id: row.id,
    kind: row.kind,
    project_id: row.project_id,
    execution_id: row.execution_id,
    idempotency_key: row.idempotency_key,
    rm_project_id: row.rm_project_id,
    card_id: row.card_id,
    flow: row.flow,
    node: row.node,
    error_class: row.error_class,
    error_text: row.error_text,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    created,
  };
}

/** POST /api/webhooks/n8n/project-start-failed */
export async function handleProjectStartFailed(req: Request): Promise<Response> {
  try {
    const door = await licenceOnly(req);
    const b = await readBody(req, StartFailedSchema);
    const project = await projectInTenant(door.tenantId, b.fr_project_id);
    if (b.idempotency_key !== undefined && !new RegExp(`^${project.id}(:retry-[1-9][0-9]*)?$`).test(b.idempotency_key)) {
      throw new AppError(422, "idempotency_key is not one of this project's start keys (`<fr id>` or `<fr id>:retry-<n>`); nothing was written").withCode(
        'idempotency_key_mismatch',
      );
    }
    const { row, created } = await recordConveyorFailure({
      kind: 'start_failed',
      projectId: project.id,
      projectName: project.name,
      tenantId: door.tenantId,
      executionId: b.execution_id,
      idempotencyKey: b.idempotency_key ?? null,
      rmProjectId: b.rm_project_id ?? null,
      node: b.stage,
      flow: 'trigger.conveyor_start',
      errorClass: 'start_failed',
      errorText: b.error_text,
    });
    return jsonResponse({ data: shape(row, created) }, created ? 201 : 200);
  } catch (err) {
    return handleError(err);
  }
}

/** POST /api/webhooks/n8n/project-coach-failed */
export async function handleProjectCoachFailed(req: Request): Promise<Response> {
  try {
    const door = await licenceOnly(req);
    const b = await readBody(req, CoachFailedSchema);
    let project: ProjectRow | null;
    if (b.fr_project_id !== undefined) {
      project = await projectInTenant(door.tenantId, b.fr_project_id);
    } else if (b.rm_project_id !== undefined) {
      project = await projectOfRmId(door.tenantId, b.rm_project_id);
    } else {
      throw new AppError(422, 'fr_project_id or rm_project_id is required; nothing was written').withCode('project_required');
    }
    const { row, created } = await recordConveyorFailure({
      kind: 'coach_failed',
      projectId: project?.id ?? null,
      projectName: project?.name ?? null,
      tenantId: door.tenantId,
      executionId: b.coach_execution_id,
      rmProjectId: b.rm_project_id ?? null,
      cardId: b.card_id ?? null,
      flow: b.flow,
      node: b.node,
      errorClass: b.error_class,
      errorText: b.error_text,
    });
    return jsonResponse({ data: shape(row, created) }, created ? 201 : 200);
  } catch (err) {
    return handleError(err);
  }
}
