// fr-agui SPEC §8.1 P0b — re-expressed as a capability, no behaviour change.
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
import { z } from 'zod';

import { defineCapability } from '../define';
import { withLicenceDoor } from '../frozen-routes';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

export const listProjectTypesOutput = z.object({
  types: z.array(
    z.object({
      name: z.string(),
      title: z.string().nullable(),
      description: z.string().nullable(),
      startable: z.boolean(),
    }),
  ),
});

export const conveyorListProjectTypesCapability = defineCapability<
  Record<string, never>,
  z.infer<typeof listProjectTypesOutput>
>({
  id: 'conveyor.list_project_types',
  area: 'conveyor',
  summary:
    "List this workspace's project types. Only types with startable: true can be used with projects.create.",
  http: { method: 'GET', path: '/api/conveyor/project-types', operationId: 'listTenantProjectTypes' },
  input: z.object({}).strict(),
  output: listProjectTypesOutput,
  errors: [{ status: 409, code: 'catalogue_not_initialised' }],
  auth: { principal: 'user', rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) } },
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  agent: {
    expose: true,
    tier: 'core',
    cronSafe: true,
    idempotencyKey: () => 'conveyor.list_project_types',
  },
  // P4d-2d (P4d-1 carry): the server's licence-door 403 (the route is off the licence allowlist and the literal
  // declared no 403 / default).
  openapi: {
    frozen: withLicenceDoor('GET', '/api/conveyor/project-types', {
        summary: "The caller tenant's project types with their ordered phases (from requirements_management)",
        description: 'Read through the tenant catalogue reader. A tenant with no RM catalogue is 409 `catalogue_not_initialised` (never an empty list, never a local fallback).',
        tags: ['Conveyor'],
        operationId: 'listTenantProjectTypes',
        responses: {
          '200': { description: '{ data: [{ name, title, description, phases: [{ name, title, position, has_gate }] }] }' },
          '401': { description: 'Unauthenticated' },
          '409': { description: '`catalogue_not_initialised` (details.tenant_id, details.missing)' },
        },
      }),
  },
  // The agent read (the catalogue reader, reduced to name/title/description/startable).
  handler: lazyActionHandler(() => import('../../agui/actions/projects-create'), {
    module: 'src/agui/actions/projects-create.ts',
    exportName: 'listProjectTypesHandler',
  }),
  legacyHandler: lazyHandler(() => import('../../routes/conveyor-catalogue'), {
    module: 'src/routes/conveyor-catalogue.ts',
    exportName: 'handleListTenantProjectTypes',
  }),
});
