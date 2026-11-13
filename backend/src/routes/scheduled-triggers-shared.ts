// src/routes/scheduled-triggers-shared.ts
//
// Shared schema + validation + insert shape for scheduled_triggers, so the
// human-authored route (routes/scheduled-triggers.ts) and the n8n
// internal-create route (routes/assets/internal-create.ts) stay in lockstep.
// The two differ only in their authz gate and origin provenance; everything
// else — body schema, cron/connector/payload validation, project-shape gate,
// and the insert column set — lives here.

import { eq } from 'drizzle-orm';

import { db } from '../db/client';
import { departments, projects, scheduledTriggers } from '../db/schema';
import { projectOwnerTenant } from '../lib/board-tenant-access';
import { validateCron, CronValidationError } from '../lib/cron-due';
import { compileMapper } from '../lib/payload-mapper';
import { ConnectorConfig, isUserConfigurableConnectorKind } from '../types/connectors';
import { BadRequestError, NotFoundError, ValidationError } from '../utils/errors';

// The body schemas live in the side-effect-free scheduled-triggers-schemas.ts
// (shared with the fr-agui P4b capability declarations); re-exported here so the
// existing importers are unchanged.
export {
  CardTemplateSchema,
  ScheduledTriggerCreateSchema,
  SourceConnectorEnum,
  type ScheduledTriggerCreateInput,
} from './scheduled-triggers-schemas';
import type { ScheduledTriggerCreateInput } from './scheduled-triggers-schemas';

export function safeValidateCron(cronExpr: string, timezone: string): void {
  try {
    validateCron(cronExpr, timezone);
  } catch (err) {
    if (err instanceof CronValidationError) {
      throw new BadRequestError(err.message);
    }
    throw err;
  }
}

export function validateConnectorConfig(config: unknown): void {
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

export function validatePayloadMapper(mapper: Record<string, string>): void {
  try {
    compileMapper(mapper);
  } catch (err) {
    throw new BadRequestError(
      `payload_mapper invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

/** Run all three payload validators (cron, connector, mapper). */
export function assertValidTriggerPayload(
  parsed: ScheduledTriggerCreateInput,
): void {
  safeValidateCron(parsed.cron, parsed.timezone);
  if (!isUserConfigurableConnectorKind(parsed.source_connector)) {
    throw new BadRequestError(`source_connector '${parsed.source_connector}' is not available`);
  }
  validateConnectorConfig(parsed.connector_config);
  validatePayloadMapper(parsed.payload_mapper);
}

/**
 * Load a project IN THE CALLER'S TENANT. The owner is resolved by the one
 * project-owner rule (`projectOwnerTenant`: the dept's `workspace_id`, else
 * `project_data.keycloak_tenant_id`); a project owned by another tenant — or
 * by none — returns `null`, exactly like a missing one, so callers answer the
 * same 404 and a foreign project id cannot be probed. The dept-role gate does
 * not provide this: the tenant_admin bypass in requireDeptRole is not
 * tenant-scoped.
 */
export async function loadProjectShape(
  projectId: string,
  callerTenantId: string,
): Promise<{ id: string; shape: string; dept_id: string | null } | null> {
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

/**
 * Load the project (in the caller's tenant) and assert it can host a
 * scheduled_intake trigger. Throws NotFoundError (missing OR foreign-tenant)
 * or ValidationError (wrong shape) — Spec 2 §7: scheduled_intake is only
 * meaningful on continuous_flow projects.
 */
export async function loadTriggerableProject(
  projectId: string,
  callerTenantId: string,
): Promise<{ id: string; shape: string; dept_id: string | null }> {
  const project = await loadProjectShape(projectId, callerTenantId);
  if (!project) {
    throw new NotFoundError('project_id does not exist');
  }
  if (project.shape !== 'continuous_flow') {
    throw new ValidationError(
      'scheduled_intake triggers require project.shape = continuous_flow',
      { code: 'shape_mismatch' },
    );
  }
  return project;
}

export interface TriggerOrigin {
  origin_kind: 'project' | 'workflow';
  origin_project_id: string;
  origin_workflow_run_id?: string | null;
  created_by_user_id: string;
}

/** Build the `.values()` object for a scheduled_triggers insert. */
export function scheduledTriggerInsertValues(
  parsed: ScheduledTriggerCreateInput,
  tenantId: string,
  origin: TriggerOrigin,
): typeof scheduledTriggers.$inferInsert {
  return {
    tenant_id: tenantId,
    project_id: parsed.project_id,
    name: parsed.name,
    cron: parsed.cron,
    timezone: parsed.timezone,
    source_connector: parsed.source_connector,
    connector_config: parsed.connector_config,
    payload_mapper: parsed.payload_mapper,
    target_list: parsed.target_list,
    card_template: parsed.card_template,
    enabled: parsed.enabled,
    origin_kind: origin.origin_kind,
    origin_project_id: origin.origin_project_id,
    origin_workflow_run_id: origin.origin_workflow_run_id ?? null,
    created_by_user_id: origin.created_by_user_id,
  };
}
