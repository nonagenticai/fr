// fr-agui SPEC §13 P4b — spec drain: the workspace channel registry
// `/api/channels` (routes/channels.ts), re-expressed with NO behaviour change
// (`legacyHandler`).
//
// Gate: validateAuth (its doors), then the tenant `ctxTenantId(user.tenantId)`
// (the frame tenant, else the JWT one; with neither the handler throws → 500).
//   * reads — any caller with that tenant; a channel of another workspace is the
//     same 404 as an absent one (a row check, not part of the principal rule);
//   * writes — `isWorkspaceAdminVia` of that tenant, else 401 'workspace-admin
//     role required' (sic: the route answers 401, not 403): the route-aware
//     `workspace-admin` rule.
//
// 🔐 `credentials` (a channel's bot token / webhook secret) is a secret INPUT on
// create and update. The wire serializer NEVER returns it (`serializeChannel`
// emits id, kind, name, tenant_id, dept_id, config, created_at, archived_at), so
// no declared output carries it.
import { z } from 'zod';

import { CreateBodySchema, ChannelKindEnum, UpdateBodySchema } from '../../routes/channels-shared';
import type { ResponseSpec } from '../define';
import { isAuthenticatedUserInResolvedTenant } from '../rbac-rules';
import { DOOR_403, VALIDATE_AUTH_401, frErrorBody, pathId, routeRule, settingsCapabilities, unauthorizedBody, workspaceAdminRule, type SettingsRoute } from './_shared';

const MODULE = { module: 'src/routes/channels.ts', load: () => import('../../routes/channels') };

const id = z.object({ id: pathId('Channel id') });

/** `serializeChannel`: the stored `credentials` are never part of it. */
const channel = z.object({
  id: z.string(),
  kind: ChannelKindEnum,
  name: z.string(),
  tenant_id: z.string(),
  dept_id: z.string().optional(),
  config: z.record(z.unknown()).optional(),
  created_at: z.string(),
  archived_at: z.string().nullable(),
});

const NOT_FOUND = "404: `error` 'Channel not found' (absent, or another workspace's).";
const RESPONSES = (writes: boolean): ResponseSpec[] => [
  {
    status: 401,
    description: VALIDATE_AUTH_401 + (writes ? " Or 'workspace-admin role required' (not a workspace-admin of the request tenant)." : ''),
    schema: unauthorizedBody,
  },
  {
    status: 'default',
    description:
      (writes
        ? "400: `error` 'invalid JSON body', or 'tenant_id in body does not match the authenticated tenant' (create). " +
          "422: `error` 'Validation error' (the body fails the schema; `details`). "
        : '') +
      NOT_FOUND +
      ' ' +
      DOOR_403 +
      " 500: fr's own (`error`), e.g. no tenant resolvable for the caller, or the database is unreachable.",
    schema: frErrorBody,
  },
];

const credentialsSecret = { input: ['/credentials'] };

const ROUTES: SettingsRoute[] = [
  {
    id: 'channels.list', method: 'GET', path: '/api/channels', handler: 'handleListChannels',
    summary: "The request tenant's channels (credentials never returned)", effect: 'read',
    input: z.object({}), output: z.array(channel), responses: RESPONSES(false),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  {
    id: 'channels.create', method: 'POST', path: '/api/channels', handler: 'handleCreateChannel',
    summary: 'Register a channel in the request tenant', effect: 'write', successStatus: 201,
    input: CreateBodySchema, output: channel, responses: RESPONSES(true), secrets: credentialsSecret,
  },
  {
    id: 'channels.get', method: 'GET', path: '/api/channels/:id', handler: 'handleGetChannel',
    summary: "One of the request tenant's channels (credentials never returned)", effect: 'read',
    input: id, output: channel, responses: RESPONSES(false),
    rule: routeRule(isAuthenticatedUserInResolvedTenant),
  },
  {
    id: 'channels.update', method: 'PATCH', path: '/api/channels/:id', handler: 'handleUpdateChannel',
    summary: "Update one of the request tenant's channels", effect: 'write',
    input: UpdateBodySchema.extend(id.shape), output: channel, responses: RESPONSES(true), secrets: credentialsSecret,
  },
  {
    id: 'channels.delete', method: 'DELETE', path: '/api/channels/:id', handler: 'handleDeleteChannel',
    summary: "Delete one of the request tenant's channels", effect: 'destructive', successStatus: 204,
    input: id, output: z.null(), responses: RESPONSES(true),
  },
];

export const CHANNEL_CAPABILITIES = settingsCapabilities(
  { area: 'channels', tag: 'Channels', tenancy: 'tenant', ...MODULE, rule: workspaceAdminRule() },
  ROUTES,
);
