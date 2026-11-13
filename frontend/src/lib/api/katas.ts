// src/lib/api/katas.ts
//
// Typed client for the super-admin kata surface. Wire contracts mirror
// backend/src/routes/katas.ts (`kataView`) and capabilities/admin/katas.ts —
// keep in sync:
//
//   GET  /api/katas?state=&project=   listKatas    → { items, stats:{today,last7d}, holding }
//   GET  /api/katas/:id               getKata      → KataView
//   POST /api/katas {source:'operator', source_project_id, source_card_id,
//                    source_execution_id?, symptom}
//                                     openKata     → 202 { status:'requested' }
//        (fr only forwards a hand-open to the conveyor coach; the kata row
//        appears once the coach opens it — there is no kata id to show yet)
//   POST /api/katas/:id/stop          stopKata     → 200 { kata, cord_release? }
//   POST /api/katas/:id/rollback      rollbackKata → 202 { status:'requested', kata }
//   POST /api/katas/:id/release       releaseKata  → 200 { kata, cord_release? }
//        (George 2026-11-04: a FAILED kata keeps the cord; only this super-admin
//        Release frees it)
//
// Every call goes through `authFetch` (fresh token per request). A non-2xx
// throws `KataApiError`, whose message is the server's own sentence — the page
// shows it verbatim.

import { authFetch } from './auth-fetch';

export const KATA_STATES = ['running', 'qa', 'published', 'closed', 'failed', 'rolled_back'] as const;
export type KataState = (typeof KATA_STATES)[number];

/** fr's internal `kata` tenant (backend middleware/internal-tenant-only.ts `KATA_TENANT_ID`). */
export const KATA_TENANT_ID = '0195f48b-d000-7000-8000-000000000006';

export interface KataLinkedCard {
  card_id: string;
  board_id: string | null;
  phase: string | null;
  linked_at: string;
  rerun_at?: string;
}

export interface KataView {
  id: string;
  source_project_id: string;
  source_tenant_id: string | null;
  source_card_id: string | null;
  source_execution_id: string | null;
  source_board_id: string | null;
  source_phase: string | null;
  symptom: string;
  opened_by: string;
  signature: string;
  root_cause_class: string | null;
  target_flow: string | null;
  target_flow_id: string | null;
  base_version_id: string | null;
  published_version_id: string | null;
  state: KataState;
  state_detail: string | null;
  replay_passed: number | null;
  replay_total: number | null;
  evidence: Record<string, unknown>;
  ops: unknown;
  replays: unknown;
  linked_cards: KataLinkedCard[];
  kata_board_id: string | null;
  kata_card_id: string | null;
  opened_at: string;
  qa_at: string | null;
  published_at: string | null;
  closed_at: string | null;
  failed_at: string | null;
  rollback_requested_at: string | null;
  rolled_back_at: string | null;
  /** A coach repeat's rollback the guard refused: 'kata_rollback_no_base' | 'kata_rollback_superseded'. */
  rollback_refused_at: string | null;
  rollback_refused_reason: string | null;
  cord_engaged_at: string | null;
  cord_held_seconds: number;
  /** When a super-admin released this FAILED kata's cord; null while it still holds. */
  cord_released_at: string | null;
  cord_released_by: string | null;
  updated_at: string;
  cord: { held: boolean; since: string | null };
}

export interface KataWindowStats {
  opened: number;
  published: number;
  failed: number;
  rolled_back: number;
  paused_seconds: number;
}

export interface KataHolding {
  kata_id: string;
  since: string | null;
}

export interface KataListResponse {
  items: KataView[];
  stats: { today: KataWindowStats; last7d: KataWindowStats };
  holding: KataHolding | null;
  /** FAILED katas still holding the cord: only a super-admin Release frees them. */
  failed_holders: string[];
}

export interface OperatorOpenInput {
  source_project_id: string;
  source_card_id: string;
  source_execution_id?: string;
  symptom: string;
}

export class KataApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | null,
    message: string,
  ) {
    super(message);
    this.name = 'KataApiError';
  }
}

/**
 * Pure: the verbatim error line for a non-2xx kata response. fr-backend's
 * `handleError` body is `{error: string, code?, details?}`; a body that is not
 * that shape is shown raw rather than replaced by a generic sentence.
 */
export function kataErrorText(status: number, bodyText: string): { code: string | null; message: string } {
  let code: string | null = null;
  let message = bodyText.trim();
  try {
    const body = JSON.parse(bodyText) as { error?: unknown; code?: unknown; details?: unknown };
    if (body && typeof body === 'object') {
      if (typeof body.code === 'string') code = body.code;
      if (typeof body.error === 'string') {
        message = body.error;
        // A zod failure says only "Validation error"; the details ARE the reason.
        if (Array.isArray(body.details) && body.details.length > 0) {
          const parts = body.details
            .map((d) => {
              const e = d as { path?: unknown; message?: unknown };
              const path = Array.isArray(e.path) ? e.path.join('.') : '';
              return typeof e.message === 'string' ? (path ? `${path}: ${e.message}` : e.message) : '';
            })
            .filter((p) => p.length > 0);
          if (parts.length) message = `${message} — ${parts.join('; ')}`;
        }
      }
    }
  } catch {
    // non-JSON body: keep the raw text
  }
  const head = `HTTP ${status}${code ? ` ${code}` : ''}`;
  return { code, message: message ? `${head}: ${message}` : head };
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await authFetch(path, init);
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    const { code, message } = kataErrorText(r.status, text);
    throw new KataApiError(r.status, code, message);
  }
  return (await r.json()) as T;
}

export function listKatas(filter: { state?: string | null; project?: string | null } = {}): Promise<KataListResponse> {
  const q = new URLSearchParams();
  if (filter.state) q.set('state', filter.state);
  if (filter.project) q.set('project', filter.project);
  const qs = q.toString();
  return call<KataListResponse>(`/api/katas${qs ? `?${qs}` : ''}`);
}

export function getKata(id: string): Promise<KataView> {
  return call<KataView>(`/api/katas/${encodeURIComponent(id)}`);
}

export function openKataByHand(input: OperatorOpenInput): Promise<{ status: 'requested' }> {
  return call<{ status: 'requested' }>('/api/katas', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source: 'operator', ...input }),
  });
}

export function stopKata(id: string): Promise<{ kata: KataView }> {
  return call<{ kata: KataView }>(`/api/katas/${encodeURIComponent(id)}/stop`, { method: 'POST' });
}

export function releaseKata(id: string): Promise<{ kata: KataView }> {
  return call<{ kata: KataView }>(`/api/katas/${encodeURIComponent(id)}/release`, { method: 'POST' });
}

export function rollbackKata(id: string): Promise<{ status: 'requested'; kata: KataView }> {
  return call<{ status: 'requested'; kata: KataView }>(`/api/katas/${encodeURIComponent(id)}/rollback`, {
    method: 'POST',
  });
}
