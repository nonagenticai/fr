// src/routes/scheduled-triggers.ts
//
// Spec 2 §5 — `scheduled_triggers` CRUD + run-now + audit log.
//
// Project-shape gate: scheduled_triggers can only be created against
// projects whose shape = 'continuous_flow'. Deliverable projects do not
// have an inbound stream by design (Spec 2 §7).
//
// Cron validation: routes call validateCron() before INSERT/UPDATE so
// the tick worker only ever sees parseable expressions.
//
// The connector itself does not run in 2-A — the tick worker (and
// run-now manual fire) writes scheduled_trigger_runs.status =
// 'skipped_no_connector'. Plan 2-B wires the n8n subflow + replaces the
// no-op.
//
// Tenant isolation: tenant_id is always the REQUEST-CONTEXT tenant
// (`ctxTenantId(user.tenantId)` — the super-admin `X-Active-Tenant` switch
// when accepted, else the JWT tenant), on every route including the list
// (services/scheduled-triggers/list.ts). A `tenant_id` field in the body is
// rejected via the strict zod schema. Same pattern as routes/channels.ts.

import { and, count, desc, eq } from 'drizzle-orm';
import { serializeCount } from '../lib/resolution';
import { db } from '../db/client';
import {
  scheduledTriggers,
  scheduledTriggerRuns,
  type ScheduledTrigger,
} from '../db/schema';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { requireDeptRole } from '../auth/requireDeptRole';
import { gateOnProject } from '../auth/projectDeptGate';
import { listScheduledTriggersForUser } from '../services/scheduled-triggers/list';
import {
  BadRequestError,
  NotFoundError,
  ValidationError,
} from '../utils/errors';
import { isUuidShape } from '../lib/uuid-shape';
import { clientSafeRunErrorRow, clientSafeRunErrorText } from '../lib/run-error-text';
import {
  createdResponse,
  jsonResponse,
  noContentResponse,
} from '../utils/response';
import { ScheduledTriggerPatchSchema } from './scheduled-triggers-schemas';
import {
  ScheduledTriggerCreateSchema,
  assertValidTriggerPayload,
  safeValidateCron,
  validateConnectorConfig,
  validatePayloadMapper,
  loadTriggerableProject,
  scheduledTriggerInsertValues,
} from './scheduled-triggers-shared';

// ---------- Validation ----------------------------------------------------

// Shared with the fr-agui P4b declaration (capabilities/schedules/scheduled-triggers.ts).
const PatchBodySchema = ScheduledTriggerPatchSchema;

// ---------- Internal helpers ----------------------------------------------

async function loadTriggerInTenant(
  triggerId: string,
  tenantId: string,
): Promise<ScheduledTrigger | null> {
  // `scheduled_triggers.id` is a `uuid` column (schema.ts:1481), so a malformed
  // path param never reached a row — it reached Postgres, which raised 22P02
  // `invalid input syntax for type uuid`. Return `null`, byte-identical to the
  // absent / other-tenant miss below, so all ~7 handlers keep answering their
  // existing 404: a distinct status for "malformed" would hand a prober a free
  // oracle, defeating the don't-leak-existence 404 this surface is built on
  // (routes/approvals.ts:408 states that contract).
  //
  // `isUuidShape`, deliberately NOT `isValidUuid` (utils/tenant) — that one also
  // pins the version nibble to 1-8 and the variant to [89ab], so it would 404
  // rows carrying an id Postgres accepts as a legal `uuid` literal.
  if (!isUuidShape(triggerId)) return null;

  const [row] = await db
    .select()
    .from(scheduledTriggers)
    .where(
      and(
        eq(scheduledTriggers.id, triggerId),
        eq(scheduledTriggers.tenant_id, tenantId),
      ),
    );
  return row ?? null;
}

// ---------- Handlers ------------------------------------------------------

/** POST /api/scheduled-triggers */
export async function handleCreateScheduledTrigger(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const parsed = ScheduledTriggerCreateSchema.parse(raw);

  assertValidTriggerPayload(parsed);
  const project = await loadTriggerableProject(
    parsed.project_id,
    ctxTenantId(user.tenantId),
  );

  // Spec §13 — only dept-manager+ of the project's dept (or
  // workspace-admin) may create a scheduled_trigger. We already loaded
  // dept_id above, so reuse it instead of re-querying.
  if (project.dept_id === null) {
    await requireDeptRole(user, '', 'dept-manager', async () => null);
  } else {
    await requireDeptRole(user, project.dept_id, 'dept-manager');
  }

  // bound_assets origin (migration 068). Human-authored from this endpoint
  // = project-scoped origin (the trigger only ever fires for one project),
  // with creator id captured. n8n-authored triggers land via the
  // internal-create surface and set origin_kind='workflow'.
  const [row] = await db
    .insert(scheduledTriggers)
    .values(
      scheduledTriggerInsertValues(parsed, ctxTenantId(user.tenantId), {
        origin_kind: 'project',
        origin_project_id: parsed.project_id,
        created_by_user_id: user.id,
      }),
    )
    .returning();
  return createdResponse(row);
}

/** GET /api/scheduled-triggers — optional ?project_id= filter
 *
 * Spec §13 — non-workspace-admin callers see only triggers whose
 * project's dept_id is one of the depts they have at least dept-member
 * on. Workspace-admin / admin sees everything in tenant. Workspace-scope
 * projects (project.dept_id IS NULL) are visible only to workspace-admin
 * because dept-only roles cannot satisfy a "minimum dept-X role on a
 * null dept" check.
 *
 * `project_id` filter, when present, is intersected with the dept
 * filter — passing a project_id you can't see returns 0 rows, never
 * 403, so the FE's project-picker degrades gracefully.
 */
export async function handleListScheduledTriggers(
  req: Request,
): Promise<Response> {
  const user = await validateAuth(req);
  const url = new URL(req.url);
  const projectId = url.searchParams.get('project_id');
  const rows = await listScheduledTriggersForUser(user, {
    projectId: projectId ?? undefined,
  });
  return jsonResponse({ items: rows.map(clientSafeRunErrorRow), total: rows.length });
}

/** GET /api/scheduled-triggers/:id */
export async function handleGetScheduledTrigger(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const row = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
  if (!row) throw new NotFoundError('Scheduled trigger not found');
  // Spec §13 — dept-member+ of the trigger's project's dept (or
  // workspace-admin). 404 takes precedence over 403 to avoid leaking
  // existence of out-of-tenant triggers; in-tenant out-of-dept rows
  // surface as 403 so the FE can render a real reason.
  await gateOnProject(user, row.project_id, 'dept-member');
  // In place, so the grandfathered `expr:row` envelope is unchanged.
  row.last_run_error = clientSafeRunErrorText(row.last_run_error);
  return jsonResponse(row);
}

/** PATCH /api/scheduled-triggers/:id */
export async function handlePatchScheduledTrigger(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);

  // Spec §13 — dept-manager+ of the trigger's project's dept. We need
  // the trigger row to know which project to look up; load once here so
  // 404 is decided before we even start parsing the body.
  const existingForGate = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
  if (!existingForGate) throw new NotFoundError('Scheduled trigger not found');
  await gateOnProject(user, existingForGate.project_id, 'dept-manager');

  const raw = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  // Strict schema rejects project_id / tenant_id / id explicitly. Surface a
  // tailored 422 instead of the default zod "unrecognized_keys" so the FE
  // can render "this field is immutable".
  if (typeof raw === 'object' && raw !== null) {
    const obj = raw as Record<string, unknown>;
    for (const key of ['project_id', 'tenant_id', 'id']) {
      if (key in obj) {
        throw new ValidationError(`${key} cannot be changed`, {
          code: 'immutable_field',
          field: key,
        });
      }
    }
  }
  const parsed = PatchBodySchema.parse(raw);

  if (parsed.connector_config !== undefined) {
    validateConnectorConfig(parsed.connector_config);
  }
  if (parsed.payload_mapper !== undefined) {
    validatePayloadMapper(parsed.payload_mapper);
  }

  if (parsed.cron) {
    // Patch may change cron without changing tz, or vice versa. Use the
    // patched value if present; otherwise fall back to whatever's already
    // stored on the row.
    const tz = parsed.timezone;
    if (tz) {
      safeValidateCron(parsed.cron, tz);
    } else {
      const existing = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
      if (!existing) throw new NotFoundError('Scheduled trigger not found');
      safeValidateCron(parsed.cron, existing.timezone);
    }
  } else if (parsed.timezone) {
    const existing = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
    if (!existing) throw new NotFoundError('Scheduled trigger not found');
    safeValidateCron(existing.cron, parsed.timezone);
  }

  // Re-enabling is the operator saying "I fixed it". Clearing the
  // consecutive-permanent-failure ledger (migration 094) is what makes that
  // true: without it a trigger auto-disabled at 3 strikes comes back with the
  // counter still at 3 and is disabled again by its very first dispatch —
  // including the case where the operator was right and the endpoint is now
  // healthy but the batch's first record happens to 404. `disabled_reason` is
  // cleared alongside so a live row never carries a stale "the worker switched
  // this off" marker.
  const reenableReset =
    parsed.enabled === true
      ? { permanent_failure_count: 0, disabled_reason: null }
      : {};

  const [row] = await db
    .update(scheduledTriggers)
    .set({ ...parsed, ...reenableReset, updated_at: new Date() })
    .where(
      and(
        eq(scheduledTriggers.id, id),
        eq(scheduledTriggers.tenant_id, ctxTenantId(user.tenantId)),
      ),
    )
    .returning();
  if (!row) throw new NotFoundError('Scheduled trigger not found');
  return jsonResponse(clientSafeRunErrorRow(row));
}

/** DELETE /api/scheduled-triggers/:id */
export async function handleDeleteScheduledTrigger(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // Spec §13 — dept-manager+ on trigger's project's dept. Load first to
  // gate, then issue the delete; 404 wins over 403 for out-of-tenant.
  const existing = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
  if (!existing) throw new NotFoundError('Scheduled trigger not found');
  await gateOnProject(user, existing.project_id, 'dept-manager');

  const deleted = await db
    .delete(scheduledTriggers)
    .where(
      and(
        eq(scheduledTriggers.id, id),
        eq(scheduledTriggers.tenant_id, ctxTenantId(user.tenantId)),
      ),
    )
    .returning({ id: scheduledTriggers.id });
  if (deleted.length === 0)
    throw new NotFoundError('Scheduled trigger not found');
  return noContentResponse();
}

/**
 * POST /api/scheduled-triggers/:id/run-now — manual fire.
 *
 * In Plan 2-A this records `status = 'skipped_no_connector'` since no
 * connector is wired. Plan 2-B replaces the no-op with a real n8n
 * webhook POST. The audit row's `kind = 'manual'` distinguishes it from
 * cron-driven runs and persists `triggered_by_user_id`.
 */
export async function handleRunNowScheduledTrigger(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const trigger = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
  if (!trigger) throw new NotFoundError('Scheduled trigger not found');
  // Spec §13 — manual-fire is a write; dept-manager+ on project dept.
  await gateOnProject(user, trigger.project_id, 'dept-manager');

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx.insert(scheduledTriggerRuns).values({
      trigger_kind: 'scheduled_intake',
      trigger_id: trigger.id,
      tenant_id: trigger.tenant_id,
      project_id: trigger.project_id,
      fired_at: now,
      finished_at: now,
      status: 'skipped_no_connector',
      kind: 'manual',
      triggered_by_user_id: user.id,
    });
    await tx
      .update(scheduledTriggers)
      .set({
        last_run_at: now,
        last_run_status: 'skipped_no_connector',
        updated_at: now,
      })
      .where(eq(scheduledTriggers.id, trigger.id));
  });

  return jsonResponse({ ok: true, status: 'skipped_no_connector' });
}

/**
 * GET /api/scheduled-triggers/:id/runs — audit log.
 *
 * Returns the most recent N rows from scheduled_trigger_runs scoped to
 * (trigger_id, tenant_id, trigger_kind='scheduled_intake'). Default N=50,
 * cap 200. Used by the per-channel detail surface in 2-C.
 */
export async function handleListScheduledTriggerRuns(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  // Confirm the trigger exists in this tenant first — leak nothing about
  // out-of-tenant rows via the audit endpoint.
  const trigger = await loadTriggerInTenant(id, ctxTenantId(user.tenantId));
  if (!trigger) throw new NotFoundError('Scheduled trigger not found');
  // Spec §13 — read-only audit; dept-member+ on project dept.
  await gateOnProject(user, trigger.project_id, 'dept-member');

  const url = new URL(req.url);
  const requested = Number.parseInt(url.searchParams.get('limit') ?? '50', 10);
  const limit = Math.min(
    Number.isFinite(requested) && requested > 0 ? requested : 50,
    200,
  );

  // ⚠️ `total` USED TO BE `rows.length` — the size of the page `.limit(limit)`
  // had just cut (50 by default, 200 at most; the JSDoc above says so). The
  // count runs against the SAME `where` the page was drawn from, never a
  // re-derived copy (routes/approvals.ts:653 idiom).
  const where = and(
    eq(scheduledTriggerRuns.trigger_id, id),
    eq(scheduledTriggerRuns.tenant_id, ctxTenantId(user.tenantId)),
    eq(scheduledTriggerRuns.trigger_kind, 'scheduled_intake'),
  );
  const [rows, totalRows] = await Promise.all([
    db
      .select()
      .from(scheduledTriggerRuns)
      .where(where)
      .orderBy(desc(scheduledTriggerRuns.fired_at))
      .limit(limit),
    db.select({ n: count() }).from(scheduledTriggerRuns).where(where),
  ]);
  const { total, total_kind, headers } = serializeCount({
    rows,
    appliedLimit: limit,
    totalMatching: totalRows[0]?.n ?? null,
  });
  return jsonResponse(
    { items: rows.map(clientSafeRunErrorRow), total, total_kind },
    200,
    headers,
  );
}
