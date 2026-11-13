/**
 * AG-UI agent-callable READ actions for the tenant PM catalogue
 * (`integrations/pm-catalogue.ts`): project phases, capabilities, card types,
 * project types, gates, WIP limits, priority levels, deliverable and
 * milestone kinds, board templates, and the project-type matrices.
 *
 * WHY THIS FILE EXISTS. `integrations/pm-catalogue.ts` is a new integration
 * module, and E-14 (`agui/coverage-check.ts`) fails on an integration module
 * with no read action. The answer is coverage, not an exemption: "which card
 * types / phases / priority levels does my tenant have?" is a user question an
 * agent answers mid-conversation, which is exactly the test `KNOWN_UNCOVERED`
 * applies, and the ratchet forbids growing that list anyway.
 *
 * NAMING: `pm_catalogue.*` — the registry's NAME_RE forbids hyphens and
 * `coverage-check.actionNamespaceFor` maps the basename onto this namespace.
 *
 * Tenant scoping: every pm-catalogue call takes `tenantId` EXPLICITLY (it
 * becomes `X-Tenant-Id`; the client is `requireTenant: true`). The handlers pass
 * `ctx.tenantId` verbatim and refuse when it is absent — never a default or
 * system tenant. Same contract as `actions/research.ts`.
 *
 * READ-ONLY. Create/update/delete, the matrix PUT and import-defaults are
 * tenant-admin writes behind the HTTP routes and are deliberately not exposed
 * here. RBAC mirrors the HTTP read routes ("any authenticated caller in their
 * tenant"): `public` plus the mandatory resolved tenant.
 */

import { z } from 'zod';

import {
  PM_CATALOGUE_LIST_PARAMS,
  PM_CATALOGUE_RESOURCES,
  getPmCatalogueItem,
  getProjectTypeCardTypes,
  listPmCatalogue,
} from '../../integrations/pm-catalogue';
import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { RbacDeniedError } from '../rbac';

function requireTenantId(ctx: ActionContext): string {
  if (!ctx.tenantId) {
    // Non-retriable authorization outcome, not a fault: a caller with no
    // resolved tenant cannot be scoped to a tenant catalogue.
    throw new RbacDeniedError(
      'tenant_unresolved',
      'pm_catalogue.*',
      'caller is not in a resolved tenant context (no tenant on the agent token and no user_roles row)',
    );
  }
  return ctx.tenantId;
}

const resourceSchema = z.enum(PM_CATALOGUE_RESOURCES);

const listInputSchema = z
  .object({
    resource: resourceSchema,
    limit: z.number().int().min(1).max(1000).optional(),
    offset: z.number().int().min(0).optional(),
    capability_id: z.string().min(1).optional(),
    project_type_id: z.string().min(1).optional(),
    phase_id: z.string().min(1).optional(),
    card_type_id: z.string().min(1).optional(),
    size: z.string().min(1).optional(),
  })
  .strict();
type ListInput = z.infer<typeof listInputSchema>;
const listOutputSchema = z.object({ result: z.unknown() });

function toParams(input: ListInput): URLSearchParams {
  const params = new URLSearchParams();
  for (const key of PM_CATALOGUE_LIST_PARAMS) {
    const value = input[key];
    if (value !== undefined) params.set(key, String(value));
  }
  return params;
}

const getInputSchema = z.object({ resource: resourceSchema, id: z.string().min(1) }).strict();
type GetInput = z.infer<typeof getInputSchema>;
const getOutputSchema = z.object({ item: z.unknown() });

const projectTypeInputSchema = z.object({ project_type_id: z.string().min(1) }).strict();
type ProjectTypeInput = z.infer<typeof projectTypeInputSchema>;
const projectTypeOutputSchema = z.object({ result: z.unknown() });

const listAction: AgentCallableAction<ListInput, z.infer<typeof listOutputSchema>> = {
  name: 'pm_catalogue.list',
  kind: 'read',
  description:
    `List the caller tenant's PM catalogue entries of one resource (${PM_CATALOGUE_RESOURCES.join(', ')}). Optional id filters: capability_id, project_type_id, phase_id, card_type_id; plus size, limit, offset.`,
  input: listInputSchema,
  output: listOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) =>
    `pm_catalogue.list:${i.resource}:${toParams(i).toString()}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    return { result: await listPmCatalogue(tenantId, input.resource, toParams(input)) };
  },
};

const getActionDef: AgentCallableAction<GetInput, z.infer<typeof getOutputSchema>> = {
  name: 'pm_catalogue.get',
  kind: 'read',
  description: "Get one entry of the caller tenant's PM catalogue by resource and id.",
  input: getInputSchema,
  output: getOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `pm_catalogue.get:${i.resource}:${i.id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    return { item: await getPmCatalogueItem(tenantId, input.resource, input.id) };
  },
};

const projectTypeCardTypesAction: AgentCallableAction<
  ProjectTypeInput,
  z.infer<typeof projectTypeOutputSchema>
> = {
  name: 'pm_catalogue.project_type_card_types',
  kind: 'read',
  description: "The card types allowed for one of the caller tenant's project types (the project-type × card-type matrix).",
  input: projectTypeInputSchema,
  output: projectTypeOutputSchema,
  approval: { type: 'auto' },
  cronSafe: true,
  rbac: { type: 'public' },
  idempotencyKey: (i) => `pm_catalogue.project_type_card_types:${i.project_type_id}`,
  handler: async (input, ctx) => {
    const tenantId = requireTenantId(ctx);
    return { result: await getProjectTypeCardTypes(tenantId, input.project_type_id) };
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

export function registerPmCatalogueActions(): void {
  safeRegister(listAction);
  safeRegister(getActionDef);
  safeRegister(projectTypeCardTypesAction);
}
