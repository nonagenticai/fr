// src/lib/katas/helpers.ts — pure logic for the super-admin kata pages
// (`/admin/kata`, `/admin/kata/[id]`) and the card view's "Open kata" action.
// No DOM, no fetch: everything here is unit-tested in helpers.test.ts.

import type { KataHolding, KataLinkedCard, KataState, KataView } from '$lib/api/katas';

export type KataTone = 'ok' | 'warn' | 'danger' | 'muted';

export const KATA_STATE_LABEL: Record<KataState, string> = {
  running: 'Running',
  qa: 'QA',
  published: 'Published',
  closed: 'Closed',
  failed: 'Failed',
  rolled_back: 'Rolled back',
};

/** Held states pull the cord (warn); published/closed are a fix that landed (ok). */
export const KATA_STATE_TONE: Record<KataState, KataTone> = {
  running: 'warn',
  qa: 'warn',
  published: 'ok',
  closed: 'ok',
  failed: 'danger',
  rolled_back: 'muted',
};

export const KATA_TONE_CHIP: Record<KataTone, string> = {
  ok: 'border-[var(--color-success)] text-[var(--color-success)]',
  warn: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
  danger: 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger)]',
  muted: 'border-[var(--color-border)] text-[var(--color-text-muted)]',
};

/** Stop is valid while the kata holds the cord (backend `stopKata`: running/qa → failed). */
export function canStop(state: KataState): boolean {
  return state === 'running' || state === 'qa';
}

/**
 * Release is valid for a FAILED kata that still holds the cord (backend `releaseFailedKata`).
 * George 2026-11-04: a failed kata keeps the cord; nothing releases it but a super-admin.
 */
export function canRelease(k: Pick<KataView, 'state' | 'cord_released_at' | 'cord'>): boolean {
  return k.state === 'failed' && k.cord_released_at === null && k.cord.held;
}

/** A rollback was requested and has not landed yet (published/closed, not rolled back). */
export function rollbackPending(k: Pick<KataView, 'rollback_requested_at' | 'rolled_back_at'>): boolean {
  return k.rollback_requested_at !== null && k.rolled_back_at === null;
}

/** The badge text for a refused coach-repeat rollback, or null. */
export function rollbackRefusedLabel(k: Pick<KataView, 'rollback_refused_reason'>): string | null {
  if (!k.rollback_refused_reason) return null;
  if (k.rollback_refused_reason === 'kata_rollback_no_base') return 'rollback refused: no base version';
  if (k.rollback_refused_reason === 'kata_rollback_superseded') return 'rollback refused: a later kata published on this flow';
  return `rollback refused: ${k.rollback_refused_reason}`;
}

/** Rollback is valid for a fix that landed (backend `requestKataRollback`: published/closed). */
export function canRollback(state: KataState): boolean {
  return state === 'published' || state === 'closed';
}

/** Whole minutes between `sinceIso` and `nowMs`; null when there is no start time. */
export function minutesSince(sinceIso: string | null, nowMs: number): number | null {
  if (!sinceIso) return null;
  const t = Date.parse(sinceIso);
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.floor((nowMs - t) / 60_000));
}

/** "45 s", "12 min", "3 h 05 min". */
export function formatSeconds(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return `${h} h ${String(m % 60).padStart(2, '0')} min`;
}

/**
 * How long a kata has held the cord in total: the closed-out seconds plus, while
 * still held, the running time since `cord_engaged_at` (the backend adds that
 * only on release).
 */
export function cordHeldSeconds(k: Pick<KataView, 'cord_held_seconds' | 'cord_engaged_at'>, nowMs: number): number {
  let total = k.cord_held_seconds ?? 0;
  if (k.cord_engaged_at) {
    const t = Date.parse(k.cord_engaged_at);
    if (!Number.isNaN(t)) total += Math.max(0, (nowMs - t) / 1000);
  }
  return total;
}

/** The header strip sentence while a kata holds the cord, or null when none does. */
export function holdingSentence(holding: KataHolding | null, nowMs: number): string | null {
  if (!holding) return null;
  const min = minutesSince(holding.since, nowMs);
  const short = holding.kata_id.slice(0, 8);
  return min === null
    ? `Conveyor paused by kata ${short} (held since an unrecorded time)`
    : `Conveyor paused by kata ${short} for ${min} min`;
}

/** "n/total" for the QA replays; em-dash when QA has not reported. */
export function replaysLabel(k: Pick<KataView, 'replay_passed' | 'replay_total'>): string {
  if (k.replay_total === null || k.replay_total === undefined) return '—';
  return `${k.replay_passed ?? 0}/${k.replay_total}`;
}

/** First line of the symptom, trimmed to `max` characters. */
export function oneLine(text: string | null | undefined, max = 140): string {
  const first = (text ?? '').split(/\r?\n/).find((l) => l.trim().length > 0)?.trim() ?? '';
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

export interface KataTimelineEvent {
  key: 'opened' | 'qa' | 'published' | 'closed' | 'failed' | 'rollback_requested' | 'rolled_back';
  label: string;
  at: string;
  tone: KataTone;
}

/**
 * The timeline from the row's own timestamps, oldest first. Only timestamps the
 * row carries become events: a missing stage is not invented. `qa_at` is the
 * LATEST entry into QA (a retry overwrites it), so it is labelled as such.
 */
export function kataTimeline(k: KataView): KataTimelineEvent[] {
  const ev: KataTimelineEvent[] = [{ key: 'opened', label: `Opened by ${k.opened_by}`, at: k.opened_at, tone: 'warn' }];
  const push = (key: KataTimelineEvent['key'], label: string, at: string | null, tone: KataTone) => {
    if (at) ev.push({ key, label, at, tone });
  };
  push('qa', 'Entered QA (latest)', k.qa_at, 'warn');
  push('published', 'Published', k.published_at, 'ok');
  push('closed', 'Closed', k.closed_at, 'ok');
  push('failed', 'Failed', k.failed_at, 'danger');
  push('rollback_requested', 'Rollback requested', k.rollback_requested_at, 'warn');
  push('rolled_back', 'Rolled back', k.rolled_back_at, 'muted');
  return ev.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** Pretty JSON for evidence / ops / replays; null and empty objects say so. */
export function prettyJson(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object' && !Array.isArray(value) && Object.keys(value as object).length === 0) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

/** Rows for a flat key/value view of the evidence: scalar fields first-class, nested ones as JSON. */
export function evidenceRows(evidence: Record<string, unknown> | null | undefined): { key: string; value: string; block: boolean }[] {
  if (!evidence) return [];
  return Object.entries(evidence).map(([key, v]) => {
    if (v === null || v === undefined) return { key, value: '—', block: false };
    if (typeof v === 'string') return { key, value: v, block: v.includes('\n') || v.length > 160 };
    if (typeof v === 'number' || typeof v === 'boolean') return { key, value: String(v), block: false };
    return { key, value: JSON.stringify(v, null, 2), block: true };
  });
}

/** Linked-card rerun state. */
export function linkedCardRerun(c: KataLinkedCard): { tone: KataTone; label: string } {
  return c.rerun_at ? { tone: 'ok', label: `re-run ${new Date(c.rerun_at).toLocaleString()}` } : { tone: 'muted', label: 'not re-run yet' };
}

// ── n8n links ────────────────────────────────────────────────────────────────

/**
 * The conveyor n8n UI. Same source as /admin/assets/workflows' "Open in n8n"
 * (`VITE_N8N_UI_URL`, default the prod alias).
 */
export function n8nUiBase(env: Record<string, unknown> = import.meta.env): string {
  const v = env.VITE_N8N_UI_URL;
  return (typeof v === 'string' && v.trim() ? v.trim() : 'https://n8n.nonagentic.ai').replace(/\/+$/, '');
}

/** The n8n workflow id, when the coach's evidence carries one (`workflow_id` / `workflowId`). */
export function evidenceWorkflowId(evidence: Record<string, unknown> | null | undefined): string | null {
  for (const k of ['workflow_id', 'workflowId', 'target_workflow_id']) {
    const v = evidence?.[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
}

/**
 * Link for a workflow version. The kata row stores the target flow by NAME
 * (`target_flow`, e.g. `bug_analysis.DOING`), not by n8n id, so a direct
 * version URL needs a workflow id from the evidence; without one the honest
 * link is a search for the flow name.
 */
export function n8nVersionLink(
  base: string,
  workflowId: string | null,
  versionId: string | null,
  targetFlow: string | null,
): { href: string; exact: boolean } | null {
  if (workflowId && versionId) {
    return { href: `${base}/workflow/${encodeURIComponent(workflowId)}/history/${encodeURIComponent(versionId)}`, exact: true };
  }
  if (workflowId) return { href: `${base}/workflow/${encodeURIComponent(workflowId)}`, exact: false };
  if (targetFlow) return { href: `${base}/home/workflows?search=${encodeURIComponent(targetFlow)}`, exact: false };
  return null;
}

// ── fr links ─────────────────────────────────────────────────────────────────

export function projectHref(projectId: string): string {
  return `/projects/${encodeURIComponent(projectId)}`;
}

export function cardHref(cardId: string): string {
  return `/cards/${encodeURIComponent(cardId)}`;
}

export function boardHref(boardId: string): string {
  return `/kanban?board=${encodeURIComponent(boardId)}`;
}

export function kataDetailHref(kataId: string): string {
  return `/admin/kata/${encodeURIComponent(kataId)}`;
}

/** The card view's "Open kata from this card" target: the New-kata form, prefilled. */
export function newKataHref(p: { projectId: string | null; cardId: string; tenantId?: string | null }): string {
  const q = new URLSearchParams({ new: '1' });
  if (p.tenantId) q.set('tenant', p.tenantId);
  if (p.projectId) q.set('project', p.projectId);
  q.set('card', p.cardId);
  return `/admin/kata?${q.toString()}`;
}

export interface NewKataPrefill {
  open: boolean;
  tenant: string;
  project: string;
  card: string;
  execution: string;
}

export function readNewKataPrefill(params: URLSearchParams): NewKataPrefill {
  return {
    open: params.get('new') === '1',
    tenant: params.get('tenant')?.trim() ?? '',
    project: params.get('project')?.trim() ?? '',
    card: params.get('card')?.trim() ?? '',
    execution: params.get('execution')?.trim() ?? '',
  };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Client-side mirror of the backend's `OperatorOpenBody` (routes/katas.ts), so
 * the form says what is missing before sending. The server re-validates.
 */
export function validateNewKata(f: { project: string; card: string; execution: string; symptom: string }): string[] {
  const errs: string[] = [];
  if (!UUID.test(f.project.trim())) errs.push('Pick a project.');
  if (!f.card.trim()) errs.push('A card id is required.');
  else if (f.card.trim().length > 128) errs.push('The card id is longer than 128 characters.');
  if (f.execution.trim().length > 128) errs.push('The execution id is longer than 128 characters.');
  if (!f.symptom.trim()) errs.push('Describe the symptom.');
  else if (f.symptom.trim().length > 8000) errs.push('The symptom is longer than 8000 characters.');
  return errs;
}
