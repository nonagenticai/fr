// src/lib/api/unifiedChannels.ts
//
// Spec 2 Plan 2-C Phase 1.1: merge helper for the unified `/channels` list.
//
// The /channels page surfaces two distinct row sources behind a single
// table — notification channels (`/api/channels`) and scheduled intake
// triggers (`/api/scheduled-triggers`). Each backend route lives at a
// different list endpoint and returns a different wire shape:
//
//   /api/channels          → bare `Channel[]` (see backend/src/routes/channels.ts)
//   /api/scheduled-triggers → `{ items: ScheduledTrigger[], total: number }`
//
// We unify them into `WireUnifiedChannel` rows discriminated by `kind`. The
// notification kinds match `ChannelKind` from `./channels.ts` (teams,
// email, web, inapp, voice). The schedule kind uses the snake_case wire
// string 'scheduled_intake' (matching the `trigger_kind` constraint on
// `scheduled_trigger_runs.trigger_kind`). URL kebab-case (`?kind=schedule-intake`) is a
// separate UI-routing convention and lives in the page components, not here.
//
// Plan: docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md §Phase 1.

import type { ReadonlyURLSearchParams } from '$app/state';
import type { Channel } from './channels';
import type { ScheduledTrigger } from '$lib/types/api';
import { fetchWithBudget } from '$lib/net/fetchWithBudget';

/**
 * Discriminated union of all rows the `/channels` table renders. The
 * notification-channel branch reuses `Channel` whole (its `kind` field is
 * already the discriminant). The schedule branch adds a synthetic `kind`
 * tag because the underlying rows do not carry one on the wire.
 */
export type WireUnifiedChannel =
  | Channel
  | (ScheduledTrigger & { kind: 'scheduled_intake' });

/**
 * Reads one list endpoint through `fetchWithBudget`'s default `authFetch`,
 * which attaches the Keycloak Bearer token. Do NOT pass `fetchImpl: fetch`
 * here: that bypasses authFetch, the backend reads only `Authorization` (no
 * cookie session), and both list endpoints then 401 in ~1 ms (measured
 * in prod).
 */
async function fetchList(url: string): Promise<unknown> {
  const res = await fetchWithBudget(url);
  if (!res.ok) {
    throw new Error(`${url} → ${res.status}`);
  }
  return res.json();
}

/**
 * Read either a bare-array body or a `{ items, total }` envelope and return
 * the underlying array. Used to bridge the wire-shape inconsistency between
 * `/api/channels` (bare array) and `/api/scheduled-triggers`
 * (`ListResponse` envelope).
 */
function readListBody<T>(body: unknown): T[] {
  if (Array.isArray(body)) return body as T[];
  if (
    body !== null &&
    typeof body === 'object' &&
    'items' in body &&
    Array.isArray((body as { items: unknown }).items)
  ) {
    return (body as { items: T[] }).items;
  }
  return [];
}

export interface ListUnifiedChannelsOpts {
  /**
   * Optional project filter. Forwarded to the schedule endpoints as a
   * `project_id` query parameter. NOT forwarded to `/api/channels` because
   * the channel registry is workspace-scoped (no per-project shape on the
   * row — see `Channel` in `./channels.ts`).
   */
  projectId?: string;
}

/**
 * Fetch both sources in parallel and return a flat list sorted by
 * `created_at` descending. Tolerates per-endpoint failure: any source that
 * rejects is dropped from the result while the others still surface, so a
 * single 500 on one route does not blank the whole page.
 */
export async function listUnifiedChannels(
  opts: ListUnifiedChannelsOpts = {},
): Promise<WireUnifiedChannel[]> {
  const trigQS = opts.projectId
    ? `?project_id=${encodeURIComponent(opts.projectId)}`
    : '';

  const [chRes, trRes] = await Promise.allSettled([
    fetchList('/api/channels'),
    fetchList(`/api/scheduled-triggers${trigQS}`),
  ]);

  const out: WireUnifiedChannel[] = [];

  if (chRes.status === 'fulfilled') {
    for (const r of readListBody<Channel>(chRes.value)) {
      out.push(r);
    }
  }
  if (trRes.status === 'fulfilled') {
    for (const r of readListBody<ScheduledTrigger>(trRes.value)) {
      out.push({ ...r, kind: 'scheduled_intake' as const });
    }
  }

  out.sort((a, b) => {
    const aCreated = 'created_at' in a ? (a.created_at ?? '') : '';
    const bCreated = 'created_at' in b ? (b.created_at ?? '') : '';
    return bCreated.localeCompare(aCreated);
  });

  return out;
}

// ---------------------------------------------------------------------------
// URL ?kind= ↔ wire-kind translation
// ---------------------------------------------------------------------------
//
// Phase 1 review flagged that the kebab-case URL convention
// (`?kind=schedule-intake`) and the snake_case wire value
// (`scheduled_intake`) had no single source of
// truth — pages were inlining string literals + ad-hoc `if` ladders. These
// helpers centralize the translation so /channels/new, /channels/[id], and
// any future page route through one canonical map.
//
// `null` from `kindFromUrl` means "no/unknown kind" → caller falls back to
// the legacy notification-channel branch.

/** Kebab-case URL discriminator. `null` = legacy notification branch. */
export type UrlKind = 'schedule-intake' | null;

/** Snake-case wire/DB discriminator. */
export type WireKind = 'scheduled_intake' | 'notification';

/**
 * Read a `?kind=` query param and return the canonical UrlKind. Anything
 * other than the recognised kebab string (or a missing param) returns
 * `null` — callers treat that as the legacy notification branch.
 */
export function kindFromUrl(searchParams: ReadonlyURLSearchParams | null): UrlKind {
  const k = searchParams?.get('kind');
  if (k === 'schedule-intake') return k;
  return null;
}

/** Translate a UrlKind to the snake_case wire discriminator. */
export function urlKindToWire(k: UrlKind): WireKind {
  if (k === 'schedule-intake') return 'scheduled_intake';
  return 'notification';
}
