/**
 * Asset quality — the stored verdict on an entity row and its score history.
 *
 * READ-ONLY. requirements_management removed its LLM quality judges (RM #238,
 * 2026-10-26), so fr no longer runs an evaluation: there is no Evaluate call
 * here. What remains is what RM still serves:
 *
 * 1. The **persisted columns on the entity row** — `quality_score`,
 *    `quality_issues`, `quality_suggestions`, `last_evaluated_at`,
 *    `last_evaluated_by_agent` — on `PrincipleOut`, `DecisionOut`,
 *    `ArchitectureElementOut` and `ArchitectureViewOut`. When a row has never
 *    been evaluated `readPersistedVerdict` returns `null` and the panel says so.
 * 2. The **score history** — `GET /api/assets/:kind/:id/quality/history`, every
 *    run RM recorded, not only the latest one persisted on the row.
 */

import { authFetch } from './auth-fetch';
import type { Block } from '$lib/types/read-model';

export interface QualityVerdict {
  /** Continuous 0..1 score, or `null` when the row carries none. Never rendered as 0. */
  score: number | null;
  issues: string[];
  suggestions: string[];
  /** When the stored verdict was written. */
  lastEvaluatedAt: string | null;
  /** Which evaluator produced the stored verdict. */
  lastEvaluatedByAgent: string | null;
}

/** The asset kinds with a stored verdict and a score history (fr's route `:kind`). */
export type QualityKind = 'principle' | 'decision' | 'architectureElement' | 'architectureView';

/**
 * The five QualityMixin columns as they appear on an entity read schema.
 *
 * Extend a row interface with this ONLY where upstream actually exposes them:
 * `PrincipleOut`, `DecisionOut`, `ArchitectureElementOut`, `ArchitectureViewOut`.
 * Declaring them anywhere else would assert a field the API never sends.
 */
export interface QualityColumns {
  quality_score?: number | null;
  quality_issues?: string[] | null;
  quality_suggestions?: string[] | null;
  last_evaluated_at?: string | null;
  last_evaluated_by_agent?: string | null;
}

/**
 * Read a stored verdict off a loaded entity.
 *
 * Returns `null` when the entity has never been evaluated OR when its read
 * schema does not expose the columns at all — the two are indistinguishable
 * from the client, which is exactly why the panel words the empty state as
 * "no stored result" rather than "never evaluated".
 *
 * `last_evaluated_at` is the discriminator rather than `quality_score`: a
 * genuine score of 0 is falsy, and treating it as absent would hide the worst
 * verdicts the judge can return.
 */
export function readPersistedVerdict(item: unknown): QualityVerdict | null {
  if (!item || typeof item !== 'object') return null;
  const row = item as QualityColumns;
  if (!row.last_evaluated_at) return null;
  return {
    score: typeof row.quality_score === 'number' ? row.quality_score : null,
    issues: Array.isArray(row.quality_issues) ? row.quality_issues : [],
    suggestions: Array.isArray(row.quality_suggestions)
      ? row.quality_suggestions
      : [],
    lastEvaluatedAt: row.last_evaluated_at,
    lastEvaluatedByAgent: row.last_evaluated_by_agent ?? null,
  };
}

/**
 * True when the stored verdict predates the entity's own last modification —
 * i.e. the score describes text that has since changed.
 *
 * Returns false when either timestamp is missing or unparseable: an unproven
 * staleness claim is worse than none.
 */
export function isVerdictStale(
  verdict: QualityVerdict | null,
  modifiedAt: string | null | undefined,
): boolean {
  if (!verdict?.lastEvaluatedAt || !modifiedAt) return false;
  const evaluated = Date.parse(verdict.lastEvaluatedAt);
  const modified = Date.parse(modifiedAt);
  if (Number.isNaN(evaluated) || Number.isNaN(modified)) return false;
  return modified > evaluated;
}

/**
 * One row of an asset's score history (every recorded run, not just the latest
 * one persisted on the entity row).
 *
 * `score` is `null` when the run produced none. It must render as "no score",
 * never as 0 and never as a 0.5 midpoint.
 */
export interface QualityHistoryEntry {
  score: number | null;
  evaluator: string | null;
  model_id: string | null;
  created_at: string;
}

function toEntry(raw: unknown): QualityHistoryEntry | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.created_at !== 'string') return null;
  return {
    // Only a finite number is a score. Anything else — absent, null, a string —
    // is "no score"; it is never coerced to 0 or to a 0.5 midpoint.
    score: typeof r.score === 'number' && Number.isFinite(r.score) ? r.score : null,
    evaluator: typeof r.evaluator === 'string' ? r.evaluator : null,
    model_id: typeof r.model_id === 'string' ? r.model_id : null,
    created_at: r.created_at,
  };
}

/**
 * GET the score history. The response is a read-model Block whose `data` is
 * requirements_management's payload verbatim (`{entity_type, entity_id, n,
 * items: [...]}`). An upstream failure arrives as `available:false` inside a
 * 200 and is THROWN here with its reason, so the panel renders "couldn't load"
 * and never an empty history that looks like "never scored".
 */
export async function fetchQualityHistory(
  kind: QualityKind,
  id: string,
  limit = 20,
): Promise<QualityHistoryEntry[]> {
  // The fr route is `GET /api/assets/:kind/:id/quality/history` (principle |
  // decision | architectureElement | architectureView).
  const url = `/api/assets/${kind}/${encodeURIComponent(id)}/quality/history?limit=${encodeURIComponent(limit)}`;
  const r = await authFetch(url);
  if (!r.ok) throw new Error(`quality history: ${r.status}`);
  const body = (await r.json()) as Block<{ items?: unknown }>;
  if (!body?.meta?.available || !body.data) {
    throw new Error(body?.meta?.error ?? 'quality history unavailable');
  }
  if (!Array.isArray(body.data.items)) {
    throw new Error('quality history: expected {items: [...]}');
  }
  return body.data.items.map(toEntry).filter((e): e is QualityHistoryEntry => e !== null);
}
