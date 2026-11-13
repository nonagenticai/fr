/**
 * AG-UI agent-callable read actions for the `worker_management` upstream.
 * Same shape as `actions/requirements.ts`. Six read actions.
 */

import { z } from 'zod';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import {
  listWorkers,
  getWorker,
  listWorkerProviders,
  listWorkerProviderModels,
  listWorkerActivity,
  listGraphExecutionSessions,
} from '../../integrations/workers';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { userRolesService } from '../../services/user-roles';

const listInputSchema = z.object({
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({ items: z.array(z.string()) });

const getInputSchema = z.object({ worker_name: z.string().min(1) });
type GetInput = z.infer<typeof getInputSchema>;
const getOutputSchema = z.object({ item: z.unknown() });

const listProvidersOutputSchema = z.object({ providers: z.unknown() });

const listProviderModelsInputSchema = z.object({ provider: z.string().min(1) });
type ListProviderModelsInput = z.infer<typeof listProviderModelsInputSchema>;
const listProviderModelsOutputSchema = z.object({ models: z.unknown() });

const listActivityInputSchema = z.object({
  worker_id: z.string().min(1),
  since: z.string().optional(),
});
type ListActivityInput = z.infer<typeof listActivityInputSchema>;
const listActivityOutputSchema = z.object({ events: z.array(z.unknown()) });

const listGraphSessionsInputSchema = z.object({
  graph_id: z.string().optional(),
  status: z.string().optional(),
  validation_passed: z.boolean().optional(),
  correlation_id: z.string().optional(),
  since: z.string().optional(),
  until: z.string().optional(),
  limit: z.number().int().min(1).max(1000).optional(),
  offset: z.number().int().min(0).optional(),
});
type ListGraphSessionsInput = z.infer<typeof listGraphSessionsInputSchema>;
// ⚠️ NO `total`. WM's list endpoint returns a bare array of ONE PAGE, so the
// old `total` was that page's row count — 100 by default, whatever the tenant
// actually holds. An agent reading it concluded the set was complete. The
// integration now reports the cap it applied and a boolean "there is more".
const listGraphSessionsOutputSchema = z.object({
  sessions: z.array(z.unknown()),
  applied_limit: z.number().int().positive(),
  truncated: z.boolean(),
});

// ---------- Admin gate for the key-spending provider listings ----------
//
// ⚠️ `workers.list_providers` / `workers.list_provider_models` answer from
// worker_management with a LIVE vendor model-list call on the tenant's BYO key
// (WM `_list_customer_provider_models` -> `live_row_models(..., fresh=True)`).
// The HTTP twins (`GET /api/assets/workers/providers[/:p/models]`) were gated
// to workspace-admin OR platform super-admin on 2026-10-02 (fr BYO validator
// D1) for exactly that reason, and the assistant frame (`routes/agent.ts`) now
// carries the member's verified portal token, so a `public` rule here was a
// second, ungated door to the same spend (validator round 2, R1). Same pair as
// the HTTP gate:
//
//   - platform super-admin: the `super_admin` realm role on `ctx.tenantRoles`
//     (the Keycloak realm roles the agent token / channel identity carries);
//   - workspace-admin of `ctx.tenantId`: a `user_roles` row, via
//     `isWorkspaceAdminVia` — the one canonical predicate.
//
// ⛔ The realm `tenant_admin` arm of `isWorkspaceAdminVia` is deliberately NOT
// reachable here: it must pin to the RAW `tenant_id` claim (`User.tenantClaim`),
// and `ActionContext` carries no raw claim — `ctx.tenantId` is the agent
// session's tenant, which `deriveTenantId` may have defaulted to `sub`. Passing
// it as the claim would admit a realm admin of ANY tenant. So `tenantClaim` is
// omitted and that arm fails closed; such an admin uses the HTTP surface.
//
// A `custom` rule, not `tenant-role`: `tenant-role 'admin'` would test a bare,
// UNPINNED realm claim (the shape `scripts/check-admin-claim-only.ts` forbids)
// and would miss every `user_roles` workspace-admin.
type HasRoleFn = (userId: string, tenantId: string, role: string) => Promise<boolean>;
const hasRoleImpl: HasRoleFn = (u, t, r) => userRolesService.hasRole(u, t, r);

async function isWorkspaceAdminOrSuperAdmin(ctx: ActionContext): Promise<boolean> {
  const roles = ctx.tenantRoles ?? [];
  if (isSuperAdmin({ roles })) return true;
  if (!ctx.tenantId || !ctx.userId) return false;
  return userRolesService.isWorkspaceAdminVia(
    { id: ctx.userId, roles: [...roles] },
    ctx.tenantId,
    hasRoleImpl,
  );
}

const adminOnlyRbac = {
  type: 'custom' as const,
  check: (ctx: ActionContext) => isWorkspaceAdminOrSuperAdmin(ctx),
};

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'workers.list',
  kind: 'read',
  description: 'List worker names visible to the calling tenant.',
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `workers.list:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const items = await listWorkers(input);
    return { items };
  },
};

const getAction: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'workers.get',
  kind: 'read',
  description: 'Fetch a single worker by name.',
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `workers.get:${i.worker_name}`,
  handler: async (input) => {
    const item = await getWorker(input.worker_name);
    return { item };
  },
};

const listProvidersAction: AgentCallableAction<
  Record<string, never>,
  z.infer<typeof listProvidersOutputSchema>
> = {
  name: 'workers.list_providers',
  kind: 'read',
  description:
    'List the LLM/inference providers configured for workers. Requires workspace-admin or super-admin (runs a live model listing on the tenant key).',
  input: z.object({}).strict(),
  output: listProvidersOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: adminOnlyRbac,
  idempotencyKey: () => 'workers.list_providers',
  handler: async () => {
    const providers = await listWorkerProviders();
    return { providers };
  },
};

const listProviderModelsAction: AgentCallableAction<
  ListProviderModelsInput,
  z.infer<typeof listProviderModelsOutputSchema>
> = {
  name: 'workers.list_provider_models',
  kind: 'read',
  description:
    'List the models available for a given inference provider. Requires workspace-admin or super-admin (runs a live model listing on the tenant key).',
  input: listProviderModelsInputSchema,
  output: listProviderModelsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: adminOnlyRbac,
  idempotencyKey: (i) => `workers.list_provider_models:${i.provider}`,
  handler: async (input) => {
    const models = await listWorkerProviderModels(input.provider);
    return { models };
  },
};

const listActivityAction: AgentCallableAction<
  ListActivityInput,
  z.infer<typeof listActivityOutputSchema>
> = {
  name: 'workers.list_activity',
  kind: 'read',
  description:
    "List a worker's recent state transitions, projected as an activity stream. Optional `since` ISO timestamp filters client-side.",
  input: listActivityInputSchema,
  output: listActivityOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `workers.list_activity:${i.worker_id}:${i.since ?? ''}`,
  handler: async (input) => {
    const events = await listWorkerActivity(input.worker_id, input.since);
    return { events };
  },
};

const listGraphSessionsAction: AgentCallableAction<
  ListGraphSessionsInput,
  z.infer<typeof listGraphSessionsOutputSchema>
> = {
  name: 'workers.list_graph_sessions',
  kind: 'read',
  description:
    'List graph_execution_sessions visible to the calling tenant (production execution traces).',
  input: listGraphSessionsInputSchema,
  output: listGraphSessionsOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `workers.list_graph_sessions:${i.graph_id ?? ''}:${i.status ?? ''}:${i.validation_passed ?? ''}:${i.correlation_id ?? ''}:${i.since ?? ''}:${i.until ?? ''}:${i.limit ?? ''}:${i.offset ?? ''}`,
  handler: async (input) => {
    const out = await listGraphExecutionSessions(input);
    return {
      sessions: out.sessions,
      applied_limit: out.appliedLimit,
      truncated: out.truncated,
    };
  },
};

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

export function registerWorkersActions(): void {
  safeRegister(listAction);
  safeRegister(getAction);
  safeRegister(listProvidersAction);
  safeRegister(listProviderModelsAction);
  safeRegister(listActivityAction);
  safeRegister(listGraphSessionsAction);
}
