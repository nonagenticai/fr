// src/services/channels-registry.ts
//
// Foundation Plan 2 follow-up — channels registry CRUD.
//
// Closes the FE admin /channels page's "backend-unavailable" banner.
// Channel-rows backfill landed in migration 049. Channels are
// the workspace-/department-scoped definitions that messages are sent
// THROUGH; per-user routing rules live in `user_channel_prefs` and the
// notification_preferences surface, not here.
//
// Scope invariant (Spec 1 §6.5):
//   * `workspace_id` is required (the `channels.workspace_id` column is
//     NOT NULL with an FK ON DELETE CASCADE).
//   * `dept_id` is optional. NULL means workspace-scoped; non-NULL means
//     department-scoped. Channels can NEVER be project-scoped — the
//     parallel `asset_assignments` edge enforces the same via a CHECK
//     constraint added in migration 028.
//
// Credentials handling:
//   * `credentials_enc` is a **write-only** field on the registry row.
//   * The Channel type returned from every read (list / get) drops the
//     credentials field entirely. Callers that need the secret material
//     call `loadChannelCredentials(id, db?)` which decrypts via the
//     AES-GCM envelope helper in `services/encryption.ts`.
//   * Phase 4 (2026-05-01): write paths encrypt via `encryptToEnvelope`;
//     read paths that opt in decrypt via `decryptFromEnvelope`. Legacy
//     plaintext rows still decrypt (passthrough + WARN) until the
//     `scripts/encrypt-channel-credentials.ts` backfill is run.
//
// RBAC is enforced at the route layer (`routes/channels.ts`), not here —
// service callers are trusted to have already gated on workspace membership
// (read) or workspace-admin (write).

import { and, eq, isNull, asc } from 'drizzle-orm';
import { db as defaultDb, channels } from '../db/client';
import { encryption } from './encryption';
import { isUuidShape } from '../lib/uuid-shape';

export type ChannelKind =
  | 'teams'
  | 'email'
  | 'web'
  | 'inapp'
  | 'voice';

/**
 * Channels that can DISPATCH outbound messages (vs. intake-only / read-only
 * registry rows). Today every kind is dispatch-capable; this set exists so
 * future intake-only kinds (e.g. `'rss'`, `'webhook-inbound'`) can be added
 * without auto-appearing in dispatch pickers — add the kind to ChannelKind
 * but leave it OUT of this set.
 */
export const DISPATCH_CAPABLE_KINDS: ReadonlySet<ChannelKind> = new Set([
  'teams',
  'email',
  'web',
  'inapp',
  'voice',
]);

export function isDispatchCapable(kind: ChannelKind): boolean {
  return DISPATCH_CAPABLE_KINDS.has(kind);
}

/**
 * Read-shape of a channel row. Matches the FE `Channel` type from
 * `frontend/src/lib/api/channels.ts` plus a couple of fields the FE
 * `Channel` declaration doesn't model yet (`config`, timestamps). FE
 * `tenant_id` is the same value as `workspace_id` here — the route
 * serializer aliases the column on the wire to satisfy the FE contract
 * without a follow-up FE change.
 */
/**
 * bound_assets provenance (migration 069). `origin_kind` is `'tenant'` for
 * human/admin-authored channels and `'workflow'` for n8n-authored ones
 * (POST /api/internal/assets/channel). Channels are never project-scoped,
 * so `'project'` is not a valid origin_kind. `origin_project_id` on a
 * workflow-authored channel is provenance (the authoring project), not
 * dispatch scope.
 */
export type ChannelOriginKind = 'tenant' | 'workflow';

export interface ChannelOrigin {
  origin_kind: ChannelOriginKind;
  origin_project_id?: string | null;
  origin_workflow_run_id?: string | null;
  created_by_user_id?: string | null;
}

export interface Channel {
  id: string;
  workspace_id: string;
  dept_id: string | null;
  kind: ChannelKind;
  name: string;
  config: Record<string, unknown>;
  origin_kind: ChannelOriginKind;
  origin_project_id: string | null;
  origin_workflow_run_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  archived_at: Date | null;
  /**
   * Derived from `kind` (server-computed; not a column). True when the
   * channel can be a dispatch target — see DISPATCH_CAPABLE_KINDS.
   */
  is_dispatch_capable: boolean;
}

export interface ChannelCreateInput {
  workspace_id: string;
  dept_id?: string | null;
  kind: ChannelKind;
  name: string;
  config?: Record<string, unknown>;
  /** Write-only secret material; never returned on read. */
  credentials?: string | null;
  /** Provenance; defaults to origin_kind='tenant' when omitted. */
  origin?: ChannelOrigin;
}

export interface ChannelUpdatePatch {
  name?: string;
  kind?: ChannelKind;
  /** Pass `null` to detach from a department (workspace-scope it again). */
  dept_id?: string | null;
  config?: Record<string, unknown>;
  /** Pass `null` to clear stored credentials. */
  credentials?: string | null;
}

export type ChannelsDb = typeof defaultDb;

// Drizzle row → public Channel shape. Strips `credentials_enc`. Always.
function rowToChannel(r: typeof channels.$inferSelect): Channel {
  return {
    id: r.id,
    workspace_id: r.workspace_id,
    dept_id: r.dept_id,
    kind: r.kind,
    name: r.name,
    config: (r.config ?? {}) as Record<string, unknown>,
    origin_kind: r.origin_kind as ChannelOriginKind,
    origin_project_id: r.origin_project_id,
    origin_workflow_run_id: r.origin_workflow_run_id,
    created_by_user_id: r.created_by_user_id,
    created_at: r.created_at,
    archived_at: r.archived_at,
    is_dispatch_capable: isDispatchCapable(r.kind),
  };
}

/**
 * List non-archived channels for a workspace, ordered by name. Caller is
 * responsible for verifying workspace membership.
 */
export async function listChannels(
  workspaceId: string,
  opts: { origin?: ChannelOriginKind } = {},
  db: ChannelsDb = defaultDb,
): Promise<Channel[]> {
  if (!workspaceId) return [];
  const conditions = [
    eq(channels.workspace_id, workspaceId),
    isNull(channels.archived_at),
  ];
  if (opts.origin) {
    conditions.push(eq(channels.origin_kind, opts.origin));
  }
  const rows = await db
    .select()
    .from(channels)
    .where(and(...conditions))
    .orderBy(asc(channels.name));
  return rows.map(rowToChannel);
}

/** Single-row read by id. Returns `null` when absent. */
export async function getChannel(
  id: string,
  db: ChannelsDb = defaultDb,
): Promise<Channel | null> {
  // `channels.id` is a `uuid` column (schema.ts:1259) and the `:id` path param
  // on the three routes that funnel through here (GET/PATCH/DELETE
  // /api/channels/:id) is not shape-validated, so a malformed id reached
  // Postgres and raised 22P02 `invalid input syntax for type uuid`. `null` is
  // the SAME miss value the empty-id and absent-row paths already return, so
  // each route keeps throwing its existing `NotFoundError('Channel not found')`
  // — the same body an out-of-tenant id gets from `assertSameWorkspace`. A
  // distinct status for "malformed" would hand a prober a free oracle against
  // that don't-leak-existence contract (routes/approvals.ts:408).
  //
  // `isUuidShape`, not `isValidUuid` (utils/tenant): the latter pins the version
  // and variant nibbles and would 404 a channel Postgres can read.
  if (!id || !isUuidShape(id)) return null;
  const rows = await db
    .select()
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);
  const row = rows[0];
  return row ? rowToChannel(row) : null;
}

/**
 * Create a channel row. Returns the credential-stripped Channel.
 *
 * Throws on uniqueness collision (workspace_id, name) — the route layer
 * maps that to a 409.
 */
export async function createChannel(
  input: ChannelCreateInput,
  db: ChannelsDb = defaultDb,
): Promise<Channel> {
  if (!input.workspace_id) {
    throw new Error('createChannel: workspace_id is required');
  }
  if (!input.name) {
    throw new Error('createChannel: name is required');
  }
  // Phase 4: encrypt credentials at rest via AES-GCM envelope. Storage
  // shape is base64-of-JSON `{v:1, iv, ct}`; decrypt via
  // `loadChannelCredentials` on demand.
  const credEncrypted =
    input.credentials != null
      ? await encryption.encryptToEnvelope(input.credentials)
      : null;
  const [row] = await db
    .insert(channels)
    .values({
      workspace_id: input.workspace_id,
      dept_id: input.dept_id ?? null,
      kind: input.kind,
      name: input.name,
      config: input.config ?? {},
      credentials_enc: credEncrypted,
      origin_kind: input.origin?.origin_kind ?? 'tenant',
      origin_project_id: input.origin?.origin_project_id ?? null,
      origin_workflow_run_id: input.origin?.origin_workflow_run_id ?? null,
      created_by_user_id: input.origin?.created_by_user_id ?? null,
    })
    .returning();
  if (!row) {
    throw new Error('createChannel: insert returned no row');
  }
  return rowToChannel(row);
}

/**
 * Partial update by id. Only fields present in `patch` are written. Returns
 * the updated Channel (credentials always stripped) or `null` when the row
 * doesn't exist.
 */
export async function updateChannel(
  id: string,
  patch: ChannelUpdatePatch,
  db: ChannelsDb = defaultDb,
  scopeWorkspaceId?: string,
): Promise<Channel | null> {
  if (!id) return null;
  const updates: Partial<typeof channels.$inferInsert> = {};
  if (patch.name !== undefined) updates.name = patch.name;
  if (patch.kind !== undefined) updates.kind = patch.kind;
  if (patch.dept_id !== undefined) updates.dept_id = patch.dept_id;
  if (patch.config !== undefined) updates.config = patch.config;
  if (patch.credentials !== undefined) {
    // Phase 4: same envelope-encrypt as createChannel. `null` clears.
    updates.credentials_enc =
      patch.credentials === null
        ? null
        : await encryption.encryptToEnvelope(patch.credentials);
  }
  if (Object.keys(updates).length === 0) {
    // No-op patch — return current row so callers can blindly call
    // updateChannel(id, {}) without surprising 404s.
    return getChannel(id, db);
  }
  // Defense-in-depth: when the route supplies the caller's workspace, scope the
  // mutation to it so a cross-tenant id can never be written even if the route's
  // assertSameWorkspace gate is later dropped/reordered (mirrors #402).
  const [row] = await db
    .update(channels)
    .set(updates)
    .where(
      scopeWorkspaceId
        ? and(eq(channels.id, id), eq(channels.workspace_id, scopeWorkspaceId))
        : eq(channels.id, id),
    )
    .returning();
  return row ? rowToChannel(row) : null;
}

/**
 * Hard-delete by id. Returns `true` when a row was removed, `false` when
 * the id was unknown. Soft-delete via `archived_at` is intentionally not
 * exposed on the public CRUD — admin-driven archival is a future Wave.
 */
export async function deleteChannel(
  id: string,
  db: ChannelsDb = defaultDb,
  scopeWorkspaceId?: string,
): Promise<boolean> {
  if (!id) return false;
  // Defense-in-depth: same workspace scoping as updateChannel (mirrors #402).
  const rows = await db
    .delete(channels)
    .where(
      scopeWorkspaceId
        ? and(eq(channels.id, id), eq(channels.workspace_id, scopeWorkspaceId))
        : eq(channels.id, id),
    )
    .returning({ id: channels.id });
  return rows.length > 0;
}

/**
 * Phase 4 — load + decrypt the raw credential string for a single channel.
 *
 * Default channel reads (`getChannel` / `listChannels`) intentionally
 * strip credentials entirely. This helper is the explicit opt-in path
 * for the few callers that legitimately need the plaintext: the
 * scheduled-trigger tick worker, the `POST /api/connectors/test-connection`
 * route, and the n8n outbound dispatch path.
 *
 * Returns `null` for unknown ids and for rows where `credentials_enc`
 * is NULL. Legacy plaintext rows pass through `decryptFromEnvelope`'s
 * one-shot WARN path until the backfill runs.
 */
export async function loadChannelCredentials(
  id: string,
  db: ChannelsDb = defaultDb,
): Promise<string | null> {
  if (!id) return null;
  const rows = await db
    .select({ credentials_enc: channels.credentials_enc })
    .from(channels)
    .where(eq(channels.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return encryption.decryptFromEnvelope(row.credentials_enc);
}

export const channelsRegistryService = {
  listChannels,
  getChannel,
  createChannel,
  updateChannel,
  deleteChannel,
  loadChannelCredentials,
};
