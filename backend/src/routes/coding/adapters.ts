// src/routes/coding/adapters.ts
//
// Pure response-shapers for the namespaced Stack-2 coding read surface
// (routes/coding/handlers.ts). Moved VERBATIM from the retired Stack-1
// routes/quality.ts — the spine (integrations/coding/spine.ts) is a pure
// pass-through returning the raw upstream wire shapes, and these adapters are
// the shaping seam that turns them into the shapes the fr frontend expects.
//
// Kept pure (no I/O) so they unit-test in isolation
// (tests/unit/routes/coding/adapters.test.ts).

/**
 * Normalize coding-gateway's /api/graphs/{c}/augmented response
 * ({nodes:[{id,type,properties}], edges:[{source,target,relationship,properties}]})
 * into the shape the fr frontend expects
 * ({nodes:[{id,label,type,metadata}], edges:[{source,target,type}], timestamp}).
 */
export function adaptAugmentedGraph(data: any): {
  nodes: Array<{ id: string; label: string; type: string; metadata: any }>;
  edges: Array<{ source: string; target: string; type: string }>;
  timestamp: string;
} {
  const rawNodes: any[] = Array.isArray(data?.nodes) ? data.nodes : [];
  const rawEdges: any[] = Array.isArray(data?.edges) ? data.edges : [];
  const nodes = rawNodes.map((n) => {
    const props = (n?.properties && typeof n.properties === 'object') ? n.properties : {};
    return {
      id: String(n?.id ?? ''),
      label: String(props.name ?? props.label ?? n?.id ?? ''),
      type: String(n?.type ?? 'default'),
      metadata: props,
    };
  });
  const edges = rawEdges.map((e) => ({
    source: String(e?.source ?? ''),
    target: String(e?.target ?? ''),
    type: String(e?.relationship ?? e?.type ?? 'dependency'),
  }));
  return {
    nodes,
    edges,
    timestamp:
      typeof data?.timestamp === 'string' ? data.timestamp : new Date().toISOString(),
  };
}

interface QualityGateCheck {
  name: string;
  description: string;
  passed: boolean;
  actual: number;
  threshold: number;
}

interface QualityGateResultRaw {
  passed: boolean;
  overall_score: number;
  grade: string;
  // coding-analysis abstains (grade "N/A", overall_score -1.0) when no analysis
  // tool succeeded. `inconclusive` is the authoritative honest-abstain flag
  // (coding-analysis #65/#66) — an inconclusive gate is NOT a warning.
  inconclusive?: boolean;
  // Per-tool provenance (coding-analysis PR-U1). `partial` = some (not all)
  // tools completed, so the grade is real but computed from a subset. The
  // lists name what ran and what did not, for a "graded on N of M tools" caveat.
  partial?: boolean;
  tools_attempted?: string[];
  tools_succeeded?: string[];
  tools_failed?: string[];
  gate_checks: QualityGateCheck[];
  recommendations: string[];
  // coding-analysis #107 (stored results): the graded run's stored status
  // (complete|partial|inconclusive|failed|not_analyzed), its id, the commit it
  // measured (null = unknown), and whether the gate graded a stored row or
  // analysed on a miss. `not_analyzed` comes with a 0.0 overall_score on an
  // abstaining gate — that 0 is NOT a measurement.
  status?: string | null;
  result_id?: string | null;
  commit_sha?: string | null;
  source?: 'stored' | 'analyzed' | null;
}

/**
 * Adapt coding-analysis' QualityGateResult into the shape the frontend expects.
 * coding-analysis doesn't carry a timestamp; synthesize one matching the fallback
 * pattern used by adaptAugmentedGraph.
 */
export function adaptQualityGateResult(
  containerName: string,
  data: unknown
): Record<string, unknown> {
  const raw = data as QualityGateResultRaw;
  const checks = Array.isArray(raw?.gate_checks) ? raw.gate_checks : [];
  // Strict `=== true`: a stray non-boolean (e.g. the string "false") must NOT
  // mute a real failure as "inconclusive".
  // Nothing stored and nothing measured: a distinct state, never a score.
  const notAnalyzed = raw?.status === 'not_analyzed';
  const inconclusive = notAnalyzed || raw?.inconclusive === true;
  // A negative or non-finite score is never a real measurement (the -1.0 abstain
  // sentinel, or garbage) — treat it as "no datum" even if the flag is absent.
  const rawScore = raw?.overall_score;
  const hasRealScore =
    !inconclusive && typeof rawScore === 'number' && Number.isFinite(rawScore) && rawScore >= 0;
  // `partial` and `inconclusive` are mutually exclusive by construction upstream;
  // force partial off when inconclusive as a belt (a partial caveat over an
  // abstained scan would be nonsense). Same strict `=== true`.
  const toolsFailed = Array.isArray(raw?.tools_failed) ? raw.tools_failed : [];
  const toolsAttempted = Array.isArray(raw?.tools_attempted) ? raw.tools_attempted : [];
  const toolsSucceeded = Array.isArray(raw?.tools_succeeded) ? raw.tools_succeeded : [];
  const partial = !inconclusive && raw?.partial === true;
  return {
    container_name: containerName,
    // `inconclusive` wins ahead of the pass/grade ternary: an un-analyzable
    // repo (passed:false, grade:"N/A") must NOT collapse to a reassuring
    // 'warning'. "This is not a pass" — but it is also not a graded failure.
    status: notAnalyzed
      ? 'not_analyzed'
      : inconclusive
      ? 'inconclusive'
      : raw?.passed
        ? 'passed'
        : raw?.grade === 'F'
          ? 'failed'
          : 'warning',
    inconclusive,
    partial,
    tools_attempted: toolsAttempted,
    tools_succeeded: toolsSucceeded,
    tools_failed: toolsFailed,
    timestamp: new Date().toISOString(),
    // Never leak coding-analysis' -1.0 sentinel (or any negative/non-finite
    // value) as a score. "No datum" is null, not 0 (a 0 reads as a real,
    // terrible score, so a genuine 0 IS surfaced).
    overall_score: hasRealScore ? rawScore : null,
    grade: notAnalyzed ? '' : raw?.grade ?? '',
    result_status: typeof raw?.status === 'string' ? raw.status : null,
    result_id: raw?.result_id ?? null,
    commit_sha: raw?.commit_sha ?? null,
    source: raw?.source ?? null,
    // An abstaining not_analyzed gate carries one synthetic check with
    // actual 0.0 — rendering it would show a fake "0" measurement.
    metrics: (notAnalyzed ? [] : checks).map((c) => ({
      name: c.name,
      description: c.description,
      status: c.passed ? 'passed' : 'failed',
      value: c.actual,
      threshold: c.threshold,
    })),
    recommendations: Array.isArray(raw?.recommendations) ? raw.recommendations : [],
  };
}

/**
 * Wrap a stored dependency-report snapshot as a "degraded" live response.
 * Exported (and pure) so it can be unit-tested the same way adaptQualityGateResult
 * is — the handler only wires it to the spine's degraded fallback + cache I/O.
 */
export function buildDegradedDependencyReport(
  report: Record<string, unknown>,
  computedAt: string | Date | undefined
): Record<string, unknown> {
  return { ...report, degraded: true, stale_as_of: computedAt };
}
