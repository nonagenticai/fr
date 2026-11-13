// fr-agui SPEC §13 P4c part 1 — spec drain: GET /api/card-types and
// GET /api/card-types/:cardType (routes/card-types.ts), the request tenant's card
// types from its requirements_management PM catalogue, re-expressed with NO
// behaviour change (`legacyHandler`).
//
// Gate (`callerTenant`): validateAuth — its refusals CAUGHT and answered
// `{ error: 'unauthorized' }` 401 — then `ctxTenantId(user.tenantId)` (the frame
// tenant, else the JWT one; neither → 500). The catalogue reader names that tenant
// explicitly to RM's client, which refuses a blank one (MISSING_TENANT, nothing
// sent). Declared: `isAuthenticatedUserInResolvedNonBlankTenant`. Tenant-level (the
// tenant's vocabulary, not a project's), so P4c, not P2.
import { z } from 'zod';

import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedNonBlankTenant } from '../rbac-rules';
import { caughtAuthResponses, pathId, routeRule, settingsCapabilities } from './_shared';

const CATALOGUE =
  "409: `code` 'catalogue_not_initialised' (`details.tenant_id`, `details.missing`: the tenant has no PM catalogue in " +
  "requirements_management yet; a super-admin imports the defaults) or `error.code` 'MISSING_TENANT' (a blank request " +
  "tenant: nothing is sent). Any other status is requirements_management's, relayed (`error.code` 'UPSTREAM_…'). " +
  "500 also when no tenant is resolvable for the caller (no frame, no JWT tenant). ";

export const CARD_TYPE_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'card_types', tag: 'Card Types', tenancy: 'tenant',
    module: 'src/routes/card-types.ts', load: () => import('../../routes/card-types'),
    rule: routeRule(isAuthenticatedUserInResolvedNonBlankTenant),
  },
  [
    {
      id: 'card_types.list', method: 'GET', path: '/api/card-types', handler: 'handleListCardTypes',
      summary: "The request tenant's card type names (its requirements_management PM catalogue)", effect: 'read',
      input: z.object({}),
      output: z.object({ card_types: z.array(z.string()).describe('Card type names, in the catalogue order.') }),
      responses: caughtAuthResponses({ status: '401' }, CATALOGUE),
    },
    {
      id: 'card_types.get', method: 'GET', path: '/api/card-types/:cardType', handler: 'handleGetCardType',
      summary: "One card type of the request tenant's catalogue, with its capability (card group)", effect: 'read',
      input: z.object({ cardType: pathId('Card type name (the catalogue `name`)') }),
      output: z.object({
        card_type: z.string(),
        title: z.string(),
        card_type_description: z.string().describe("The catalogue description ('' when unset)."),
        card_group: z.string().nullable().describe("The card type's capability name (null when its capability is not in the catalogue)."),
        capability: z.object({ name: z.string(), title: z.string() }).nullable(),
        inputs: z.array(z.string()).describe('[] when the catalogue records none (RM null).'),
        outputs: z.array(z.string()),
        acceptance: z.array(z.string()),
        rules: z.array(z.string()),
        human_task: z.boolean().nullable(),
        definition_of_done: z.unknown().describe('Verbatim from the catalogue; null when unset.'),
      }),
      responses: [
        ...caughtAuthResponses({ status: '401' }, CATALOGUE).slice(0, 1),
        {
          status: 404,
          description: "`error` 'card_type_not_found': the tenant's catalogue has no card type by that name.",
          schema: z.object({ error: z.literal('card_type_not_found'), card_type: z.string() }),
        },
        ...caughtAuthResponses({ status: '401' }, CATALOGUE).slice(1),
      ],
    },
  ],
);
