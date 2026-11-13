/**
 * KAG retrieval-quality benchmark client.
 *
 * Thin wrapper over `assetFetch` for the backend's `/api/assets/kag/benchmarks`
 * route, which serves a committed, harness-generated summary contract (see
 * `kag/eval/summary.py`). The eval runs offline, so this is a per-deploy
 * snapshot — the frontend never hardcodes the numbers; it renders whatever the
 * endpoint returns. Response shape mirrors the harness JSON.
 */

import { assetFetch } from './assets';

/** One ablation-ladder rung (a retrieval mode's mean scores). */
export interface LadderRow {
  mode: string;
  n: number;
  recall_at_5: number | null;
  cover_em: number | null;
  judge_correct: number | null;
  abstain_rate: number | null;
  bridge_fires: number;
  chunks_per_q: number;
}

/** H1 verdict: does `full` beat naive `dense` on the primary metric? */
export interface H1Verdict {
  metric: string;
  full: number | null;
  dense: number | null;
  delta: number | null;
  verdict: string;
}

/** Paired `full − full_nobridge` delta + 95% CI for one metric. */
export interface BridgeAttribution {
  metric: string;
  full: number | null;
  full_nobridge: number | null;
  delta: number | null;
  ci_low: number | null;
  ci_high: number | null;
  significant: boolean;
  paired_n: number;
}

export interface BenchmarkResult {
  benchmark: string;
  n: number;
  scored: number;
  ladder: LadderRow[];
  h1: H1Verdict | null;
  bridge_attribution: BridgeAttribution[];
}

export interface BenchmarkSummary {
  generated_at: string;
  judge: string;
  gate: string;
  benchmarks: BenchmarkResult[];
  /**
   * Retrieval modes DELIBERATELY absent from every `ladder` above.
   *
   * TOP-LEVEL, not per-row, precisely because there is no row: a withheld mode
   * has no numbers to hang a field on, and inventing an all-null row to carry
   * one would put a rung on the ladder that the reader would then try to read.
   *
   * Shipped example: `hybrid_rerank` is kag's server default AND this UI's
   * default. The n50-20260902 run measured it at 2026-09-02 20:43Z; kag #168
   * merged 73 minutes later and changed that mode's near-dup collapse, which
   * gitops now runs live as `KAG_NEAR_DUP_COLLAPSE_RERANK=1`. The measurement
   * describes code that no longer runs, so it is withheld rather than
   * published as current.
   */
  unmeasured_modes?: string[];
  /** Why `unmeasured_modes` were withheld. Rendered verbatim; never omitted when the list is non-empty. */
  unmeasured_reason?: string;
}

/** Fetch the retrieval-quality benchmark summary. Throws `AssetError` on failure. */
export async function fetchKagBenchmarks(): Promise<BenchmarkSummary> {
  return assetFetch<BenchmarkSummary>('/api/assets/kag/benchmarks');
}
