// src/routes/channels.ts
//
// Foundation Plan 2 follow-up — `/api/channels` CRUD.
//
// Unblocks the FE admin /channels page (which previously showed a
// "backend-unavailable" banner). Channel-rows backfill landed in
// migration 049 (workspace-scope `owns` asset_assignments edges).
//
// Wire contract — matches `frontend/src/lib/api/channels.ts`:
//   GET    /api/channels         → 200 [Channel]    (any workspace member)
//   GET    /api/channels/:id     → 200 Channel      (any workspace member)
//   POST   /api/channels         → 201 Channel      (workspace-admin)
//   PATCH  /api/channels/:id     → 200 Channel      (workspace-admin)
//   DELETE /api/channels/:id     → 204               (workspace-admin)
//
// Tenant id ↔ workspace id naming:
//   The backend's `channels.workspace_id` column IS the tenant_id
//   (see migration 029 — "the workspace IS the tenant"). The FE
//   `Channel` type expects a `tenant_id` field, so the route
//   serializer aliases `workspace_id → tenant_id` on the wire. This
//   keeps the FE contract untouched while the DB & service layer use
//   the more honest workspace_id name. Switching either side is a
//   single-renamed-key change in `serializeChannel` if we ever want to
//   align the names.
//
// RBAC:
//   Reads — any authenticated user whose `tenantId` matches the
//     `channels.workspace_id`. The fr User claim only carries one
//     tenantId today (single-workspace-per-user), so the gate
//     reduces to "user.tenantId === channel.workspace_id".
//   Writes — same workspace gate plus `admin` role within that
//     tenant, resolved through the existing `userRolesService.hasRole`
//     path used by `routes/engagements/deliveries.ts`. Keycloak
//     `roles` claim 'admin' also satisfies the gate, matching the
//     two-signal pattern that surface uses.
//
// `agui/rbac.ts` is intentionally NOT modified — it's action-scoped
// (used by the agent-callable invoker) and a later lane may extend it.
// Mirroring the deliveries.ts admin bridge here keeps the HTTP layer
// independent.

import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import { jsonResponse, createdResponse, noContentResponse } from '../utils/response';
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from '../utils/errors';
import type { User } from '../types/api';
import { userRolesService } from '../services/user-roles';
import {
  channelsRegistryService,
  type Channel,
  type ChannelKind,
} from '../services/channels-registry';
import { CreateBodySchema, UpdateBodySchema } from './channels-shared';


// ---------- Validation -----------------------------------------------------
//
// `ChannelKindEnum` + `ChannelCreateSchema` live in `./channels-shared` so the
// n8n internal-create route (routes/assets/internal-create.ts) and this human
// route stay in lockstep on the channel create shape.

// The create / update body schemas live in `./channels-shared` (shared with the
// capability declarations, fr-agui P4b, so the declared input IS the route's).

// ---------- Wire serializer ------------------------------------------------

interface WireChannel {
  id: string;
  kind: ChannelKind;
  name: string;
  tenant_id: string;
  dept_id?: string;
  config?: Record<string, unknown>;
  created_at: string;
  archived_at: string | null;
}

function serializeChannel(c: Channel): WireChannel {
  const wire: WireChannel = {
    id: c.id,
    kind: c.kind,
    name: c.name,
    tenant_id: c.workspace_id,
    config: c.config,
    created_at: c.created_at.toISOString(),
    archived_at: c.archived_at ? c.archived_at.toISOString() : null,
  };
  if (c.dept_id !== null) wire.dept_id = c.dept_id;
  return wire;
}

// ---------- RBAC bridge ----------------------------------------------------

async function isWorkspaceAdmin(user: User): Promise<boolean> {
  // Delegates to the shared test. This used to check ONLY hasRole(..., 'admin'),
  // which matches no real grant — `user_roles.role` holds 'workspace-admin' for
  // every actual workspace admin, so a person granted admin IN-APP was refused
  // and only a Keycloak `admin` claim got through.
  return userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
}

function assertSameWorkspace(user: User, channel: Channel): void {
  if (channel.workspace_id !== ctxTenantId(user.tenantId)) {
    // 404 — leak nothing about the existence of out-of-tenant rows.
    throw new NotFoundError('Channel not found');
  }
}

async function assertWorkspaceAdmin(user: User): Promise<void> {
  const ok = await isWorkspaceAdmin(user);
  if (!ok) {
    throw new UnauthorizedError('workspace-admin role required');
  }
}

// ---------- Handlers -------------------------------------------------------

/** GET /api/channels */
export async function handleListChannels(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const list = await channelsRegistryService.listChannels(ctxTenantId(user.tenantId));
  return jsonResponse(list.map(serializeChannel));
}

/** GET /api/channels/:id */
export async function handleGetChannel(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  const ch = await channelsRegistryService.getChannel(id);
  if (!ch) throw new NotFoundError('Channel not found');
  assertSameWorkspace(user, ch);
  return jsonResponse(serializeChannel(ch));
}

/** POST /api/channels */
export async function handleCreateChannel(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);

  const body = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const parsed = CreateBodySchema.parse(body);

  // Guard against cross-tenant create attempts. FE sends `tenant_id`
  // implicitly via the auth header; if it's present in the body it must
  // match the caller's resolved tenant.
  if (parsed.tenant_id && parsed.tenant_id !== ctxTenantId(user.tenantId)) {
    throw new BadRequestError(
      'tenant_id in body does not match the authenticated tenant',
    );
  }

  const ch = await channelsRegistryService.createChannel({
    workspace_id: ctxTenantId(user.tenantId),
    dept_id: parsed.dept_id ?? null,
    kind: parsed.kind,
    name: parsed.name,
    config: parsed.config,
    credentials: parsed.credentials ?? null,
  });
  return createdResponse(serializeChannel(ch));
}

/** PATCH /api/channels/:id */
export async function handleUpdateChannel(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);

  const existing = await channelsRegistryService.getChannel(id);
  if (!existing) throw new NotFoundError('Channel not found');
  assertSameWorkspace(user, existing);

  const body = await req.json().catch(() => {
    throw new BadRequestError('invalid JSON body');
  });
  const parsed = UpdateBodySchema.parse(body);

  const updated = await channelsRegistryService.updateChannel(
    id,
    parsed,
    undefined,
    ctxTenantId(user.tenantId),
  );
  if (!updated) throw new NotFoundError('Channel not found');
  return jsonResponse(serializeChannel(updated));
}

/** DELETE /api/channels/:id */
export async function handleDeleteChannel(
  req: Request,
  id: string,
): Promise<Response> {
  const user = await validateAuth(req);
  await assertWorkspaceAdmin(user);

  const existing = await channelsRegistryService.getChannel(id);
  if (!existing) throw new NotFoundError('Channel not found');
  assertSameWorkspace(user, existing);

  const ok = await channelsRegistryService.deleteChannel(
    id,
    undefined,
    ctxTenantId(user.tenantId),
  );
  if (!ok) throw new NotFoundError('Channel not found');
  return noContentResponse();
}
