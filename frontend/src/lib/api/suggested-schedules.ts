// src/lib/api/suggested-schedules.ts
//
// Typed wrappers for the **suggested-schedules inbox** (Spec 2 Plan 2-D
// Phase 5/8). Backend routes (mounted in backend/src/routes/suggested-schedules.ts):
//
//   GET  /api/projects/:projectId/suggested-schedules?status=new|accepted|dismissed
//   POST /api/internal/suggested-schedules                  (workspace-admin)
//   POST /api/suggested-schedules/:id/accept                → ScheduledTrigger
//   POST /api/suggested-schedules/:id/dismiss               → SuggestedSchedule
//
// Mirrors the `channels.ts` pattern (authFetch + bare/{data} envelope tolerance)
// rather than `unified-client.ts`'s ApiClient class. The list surface returns
// the backend `{ items, total }` envelope (ListResponse<T>) as documented in
// the suggested-schedules route handler.
//
// Plan ref: confirmed-spec-2-spicy-breeze.md Phase 8 (Plan 2-D UI Surfaces).

import { authFetch } from './auth-fetch';
import type { ScheduledTrigger } from '$lib/types/api';

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

export type SuggestedScheduleStatus = 'new' | 'accepted' | 'dismissed';
export type SuggestedScheduleSource = 'manual' | 'heuristic';

/**
 * SuggestedSchedule row as returned on the wire by the GET list endpoint.
 *
 * The `payload` field carries the heuristic-suggested scheduled-trigger body
 * (suggested_name / suggested_cron / suggested_source_connector / etc — see
 * `SuggestedPayloadSchema` in the backend route). It is shaped as a free-form
 * record on the FE because the contents are for display only — no FE-side
 * validation happens here; the backend accept handler re-validates strictly.
 */
export interface SuggestedSchedule {
  id: string;
  tenant_id: string;
  project_id: string;
  user_id: string | null;
  source: SuggestedScheduleSource;
  ad_hoc_summary: string;
  payload: Record<string, unknown>;
  status: SuggestedScheduleStatus;
  promoted_trigger_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface ListSuggestedSchedulesOpts {
  status?: SuggestedScheduleStatus;
}

/**
 * Body shape for `POST /api/internal/suggested-schedules` — admin-only stub
 * used by QA + (later) the heuristic auto-detector. `payload` is the same
 * suggested-trigger body the FE card renders, opaque to the FE wrapper.
 */
export interface InternalCreateSuggestedScheduleInput {
  project_id: string;
  ad_hoc_summary: string;
  payload?: Record<string, unknown>;
  user_id?: string;
}

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

/**
 * Read a `{ items, total }` ListResponse envelope OR a bare array, returning
 * the underlying array. Same shape-tolerance idiom as `channels.listChannels`.
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

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * GET /api/projects/:projectId/suggested-schedules?status=...
 *
 * RBAC: dept-member+ on the project's dept (backend gates).
 */
export async function list(
  projectId: string,
  opts: ListSuggestedSchedulesOpts = {},
): Promise<SuggestedSchedule[]> {
  const sp = new URLSearchParams();
  if (opts.status) sp.set('status', opts.status);
  const qs = sp.toString();
  const url = `/api/projects/${encodeURIComponent(projectId)}/suggested-schedules${
    qs ? `?${qs}` : ''
  }`;
  const resp = await authFetch(url);
  await ensureOk(resp, 'suggestedSchedules.list');
  const json = (await resp.json()) as unknown;
  return readListBody<SuggestedSchedule>(json);
}

/**
 * POST /api/suggested-schedules/:id/accept
 *
 * Atomic promote — server creates a `scheduled_triggers` row, marks the
 * suggestion `accepted`, and returns the new trigger (with
 * `from_suggestion_id` set to the accepted row's id).
 *
 * RBAC: dept-member+ on the project's dept.
 */
export async function accept(id: string): Promise<ScheduledTrigger> {
  const resp = await authFetch(
    `/api/suggested-schedules/${encodeURIComponent(id)}/accept`,
    { method: 'POST', headers: JSON_HEADERS },
  );
  await ensureOk(resp, 'suggestedSchedules.accept');
  const json = (await resp.json()) as ScheduledTrigger | { data: ScheduledTrigger };
  return 'data' in json && (json as { data?: unknown }).data !== undefined
    ? (json as { data: ScheduledTrigger }).data
    : (json as ScheduledTrigger);
}

/**
 * POST /api/suggested-schedules/:id/dismiss
 *
 * Idempotent — re-dismissing a `dismissed` row is a no-op 200. Dismissing
 * an already-`accepted` row 409s. Returns the updated SuggestedSchedule row.
 *
 * RBAC: dept-member+ on the project's dept.
 */
export async function dismiss(id: string): Promise<SuggestedSchedule> {
  const resp = await authFetch(
    `/api/suggested-schedules/${encodeURIComponent(id)}/dismiss`,
    { method: 'POST', headers: JSON_HEADERS },
  );
  await ensureOk(resp, 'suggestedSchedules.dismiss');
  const json = (await resp.json()) as SuggestedSchedule | { data: SuggestedSchedule };
  return 'data' in json && (json as { data?: unknown }).data !== undefined
    ? (json as { data: SuggestedSchedule }).data
    : (json as SuggestedSchedule);
}

/**
 * POST /api/internal/suggested-schedules
 *
 * Admin-only stub used by QA / browser smoke. Creates a single
 * `suggested_schedules` row with `source: 'manual'` (the heuristic path
 * lands later via a separate internal entry point).
 *
 * RBAC: workspace-admin only.
 */
export async function internalCreate(
  input: InternalCreateSuggestedScheduleInput,
): Promise<SuggestedSchedule> {
  const resp = await authFetch('/api/internal/suggested-schedules', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await ensureOk(resp, 'suggestedSchedules.internalCreate');
  const json = (await resp.json()) as SuggestedSchedule | { data: SuggestedSchedule };
  return 'data' in json && (json as { data?: unknown }).data !== undefined
    ? (json as { data: SuggestedSchedule }).data
    : (json as SuggestedSchedule);
}
