/**
 * AG-UI agent-callable actions for the n8n observability + workflow-trigger
 * surface. Mirrors the shape of `bridge.ts` / `streams.ts`.
 *
 * Spec sources:
 *   - `docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md`
 *     §"Agent-callable actions" — original three reads (renamed under the
 *     `n8n.*` namespace by Wave 2; the spec table still uses `activity.*`
 *     names for historical reasons but the closeout note at the top of the
 *     spec records the rename).
 *   - `docs/superpowers/specs/completed/2026-04-25-n8n-observability-implementation.md`
 *     §"Action catalog" — current `n8n.list_workflows` / `n8n.list_executions`
 *     / `n8n.get_execution` reads.
 *   - §"Open follow-ups (#29)" + the comment in `routes/tools/n8n.ts`
 *     introducing the Wave-2 `n8n.trigger_workflow` write action that
 *     persists the (project, user) → execution mapping row.
 *
 * Every handler delegates to the shared domain helpers exported from
 * `routes/tools/n8n.ts` (`listExecutionsImpl`, `getExecutionImpl`,
 * `listWorkflowsImpl`) so the AG-UI invocation path and the HTTP route
 * layer share one user-scope JOIN against `n8n_execution_mapping`. The
 * write action additionally calls `runWorkflow()` from
 * `integrations/n8n.ts` and inserts the mapping row on success.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { IntegrationError } from '../../integrations/_lib/errors';
import { db as defaultDb, n8nExecutionMapping } from '../../db/client';
import { runWorkflow as runN8nWorkflow } from '../../integrations/n8n';
import { canReadProductionWorkflows } from '../../lib/production-workflows-gate';
import { ForbiddenError } from '../../utils/errors';

/**
 * ⛔ STRICT TENANT SEPARATION (2026-09-30): fr's n8n is the PRODUCTION
 * instance (the conveyor). An AG-UI caller reaches it only when super-admin or
 * when its tenant is a platform tenant — see `lib/production-workflows-gate.ts`.
 * `tenantRoles` is the only role claim this layer carries; absent it the
 * platform-tenant arm decides (fail closed).
 */
function agentMayUseProductionN8n(ctx: ActionContext): boolean {
  return canReadProductionWorkflows(
    { roles: ctx.tenantRoles, tenantId: ctx.tenantId ?? null },
    ctx.tenantId ?? null,
  );
}
import {
  STATUS_VALUES,
  getExecutionImpl,
  listExecutionsImpl,
  listWorkflowsImpl,
} from '../../routes/tools/n8n';

// ---------------------------------------------------------------------------
// Schemas (zod) — kept loose where the upstream n8n shapes are large; the
// shared impls in `routes/tools/n8n.ts` already shape executions into the
// `ScopedExecution` envelope before we surface them.
// ---------------------------------------------------------------------------

const listInputSchema = z.object({
  limit: z.number().int().min(1).max(250).optional(),
  cursor: z.string().optional(),
  status: z.enum(STATUS_VALUES).optional(),
  projectId: z.string().optional(),
  workflowId: z.string().optional(),
});
type ListInput = z.infer<typeof listInputSchema>;

const listOutputSchema = z.object({
  executions: z.array(z.unknown()),
  cursor: z.string().nullable().optional(),
});

const getInputSchema = z.object({ executionId: z.string().min(1) });
type GetInput = z.infer<typeof getInputSchema>;

const getOutputSchema = z.object({
  execution: z.unknown(),
  traceUrl: z.string().nullable(),
});

const listWorkflowsInputSchema = z.object({
  active: z.boolean().optional(),
  limit: z.number().int().min(1).max(250).optional(),
});
type ListWorkflowsInput = z.infer<typeof listWorkflowsInputSchema>;

const listWorkflowsOutputSchema = z.object({
  workflows: z.array(z.unknown()),
});

const triggerWorkflowInputSchema = z.object({
  workflowId: z.string().min(1),
  projectId: z.string().min(1),
  payload: z.unknown().optional(),
  idempotency_key: z.string().min(1),
});
type TriggerWorkflowInput = z.infer<typeof triggerWorkflowInputSchema>;

const triggerWorkflowOutputSchema = z.object({
  executionId: z.string(),
});

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const n8nListExecutionsAction: AgentCallableAction<
  ListInput,
  z.infer<typeof listOutputSchema>
> = {
  name: 'n8n.list_executions',
  kind: 'read',
  description:
    'List recent + in-flight n8n executions for the calling user, optionally filtered by project, workflow or status.',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `n8n.list_executions:${input.projectId ?? ''}:${input.status ?? ''}:${input.workflowId ?? ''}:${input.limit ?? ''}:${input.cursor ?? ''}`,
  handler: async (input, ctx: ActionContext) => {
    const out = await listExecutionsImpl(ctx.userId, input, {
      productionVisible: agentMayUseProductionN8n(ctx),
      tenantId: ctx.tenantId ?? undefined,
    });
    return { executions: out.data, cursor: out.meta.cursor };
  },
  rbac: { type: 'public' },
};

const n8nGetExecutionAction: AgentCallableAction<
  GetInput,
  z.infer<typeof getOutputSchema>
> = {
  name: 'n8n.get_execution',
  kind: 'read',
  description:
    'Fetch one n8n execution (status, duration, trace URL) — scoped to the calling user.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) => `n8n.get_execution:${input.executionId}`,
  handler: async (input, ctx: ActionContext) => {
    const out = await getExecutionImpl(ctx.userId, input.executionId, {
      productionVisible: agentMayUseProductionN8n(ctx),
      tenantId: ctx.tenantId ?? undefined,
    });
    if (!out) {
      throw new IntegrationError({
        code: 'UPSTREAM_NOT_FOUND',
        message: `Execution ${input.executionId} not found in user scope`,
        service: 'n8n',
      });
    }
    return { execution: out.execution, traceUrl: out.trace_url };
  },
  rbac: { type: 'public' },
};

const n8nListWorkflowsAction: AgentCallableAction<
  ListWorkflowsInput,
  z.infer<typeof listWorkflowsOutputSchema>
> = {
  name: 'n8n.list_workflows',
  kind: 'read',
  description: 'List n8n workflows visible to the configured API key.',
  input: listWorkflowsInputSchema,
  output: listWorkflowsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  idempotencyKey: (input) =>
    `n8n.list_workflows:${input.active ?? 'any'}:${input.limit ?? 'all'}`,
  handler: async (input, ctx: ActionContext) => {
    // A customer gets an empty catalogue, same shape.
    if (!agentMayUseProductionN8n(ctx)) return { workflows: [] };
    const out = await listWorkflowsImpl({
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
    return { workflows: out.workflows };
  },
  rbac: { type: 'public' },
};

// Wave-2 follow-up to spec §"Architecture decisions / Project association":
// every n8n run that fr fires must persist a mapping row so the activity
// surface can JOIN against it. This action wraps the Public-API
// `POST /workflows/{id}/run` call, then records the row.
//
// Approval: `single-approver: project-owner` — only the project owner can
// authorise an agent-issued workflow trigger.
// RBAC: `project-role: editor` — only editors+ can even propose the trigger
// (denials happen BEFORE approval-row creation; see registry.ts §"Enforcement
// order").
// Idempotency key: includes the caller-supplied `idempotency_key` so retries
// of the SAME logical request collapse onto the same approval row, and
// includes `(workflowId, projectId)` so the same key never accidentally
// authorises a different run.
const n8nTriggerWorkflowAction: AgentCallableAction<
  TriggerWorkflowInput,
  z.infer<typeof triggerWorkflowOutputSchema>
> = {
  name: 'n8n.trigger_workflow',
  kind: 'write',
  description:
    'Trigger an n8n workflow run via the Public API and record the execution -> (project, user) mapping. Approval: single-approver / project-owner.',
  input: triggerWorkflowInputSchema,
  output: triggerWorkflowOutputSchema,
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (i) =>
    `n8n.trigger_workflow:${i.idempotency_key}:${i.workflowId}:${i.projectId}`,
  handler: async (input, ctx: ActionContext) => {
    // A write against the production conveyor: refused outright for a customer.
    if (!agentMayUseProductionN8n(ctx)) {
      // Caller-side refusal (no upstream was contacted), so not an UPSTREAM_* code.
      throw new ForbiddenError('n8n.trigger_workflow is restricted to platform tenants');
    }
    const { executionId } = await runN8nWorkflow(input.workflowId, input.payload);
    await defaultDb
      .insert(n8nExecutionMapping)
      .values({
        execution_id: executionId,
        workflow_id: input.workflowId,
        project_id: input.projectId,
        user_id: ctx.userId,
        correlation_id: ctx.correlationId,
        initiated_via: 'agent',
        tenant_id: ctx.tenantId ?? null,
      })
      .onConflictDoUpdate({
        target: n8nExecutionMapping.execution_id,
        set: {
          workflow_id: input.workflowId,
          project_id: input.projectId,
          user_id: ctx.userId,
          correlation_id: ctx.correlationId,
          initiated_via: 'agent',
          tenant_id: ctx.tenantId ?? null,
        },
      });
    return { executionId };
  },
  rbac: { type: 'project-role', role: 'editor' },
};

// ---------------------------------------------------------------------------
// Registration entry point
// ---------------------------------------------------------------------------

function safeRegister<I, O>(action: AgentCallableAction<I, O>): void {
  try {
    registerAction(action);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') {
      return;
    }
    throw err;
  }
}

export function registerN8nActions(): void {
  safeRegister(n8nListExecutionsAction);
  safeRegister(n8nGetExecutionAction);
  safeRegister(n8nListWorkflowsAction);
  safeRegister(n8nTriggerWorkflowAction);
}
