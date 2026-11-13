// crossPaperContradictions.ts
// ============================
// Pure aggregation for P3-R2: turn per-entity `topologyContradictions` results
// into CROSS-paper disagreements ("paper A and paper B disagree on X"). The
// per-entity contradiction check already ships; this reduces it over a session's
// pushed papers so the researcher sees which of THEIR papers conflict, not one
// entity at a time. Kept framework-free + unit-tested.

import type { ContradictionResponse } from '$lib/api/research';

/** A session paper with the graph entities it contributed. */
export interface SessionPaper {
  paperId: string;
  title: string;
  entityIds: string[];
}

/** The contradiction result for one queried entity (null = not yet / failed). */
export interface EntityContradictions {
  entityId: string;
  response: ContradictionResponse | null;
}

/** One cross-paper disagreement between two of the session's papers. */
export interface CrossPaperDisagreement {
  paperAId: string;
  paperATitle: string;
  paperBId: string;
  paperBTitle: string;
  /** The contested entity/topic (the contradiction pair's target label or id). */
  topic: string;
  /** Net support score from the pair, when present (lower = more contested). */
  netSupportScore?: number;
}

interface PaperRef {
  paperId: string;
  title: string;
}

/**
 * entityId → EVERY session paper that contributed it (multi-attribution).
 * A shared entity contributed by several papers maps to ALL of them, so a
 * contradiction whose two sides are the SAME shared entity (contributed by both
 * paper A and paper B) is no longer collapsed to a single paper and dropped.
 * The same paperId is added at most once per entity (dedup by paperId).
 */
export function buildEntityPaperMap(papers: SessionPaper[]): Map<string, PaperRef[]> {
  const map = new Map<string, PaperRef[]>();
  for (const p of papers) {
    for (const eid of p.entityIds) {
      if (!eid) continue;
      const refs = map.get(eid);
      if (!refs) {
        map.set(eid, [{ paperId: p.paperId, title: p.title }]);
      } else if (!refs.some((r) => r.paperId === p.paperId)) {
        refs.push({ paperId: p.paperId, title: p.title });
      }
    }
  }
  return map;
}

/**
 * Human label for a net-support score that keeps direction legible. A negative
 * score printed under the bare word "support" reads as a confusing "-40%", so
 * show magnitude PLUS an explicit direction word. undefined → em dash.
 */
export function netSupportLabel(score?: number): string {
  if (typeof score !== 'number') return '—';
  const magnitude = `${Math.round(Math.abs(score) * 100)}%`;
  if (score > 0) return `net support ${magnitude}`;
  if (score < 0) return `net opposition ${magnitude}`;
  return `net neutral ${magnitude}`;
}

/** Unordered key for a paper pair so A-B and B-A dedupe to one. */
function pairKey(a: string, b: string, topic: string): string {
  return [a, b].sort().join('|') + '::' + topic;
}

/**
 * Reduce per-entity contradiction results to the disagreements whose two entities
 * belong to DIFFERENT session papers. A pair links the queried entity (→ papers A)
 * to a `target_id` (→ papers B); because entities are multi-attributed we fan out
 * over the cartesian product of the queried entity's papers × the target's papers,
 * emitting a row for every distinct A≠B combination (including the case where both
 * sides are the SAME shared entity contributed by two different papers). Deduped by
 * the unordered paper pair + topic, so A-B/B-A and cross-entity repeats collapse.
 */
export function findCrossPaperDisagreements(
  papers: SessionPaper[],
  results: EntityContradictions[],
): CrossPaperDisagreement[] {
  const entityToPaper = buildEntityPaperMap(papers);
  const seen = new Set<string>();
  const out: CrossPaperDisagreement[] = [];

  for (const { entityId, response } of results) {
    const papersA = entityToPaper.get(entityId);
    if (!papersA || !response) continue;
    for (const pair of response.contradiction_pairs ?? []) {
      const targetId = typeof pair.target_id === 'string' ? pair.target_id : '';
      if (!targetId) continue;
      const papersB = entityToPaper.get(targetId);
      if (!papersB) continue;
      const topic =
        (typeof pair.target_label === 'string' && pair.target_label) || targetId;
      // Fan out over every A×B combination; keep only cross-paper (A ≠ B).
      for (const paperA of papersA) {
        for (const paperB of papersB) {
          if (paperB.paperId === paperA.paperId) continue;
          const key = pairKey(paperA.paperId, paperB.paperId, topic);
          if (seen.has(key)) continue;
          seen.add(key);
          out.push({
            paperAId: paperA.paperId,
            paperATitle: paperA.title,
            paperBId: paperB.paperId,
            paperBTitle: paperB.title,
            topic,
            netSupportScore:
              typeof pair.net_support_score === 'number' ? pair.net_support_score : undefined,
          });
        }
      }
    }
  }
  // Most-contested first (lowest net support), stable for ties.
  return out.sort((a, b) => (a.netSupportScore ?? 0) - (b.netSupportScore ?? 0));
}

/**
 * Count DISTINCT external evidence sources that this session's papers contradict.
 * A pair links a queried session entity to an external `target_id`; the SAME
 * external target cited under several queried entities is ONE piece of external
 * evidence, not many — so we dedup into a Set (mirroring the `seen`-Set
 * discipline of `findCrossPaperDisagreements`) instead of blindly incrementing.
 * Dedup key = the external `target_id`: the UI labels this "N contradictions
 * against evidence outside this session", i.e. distinct outside evidence, not
 * per-entity mentions of it.
 */
export function countExternalContradictions(
  papers: SessionPaper[],
  results: EntityContradictions[],
): number {
  const entityToPaper = buildEntityPaperMap(papers);
  const seen = new Set<string>();
  for (const { response } of results) {
    for (const pair of response?.contradiction_pairs ?? []) {
      const targetId = typeof pair.target_id === 'string' ? pair.target_id : '';
      if (targetId && !entityToPaper.has(targetId)) seen.add(targetId);
    }
  }
  return seen.size;
}
