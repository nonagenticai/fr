// src/lib/api/deliveries.ts
//
// Typed wrappers for the backend's `/api/engagements/deliveries` surface
// (Wave 4 Task 4.1). All calls go through `authFetch` so the bearer token
// is attached.
//
// Plan: docs/superpowers/plans/...woolly-harp Wave 5 Task 5.2 Step 1.
//
// The query type and channel/status enums mirror the zod schema in
// `backend/src/routes/engagements/deliveries.ts` exactly. Keep them in
// sync if the backend schema evolves.

import { authFetch } from './auth-fetch';
import { arrayOf, decodeResponse, num, object, optional, record, str } from './response-shape';
import { shortId } from '$lib/utils/shortId';

// Channels emitted by the fan-out paths (mirrors `ChannelEnum` server-side).
export const DELIVERY_CHANNELS = [
  'teams',
  'websocket',
  'email',
  'inapp',
  'voice',
  'web',
] as const;
export type DeliveryChannel = (typeof DELIVERY_CHANNELS)[number];

// Statuses written by the fan-out paths (mirrors `StatusEnum` server-side).
export const DELIVERY_STATUSES = [
  'queued',
  'sent',
  'delivered',
  'failed',
  'skipped_disabled',
] as const;
export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];

/** Row shape returned by the API — mirrors `engagement_deliveries` columns. */
export interface DeliveryRow {
  id: string;
  engagement_id: string | null;
  engagement_type: string;
  channel: string;
  recipient_user_id: string | null;
  recipient_address: string;
  status: string;
  error: string | null;
  metadata_json: Record<string, unknown> | null;
  action_id: string | null;
  created_at: string; // ISO timestamp
}

/** Query params accepted by `GET /api/engagements/deliveries`. */
export interface ListDeliveriesQuery {
  /** Admin-only filter — silently ignored for non-admins. */
  userId?: string;
  channel?: DeliveryChannel;
  status?: DeliveryStatus;
  /** UUID of an action invocation. */
  actionId?: string;
  /** ISO 8601 with offset, e.g. `2026-04-26T00:00:00Z`. */
  since?: string;
  /** 1..500. Server default is 100. */
  limit?: number;
}

interface ListResponse {
  data: DeliveryRow[];
  meta: { count: number };
}

/**
 * Declared shape of `GET /api/engagements/deliveries`: `{data, meta: {count}}`
 * — a third envelope again, sibling to neither `{items, total}` nor bare
 * `{data}`.
 *
 * `data` is strict because it IS the answer. `meta.count` is optional and falls
 * back to `data.length`: it is a decoration the page does not render, and a
 * decoration must never be able to red-light a list that arrived intact.
 */
const DELIVERY_LIST_SHAPE = object({
  data: arrayOf(record<DeliveryRow>({ id: str, channel: str, status: str })),
  meta: optional(object({ count: optional(num) })),
});

interface GetResponse {
  data: DeliveryRow;
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

export async function listDeliveries(
  query: ListDeliveriesQuery = {},
): Promise<ListResponse> {
  const q = new URLSearchParams();
  if (query.userId) q.set('userId', query.userId);
  if (query.channel) q.set('channel', query.channel);
  if (query.status) q.set('status', query.status);
  if (query.actionId) q.set('actionId', query.actionId);
  if (query.since) q.set('since', query.since);
  if (query.limit !== undefined) q.set('limit', String(query.limit));
  const qs = q.toString();
  const url = `/api/engagements/deliveries${qs ? `?${qs}` : ''}`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'deliveries.list');
  // Was: `Array.isArray(json?.data) ? json.data : []` plus `json?.meta ?? {count: 0}`.
  // Between them those two defaults could turn ANY unreadable body into a
  // fully-formed, entirely fictional "0 deliveries" — the page cannot tell that
  // from a quiet week.
  const body = await decodeResponse(resp, DELIVERY_LIST_SHAPE, {
    endpoint: '/api/engagements/deliveries',
    method: 'GET',
  });
  return { data: body.data, meta: { count: body.meta?.count ?? body.data.length } };
}

export async function getDelivery(id: string): Promise<DeliveryRow> {
  const url = `/api/engagements/deliveries/${encodeURIComponent(id)}`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'deliveries.get');
  const json = (await resp.json()) as GetResponse;
  return json.data;
}

// ---------- UI helpers ---------------------------------------------------

/**
 * Mask a recipient address for display in the audit log table.
 *   - phones (voice): keep last 4 — `••••1234`
 *   - emails (email/teams):  first char + domain — `a••••@example.com`
 *   - opaque ids (websocket/inapp/web): truncated as-is
 */
export function maskRecipient(channel: string, address: string): string {
  if (!address) return '';
  if (channel === 'voice') {
    const digits = address.replace(/\D/g, '');
    if (digits.length >= 4) {
      return `••••${digits.slice(-4)}`;
    }
    return '••••';
  }
  if (channel === 'email' || channel === 'teams') {
    const at = address.indexOf('@');
    if (at > 0) {
      const local = address.slice(0, at);
      const domain = address.slice(at);
      const head = local.charAt(0);
      return `${head}••••${domain}`;
    }
    return '••••';
  }
  // websocket / inapp / web — opaque session ids, truncate.
  //
  // The ≤12 passthrough stays: a short session token is already short enough to
  // show whole. Above it, the stub comes from `shortId` — the TAIL 8 with a
  // LEADING ellipsis, not the leading 8 with a trailing one (fr#1203/#1205).
  if (address.length <= 12) return address;
  return shortId(address);
}

/**
 * Map backend delivery statuses to the StatusBadge palette.
 * StatusBadge knows: success / running / error / waiting / live / idle / stale / unknown.
 */
export function statusBadgeKind(status: string): string {
  switch (status) {
    case 'sent':
    case 'delivered':
      return 'success';
    case 'queued':
      return 'waiting';
    case 'failed':
      return 'error';
    case 'skipped_disabled':
      return 'idle';
    default:
      return 'unknown';
  }
}
