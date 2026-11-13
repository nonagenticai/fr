// Client for the Architecture Governance BFF (P3.1 of the fr Architecture
// Governance lane).
//
// - `GET /api/governance/architecture/conformance?projectId=<uuid>` — thin
//   wrapper over `requirements_management`'s `POST /architecture/tools/conformance`
//   with a 60s in-memory TTL cache. The fr dashboard renders the upstream JSON
//   directly; the shape mirrors `conformance.py:298-319` verbatim.
//
// The proposals review queue (its accept / bulk-accept orchestration and the
// containers read that fed its container picker) was removed with
// requirements_management's LLM proposals route (RM #238).

import { authFetch } from './auth-fetch';
import { errorDetailOf } from './error-detail';

export interface ConformanceElementRef {
  id: string;
  title: string;
  layer: string;
  element_type: string;
}

export interface ConformanceCodeUnitRef {
  id: string;
  name: string;
  container: string;
}

export interface ConformanceEdgePair {
  source: ConformanceElementRef;
  target: ConformanceElementRef;
}

export interface ConformanceIllegalEdge extends ConformanceEdgePair {
  source_layer: string;
  target_layer: string;
  reason: string;
}

export interface ArchitectureConformanceResult {
  realization_coverage: {
    realization_coverage: number;
    total_application_components: number;
    realized_count: number;
    realized: ConformanceElementRef[];
    unrealized: ConformanceElementRef[];
    orphan_artifacts: ConformanceElementRef[];
    unbound_code_units: ConformanceCodeUnitRef[];
  };
  dependency_conformance: {
    conformance_score: number;
    designed_count: number;
    realized_count: number;
    matched: ConformanceEdgePair[];
    missing: ConformanceEdgePair[];
    extra: ConformanceEdgePair[];
    unmappable_realized_edges: number;
  };
  illegal_dependencies: {
    illegal_count: number;
    illegal_dependencies: ConformanceIllegalEdge[];
    unranked_edges: number;
    layer_order: string[];
  };
  summary: {
    realization_coverage: number;
    conformance_score: number;
    illegal_count: number;
    unrealized_components: number;
    orphan_artifacts: number;
  };
}

export interface ConformanceEnvelope {
  data: ArchitectureConformanceResult;
  meta: { cached: boolean };
}

export async function getArchitectureConformance(
  projectId: string,
  opts: { fresh?: boolean } = {},
): Promise<ConformanceEnvelope> {
  const sp = new URLSearchParams({ projectId });
  if (opts.fresh) sp.set('fresh', 'true');
  const res = await authFetch(`/api/governance/architecture/conformance?${sp.toString()}`);
  if (!res.ok) {
    // Read the body. Every throw in this module used to carry a status and
    // nothing else — not even `statusText` — so the governance dashboard told
    // the user `Failed to load: conformance fetch failed: 502`
    // (`projects/[id]/governance/+page.svelte:43` renders `e.message` verbatim)
    // while the upstream's own sentence sat unread in the same payload.
    // requirements_management is reached through fr's BFF, so its refusals
    // arrive as `{error:{code,message,upstream:{status,body:{detail}}}}` — the
    // exact shape `error-detail.ts` exists to unwrap.
    //
    // `errorDetailOf`, not `errorDetailFrom`: this Response is UNDRAINED here.
    // Picking the wrong one of the pair silently returns ''.
    const detail = await errorDetailOf(res);
    throw new Error(`conformance fetch failed: ${res.status}${detail ? ` — ${detail}` : ''}`);
  }
  return (await res.json()) as ConformanceEnvelope;
}

/**
 * Honest empty-state detector. The upstream returns
 * `realization_coverage = 1.0` when `total_application_components === 0`
 * (perfect score on an empty model — `conformance.py:175`), which is
 * indistinguishable from "perfectly conformant" by the score alone. Branch
 * on the component count explicitly, NOT just the score, so the dashboard
 * never tells the user "100% — perfect compliance" for an empty tenant.
 */
export function isEmptyModel(result: ArchitectureConformanceResult): boolean {
  return result.realization_coverage.total_application_components === 0;
}
