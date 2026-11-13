// src/lib/api/channel-prefs.ts
//
// Per-user **notification preferences** for the `/api/me/channels` surface
// (Wave 4 / Wave 5 of the woolly-harp plan), plus the read-only
// `/api/me/channel-commands` guide. Both are consumed by the
// Communication settings page (`/settings/communication`).
//
// ─────────────────────────────────────────────────────────────────────────────
// Plan-2 split note (foundation Plan 2 — Task 12, 2026-04-27):
//
//   This module is named `channel-prefs.ts` for filename stability, but
//   semantically it covers **user notification preferences** — the
//   per-user routing rules describing how a given user wants to be reached
//   (their phone, their email, which to default to, etc.).
//
//   The **channel registry** (workspace-/department-scoped channel
//   definitions that messages flow THROUGH) lives in a separate module:
//   `frontend/src/lib/api/channels.ts`.
//
//   To avoid breaking existing callers
//   while we migrate, the old export names (`listChannels`, `addChannel`,
//   `updateChannel`, `updateChannels`, `deleteChannel`) are kept as
//   back-compat aliases that point at the new, semantically-correct
//   symbols (`listMyChannelPrefs`, `addPref`, `updatePref`, `replacePrefs`,
//   `deletePref`). New code should prefer the *Pref-suffixed names.
// ─────────────────────────────────────────────────────────────────────────────
//
// Body shapes mirror `backend/src/routes/me/channels.ts` zod schemas exactly:
//   - ChannelEnum: 'teams' | 'websocket' | 'email' | 'telegram' | 'mcp'
//   - PrefSchema: { id?, channel, address, tenant_id?, enabled?, is_default? }
//   - GET    /api/me/channels         → { data: UserChannelPref[] }
//   - POST   /api/me/channels         → { data: UserChannelPref }    (201)
//   - PUT    /api/me/channels         → { data: UserChannelPref[] }  (replace-all)
//   - DELETE /api/me/channels/:id     → 204 no content
//   - GET    /api/me/channel-commands → { data: ChannelCommandsGuide } (incl. the
//     caller's workspaces a link can be pinned to)
//     (source: backend/src/domain/engagement/channel-commands.ts)
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 5 Task 5.1 Step 1.

import { authFetch } from './auth-fetch';

export type ChannelKind = 'teams' | 'websocket' | 'email' | 'telegram' | 'mcp';

export interface UserChannelPref {
  id: string;
  user_id: string;
  channel: ChannelKind;
  address: string;
  /** The workspace this link acts in; null = unpinned (fr derives it from membership). */
  tenant_id: string | null;
  enabled: boolean;
  is_default: boolean;
  created_at: string;
  updated_at: string;
}

export interface AddPrefInput {
  channel: ChannelKind;
  address: string;
  tenant_id?: string | null;
  enabled?: boolean;
  is_default?: boolean;
}

/** Replace-all PUT body row shape (id optional; rows without id are inserted). */
export interface ReplacePrefInput {
  id?: string;
  channel: ChannelKind;
  address: string;
  tenant_id?: string | null;
  enabled?: boolean;
  is_default?: boolean;
}

interface DataEnvelope<T> {
  data: T;
}

async function ensureOk(resp: Response, label: string): Promise<void> {
  if (!resp.ok) {
    let detail = '';
    try {
      detail = (await resp.text()).slice(0, 300);
    } catch {
      /* ignore */
    }
    throw new Error(
      `${label} failed: ${resp.status} ${resp.statusText}${detail ? ` — ${detail}` : ''}`,
    );
  }
}

/** GET /api/me/channels — list the caller's channel preferences. */
export async function listMyChannelPrefs(): Promise<UserChannelPref[]> {
  const resp = await authFetch('/api/me/channels');
  await ensureOk(resp, 'channel-prefs.list');
  const json = (await resp.json()) as DataEnvelope<UserChannelPref[]>;
  return Array.isArray(json?.data) ? json.data : [];
}

/** One channel fr can be operated from (mirrors backend `ChannelGuide`). */
export interface ChannelGuide {
  channel: string;
  label: string;
  /** Messages from this channel are run as commands (not only notifications out). */
  commands: boolean;
  /** How the user finds the address to link on Communication settings. */
  link: string;
}

/** A workspace the caller belongs to, which a link can be pinned to. */
export interface ChannelWorkspace {
  id: string;
  name: string | null;
}

/** One command a channel accepts (mirrors backend `ChannelCommand`). */
export interface ChannelCommand {
  usage: string;
  description: string;
  capability: string;
  /** The write parks for an explicit `approve <id>` before it runs. */
  confirms: boolean;
}

export interface ChannelCommandsGuide {
  channels: ChannelGuide[];
  commands: ChannelCommand[];
  workspaces: ChannelWorkspace[];
}

/** GET /api/me/channel-commands — which channels accept commands, and which commands. */
export async function getChannelCommands(): Promise<ChannelCommandsGuide> {
  const resp = await authFetch('/api/me/channel-commands');
  await ensureOk(resp, 'channel-prefs.commands');
  const json = (await resp.json()) as DataEnvelope<Partial<ChannelCommandsGuide>>;
  return {
    channels: Array.isArray(json?.data?.channels) ? json.data.channels : [],
    commands: Array.isArray(json?.data?.commands) ? json.data.commands : [],
    workspaces: Array.isArray(json?.data?.workspaces) ? json.data.workspaces : [],
  };
}

/** POST /api/me/channels — add a single pref. */
export async function addPref(input: AddPrefInput): Promise<UserChannelPref> {
  const resp = await authFetch('/api/me/channels', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  await ensureOk(resp, 'channel-prefs.add');
  const json = (await resp.json()) as DataEnvelope<UserChannelPref>;
  return json.data;
}

/**
 * PUT /api/me/channels — replace-all upsert.
 *
 * The backend has no per-row PATCH endpoint, so toggling `enabled` or
 * `is_default` on a single row means sending the whole list back with the
 * desired field flipped on the target row. This wrapper preserves that
 * contract: pass the full updated list, get back the new server state.
 */
export async function replacePrefs(
  prefs: ReplacePrefInput[],
): Promise<UserChannelPref[]> {
  const resp = await authFetch('/api/me/channels', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs }),
  });
  await ensureOk(resp, 'channel-prefs.update');
  const json = (await resp.json()) as DataEnvelope<UserChannelPref[]>;
  return Array.isArray(json?.data) ? json.data : [];
}

/**
 * Convenience: update a single pref by id, leaving the others untouched.
 *
 * Reads the current list, finds the row, applies `patch`, and PUTs the
 * whole replacement set. Throws if the id isn't found server-side.
 */
export async function updatePref(
  id: string,
  patch: Partial<Pick<UserChannelPref, 'enabled' | 'is_default' | 'address'>>,
  current?: UserChannelPref[],
): Promise<UserChannelPref[]> {
  const list = current ?? (await listMyChannelPrefs());
  const target = list.find((p) => p.id === id);
  if (!target) {
    throw new Error(`channel-prefs.update_one: id ${id} not found`);
  }
  const next: ReplacePrefInput[] = list.map((p) => ({
    id: p.id,
    channel: p.channel,
    address: p.id === id && patch.address !== undefined ? patch.address : p.address,
    tenant_id: p.tenant_id ?? null,
    enabled: p.id === id && patch.enabled !== undefined ? patch.enabled : p.enabled,
    is_default:
      p.id === id && patch.is_default !== undefined
        ? patch.is_default
        : // when promoting one row to default, demote everyone else
          patch.is_default === true
          ? false
          : p.is_default,
  }));
  return replacePrefs(next);
}

/** DELETE /api/me/channels/:id */
export async function deletePref(id: string): Promise<void> {
  const resp = await authFetch(`/api/me/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await ensureOk(resp, 'channel-prefs.delete');
}

/**
 * Mask an address for display, per channel kind. Pure helper, exported so
 * tests can pin the rules.
 *
 *   email | teams    → email-shaped, first letter + domain (`a••••@example.com`)
 *   websocket | telegram | mcp → opaque id, first 6 + ellipsis (`abc123…`)
 */
export function maskAddress(channel: ChannelKind, address: string): string {
  if (!address) return '';
  if (channel === 'email' || channel === 'teams') {
    const at = address.indexOf('@');
    if (at <= 0) return address.slice(0, 1) + '••••';
    const local = address.slice(0, at);
    const domain = address.slice(at);
    return `${local.slice(0, 1)}••••${domain}`;
  }
  // websocket / opaque
  if (address.length <= 6) return address;
  return `${address.slice(0, 6)}…`;
}

// ---------------------------------------------------------------------------
// Back-compat aliases (Plan-2 split, 2026-04-27)
//
// Older callers imported these original names.
// They remain stable shims pointing at the new semantic names above; new
// code should import the *Pref-suffixed symbols directly.
// ---------------------------------------------------------------------------

/** @deprecated use `listMyChannelPrefs` — name kept for back-compat. */
export const listChannels = listMyChannelPrefs;

/** @deprecated use `addPref` — name kept for back-compat. */
export const addChannel = addPref;

/** @deprecated use `updatePref` — name kept for back-compat. */
export const updateChannel = updatePref;

/** @deprecated use `replacePrefs` — name kept for back-compat. */
export const updateChannels = replacePrefs;

/** @deprecated use `deletePref` — name kept for back-compat. */
export const deleteChannel = deletePref;

/** @deprecated use `AddPrefInput` — name kept for back-compat. */
export type AddChannelInput = AddPrefInput;

/** @deprecated use `ReplacePrefInput` — name kept for back-compat. */
export type ReplaceChannelInput = ReplacePrefInput;
