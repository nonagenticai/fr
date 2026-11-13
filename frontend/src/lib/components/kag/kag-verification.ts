/**
 * Verification overlay data for the graph canvas — READ ONLY.
 *
 * Composes existing Scientific-Processor reads into a `nodeId → {score, flags}`
 * map the canvas renders as a badge ring + risk dot. Two passes:
 *   · fast   — one graph-wide `pipeline/anomalies` GET flags entities whose
 *              verification score dropped (cheap, always run);
 *   · deep   — an opt-in, concurrency-capped fan-out over the *visible* ids
 *              calling `verify/integrity` (+ `topology/contradictions`), memoised
 *              per id so re-runs and re-renders don't re-fetch.
 *
 * It deliberately never calls the write-back pipeline endpoints
 * (`pipeline/batch` / `pipeline/trigger`) — the customer graph stays read-only.
 */

import { researchApi } from '$lib/api/research';

export interface NodeVerification {
  score?: number;
  flags: string[];
}

export type VerificationMap = Record<string, NodeVerification>;

// Per-id memo of the (expensive) deep result, kept for the component's lifetime
// of the module so switching overlays / re-rendering doesn't re-hit the network.
const deepMemo = new Map<string, NodeVerification>();

/**
 * Invalidate memoised deep-verification results so the next `fetchVerification`
 * recomputes them from source. Pass the ids being re-verified, or omit to clear
 * the whole memo. Without this a re-verify keeps badging the stale score until a
 * full page reload.
 */
export function clearVerificationMemo(ids?: string[]): void {
  if (!ids) {
    deepMemo.clear();
    return;
  }
  for (const id of ids) deepMemo.delete(id);
}

function pickId(rec: Record<string, unknown>): string | null {
  for (const k of ['entity_id', 'id', 'node_id', 'element_id', 'uuid']) {
    const v = rec[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return null;
}

function pickNum(rec: Record<string, unknown>, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = rec[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Run `worker` over `items` with at most `concurrency` in flight. */
async function pool<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let i = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      await worker(items[idx]!);
    }
  });
  await Promise.all(runners);
}

export interface FetchVerificationOpts {
  /** Run the per-node integrity/contradiction fan-out (default true). */
  deep?: boolean;
  concurrency?: number;
  /** Called with the running count of resolved nodes, for progress UI. */
  onProgress?: (done: number, total: number) => void;
  /**
   * Re-verify from source: drop any memoised deep result for the given ids
   * before the fan-out, so a re-run reflects a fresh score instead of the value
   * captured on the first verify.
   */
  force?: boolean;
}

/**
 * Build the verification overlay for a set of visible node ids. Never throws —
 * individual failures are swallowed so a partial overlay still renders.
 */
export async function fetchVerification(
  ids: string[],
  opts: FetchVerificationOpts = {},
): Promise<VerificationMap> {
  const { deep = true, concurrency = 4, onProgress, force = false } = opts;
  const out: VerificationMap = {};

  // Fast pass: graph-wide anomalies (dropped scores). Non-fatal if it fails.
  try {
    const anomalies = await researchApi.pipelineAnomalies();
    for (const a of anomalies.anomalies ?? []) {
      const id = pickId(a);
      if (!id) continue;
      out[id] = {
        score: pickNum(a, ['score', 'current_score', 'integrity_score', 'latest_score']),
        flags: ['anomaly'],
      };
    }
  } catch {
    /* anomalies are best-effort context */
  }

  if (!deep || ids.length === 0) return out;

  // A forced re-verify must not be served the stale memoised badge — drop these
  // ids so the pool below recomputes them from source.
  if (force) clearVerificationMemo(ids);

  let done = 0;
  await pool(ids, concurrency, async (id) => {
    let v = deepMemo.get(id);
    if (!v) {
      v = { flags: [] };
      try {
        const r = await researchApi.verifyIntegrity({ entity_id: id });
        if (typeof r.integrity_score === 'number') v.score = r.integrity_score;
      } catch {
        /* entity may not be in the scientific store yet */
      }
      try {
        const c = await researchApi.topologyContradictions({ entity_id: id });
        // Upstream emits `contradiction_pairs` + `total_contradictions`, never a `contradictions`
        // array — reading the old key meant this badge never fired.
        const n = c.total_contradictions ?? c.contradiction_pairs?.length ?? 0;
        if (n > 0) v.flags.push('contradiction');
      } catch {
        /* non-fatal */
      }
      deepMemo.set(id, v);
    }
    const prior = out[id];
    out[id] = {
      score: v.score ?? prior?.score,
      flags: Array.from(new Set([...(prior?.flags ?? []), ...v.flags])),
    };
    onProgress?.(++done, ids.length);
  });

  return out;
}
