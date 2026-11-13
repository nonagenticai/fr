/**
 * AG-UI agent-callable actions for the Theory-of-Constraints (TOC / Dettmer
 * Logical Thinking Process) surface. Mirrors `actions/decisions.ts` (reads)
 * and `actions/n8n.ts` (the trigger-workflow write that persists an
 * `n8n_execution_mapping` row).
 *
 * Split (mirrors the architecture decision in the TOC plan):
 *   - reads (list/get/graph/quality/config) → direct to RM `/toc` via
 *     `integrations/toc.ts`, `approval:'auto'`, idempotency-keyed.
 *   - writes (build_io_map / evaporate_conflict / evaluate_lenses) → resolve
 *     the configured AA builder-subroutine workflow id and trigger it via
 *     `integrations/n8n.runWorkflow`, recording the execution→(project,user)
 *     mapping. The subroutine writes the tree back into RM; the frontend reads
 *     it back via `toc.get_graph`. Writes MUST carry a non-auto approval
 *     (registerAction throws InvalidActionApprovalError otherwise).
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { RbacDeniedError } from '../rbac';
import { withInvokeCard } from '../capability-invoke-card';
import { IntegrationError } from '../../integrations/_lib/errors';
import { triggerWorkflow } from '../../integrations/n8n';
import { config } from '../../config';
import {
  getTocConfig,
  getTocGraph,
  getTocQuality,
  getTocTree,
  type TocTree,
} from '../../integrations/toc';
import { rmCall } from '../../integrations/architecture';
import { getListTocTreesUrl } from '@fr/service-client-requirements';

// ---------------------------------------------------------------------------
// Read actions
// ---------------------------------------------------------------------------

const listInputSchema = z.object({
  tree_type: z.string().optional(),
  project_id: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({ items: z.array(z.unknown()) });

const listTreesAction: AgentCallableAction<
  ListInput,
  z.infer<typeof listOutputSchema>
> = {
  name: 'toc.list_trees',
  kind: 'read',
  description:
    'List TOC reasoning trees (io_map / evaporating_cloud / crt / frt / prt / trt) visible to the caller. Optional filters: tree_type, project_id, limit, offset.',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `toc.list_trees:${i.tree_type ?? ''}:${i.project_id ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const params: Record<string, string> = {};
    if (input.tree_type) params.tree_type = input.tree_type;
    if (input.project_id) params.project_id = input.project_id;
    if (input.limit !== undefined) params.limit = String(input.limit);
    if (input.offset !== undefined) params.offset = String(input.offset);
    const items = (await rmCall<TocTree[]>(getListTocTreesUrl(Object.keys(params).length ? params : undefined))).data;
    return { items };
  },
};

const getTreeInputSchema = z.object({ tree_id: z.string().min(1) });
type GetTreeInput = z.infer<typeof getTreeInputSchema>;
const getTreeOutputSchema = z.object({ item: z.unknown() });

const getTreeAction: AgentCallableAction<
  GetTreeInput,
  z.infer<typeof getTreeOutputSchema>
> = {
  name: 'toc.get_tree',
  kind: 'read',
  description: 'Fetch a single TOC tree by id.',
  input: getTreeInputSchema,
  output: getTreeOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `toc.get_tree:${i.tree_id}`,
  handler: async (input) => {
    const item = await getTocTree(input.tree_id);
    return { item };
  },
};

const getGraphInputSchema = z.object({ tree_id: z.string().min(1) });
type GetGraphInput = z.infer<typeof getGraphInputSchema>;
const getGraphOutputSchema = z.object({ graph: z.unknown() });

const getGraphAction: AgentCallableAction<
  GetGraphInput,
  z.infer<typeof getGraphOutputSchema>
> = {
  name: 'toc.get_graph',
  kind: 'read',
  description:
    'Fetch the assembled {tree, nodes, edges} graph for a TOC tree (use after a build action writes the tree back).',
  input: getGraphInputSchema,
  output: getGraphOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `toc.get_graph:${i.tree_id}`,
  handler: async (input) => {
    const graph = await getTocGraph(input.tree_id);
    return { graph };
  },
};

const getQualityInputSchema = z.object({ tree_id: z.string().min(1) });
type GetQualityInput = z.infer<typeof getQualityInputSchema>;
const getQualityOutputSchema = z.object({ quality: z.unknown() });

const getQualityAction: AgentCallableAction<
  GetQualityInput,
  z.infer<typeof getQualityOutputSchema>
> = {
  name: 'toc.get_quality',
  kind: 'read',
  description:
    'Run / fetch the structural 8-CLR (Categories of Legitimate Reservation) quality report for a TOC tree.',
  input: getQualityInputSchema,
  output: getQualityOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `toc.get_quality:${i.tree_id}`,
  handler: async (input) => {
    const quality = await getTocQuality(input.tree_id);
    return { quality };
  },
};

const getConfigInputSchema = z.object({ project_id: z.string().optional() });
type GetConfigInput = z.infer<typeof getConfigInputSchema>;
const getConfigOutputSchema = z.object({ config: z.unknown() });

const getConfigAction: AgentCallableAction<
  GetConfigInput,
  z.infer<typeof getConfigOutputSchema>
> = {
  name: 'toc.get_config',
  kind: 'read',
  description:
    'Fetch the 3-level (tenant / project / tree) TOC configuration for the caller (optionally project-scoped).',
  input: getConfigInputSchema,
  output: getConfigOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `toc.get_config:${i.project_id ?? ''}`,
  handler: async (input) => {
    const cfg = await getTocConfig(
      input.project_id ? { projectId: input.project_id } : {},
    );
    return { config: cfg };
  },
};

// ---------------------------------------------------------------------------
// Write actions — trigger an AA builder subroutine + persist the mapping row.
// ---------------------------------------------------------------------------

const buildInputSchema = z.object({
  project_id: z.string().min(1),
  payload: z.unknown().optional(),
  idempotency_key: z.string().min(1),
});
type BuildInput = z.infer<typeof buildInputSchema>;
const buildOutputSchema = z.object({ executionId: z.string() });

/**
 * Resolve a configured AA workflow id; fail at the call site (not at boot)
 * when the env knob is unset — the read/CRUD surface works without it, only
 * the build path needs it.
 */
function resolveConfigured(value: string, knob: string): string {
  if (!value) {
    throw new IntegrationError({
      // An unset env knob is fr's own misconfiguration. It was reported as an
      // n8n body error, which blamed a service that was never called and made
      // the AG-UI layer advertise it as retriable -- no retry sets an env var.
      code: 'INTERNAL_PRECONDITION',
      message: `TOC build action requires ${knob} to be configured`,
    });
  }
  return value;
}

/**
 * Trigger an AA builder subroutine via its production WEBHOOK (not the n8n
 * public API — that has no run-by-id endpoint, `POST /workflows/{id}/run`
 * returns 405). `triggerWorkflow` posts to `n8n.svc/webhook/<path>` and writes
 * the execution→(project,user) mapping row itself. The subroutine writes the
 * resulting tree back into requirements_management; the frontend reads it via
 * `toc.get_graph`. `workflowId` is metadata for the mapping row only (falls
 * back to the webhook path when the id env knob is unset).
 */
/**
 * The only project a build may target is the one the caller was authorized
 * for. RBAC (`project-role: editor`) checks membership against
 * `ctx.projectId` — the agent thread's bound project (fr-agui SPEC §5.7; the
 * token's never-minted `project_id` claim is gone), carried unchanged onto the
 * deferred approval row — and the approval is routed to THAT
 * project's owner. `input.project_id` is caller-supplied and nothing else
 * compares it: an editor of A passing B would get A's owner to approve a
 * build that runs against B and is billed (X-Project-Id) to B. Refuse any
 * mismatch, and fail closed when there is no project-scoped context (RBAC
 * already refuses that for this rule; this keeps the handler safe on its own).
 */
function authorizedBuildProject(
  actionName: string,
  input: BuildInput,
  ctx: ActionContext,
): string {
  if (!ctx.projectId) {
    throw new RbacDeniedError(
      'rbac_project_required',
      actionName,
      'this action requires a project-scoped context but ctx.projectId is null',
    );
  }
  if (input.project_id !== ctx.projectId) {
    throw new RbacDeniedError(
      'rbac_project_mismatch',
      actionName,
      `input.project_id ${input.project_id} does not match the caller's authorized project ${ctx.projectId}`,
    );
  }
  return ctx.projectId;
}

async function triggerBuild(
  webhookPath: string,
  workflowId: string,
  input: BuildInput,
  ctx: ActionContext,
  actionName: string,
): Promise<{ executionId: string }> {
  const projectId = authorizedBuildProject(actionName, input, ctx);
  const { executionId } = await triggerWorkflow(
    webhookPath,
    {
      ...(input.payload && typeof input.payload === 'object'
        ? (input.payload as Record<string, unknown>)
        : {}),
      // After the spread: a caller-supplied `payload.project_id` must not
      // re-target the build after the check above.
      project_id: projectId,
      // Same rule for the actor: X-Actor-Id is ctx.userId, and
      // withN8nAttributionBody never overwrites a caller-set field, so a
      // caller's `payload.actor_id` would survive into the body and disagree
      // with the header (billing another member). Server-derived wins.
      actor_id: ctx.userId,
    },
    {
      projectId,
      userId: ctx.userId,
      workflowId,
      initiatedVia: 'agent',
      correlationId: ctx.correlationId,
      tenantId: ctx.tenantId ?? null,
    },
  );
  return { executionId };
}

const buildIoMapAction: AgentCallableAction<
  BuildInput,
  z.infer<typeof buildOutputSchema>
> = {
  name: 'toc.build_io_map',
  kind: 'write',
  description:
    'Author an objective Intermediate-Objectives (IO) Map for a project via the AA "Build IO Map" subroutine. Writes a TOC io_map tree into requirements_management; read it back via toc.get_graph. Approval: single-approver / project-owner.',
  input: buildInputSchema,
  output: buildOutputSchema,
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (i) => `toc.build_io_map:${i.idempotency_key}:${i.project_id}`,
  handler: (input, ctx: ActionContext) =>
    triggerBuild(
      resolveConfigured(
        config.services.n8n.aaBuildIoMapWebhook,
        'AA_BUILD_IO_MAP_WEBHOOK',
      ),
      config.services.n8n.aaBuildIoMapWorkflowId ||
        config.services.n8n.aaBuildIoMapWebhook,
      input,
      ctx,
      'toc.build_io_map',
    ),
  rbac: { type: 'project-role', role: 'editor' },
};

const evaporateConflictAction: AgentCallableAction<
  BuildInput,
  z.infer<typeof buildOutputSchema>
> = {
  name: 'toc.evaporate_conflict',
  kind: 'write',
  description:
    'Build an Evaporating Cloud (conflict-resolution diagram) for a project conflict via the AA "Build Evaporating Cloud" subroutine. Writes a TOC evaporating_cloud tree into requirements_management. Approval: single-approver / project-owner.',
  input: buildInputSchema,
  output: buildOutputSchema,
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (i) =>
    `toc.evaporate_conflict:${i.idempotency_key}:${i.project_id}`,
  handler: (input, ctx: ActionContext) =>
    triggerBuild(
      resolveConfigured(
        config.services.n8n.aaBuildEvaporatingCloudWebhook,
        'AA_BUILD_EVAPORATING_CLOUD_WEBHOOK',
      ),
      config.services.n8n.aaBuildEvaporatingCloudWorkflowId ||
        config.services.n8n.aaBuildEvaporatingCloudWebhook,
      input,
      ctx,
      'toc.evaporate_conflict',
    ),
  rbac: { type: 'project-role', role: 'editor' },
};

const evaluateLensesAction: AgentCallableAction<
  BuildInput,
  z.infer<typeof buildOutputSchema>
> = {
  name: 'toc.evaluate_lenses',
  kind: 'write',
  description:
    'Author CLR reasoning lenses (clr_assessment + goal_tree_relevance) for a project asset via the AA evaluate-lenses subroutine. Approval: single-approver / project-owner.',
  input: buildInputSchema,
  output: buildOutputSchema,
  approval: { type: 'single-approver', approver: 'project-owner' },
  cronSafe: false,
  idempotencyKey: (i) =>
    `toc.evaluate_lenses:${i.idempotency_key}:${i.project_id}`,
  handler: (input, ctx: ActionContext) =>
    // No lens-eval builder/webhook exists yet — this resolves an unset knob
    // and fails at call-site until the CLR lens-read work lands (plan §2.2).
    triggerBuild(
      resolveConfigured(
        config.services.n8n.aaEvaluateLensesWebhook,
        'AA_EVALUATE_LENSES_WEBHOOK',
      ),
      config.services.n8n.aaEvaluateLensesWorkflowId ||
        config.services.n8n.aaEvaluateLensesWebhook,
      input,
      ctx,
      'toc.evaluate_lenses',
    ),
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

export function registerTocActions(): void {
  safeRegister(listTreesAction);
  safeRegister(getTreeAction);
  safeRegister(getGraphAction);
  safeRegister(getQualityAction);
  safeRegister(getConfigAction);
  safeRegister(withInvokeCard(buildIoMapAction));
  safeRegister(withInvokeCard(evaporateConflictAction));
  safeRegister(withInvokeCard(evaluateLensesAction));
}
