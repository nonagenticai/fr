// src/lib/api/channels.ts
//
// Typed wrappers for the **channel registry** (Plan-2 admin surface):
// workspace-/department-scoped channel definitions that messages are sent
// THROUGH. This is distinct from `channel-prefs.ts`, which models per-user
// routing rules (which channels a given user prefers/owns).
//
// Endpoint base: `/api/channels` per the Plan-2 spec. The fr backend
// currently only ships the `/api/me/channels` (prefs) surface; the registry
// CRUD is being delivered in parallel by the backend agent on a separate
// worktree. Live calls will 404 until those routes land. Tests mock
// `authFetch` directly so the wrapper contract is verified without a live
// backend.
//
// Plan reference: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md
// (Task 12).

import { authFetch } from './auth-fetch';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ChannelKind =
  | 'teams'
  | 'telegram'
  | 'email'
  | 'web'
  | 'inapp'
  | 'voice';

export type Channel = {
  id: string;
  kind: ChannelKind;
  name: string;
  tenant_id: string;
  dept_id?: string;
  /**
   * Server-derived: true when the channel can be used as a dispatch
   * target. Currently matches every kind, but
   * future intake-only kinds (e.g. inbound webhooks) will set false.
   */
  is_dispatch_capable?: boolean;
};

export type ChannelCreateInput = {
  kind: ChannelKind;
  name: string;
  /** Optional — omit to create a workspace-scoped channel. */
  dept_id?: string;
};

export type ChannelUpdatePatch = Partial<{
  name: string;
  kind: ChannelKind;
  dept_id: string | null;
}>;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const JSON_HEADERS = { 'Content-Type': 'application/json' } as const;

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

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/** GET /api/channels — list channels visible to the caller. */
export async function listChannels(): Promise<Channel[]> {
  const resp = await authFetch('/api/channels');
  await ensureOk(resp, 'channels.list');
  const json = (await resp.json()) as Channel[] | { data: Channel[] };
  // Tolerate both bare-array and `{ data }` envelope shapes; the backend
  // routes on this hostname use both conventions in different surfaces.
  if (Array.isArray(json)) return json;
  return Array.isArray(json?.data) ? json.data : [];
}

/** POST /api/channels — create a new channel. */
export async function createChannel(
  input: ChannelCreateInput,
): Promise<Channel> {
  const resp = await authFetch('/api/channels', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await ensureOk(resp, 'channels.create');
  const json = (await resp.json()) as Channel | { data: Channel };
  return 'data' in json ? json.data : json;
}

/** PATCH /api/channels/:id — partial update. */
export async function updateChannel(
  id: string,
  patch: ChannelUpdatePatch,
): Promise<Channel> {
  const resp = await authFetch(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  await ensureOk(resp, 'channels.update');
  const json = (await resp.json()) as Channel | { data: Channel };
  return 'data' in json ? json.data : json;
}

/** DELETE /api/channels/:id — tolerate 204 or `{ ok: true }`. */
export async function deleteChannel(id: string): Promise<void> {
  const resp = await authFetch(`/api/channels/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
  await ensureOk(resp, 'channels.delete');
}
