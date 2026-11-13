// fr-agui SPEC §8.1 P0b — re-expressed as a capability (route unchanged); P1b exposes it to the doorway agent.
// ⛔ Side-effect free (define.ts): handlers are bound through lazy.ts.
import { z } from 'zod';

import { defineCapability } from '../define';
import { lazyActionHandler, lazyHandler } from '../lazy';
import { isAuthenticatedTenantUser } from '../rbac-rules';

export const projectsListCapability = defineCapability({
  id: 'projects.list',
  area: 'projects',
  summary: "List user's projects",
  http: { method: 'GET', path: '/api/projects', operationId: 'listProjects' },
  input: z.object({
    include_archived: z.string().optional().describe("'true' includes archived projects"),
    programme_id: z.string().optional().describe('Restrict to one programme'),
  }),
  output: z.unknown(),
  errors: [],
  auth: { principal: 'user', rbac: { type: 'custom', check: (ctx) => isAuthenticatedTenantUser(ctx) } },
  tenancy: 'tenant',
  effect: 'read',
  confirm: 'none',
  // P1b (SPEC §6.0): a doorway read. The agent handler runs the route's own list
  // query for the agent's read identity (agui/actions/projects-read.ts).
  agent: {
    expose: true,
    tier: 'core',
    cronSafe: true,
    idempotencyKey: (i: { include_archived?: string; programme_id?: string }) =>
      `projects.list:${i.include_archived ?? ''}:${i.programme_id ?? ''}`,
  },
  licence: { ops: ['projects.listProjects'] },
  openapi: {
    frozen: {
        summary: "List user's projects",
        tags: ['Projects'],
        operationId: 'listProjects',
        responses: {
          '200': {
            description: 'List of projects',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    projects: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Project' },
                    },
                    total: { type: 'integer' },
                  },
                },
              },
            },
          },
        },
      },
  },
  handler: lazyActionHandler(() => import('../../agui/actions/projects-read'), {
    module: 'src/agui/actions/projects-read.ts',
    exportName: 'projectsListHandler',
  }),
  legacyHandler: lazyHandler(() => import('../../routes/projects'), {
    module: 'src/routes/projects.ts',
    exportName: 'handleListProjects',
  }),
});
