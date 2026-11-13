// fr-agui SPEC §5.2 (W) / §13 P1c — `POST /api/capabilities/:id/invoke`, the route a
// confirm card calls for an agent-NATIVE write (no UI route of its own), under the
// human's Keycloak session. Declared as a capability so it is in the spec and the
// route accounting; the handler is routes/capability-invoke.ts.
//
// ⛔ Side-effect free (define.ts): the handler is bound through lazy.ts.
import { z } from 'zod';

import { defineCapability, LICENCE_ROUTE_DOOR_ERROR } from '../define';
import { lazyHandler } from '../lazy';

export const capabilitiesInvokeCapability = defineCapability({
  id: 'capabilities.invoke',
  area: 'capabilities',
  summary: "Confirm an agent proposal for a project-scoped native write (the human's click on its card)",
  description:
    'Runs ONE agent-native write of the project agent — today toc.build_io_map, toc.evaporate_conflict and ' +
    "toc.evaluate_lenses — as the calling user, on a project the caller can read. The body is the action's input " +
    "(it names the project). The action's own RBAC and approval policy apply: a project-owner or multi-party " +
    'policy parks (202, a PendingAction). Any other id is 404 not_invokable. Response: {data, invalidate}.',
  http: { method: 'POST', path: '/api/capabilities/:id/invoke', operationId: 'invokeCapability' },
  input: z.object({ id: z.string().min(1) }).passthrough(),
  output: z.object({ data: z.unknown(), invalidate: z.array(z.string()) }),
  errors: [
    { status: 400, code: 'invalid_input' },
    LICENCE_ROUTE_DOOR_ERROR,
    { status: 404, code: 'not_invokable' },
    { status: 404, code: 'not_found' },
    { status: 422, code: 'project_required' },
  ],
  // Authorisation is the invoked action's own rule, evaluated by invokeAction
  // with the human's context; this row adds nothing of its own at the registry layer.
  auth: { principal: 'user', rbac: { type: 'custom', check: async () => false } },
  tenancy: 'project',
  effect: 'write',
  confirm: 'card',
  agent: { expose: false, reason: 'transport' },
  openapi: {
    tags: ['Projects'],
    responses: [
      {
        status: 202,
        description: 'The action parked for approval under its declared policy',
        schema: z.object({ data: z.object({ status: z.literal('pending'), actionId: z.string() }).passthrough(), invalidate: z.array(z.string()) }),
      },
    ],
  },
  legacyHandler: lazyHandler(() => import('../../routes/capability-invoke'), {
    module: 'src/routes/capability-invoke.ts',
    exportName: 'handleCapabilityInvoke',
  }),
});
