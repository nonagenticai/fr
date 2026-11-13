// src/lib/api/notifications.ts
//
// WS1 Phase 1B — client for the project-execution notification inbox + the
// per-user (event_type x channel) preference matrix. Mirrors the backend
// routes/me/notifications.ts + routes/me/notification-prefs.ts envelopes and
// the domain/engagement/event-types.ts taxonomy.
import { authFetch } from './auth-fetch';
import {
  bool,
  dataEnvelope,
  dataListEnvelope,
  decodeResponse,
  num,
  object,
  record,
  str,
} from './response-shape';

export type NotificationSeverity = 'info' | 'success' | 'warning' | 'error';

export interface NotificationRow {
  id: string;
  tenant_id: string;
  user_id: string;
  event_type: string;
  severity: NotificationSeverity;
  title: string;
  body: string | null;
  link: string | null;
  project_id: string | null;
  card_id: string | null;
  execution_id: string | null;
  source: string;
  correlation_id: string | null;
  metadata: Record<string, unknown> | null;
  read_at: string | null;
  created_at: string;
}

export interface PrefMatrixCell {
  event_type: string;
  channel: string;
  enabled: boolean;
  is_default: boolean;
}

export interface PrefRowInput {
  event_type: string;
  channel: string;
  enabled: boolean;
}

// Mirror of backend EVENT_TYPE_DEFS labels (event-types.ts). Kept here so the
// matrix UI renders human rows without an extra round-trip; the backend remains
// the source of truth for validation + defaults.
export const EVENT_TYPE_LABELS: Record<string, string> = {
  'card.done': 'Card completed',
  'card.blocked': 'Card blocked',
  'card.failed': 'Card failed',
  'pr.opened': 'PR opened',
  'pr.merged': 'PR merged',
  'outcome.regression': 'Regression detected',
  'outcome.improvement': 'Improvement detected',
  'budget.threshold': 'Budget alert',
  'report.ready': 'Report ready',
  'project.start_failed': 'Conveyor start failed',
  'project.coach_failed': 'Kanban coach could not act',
};

// Signal is REMOVED as a channel (owner 2026-10-31) — gone from the backend
// and from this matrix alike; legacy signal cells from the API are not rendered.
// telegram IS surfaced: the backend accepts it on /api/me/channels +
// /api/me/notification-prefs, and it's the live comms hub for push alerts
// (e.g. budget.threshold). mcp = an MCP client (e.g. care-bus) linked on
// Communication settings. The order mirrors the backend list exactly.
export const NOTIFICATION_CHANNELS = ['email', 'telegram', 'teams', 'websocket', 'mcp'] as const;
export type NotificationChannel = (typeof NOTIFICATION_CHANNELS)[number];

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

/**
 * Declared shape of `GET /api/me/notifications`: `{data: NotificationRow[]}`.
 *
 * The backend (`routes/me/notifications.ts`) ends `jsonResponse({ data: rows })`
 * — no `total`, unlike its `{items, total}` siblings elsewhere in the same API.
 * Declaring it means the day that handler is re-enveloped, this page SAYS SO
 * instead of reporting an empty inbox to every user in the estate.
 *
 * Guarded per row on `id` alone. That is the minimum that proves these are rows
 * of some kind rather than whatever a wrong envelope handed us, and the maximum
 * that is safe: every additional guarded field is a column the backend can
 * never make nullable without reddening this page, and the envelope check
 * above is already where the silent-empty defect actually lives.
 */
export const NOTIFICATION_LIST_SHAPE = dataListEnvelope(record<NotificationRow>({ id: str }));

/** GET /api/me/notifications?status=unread|all&limit=N */
export async function listNotifications(
  opts: { status?: 'unread' | 'all'; limit?: number } = {},
): Promise<NotificationRow[]> {
  const sp = new URLSearchParams();
  if (opts.status) sp.set('status', opts.status);
  if (opts.limit) sp.set('limit', String(opts.limit));
  const qs = sp.toString();
  const path = '/api/me/notifications';
  const resp = await authFetch(`${path}${qs ? `?${qs}` : ''}`);
  await ensureOk(resp, 'notifications.list');
  // Was: `Array.isArray(json?.data) ? json.data : []`. That `: []` answered a
  // question it could not answer — a `{items: […]}` body became "no
  // notifications", indistinguishable from a genuinely empty inbox. An empty
  // inbox still resolves to `[]` here; an unreadable body now throws.
  const page = await decodeResponse(resp, NOTIFICATION_LIST_SHAPE, {
    endpoint: path,
    method: 'GET',
  });
  return page.items;
}

/**
 * Declared shape of `GET /api/me/notifications/unread-count`: `{data:{count}}`.
 *
 * ⛔ THE DEFECT THIS REPLACES: `return json?.data?.count ?? 0`. That `?? 0` is
 * the sibling of the `: []` deleted from `listNotifications` above, and it is
 * worse in one respect — `0` on this endpoint is not a blank, it is the value
 * that means "your inbox is clear". So a re-enveloped handler, an HTML error
 * page from an ingress, or a `{count}` that lost its `data` wrapper all read as
 * a MEASURED zero: badge hidden, no error, no log, nothing to test. An empty
 * inbox still resolves to `0` here; an unreadable body now throws.
 *
 * `count` is the only field, and it is entirely load-bearing, so it is declared
 * rather than guarded (`object`, not `record`).
 */
export const UNREAD_COUNT_SHAPE = dataEnvelope(object({ count: num }));

/** GET /api/me/notifications/unread-count */
export async function getUnreadCount(): Promise<number> {
  const path = '/api/me/notifications/unread-count';
  const resp = await authFetch(path);
  await ensureOk(resp, 'notifications.unread-count');
  const { count } = await decodeResponse(resp, UNREAD_COUNT_SHAPE, {
    endpoint: path,
    method: 'GET',
  });
  return count;
}

/** POST /api/me/notifications/:id/read */
export async function markRead(id: string): Promise<void> {
  const resp = await authFetch(`/api/me/notifications/${encodeURIComponent(id)}/read`, {
    method: 'POST',
  });
  await ensureOk(resp, 'notifications.mark-read');
}

/** POST /api/me/notifications/read-all */
export async function markAllRead(): Promise<number> {
  const resp = await authFetch('/api/me/notifications/read-all', { method: 'POST' });
  await ensureOk(resp, 'notifications.read-all');
  const json = (await resp.json()) as DataEnvelope<{ marked: number }>;
  return json?.data?.marked ?? 0;
}

/**
 * Declared shape of the `(event_type x channel)` preference matrix:
 * `{data: PrefMatrixCell[]}`.
 *
 * ⛔ THE DEFECT THIS REPLACES: `Array.isArray(json?.data) ? json.data : []`.
 * The settings page renders an empty matrix as "no preferences", and every
 * `cellEnabled` lookup falls back to `false` — so an unreadable body did not
 * merely show nothing, it showed every channel for every event as switched
 * OFF. A user reading that concludes their alerting is disabled; a user who
 * then presses Save makes it true, because `replaceNotificationPrefs` is a
 * replace-all upsert. An empty matrix still resolves to `[]`; an unreadable
 * body now throws, and `loadMatrix`'s existing `catch` already draws it.
 *
 * Guarded (not declared) per row, per `record`'s contract: these three fields
 * are what make a cell a cell — the two that IDENTIFY it and the one that
 * carries its value, all three read by `cellEnabled`. `is_default` is left
 * unguarded so the backend can keep evolving it.
 */
export const PREF_MATRIX_SHAPE = dataListEnvelope(
  record<PrefMatrixCell>({ event_type: str, channel: str, enabled: bool }),
);

/** GET /api/me/notification-prefs — full (event_type x channel) matrix. */
export async function getNotificationPrefs(): Promise<PrefMatrixCell[]> {
  const path = '/api/me/notification-prefs';
  const resp = await authFetch(path);
  await ensureOk(resp, 'notification-prefs.list');
  const page = await decodeResponse(resp, PREF_MATRIX_SHAPE, {
    endpoint: path,
    method: 'GET',
  });
  return page.items;
}

/** PUT /api/me/notification-prefs — replace-all upsert; returns the new matrix. */
export async function replaceNotificationPrefs(
  prefs: PrefRowInput[],
): Promise<PrefMatrixCell[]> {
  const resp = await authFetch('/api/me/notification-prefs', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prefs }),
  });
  await ensureOk(resp, 'notification-prefs.update');
  const json = (await resp.json()) as DataEnvelope<PrefMatrixCell[]>;
  return Array.isArray(json?.data) ? json.data : [];
}
