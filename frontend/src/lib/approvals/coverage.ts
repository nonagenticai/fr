// COVERAGE (George BDD ruling 2026-10-01) — a coding card whose acceptance criteria lack an
// executed passing scenario. Approve = covered, reject = a gap, per criterion: the decider may
// tick criteria as rejected, sent as `rejected_criterion_ids`.
//
// ⚠️ A MIRROR OF THE SERVER, WHICH IS THE ONE THAT DECIDES.
// `backend/src/domain/engagement/deblock-actions.ts :: classifyCoverageDecision` validates the
// ids against the row's `metadata.coverage_request.criteria` and resolves the full split. These
// helpers only read the row for display and shape the request body.

import type { Approval } from '$lib/types/api';
import { deblockActionOf } from './question';

export interface CoverageCriterion {
  criterion_id: string;
  text: string | null;
  scenario_id: string | null;
  reason_not_computed: string | null;
}

export interface CoverageArtifact {
  kind: string | null;
  ref: string;
  sha: string | null;
}

/** What the decision bar hands back on a COVERAGE row. */
export interface CoverageChoice {
  rejectedCriterionIds: string[];
}

const strOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.trim().length > 0 ? v : null;

function coverageRequestOf(a: Pick<Approval, 'metadata'>): Record<string, unknown> | null {
  const raw = ((a.metadata ?? {}) as Record<string, unknown>).coverage_request;
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null;
}

/** Is this row a COVERAGE sign-off (by its stored deblock_action)? */
export function isCoverageRow(a: Pick<Approval, 'metadata'>): boolean {
  return deblockActionOf(a) === 'COVERAGE';
}

/** The row's criteria (de-duplicated by id, in order), or null when it carries none. */
export function coverageCriteriaOf(a: Pick<Approval, 'metadata'>): CoverageCriterion[] | null {
  const criteria = coverageRequestOf(a)?.criteria;
  if (!Array.isArray(criteria)) return null;
  const out: CoverageCriterion[] = [];
  for (const c of criteria) {
    if (!c || typeof c !== 'object') continue;
    const r = c as Record<string, unknown>;
    const id = strOrNull(r.criterion_id);
    if (!id || out.some((x) => x.criterion_id === id)) continue;
    out.push({
      criterion_id: id,
      text: strOrNull(r.text),
      scenario_id: strOrNull(r.scenario_id),
      reason_not_computed: strOrNull(r.reason_not_computed),
    });
  }
  return out.length > 0 ? out : null;
}

/** The row's artifacts (links shown beside the criteria), possibly empty. */
export function coverageArtifactsOf(a: Pick<Approval, 'metadata'>): CoverageArtifact[] {
  const arts = coverageRequestOf(a)?.artifacts;
  if (!Array.isArray(arts)) return [];
  return arts.flatMap((x) => {
    if (!x || typeof x !== 'object') return [];
    const r = x as Record<string, unknown>;
    const ref = strOrNull(r.ref);
    return ref ? [{ kind: strOrNull(r.kind), ref, sha: strOrNull(r.sha) }] : [];
  });
}

/** A ref is rendered as a link only when it is an http(s) URL. */
export function isLinkRef(ref: string): boolean {
  return /^https?:\/\//i.test(ref);
}

/**
 * The body fragment a COVERAGE decision adds. Absent `coverage` ⇒ nothing. An empty choice
 * is sent as nothing too: the server reads "none named" as approve = all covered and
 * reject = all gaps, so `[]` and absent mean the same and the smaller body wins.
 */
export function coveragePayload(
  coverage: CoverageChoice | undefined,
): { rejected_criterion_ids?: string[] } {
  if (!coverage) return {};
  const ids = [...new Set(coverage.rejectedCriterionIds.map((s) => s.trim()).filter(Boolean))];
  return ids.length > 0 ? { rejected_criterion_ids: ids } : {};
}
