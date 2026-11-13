// src/routes/me/channels.ts
//
// User-scoped channel-preference CRUD. Auth'd caller's `user.id` is the
// user_id for every row read or written — there is no admin surface here.
import { isReservedAgentAddress } from '../../domain/engagement/agent-members';
import { PrefSchema, ReplaceBodySchema } from './channels-schemas';
import { validateAuth } from '../../middleware/auth';
import { jsonResponse, noContentResponse, createdResponse } from '../../utils/response';
import { AppError, NotFoundError } from '../../utils/errors';
import { isChannelWorkspaceMember, listChannelWorkspaces, listUserTenants } from '../../capabilities/principal';
import { isUuidShape } from '../../lib/uuid-shape';
import {
  addPref,
  deletePref,
  getPrefsForUser,
  replacePrefs,
} from '../../domain/engagement/channel-prefs';
import { CHANNEL_COMMANDS, CHANNEL_GUIDES } from '../../domain/engagement/channel-commands';

// The body schemas live in ./channels-schemas (side-effect free), shared with the
// capability declaration (fr-agui P4b part 3, capabilities/account/me.ts).
//
// Claude sessions / MCP clients (George 2026-10-15, P1-TEAM) reach fr as the `mcp`
// channel (channels/mcp.ts, adapters/mcp.ts): one `ChannelEnum` value, a push channel.

/**
 * GET /api/me/channel-commands — what each channel can do, and the caller's
 * workspaces a link can be pinned to (Communication settings).
 */
export async function handleListChannelCommands(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  // Memberships plus the Keycloak home; a directory outage shows the memberships only.
  const workspaces = await listChannelWorkspaces(user.id).catch(() => listUserTenants(user.id));
  return jsonResponse({ data: { channels: CHANNEL_GUIDES, commands: CHANNEL_COMMANDS, workspaces } });
}

/**
 * A link may only be pinned to a workspace the caller belongs to. A pin a row
 * already holds is not re-checked, so a lost membership does not block every
 * later toggle (the dispatcher refuses that stale pin anyway).
 */
/** fr #1683: `agent:` addresses belong to admin-created agent members; nobody self-links one. */
function assertNoAgentAddress(prefs: Array<{ address: string }>): void {
  if (prefs.some((p) => isReservedAgentAddress(p.address))) {
    throw new AppError(422, "addresses starting with 'agent:' are reserved for agent members").withCode('channel_address_reserved');
  }
}

async function assertLinkTenants(
  userId: string,
  prefs: Array<{ id?: string; tenant_id?: string | null }>,
  existing: Array<{ id: string; tenant_id: string | null }> = [],
): Promise<void> {
  for (const p of prefs) {
    const unchanged = p.id !== undefined && existing.some((e) => e.id === p.id && e.tenant_id === (p.tenant_id ?? null));
    if (p.tenant_id && !unchanged && !(await isChannelWorkspaceMember(userId, p.tenant_id))) {
      throw new AppError(422, 'tenant_id is not one of your workspaces').withCode('channel_tenant_not_a_membership');
    }
  }
}

/** GET /api/me/channels */
export async function handleListMyChannels(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const prefs = await getPrefsForUser(user.id);
  return jsonResponse({ data: prefs });
}

/** PUT /api/me/channels — replace-all upsert */
export async function handleReplaceMyChannels(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await req.json();
  const parsed = ReplaceBodySchema.parse(body);
  assertNoAgentAddress(parsed.prefs);
  await assertLinkTenants(user.id, parsed.prefs, await getPrefsForUser(user.id));
  const prefs = await replacePrefs(user.id, parsed.prefs);
  return jsonResponse({ data: prefs });
}

/** POST /api/me/channels — add a single pref */
export async function handleAddMyChannel(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const body = await req.json();
  const parsed = PrefSchema.parse(body);
  assertNoAgentAddress([parsed]);
  await assertLinkTenants(user.id, [parsed]);
  const pref = await addPref(user.id, parsed);
  return createdResponse({ data: pref });
}

/** DELETE /api/me/channels/:id */
export async function handleDeleteMyChannel(req: Request, id: string): Promise<Response> {
  const user = await validateAuth(req);
  // `user_channel_prefs.id` is a `uuid` column (schema.ts:655), so a `:id`
  // segment that is not UUID-shaped aborts `deletePref`'s DELETE with 22P02
  // `invalid input syntax for type uuid` instead of deleting zero rows — a bare
  // 500 where the contract is a 404. Guarded at the ROUTE boundary rather than
  // inside deletePref so the domain helper's signature and its other callers
  // are untouched; `ok === false` and "malformed" now produce the identical
  // 404, so a malformed id is indistinguishable from another user's pref.
  // (`replacePrefs` needs no guard: it only reuses an incoming `id` when that id
  // is already in the set READ from the DB, so a malformed one falls to INSERT.)
  // `isUuidShape`, not `isValidUuid` (utils/tenant), which pins the
  // version/variant nibbles and would 404 legal `uuid` literals.
  if (!isUuidShape(id)) throw new NotFoundError('Channel preference not found');
  const ok = await deletePref(user.id, id);
  if (!ok) throw new NotFoundError('Channel preference not found');
  return noContentResponse();
}
