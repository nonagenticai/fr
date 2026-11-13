// fr-agui SPEC §13 P4c part 1 — spec drain: GET /api/engagements/deliveries[/:id]
// (routes/engagements/deliveries.ts), the delivery audit trail, re-expressed with
// NO behaviour change.
//
// Gate: validateAuth (thrown to the central catch), then the visibility clause,
// which resolves the active tenant with `ctxTenantId(user.tenantId)` (the frame,
// else the JWT tenant; neither → 500, before any read). What a caller then SEES is
// a row filter, not a refusal: their own rows (any tenant), plus — for a
// workspace-admin or a super_admin — the rows whose approval belongs to the active
// tenant. Declared: `isAuthenticatedUserInResolvedTenant`; tenancy `tenant`.
//
// 🔐 `recipient_address` is where the message went — for a Teams delivery that is
// the incoming-webhook URL, which embeds its credential. Declared secrets.output
// (declaration only: the route returns it as stored, to the rows' visible readers).
import { z } from 'zod';

import { ChannelEnum, ListQuerySchema, StatusEnum } from '../../routes/engagements/deliveries-schemas';
import type { Capability } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { isoTime, pathId, routeRule, settingsCapabilities, standardResponses } from './_shared';

const delivery = z.object({
  id: z.string(),
  engagement_id: z.string().nullable().describe('The approval (or other engagement) the delivery was raised for.'),
  engagement_type: z.string(),
  channel: z.string().describe(`One of ${ChannelEnum.options.join(', ')} (or a channel name fr did not register).`),
  recipient_user_id: z.string().nullable(),
  recipient_address: z.string().describe('🔐 Where the message was sent (an address; for Teams, the incoming-webhook URL).'),
  status: z.string().describe(`${StatusEnum.options.join(', ')}, or 'pending' while a record-before-send delivery is in flight.`),
  error: z.string().nullable().describe('The transport failure; rewritten to a generic line for anyone but a super_admin.'),
  metadata_json: z.record(z.unknown()).nullable().describe('Error-keyed strings are rewritten for anyone but a super_admin.'),
  action_id: z.string().nullable(),
  created_at: isoTime,
});

export const ENGAGEMENT_CAPABILITIES: ReadonlyArray<Capability<unknown, unknown>> = settingsCapabilities(
  {
    area: 'engagements', tag: 'Engagements', tenancy: 'tenant',
    module: 'src/routes/engagements/deliveries.ts', load: () => import('../../routes/engagements/deliveries'),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  [
    {
      id: 'engagements.list_deliveries', method: 'GET', path: '/api/engagements/deliveries', handler: 'handleListDeliveries',
      summary: 'Delivery audit rows the caller may see (their own; an admin also the active tenant\'s), newest first', effect: 'read',
      description:
        '`userId` filters by recipient for a workspace-admin or super_admin and is silently ignored for anyone else. ' +
        '`meta.count` is the true number of matching rows (`count_kind`), not the page size.',
      input: ListQuerySchema,
      output: z.object({
        data: z.array(delivery),
        meta: z.object({ count: z.number().int().nullable(), count_kind: z.enum(['exact', 'at_least', 'unknown']) }),
      }),
      secrets: { output: ['/data/recipient_address'] },
      responses: standardResponses("422: `error` 'Validation error' (`details`): a query value that fails the schema. ", { noTenant500: true }),
    },
    {
      id: 'engagements.get_delivery', method: 'GET', path: '/api/engagements/deliveries/:id', handler: 'handleGetDelivery',
      summary: 'One delivery audit row the caller may see', effect: 'read',
      input: z.object({ id: pathId('Delivery id (a uuid; anything else is the same 404)') }),
      output: z.object({ data: delivery }),
      secrets: { output: ['/data/recipient_address'] },
      responses: standardResponses(
        "404: `error` 'Delivery not found' — absent, not a uuid, or not visible to the caller (indistinguishable). ",
        { noTenant500: true },
      ),
    },
  ],
);
