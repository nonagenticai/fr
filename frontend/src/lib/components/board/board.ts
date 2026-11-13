// board.ts — the pure half of the R5 Board, the card drawer and the Flow runs page
// (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 / §5 R5; cockpit C4 / C5 / C9).
//
// Phase placement is EXACT and comes from the read model (board.ts in the backend: the card's own
// `phase` field, Closure = card type `project_closure`). The page filters on it and guesses nothing:
// a card without one is listed under "not tied to a phase".
import type { BoardCard, BoardColumn, CockpitFlowRun, ProjectBoard } from '$lib/types/cockpit';
import { durationWords } from '$lib/projects/cockpit-status';
import type { TrailDocument, TrailPullRequest } from '$lib/types/outputs';

/** The project's outputs as the card drawer reads them (one read per board page). */
export type DrawerOutputs =
  | { kind: 'reading' }
  | { kind: 'failed' }
  | { kind: 'loaded'; documents: TrailDocument[]; pullRequests: TrailPullRequest[] };

/** The cockpit reads at most this many flow runs (backend FLOW_RUNS_LIMIT): a full list may be cut. */
export const FLOW_RUNS_SHOWN_CAP = 200;

/** The two board filters that are not a phase. */
export const ALL_CARDS = '__all__';
export const UNPLACED = '__unplaced__';

export type BoardFilter = string; // a phase name, ALL_CARDS or UNPLACED

/** The phase the board shows: the user's pick, else the current phase, else every card. */
export function boardFilterShown(
  phases: readonly { name: string }[],
  current: string | null,
  chosen: BoardFilter | null,
): BoardFilter {
  if (chosen === ALL_CARDS || chosen === UNPLACED) return chosen;
  if (chosen && phases.some((p) => p.name === chosen)) return chosen;
  if (current && phases.some((p) => p.name === current)) return current;
  return phases[0]?.name ?? ALL_CARDS;
}

export function cardsInFilter(cards: readonly BoardCard[], filter: BoardFilter): BoardCard[] {
  if (filter === ALL_CARDS) return [...cards];
  if (filter === UNPLACED) return cards.filter((c) => c.phase === null);
  return cards.filter((c) => c.phase === filter);
}

export interface BoardColumnView {
  column: BoardColumn;
  cards: BoardCard[];
}

/** Every column of the board, in the board's order, with the filtered cards in it. */
export function columnsWithCards(board: Pick<ProjectBoard, 'columns'>, cards: readonly BoardCard[]): BoardColumnView[] {
  return board.columns.map((column) => ({ column, cards: cards.filter((c) => c.list_id === column.id) }));
}

/** "In Doing 12 min" / "Done 25 Oct, 10:04" / "In To do since it was made, 8 min". */
export function timeInColumnWords(card: Pick<BoardCard, 'in_column_since' | 'list_name' | 'done'>, now: number): string {
  const t = card.in_column_since ? Date.parse(card.in_column_since) : NaN;
  const col = card.list_name ?? 'this column';
  if (!Number.isFinite(t)) return `In ${col}; when it arrived is not recorded`;
  if (card.done) {
    return `Done ${new Date(t).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}`;
  }
  return `In ${col} ${durationWords(Math.max(0, now - t))}`;
}

/** The blocked line under a card: the reason, or an honest "no reason recorded". */
export function blockedWords(card: Pick<BoardCard, 'blocked' | 'block_reason' | 'block_kind'>): string | null {
  if (!card.blocked) return null;
  if (card.block_reason) return `Blocked: ${card.block_reason}`;
  return card.block_kind === 'lane'
    ? 'Blocked: no reason was recorded on the card'
    : 'Blocked';
}

// ── Flow runs (C5) ───────────────────────────────────────────────────────────

/** One row of the merged Flow runs list. */
export interface FlowRunRow {
  key: string;
  execution_id: string;
  /** conveyor = n8n's execution hook (conveyor_flow_runs); member = a run a member started from fr. */
  source: 'conveyor' | 'member';
  status: string;
  n8n_status: string | null;
  flow: string | null;
  card_id: string | null;
  started_at: string | null;
  stopped_at: string | null;
  duration_ms: number | null;
  failed_node: string | null;
  error_class: string | null;
  error_message: string | null;
  started_by: string | null;
}

const FAILED = new Set(['error', 'crashed', 'failed']);
export const isFailedRun = (r: Pick<FlowRunRow, 'status'>): boolean => FAILED.has(r.status);

export function durationOf(start: string | null | undefined, stop: string | null | undefined): number | null {
  const a = start ? Date.parse(start) : NaN;
  const b = stop ? Date.parse(stop) : NaN;
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}

export interface HookRunIn extends CockpitFlowRun {
  error_message?: string | null;
}

export interface MemberRunIn {
  id: string;
  status: string | null;
  workflow_id?: string | null;
  started_at?: string | null;
  stopped_at?: string | null;
  duration_ms?: number | null;
  triggered_at?: string | null;
  card_id?: string | null;
  started_by?: string | null;
}

/**
 * Merge the execution hook's record with the runs members started from fr, one row per n8n
 * execution. The hook's row wins (it carries the flow, card, step and n8n's own status); a member
 * run fills what the hook did not report and adds who started it.
 */
export function mergeFlowRuns(hook: readonly HookRunIn[], member: readonly MemberRunIn[]): FlowRunRow[] {
  const out = new Map<string, FlowRunRow>();
  for (const r of hook) {
    out.set(r.execution_id, {
      key: `x:${r.execution_id}`,
      execution_id: r.execution_id,
      source: 'conveyor',
      status: r.status,
      n8n_status: r.n8n_status ?? null,
      flow: r.workflow_name ?? r.workflow_id ?? null,
      card_id: r.card_id,
      started_at: r.started_at,
      stopped_at: r.stopped_at,
      duration_ms: durationOf(r.started_at, r.stopped_at),
      failed_node: r.failed_node,
      error_class: r.error_class,
      error_message: r.error_message ?? null,
      started_by: null,
    });
  }
  for (const m of member) {
    const prev = out.get(m.id);
    const started = m.started_at ?? m.triggered_at ?? null;
    if (prev) {
      prev.started_by = m.started_by ?? prev.started_by;
      prev.started_at ??= started;
      prev.stopped_at ??= m.stopped_at ?? null;
      prev.duration_ms ??= m.duration_ms ?? durationOf(prev.started_at, prev.stopped_at);
      prev.n8n_status ??= m.status;
      continue;
    }
    out.set(m.id, {
      key: `x:${m.id}`,
      execution_id: m.id,
      source: 'member',
      status: m.status ?? 'unknown',
      n8n_status: m.status,
      flow: m.workflow_id ?? null,
      card_id: m.card_id ?? null,
      started_at: started,
      stopped_at: m.stopped_at ?? null,
      duration_ms: m.duration_ms ?? durationOf(started, m.stopped_at),
      failed_node: null,
      error_class: null,
      error_message: null,
      started_by: m.started_by ?? null,
    });
  }
  return [...out.values()];
}

/** Newest first; while the project runs, failed runs come first (each group newest first). */
export function sortFlowRuns(rows: readonly FlowRunRow[], failuresFirst: boolean): FlowRunRow[] {
  const t = (r: FlowRunRow) => (r.started_at ? Date.parse(r.started_at) : NaN);
  return [...rows].sort((a, b) => {
    if (failuresFirst) {
      const fa = isFailedRun(a) ? 0 : 1;
      const fb = isFailedRun(b) ? 0 : 1;
      if (fa !== fb) return fa - fb;
    }
    const ta = t(a);
    const tb = t(b);
    if (Number.isFinite(ta) && Number.isFinite(tb)) return tb - ta;
    if (Number.isFinite(ta)) return -1;
    if (Number.isFinite(tb)) return 1;
    return 0;
  });
}

/** Plain words for a run's status. A flow that took its own failure path while n8n says "success" is a failure. */
export function runStatusWords(r: Pick<FlowRunRow, 'status' | 'n8n_status'>): string {
  const w: Record<string, string> = {
    success: 'Succeeded',
    error: 'Failed',
    crashed: 'Crashed',
    failed: 'Failed',
    running: 'Running',
    waiting: 'Waiting',
    canceled: 'Cancelled',
    new: 'Queued',
    unknown: 'Status not known',
  };
  return w[r.status] ?? r.status;
}

export function runDurationWords(ms: number | null): string {
  return ms === null ? '—' : durationWords(ms);
}

// ── Card cost (drawer) ───────────────────────────────────────────────────────

export type CardCostView =
  | { kind: 'amount'; cost: number | null; calls: number; currency: string }
  | { kind: 'none_recorded'; since: string | null }
  | { kind: 'not_attributed'; unattributed_calls: number }
  | { kind: 'unavailable' };

/**
 * The card's cost from billing's by-card breakdown. Honest about each gap: billing unreadable,
 * calls that carry no card at all (nothing can be split per card), or no call recorded for this card.
 */
export function cardCost(
  costs: { by_card: { card_id: string | null; cost: number | null; calls: number }[]; by_card_since: string | null; currency: string } | null,
  cardId: string,
): CardCostView {
  if (!costs) return { kind: 'unavailable' };
  const row = costs.by_card.find((r) => r.card_id === cardId);
  if (row) return { kind: 'amount', cost: row.cost, calls: row.calls, currency: costs.currency };
  const attributed = costs.by_card.some((r) => r.card_id !== null);
  if (!attributed) {
    const unattributed = costs.by_card.filter((r) => r.card_id === null).reduce((n, r) => n + r.calls, 0);
    return { kind: 'not_attributed', unattributed_calls: unattributed };
  }
  return { kind: 'none_recorded', since: costs.by_card_since };
}
