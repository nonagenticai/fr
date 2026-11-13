// src/routes/suggested-schedules.ts
//
// Spec 2 §9 / Plan 2-D Phase 5 — Suggestion Inbox backend.
//
// Four endpoints:
//
//   GET  /api/projects/:projectId/suggested-schedules?status=new
//        — list candidates for a project. Dept-member+ on the project's
//          dept (workspace-admin if project is workspace-scope).
//
//   POST /api/internal/suggested-schedules
//        — admin-only stub used by QA + the future heuristic auto-
//          detector. Body is `{ project_id, ad_hoc_summary, payload }`
//          and `source` is forced to 'manual' (Phase 5 ships the manual
//          path; the heuristic path lives in a later phase per Spec §9
//          and is intentionally out of scope here).
//
//   POST /api/suggested-schedules/:id/accept
//        — atomic promote. In a single tx we:
//            1. SELECT the row + assert status='new' (else 409)
//            2. Validate the project's shape is `continuous_flow` (else 422)
//            3. Validate cron + connector_config + payload_mapper from
//               the suggestion's `payload.suggested_*` keys
//            4. INSERT into scheduled_triggers
//            5. UPDATE the suggestion row: status='accepted',
//               promoted_trigger_id=<new trigger id>
//          Returns the new scheduled_triggers row.
//          Dept-manager+ on project's dept.
//
//   POST /api/suggested-schedules/:id/dismiss
//        — UPDATE status='dismissed'. Idempotent: dismissing an already-
//          dismissed row is a 200 no-op. Dept-member+ on project's dept.
//
// `payload.suggested_*` shape mirrors scheduled_triggers fields. We don't
// trust the row was inserted with valid keys — the accept handler
// validates them with the same helpers scheduled-triggers uses
// (validateCron, ConnectorConfig, compileMapper) so a bad heuristic /
// QA stub fails at promote-time rather than at first cron tick.
//
// RBAC pattern matches scheduled-triggers / scheduled-reports: tenant_id
// is always taken from `user.tenantId` (post-validateAuth), strict zod
// schemas reject body-supplied tenant_id / id.

import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import { db } from '../db/client';
import {
  departments,
  projects,
  scheduledTriggers,
  suggestedSchedules,
  type SuggestedSchedule,
} from '../db/schema';
import { validateCron, CronValidationError } from '../lib/cron-due';
import { compileMapper } from '../lib/payload-mapper';
import { ConnectorConfig, isUserConfigurableConnectorKind } from '../types/connectors';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { gateOnProject } from '../auth/projectDeptGate';
import { projectOwnerTenant } from '../lib/board-tenant-access';
import { isUuidShape } from '../lib/uuid-shape';
import { userRolesService } from '../services/user-roles';
import {
  AppError,
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
} from '../utils/errors';
import {
  createdResponse,
  jsonResponse,
} from '../utils/response';
import type { User } from '../types/api';

// ---------- Validation ----------------------------------------------------

const SourceConnectorEnum = z.enum([
  'file',
  's3',
  'rss',
  'imap',
  'github_query',
  'n8n_webhook',
]);

const CardTemplateSchema = z.object({
  card_type: z.string().min(1),
  labels: z.array(z.string()).optional(),
  custom_fields: z.record(z.unknown()).optional(),
});

// Schema applied to `payload` at accept-time (NOT at internal-create
// time — the heuristic / QA inserter is allowed to write half-formed
// payloads; we just refuse to promote them). Mirrors
// scheduled-triggers' CreateBodySchema, prefixed with `suggested_`.
const AcceptPayloadSchema = z
  .object({
    suggested_name: z.string().min(1).max(256),
    suggested_cron: z.string().min(1),
    suggested_timezone: z.string().min(1).default('UTC'),
    suggested_source_connector: SourceConnectorEnum,
    suggested_connector_config: z.record(z.unknown()),
    suggested_payload_mapper: z.record(z.string()),
    suggested_target_list: z.string().min(1).default('INBOX'),
    suggested_card_template: CardTemplateSchema,
    suggested_enabled: z.boolean().default(true),
  })
  .passthrough(); // tolerate extra heuristic-only fields

const InternalCreateBodySchema = z
  .object({
    project_id: z.string().uuid(),
    ad_hoc_summary: z.string().min(1).max(2000),
    payload: z.record(z.unknown()).default({}),
    user_id: z.string().uuid().optional(),
  })
  .strict();

// ---------- Internal helpers ----------------------------------------------

/**
 * Load a project IN THE CALLER'S TENANT — the same owner check as
 * scheduled-triggers-shared.ts `loadProjectShape` (fr row 54107daa): the owner
 * is `projectOwnerTenant` (dept `workspace_id`, else
 * `project_data.keycloak_tenant_id`), and a foreign or ownerless project is the
 * SAME miss as an absent one, so a foreign id cannot be probed. The dept-role
 * gates do not provide this: the tenant_admin bypass in requireDeptRole /
 * isWorkspaceAdmin is not scoped to the PROJECT's tenant.
 */
async function loadProject(
  projectId: string,
  callerTenantId: string,
): Promise<{ id: string; shape: string; dept_id: string | null } | null> {
  // `projects.id` is a `uuid` column (schema.ts:72). A `:projectId` path
  // segment that is not UUID-shaped does NOT select zero rows — it aborts the
  // query with 22P02 `invalid input syntax for type uuid`, which escapes
  // `handleListSuggestedSchedules` as a bare 500, a status this surface does
  // not promise for a bad id. Returning this function's OWN miss value keeps
  // malformed and absent indistinguishable: both callers turn `null` into the
  // existing `NotFoundError('project_id does not exist')`, so a prober gets no
  // oracle for telling a malformed id from a well-formed unreachable one.
  //
  // `isUuidShape`, NOT `isValidUuid` (utils/tenant): that one pins the version
  // nibble to 1-8 and the variant to [89ab] and would 404 rows that exist.
  if (!isUuidShape(projectId)) return null;

  const [row] = await db
    .select({
      id: projects.id,
      shape: projects.shape,
      dept_id: projects.dept_id,
      workspace_id: departments.workspace_id,
      project_data: projects.project_data,
    })
    .from(projects)
    .leftJoin(departments, eq(departments.id, projects.dept_id))
    .where(eq(projects.id, projectId));
  if (!row) return null;
  if (projectOwnerTenant(row) !== callerTenantId) return null;
  return { id: row.id, shape: row.shape, dept_id: row.dept_id };
}

async function loadSuggestionInTenant(
  id: string,
  tenantId: string,
): Promise<SuggestedSchedule | null> {
  // `suggested_schedules.id` is a `uuid` column (schema.ts:1718), so a
  // non-UUID `:id` raises 22P02 `invalid input syntax for type uuid` rather
  // than missing — a 500 this surface does not promise. `null` is the SAME
  // miss value an absent / other-tenant row yields, so accept and dismiss keep
  // their existing `NotFoundError('Suggested schedule not found')` and a
  // malformed id stays indistinguishable from an absent one (the
  // don't-leak-existence contract at routes/approvals.ts:~408-438).
  //
  // This is the ONLY seam that needs it: the later
  // `eq(suggestedSchedules.id, id)` in handleAccept (:~376) and handleDismiss
  // (:~438) are both downstream of this lookup and unreachable with a
  // malformed id. `isUuidShape`, not `isValidUuid` (utils/tenant) — the latter
  // pins the version nibble and would 404 live rows.
  if (!isUuidShape(id)) return null;

  const [row] = await db
    .select()
    .from(suggestedSchedules)
    .where(
      and(
        eq(suggestedSchedules.id, id),
        eq(suggestedSchedules.tenant_id, tenantId),
      ),
    );
  return row ?? null;
}

function safeValidateCron(cronExpr: string, timezone: string): void {
  try {
    validateCron(cronExpr, timezone);
  } catch (err) {
    if (err instanceof CronValidationError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
}

function validateConnectorConfig(config: unknown): void {
  const result = ConnectorConfig.safeParse(config);
  if (!result.success) {
    const msg = result.error.issues.map((i) => i.message).join('; ');
    throw new BadRequestError(`connector_config invalid: ${msg}`);
  }
  // H1: `file` reads the backend pod's own filesystem — never user-configurable.
  if (!isUserConfigurableConnectorKind(result.data.kind)) {
    throw new BadRequestError(`connector_config invalid: kind '${result.data.kind}' is not available`);
  }
}

function validatePayloadMapper(mapper: Record<string, string>): void {
  try {
    compileMapper(mapper);
  } catch (err) {
    throw new BadRequestError(
      `payload_mapper invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function isWorkspaceAdmin(user: User): Promise<boolean> {
  // The claim path here was already right; the DB path was not — it checked
  // only 'admin', which no real grant carries. Shared test now owns both.
  return userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
}

// ---------- Handlers ------------------------------------------------------

/**
 * GET /api/projects/:projectId/suggested-schedules?status=new
 *
 * Lists candidates scoped to the project. RBAC: dept-member+ on the
 * project's dept (workspace-admin for workspace-scope projects).
 *
 * Returns ListResponse<T> = { items, total } matching the FE convention
 * pinned by scheduled-triggers / scheduled-reports.
 */
export async function handleListSuggestedSchedules(
  req: Request,
  projectId: string,
): Promise<Response> {
  const user = await validateAuth(req);

  const project = await loadProject(projectId, ctxTenantId(user.tenantId));
  if (!project) throw new NotFoundError('project_id does not exist');
  await gateOnProject(user, projectId, 'dept-member');

  const url = new URL(req.url);
  const statusFilter = url.searchParams.get('status');

  const baseWhere = and(
    eq(suggestedSchedules.tenant_id, ctxTenantId(user.tenantId)),
    eq(suggestedSchedules.project_id, projectId),
  );

  // Explicit allowlist for `status` so a typo in the query string never
  // silently returns "all rows".
  let where = baseWhere;
  if (statusFilter !== null) {
    if (
      statusFilter !== 'new' &&
      statusFilter !== 'accepted' &&
      statusFilter !== 'dismissed'
    ) {
      throw new BadRequestError(
        `invalid status filter: ${statusFilter} (expected new|accepted|dismissed)`,
      );
    }
    where = and(baseWhere, eq(suggestedSchedules.status, statusFilter));
  }

  const rows = await db.select().from(suggestedSchedules).where(where);
  return jsonResponse({ items: rows, total: rows.length });
}

/**
 * POST /api/internal/suggested-schedules — admin-only stub used by QA
 * and (later) the heuristic auto-detector. `source` is forced to
 * 'manual' here; the heuristic path will land in a separate phase and
 * use a different internal entry point or `source: 'heuristic'`.
 */
export async function handleInternalCreateSuggestedSchedule(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  if (!(await isWorkspaceAdmin(user))) {
    throw new UnauthorizedError('workspace-admin role required');
  }

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const parsed = InternalCreateBodySchema.parse(raw);

  // Existence + tenant binding via project lookup. The project-shape
  // check is intentionally NOT here — heuristic / QA can stage rows
  // against any project; the accept handler is where shape is gated.
  const project = await loadProject(parsed.project_id, ctxTenantId(user.tenantId));
  if (!project) throw new NotFoundError('project_id does not exist');

  const [row] = await db
    .insert(suggestedSchedules)
    .values({
      tenant_id: ctxTenantId(user.tenantId),
      project_id: parsed.project_id,
      user_id: parsed.user_id ?? null,
      source: 'manual',
      ad_hoc_summary: parsed.ad_hoc_summary,
      payload: parsed.payload,
    })
    .returning();
  return createdResponse(row);
}

/**
 * POST /api/suggested-schedules/:id/accept — atomic promote.
 *
 * Single tx:
 *   1. SELECT the suggestion (404 if not found in tenant)
 *   2. Project-shape gate: continuous_flow only (422 otherwise)
 *   3. Status gate: must be 'new' (409 otherwise — double-accept)
 *   4. Validate `payload.suggested_*` (400 on bad cron/connector/mapper)
 *   5. INSERT scheduled_triggers
 *   6. UPDATE suggestion: status='accepted', promoted_trigger_id=<new id>
 *
 * RBAC: dept-manager+ on the project's dept.
 */
export async function handleAcceptSuggestedSchedule(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);

  const existing = await loadSuggestionInTenant(id, ctxTenantId(user.tenantId));
  if (!existing) throw new NotFoundError('Suggested schedule not found');

  await gateOnProject(user, existing.project_id, 'dept-manager');

  const project = await loadProject(existing.project_id, ctxTenantId(user.tenantId));
  if (!project) throw new NotFoundError('Suggested schedule not found');
  if (project.shape !== 'continuous_flow') {
    throw new ValidationError(
      'scheduled_intake triggers require project.shape = continuous_flow',
      { code: 'shape_mismatch' },
    );
  }

  if (existing.status !== 'new') {
    // 409 — already-promoted or already-dismissed. Don't double-fire.
    throw new AppError(409, `suggestion is in status '${existing.status}'`, {
      code: 'already_resolved',
      status: existing.status,
    });
  }

  const payload = AcceptPayloadSchema.parse(existing.payload);
  safeValidateCron(payload.suggested_cron, payload.suggested_timezone);
  if (!isUserConfigurableConnectorKind(payload.suggested_source_connector)) {
    throw new BadRequestError(
      `source_connector '${payload.suggested_source_connector}' is not available`,
    );
  }
  validateConnectorConfig(payload.suggested_connector_config);
  validatePayloadMapper(payload.suggested_payload_mapper);

  const newTrigger = await db.transaction(async (tx) => {
    // Re-read the suggestion inside the tx with FOR UPDATE-equivalent
    // semantics by checking the status before update. We rely on the
    // UPDATE...WHERE status='new' guard below as the actual race-free
    // commit point — if a parallel accept landed first, the UPDATE
    // affects 0 rows and we throw 409.
    const [trig] = await tx
      .insert(scheduledTriggers)
      .values({
        tenant_id: ctxTenantId(user.tenantId),
        project_id: existing.project_id,
        name: payload.suggested_name,
        cron: payload.suggested_cron,
        timezone: payload.suggested_timezone,
        source_connector: payload.suggested_source_connector,
        connector_config: payload.suggested_connector_config,
        payload_mapper: payload.suggested_payload_mapper,
        target_list: payload.suggested_target_list,
        card_template: payload.suggested_card_template,
        enabled: payload.suggested_enabled,
        // Plan 2-D Phase 8 Task 8.4 — provenance link for the FE
        // "from suggestion #<short>" badge on /channels/[id]. Set ONLY
        // on this code path (hand-created triggers leave it NULL).
        from_suggestion_id: id,
        // bound_assets origin (migration 068). Promoted-from-suggestion
        // is treated as project-origin — the human acted on a suggested
        // schedule that already targeted one project.
        origin_kind: 'project',
        origin_project_id: existing.project_id,
        created_by_user_id: user.id,
      })
      .returning();

    const updated = await tx
      .update(suggestedSchedules)
      .set({
        status: 'accepted',
        promoted_trigger_id: trig!.id,
        updated_at: new Date(),
      })
      .where(
        and(
          eq(suggestedSchedules.id, id),
          eq(suggestedSchedules.tenant_id, ctxTenantId(user.tenantId)),
          eq(suggestedSchedules.status, 'new'),
        ),
      )
      .returning({ id: suggestedSchedules.id });

    if (updated.length === 0) {
      // Race: another caller flipped status between our SELECT and
      // UPDATE. Roll back the INSERT by throwing — the surrounding
      // transaction wraps both writes so the trigger is discarded.
      throw new AppError(409, 'suggestion was concurrently resolved', {
        code: 'already_resolved',
      });
    }

    return trig!;
  });

  return createdResponse(newTrigger);
}

/**
 * POST /api/suggested-schedules/:id/dismiss — idempotent.
 *
 * UPDATE status='dismissed'. If the row is already dismissed we still
 * return 200 with the row unchanged. If it's `accepted` we refuse with
 * 409 — that's a state regression, not a no-op.
 *
 * RBAC: dept-member+ on the project's dept.
 */
export async function handleDismissSuggestedSchedule(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);

  const existing = await loadSuggestionInTenant(id, ctxTenantId(user.tenantId));
  if (!existing) throw new NotFoundError('Suggested schedule not found');

  await gateOnProject(user, existing.project_id, 'dept-member');

  if (existing.status === 'accepted') {
    throw new AppError(409, 'cannot dismiss an accepted suggestion', {
      code: 'already_resolved',
      status: existing.status,
    });
  }

  if (existing.status === 'dismissed') {
    // Idempotent — return the row as-is.
    return jsonResponse(existing);
  }

  const [row] = await db
    .update(suggestedSchedules)
    .set({
      status: 'dismissed',
      updated_at: new Date(),
    })
    .where(
      and(
        eq(suggestedSchedules.id, id),
        eq(suggestedSchedules.tenant_id, ctxTenantId(user.tenantId)),
      ),
    )
    .returning();

  return jsonResponse(row);
}
