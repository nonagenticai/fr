// src/routes/assets/internal-create.ts
//
// Internal endpoints hit by n8n custom nodes when a workflow authors an
// asset during project execution. Each handler does TWO things
// atomically from the n8n caller's perspective:
//
//   1. Forwards the create payload to the upstream asset service, with
//      origin_kind='workflow' + origin_workflow_run_id set so provenance
//      survives.
//   2. Inserts an asset_bindings row so the new asset is in scope for
//      n8n on this project (and shows up in the Project workspace tab).
//
// Auth: validateAuth + role gate. Caller must carry the
// `workflow-runner` role (Keycloak SA token, see MEMORY
// internal-service-roles-cross-tenant-pattern.md). License-authz at
// the ingress already verified the token's tenant; the role gate
// blocks human bearers from minting workflow-origin rows.
//
// Currently wired: requirement (pilot), principle, decision
// (upstream-service kinds), and trigger (fr-local scheduled_triggers).
// Workflow / channel / artifact are not wired here: workflows live in
// n8n's own DB; channels and artifacts go through dedicated fr-backend
// routes with different shapes and no origin columns yet.
//
// The trigger handler differs from the upstream-service handlers — it
// inserts directly into the fr-local scheduled_triggers table (sharing
// schema + validation with routes/scheduled-triggers.ts via
// scheduled-triggers-shared.ts) instead of calling an upstream service.

import { z } from 'zod';

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { AppError, pgErrorCode } from '../../utils/errors';
import { jsonResponse } from '../../utils/response';
import { handle } from './_lib/handler';
import { db, assetBindings, scheduledTriggers } from '../../db/client';
import { isValidUuid } from '../../utils/tenant';
import { createRequirement } from '../../integrations/requirements';
import { createPrinciple } from '../../integrations/principles';
import { createDecision } from '../../integrations/decisions';
import {
  ScheduledTriggerCreateSchema,
  assertValidTriggerPayload,
  loadProjectShape,
  loadTriggerableProject,
  scheduledTriggerInsertValues,
} from '../scheduled-triggers-shared';
import { ChannelCreateSchema } from '../channels-shared';
import { channelsRegistryService } from '../../services/channels-registry';
import type {
  RequirementIn,
  PrincipleIn,
  DecisionIn,
} from '@fr/service-client-requirements';
import type { User } from '../../types/api';
import type { AssetKind } from './bindings';

const WORKFLOW_RUNNER_ROLE = 'workflow-runner';

/**
 * Generic internal-create body. Each handler validates the payload's
 * required fields downstream by calling the appropriate upstream
 * integration — the wire shape here only enforces the n8n-provided
 * envelope (project_id, workflow_run_id, free-form payload).
 */
const InternalCreateBody = z.object({
  project_id: z.string().uuid(),
  workflow_run_id: z.string().min(1).max(200),
  payload: z.record(z.string(), z.unknown()),
});

type InternalCreateInput = z.infer<typeof InternalCreateBody>;

function requireWorkflowRunner(roles: string[]): void {
  if (!roles.includes(WORKFLOW_RUNNER_ROLE)) {
    throw new AppError(
      403,
      `${WORKFLOW_RUNNER_ROLE} role required for internal asset authoring`,
    );
  }
}

// Provenance fields are part of the upstream `*In` schemas as of
// requirements_management 0.2.0 (the regen now ships them directly on
// `RequirementIn` / `PrincipleIn` / `DecisionIn`
// as `origin_kind?: string` etc). We just inject the workflow-runner values
// at the call site — no local intersection-type wrapping needed.
function originFields(workflowRunId: string): {
  origin_kind: 'workflow';
  origin_workflow_run_id: string;
  created_by_user_id: string;
} {
  return {
    origin_kind: 'workflow',
    origin_workflow_run_id: workflowRunId,
    created_by_user_id: `workflow:${workflowRunId}`,
  };
}

/**
 * Insert the asset_bindings row for an n8n-authored asset. Idempotent
 * on (kind, id, project_id) PK conflict — n8n retry-safe.
 */
async function bindNewAsset(
  kind: AssetKind,
  assetId: string,
  projectId: string,
  workflowRunId: string,
): Promise<void> {
  await db
    .insert(assetBindings)
    .values({
      asset_kind: kind,
      asset_id: assetId,
      project_id: projectId,
      bound_by_user_id: `workflow:${workflowRunId}`,
    })
    .onConflictDoNothing();
}

/**
 * Shared parse + auth + project-ownership guard. Throws an AppError on
 * any of: invalid body, missing role, unknown or foreign-tenant project. Returns the
 * parsed body plus the authenticated user (for tenant context).
 */
async function parseAndAuth(
  req: Request,
): Promise<{ parsed: InternalCreateInput; user: User }> {
  const user = await validateAuth(req);
  requireWorkflowRunner(user.roles);

  const raw = await req.json().catch(() => {
    throw new AppError(400, 'invalid JSON body');
  });
  const parsed = InternalCreateBody.parse(raw);
  if (!isValidUuid(parsed.project_id)) {
    throw new AppError(400, 'project_id is not a valid UUID');
  }

  // The project must be OWNED by the caller's tenant (projectOwnerTenant,
  // inside loadProjectShape). A foreign-tenant project answers the SAME 404
  // as a missing one, so a workflow-runner SA can neither bind assets into
  // another tenant's project nor probe which ids exist. No super-admin or
  // platform bypass: a platform SA binds into its own platform projects only.
  const project = await loadProjectShape(parsed.project_id, ctxTenantId(user.tenantId));
  if (!project) {
    throw new AppError(404, 'project_id does not exist');
  }
  return { parsed, user };
}

// ---------------------------------------------------------------------------
// Per-kind handlers. Each is a thin wrapper that injects origin fields
// into the payload, calls the upstream create, and binds the result.
// ---------------------------------------------------------------------------

export async function handleInternalCreateRequirement(
  req: Request,
): Promise<Response> {
  const { parsed } = await parseAndAuth(req);
  const upstreamBody: RequirementIn = {
    ...(parsed.payload as Record<string, unknown>),
    ...originFields(parsed.workflow_run_id),
  } as unknown as RequirementIn;

  return handle(
    async () => {
      const created = await createRequirement(upstreamBody);
      const id = String((created as { id?: unknown }).id ?? '');
      await bindNewAsset('requirement', id, parsed.project_id, parsed.workflow_run_id);
      return {
        asset: created,
        binding: {
          asset_kind: 'requirement' as const,
          asset_id: id,
          project_id: parsed.project_id,
          workflow_run_id: parsed.workflow_run_id,
        },
      };
    },
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleInternalCreatePrinciple(
  req: Request,
): Promise<Response> {
  const { parsed } = await parseAndAuth(req);
  const upstreamBody: PrincipleIn = {
    ...(parsed.payload as Record<string, unknown>),
    ...originFields(parsed.workflow_run_id),
  } as unknown as PrincipleIn;

  return handle(
    async () => {
      const created = await createPrinciple(upstreamBody);
      const id = String((created as { id?: unknown }).id ?? '');
      await bindNewAsset('principle', id, parsed.project_id, parsed.workflow_run_id);
      return {
        asset: created,
        binding: {
          asset_kind: 'principle' as const,
          asset_id: id,
          project_id: parsed.project_id,
          workflow_run_id: parsed.workflow_run_id,
        },
      };
    },
    (data) => jsonResponse({ data }, 201),
  );
}

export async function handleInternalCreateDecision(
  req: Request,
): Promise<Response> {
  const { parsed } = await parseAndAuth(req);
  const upstreamBody: DecisionIn = {
    ...(parsed.payload as Record<string, unknown>),
    ...originFields(parsed.workflow_run_id),
  } as unknown as DecisionIn;

  return handle(
    async () => {
      const created = await createDecision(upstreamBody);
      const id = String((created as { id?: unknown }).id ?? '');
      await bindNewAsset('decision', id, parsed.project_id, parsed.workflow_run_id);
      return {
        asset: created,
        binding: {
          asset_kind: 'decision' as const,
          asset_id: id,
          project_id: parsed.project_id,
          workflow_run_id: parsed.workflow_run_id,
        },
      };
    },
    (data) => jsonResponse({ data }, 201),
  );
}

/**
 * Triggers are fr-local (scheduled_triggers), not an upstream service. The
 * payload validates against the same schema as the human create route; the
 * envelope project_id is authoritative (it is both the trigger's firing
 * project and the binding target). Origin is stamped `workflow`.
 */
export async function handleInternalCreateTrigger(
  req: Request,
): Promise<Response> {
  const { parsed, user } = await parseAndAuth(req);

  // Force the trigger's own project_id to the envelope target so the
  // firing project and the binding target can never diverge.
  const triggerInput = ScheduledTriggerCreateSchema.parse({
    ...(parsed.payload as Record<string, unknown>),
    project_id: parsed.project_id,
  });

  return handle(
    async () => {
      assertValidTriggerPayload(triggerInput);
      await loadTriggerableProject(parsed.project_id, ctxTenantId(user.tenantId));

      const [row] = await db
        .insert(scheduledTriggers)
        .values(
          scheduledTriggerInsertValues(triggerInput, ctxTenantId(user.tenantId), {
            origin_kind: 'workflow',
            origin_project_id: parsed.project_id,
            origin_workflow_run_id: parsed.workflow_run_id,
            created_by_user_id: `workflow:${parsed.workflow_run_id}`,
          }),
        )
        .returning();

      const id = String(row?.id ?? '');
      await bindNewAsset('trigger', id, parsed.project_id, parsed.workflow_run_id);
      return {
        asset: row,
        binding: {
          asset_kind: 'trigger' as const,
          asset_id: id,
          project_id: parsed.project_id,
          workflow_run_id: parsed.workflow_run_id,
        },
      };
    },
    (data) => jsonResponse({ data }, 201),
  );
}

/** True for a Postgres unique-violation (SQLSTATE 23505), optionally scoped
 * to a named constraint. Drizzle wraps the driver error, so the 23505 +
 * constraint_name live on the underlying postgres error — which may be `err`
 * itself or `err.cause`. postgres.js exposes `code` + `constraint_name`.
 *
 * The SQLSTATE half of that walk is delegated to the shared `pgErrorCode` in
 * utils/errors: this file, routes/tools/bridge.ts and the shared error->HTTP
 * mapping each grew their own copy of it, so there is now ONE implementation
 * instead of three. `pgErrorCode` returns only the code, not the object that
 * carried it, so the constraint_name half stays local — we re-scan the same
 * [err, err.cause] candidates and only accept a candidate that itself bears
 * the 23505, exactly as before (a 23505 whose constraint_name names a
 * DIFFERENT constraint must still return false). */
function isUniqueViolation(err: unknown, constraint?: string): boolean {
  if (pgErrorCode(err) !== '23505') return false;
  if (!constraint) return true;
  const candidates = [err, (err as { cause?: unknown })?.cause];
  for (const candidate of candidates) {
    const e = candidate as { code?: unknown; constraint_name?: unknown };
    if (e?.code !== '23505') continue;
    if (e?.constraint_name && e.constraint_name !== constraint) {
      continue;
    }
    return true;
  }
  return false;
}

/**
 * Channels are fr-local (services/channels-registry), so this mirrors the
 * trigger handler rather than the upstream-service handlers. Two channel
 * specifics:
 *   - "The workspace IS the tenant" (migration 029), so workspace_id is the
 *     caller's resolved tenant — channels can never be project-scoped, but
 *     they ARE bound to the authoring project via asset_bindings so n8n sees
 *     them in scope. dept_id mirrors the project's department (or NULL =>
 *     workspace-scoped) for the firing project.
 *   - createChannel is NOT idempotent on (workspace_id, name): a duplicate
 *     name maps to 409 (the binding insert is still idempotent). n8n must
 *     supply unique channel names or handle the 409 on retry.
 */
export async function handleInternalCreateChannel(
  req: Request,
): Promise<Response> {
  const { parsed, user } = await parseAndAuth(req);
  const channelInput = ChannelCreateSchema.parse(parsed.payload);

  return handle(
    async () => {
      const project = await loadProjectShape(parsed.project_id, ctxTenantId(user.tenantId));
      if (!project) {
        throw new AppError(404, 'project_id does not exist');
      }

      let created;
      try {
        created = await channelsRegistryService.createChannel({
          workspace_id: ctxTenantId(user.tenantId),
          dept_id: channelInput.dept_id ?? project.dept_id ?? null,
          kind: channelInput.kind,
          name: channelInput.name,
          config: channelInput.config,
          credentials: channelInput.credentials ?? null,
          origin: {
            origin_kind: 'workflow',
            origin_project_id: parsed.project_id,
            origin_workflow_run_id: parsed.workflow_run_id,
            created_by_user_id: `workflow:${parsed.workflow_run_id}`,
          },
        });
      } catch (err) {
        if (isUniqueViolation(err, 'channels_workspace_name_unique')) {
          throw new AppError(
            409,
            `a channel named "${channelInput.name}" already exists in this workspace`,
          );
        }
        throw err;
      }

      await bindNewAsset('channel', created.id, parsed.project_id, parsed.workflow_run_id);
      return {
        asset: created,
        binding: {
          asset_kind: 'channel' as const,
          asset_id: created.id,
          project_id: parsed.project_id,
          workflow_run_id: parsed.workflow_run_id,
        },
      };
    },
    (data) => jsonResponse({ data }, 201),
  );
}
