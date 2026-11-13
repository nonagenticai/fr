// fr-agui SPEC §13 P4b — spec drain: the in-app message routes, re-expressed
// with NO behaviour change (`legacyHandler`):
//
//   * D9 `/api/inapp/messages` GET + POST (routes/inapp-messages.ts) — the
//     caller's own in-app chat history. KEPT and specced (SPEC §8.4 D9).
//     n8n-nodes-kaizen-core-actions `postInAppMessage` calls the POST (body
//     `{ text, userId?, threadId?, correlationId? }`). Its node source says it
//     authenticates with a Keycloak service-account JWT (KaizenCoreActions.node.ts:
//     the legacy licenseToken field is ignored), i.e. as an ordinary validateAuth
//     user. The route is NOT on the licence route allowlist, and this unit does
//     not change that: a licence-shaped bearer is refused by the SERVER's route
//     door right after routing (403 `licence_route_not_allowed`), before this
//     handler runs. The conveyor priority identity is refused INSIDE validateAuth
//     on the POST, and this handler (which catches every validateAuth throw)
//     answers that as a 401. Whether the node's call should be allowlisted is the
//     open D9 decision (measure the live call first), not a spec-drain change.
//   * `POST /api/notifications/inapp` (routes/notifications/inapp.ts) — an
//     internal tenant posts an outbound notification to a user.
//
// Gates: the chat history — validateAuth only (its doors), keyed by the caller's
// id (a body `userId` naming anyone else is a 403); the notification —
// validateAuth, then `requireAnyInternalTenant` (the request-context tenant is
// an internal tenant, else an opaque 404).
import { z } from 'zod';

import { sendInappNotificationSchema } from '../../routes/notifications/inapp-schemas';
import type { ResponseSpec } from '../define';
import { isAuthenticatedUser, isAuthenticatedUserInInternalTenant } from '../rbac-rules';
import {
  DOOR_403,
  LICENCE_ROUTE_DOOR_403,
  VALIDATE_AUTH_401,
  frErrorBody,
  preHandlerRefusalBody,
  routeRule,
  settingsCapabilities,
  unauthorizedBody,
} from './_shared';

/** An `inapp_messages` row as `jsonResponse` serialises it. */
const message = z.object({
  id: z.string(),
  user_id: z.string(),
  direction: z.enum(['inbound', 'outbound']),
  text: z.string(),
  correlation_id: z.string().nullable(),
  meta_json: z.record(z.unknown()).nullable(),
  created_at: z.string(),
});

/**
 * These handlers catch EVERY validateAuth throw and answer 401 — including the
 * conveyor priority identity's door (validateAuth refuses it on a write). A licence
 * bearer never reaches them: the server's route door answers it 403 first.
 */
const inapp401 = (method: 'GET' | 'POST'): ResponseSpec => ({
  status: 401,
  description:
    "`error`: the auth failure's message ('Missing or invalid Authorization header', 'Invalid or expired token') or " +
    "'unauthorized'. The handler catches every validateAuth throw and answers it 401. " +
    (method === 'POST'
      ? "So the conveyor priority identity — refused inside validateAuth ('conveyor_route_forbidden') — gets a 401 here, not a 403."
      : 'The conveyor priority identity is admitted on this GET.') +
    ' A licence bearer is the 403 below, not a 401.',
  schema: unauthorizedBody,
});

/**
 * The licence route door + a request-context refusal (before routing), both `{ error, code }`.
 * The same on every method since the read-only support switch was retired (George 2026-10-27).
 */
const INAPP_GET_403_DOOR =
  `${LICENCE_ROUTE_DOOR_403} Or a request-context refusal before routing: \`code\` 'active_tenant_not_permitted' ` +
  '(a super_admin naming, in X-Active-Tenant, a workspace it may not switch into; `reason` is one of ' +
  "'archived', 'unknown', 'service_account' (a service-account token) or 'untrusted_session' " +
  '(a super_admin token that is not a Non-Agentic AI browser session)).';
const INAPP_POST_403_DOOR = INAPP_GET_403_DOOR;

export const INAPP_MESSAGE_CAPABILITIES = settingsCapabilities(
  {
    area: 'inapp', tag: 'In-App Messages', tenancy: 'self',
    module: 'src/routes/inapp-messages.ts', load: () => import('../../routes/inapp-messages'),
    rule: routeRule(isAuthenticatedUser),
  },
  [
    {
      id: 'inapp.list_messages', method: 'GET', path: '/api/inapp/messages', handler: 'handleInAppListMessages',
      summary: "The caller's most recent in-app messages (newest first)", effect: 'read',
      input: z.object({
        limit: z.string().optional().describe('Rows: default 50, capped at 200; an absent, non-numeric or < 1 value is the default (never a 400).'),
      }),
      output: z.object({ messages: z.array(message) }),
      responses: [
        inapp401('GET'),
        { status: 403, description: INAPP_GET_403_DOOR, schema: preHandlerRefusalBody },
        { status: 'default', description: "500: fr's own (`error`), e.g. the database is unreachable.", schema: frErrorBody },
      ],
    },
    {
      id: 'inapp.post_message', method: 'POST', path: '/api/inapp/messages', handler: 'handleInAppPostMessage',
      summary: 'Post an in-app chat message as the caller', effect: 'write', successStatus: 202,
      description:
        'D9. With the channel dispatcher OFF the message is stored and the answer is 202 `{ received: true }`. With it ON ' +
        '(CHANNEL_DISPATCH_ENABLED) the dispatcher answers instead (its own status and body).',
      input: z
        .object({
          text: z.unknown().optional().describe('A non-empty string, required when the dispatcher is off (else 400).'),
          userId: z.unknown().optional().describe("When present (truthy) it must be the caller's own id, else 403."),
          threadId: z.unknown().optional(),
          correlationId: z.unknown().optional().describe('Stored when a string.'),
        })
        .passthrough(),
      output: z.object({ received: z.literal(true) }),
      responses: [
        {
          status: 400,
          description: "`error`: 'invalid JSON body' or 'text is required'.",
          schema: z.object({ error: z.enum(['invalid JSON body', 'text is required']) }),
        },
        {
          status: 403,
          description: `\`error\` 'userId does not match authenticated user' (the handler; no \`code\`). ${INAPP_POST_403_DOOR}`,
          schema: z.union([z.object({ error: z.literal('userId does not match authenticated user') }), preHandlerRefusalBody]),
        },
        inapp401('POST'),
        {
          status: 'default',
          description: "500: `error` 'db error' (or the raw database text for a super_admin). With the dispatcher on: its answer, any status.",
          schema: z.object({ error: z.string().optional() }).passthrough(),
        },
      ],
    },
  ],
);

export const INAPP_NOTIFICATION_CAPABILITIES = settingsCapabilities(
  {
    area: 'notifications', tag: 'Notifications', tenancy: 'tenant',
    module: 'src/routes/notifications/inapp.ts', load: () => import('../../routes/notifications/inapp'),
    rule: routeRule(isAuthenticatedUserInInternalTenant),
  },
  [
    {
      id: 'notifications.send_inapp', method: 'POST', path: '/api/notifications/inapp', handler: 'handleSendInappNotification',
      summary: 'Send an in-app notification to a user (internal tenants only)', effect: 'write', successStatus: 202,
      description: 'Stores one outbound `inapp_messages` row for `recipientUserId`. Only an internal tenant may call it; every other tenant gets the opaque 404.',
      input: sendInappNotificationSchema,
      output: z.object({ id: z.string(), queued: z.literal(true) }),
      responses: [
        { status: 401, description: VALIDATE_AUTH_401, schema: unauthorizedBody },
        {
          status: 422,
          description: "`error` 'Validation error' (the body is not JSON, or fails the schema; `details`).",
          schema: z.object({ error: z.literal('Validation error'), details: z.array(z.unknown()) }),
        },
        {
          status: 'default',
          description:
            "404: `error.code` 'UPSTREAM_NOT_FOUND' when the request tenant is not an improvement-loop tenant (opaque on purpose). " +
            DOOR_403 +
            " 502: `error.code` 'UPSTREAM_BAD_STATUS' (the insert returned no row). Otherwise fr's own 500.",
          schema: frErrorBody,
        },
      ],
    },
  ],
);
