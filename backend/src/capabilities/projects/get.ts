// fr-agui SPEC §8.1 P0b — re-expressed as a capability (route unchanged); P1b exposes it to the doorway agent.
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
import { z } from 'zod';

import { defineCapability } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

export const projectsGetCapability = defineCapability({
  id: 'projects.get',
  area: 'projects',
  summary: 'Get project by ID',
  http: { method: 'GET', path: '/api/projects/:id', operationId: 'getProject' },
  input: z.object({ id: z.string().uuid().describe('The project id') }),
  output: z.unknown(),
  errors: [{ status: 404, code: 'not_found' }],
  auth: { principal: 'user', rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) } },
  tenancy: 'project',
  effect: 'read',
  confirm: 'none',
  rmOwned: ['phase', 'structure'],
  // P1b (SPEC §6.0): a doorway read, the route's own visibility query for the
  // agent's read identity. In a project-bound thread `id` is the PROJECT
  // PARAMETER: removed from the model's schema and injected from the thread
  // (agent/project-binding.ts); another id is refused `project_mismatch`.
  agent: {
    expose: true,
    tier: 'core',
    cronSafe: true,
    idempotencyKey: (i: { id: string }) => `projects.get:${i.id}`,
  },
  licence: { ops: ['projects.getProject', 'project.get'] },
  openapi: {
    frozen: {
        summary: 'Get project by ID',
        tags: ['Projects'],
        operationId: 'getProject',
        parameters: [
          {
            name: 'id',
            in: 'path',
            required: true,
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Project details',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Project' },
              },
            },
          },
          '404': {
            description: 'Project not found',
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Error' },
              },
            },
          },
        },
      },
  },
  handler: lazyActionHandler(() => import('../../agui/actions/projects-read'), {
    module: 'src/agui/actions/projects-read.ts',
    exportName: 'projectsGetHandler',
  }),
  legacyHandler: lazyHandler(() => import('../../routes/projects'), {
    module: 'src/routes/projects.ts',
    exportName: 'handleGetProject',
  }),
});
