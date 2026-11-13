// degradation.ts — pure chunk-ratio formatting shared by the two surfaces that
// have to tell a researcher their document is only PARTLY in the graph:
// DocumentUploadPanel (the row pill + note) and IngestionProgress (the stepper
// cap). Lives in its own module rather than in either component's
// `<script module>` because DocumentUploadPanel imports IngestionProgress —
// exporting from one into the other would be an import cycle.
//
// WHY THIS EXISTS AT ALL
// karma PR #127 gave the pipeline "partial credit": a job that indexed 18 of
// 137 chunks now COMPLETES. The row used to render a clean green `completed`.
// George's rule: a researcher must never be shown a silently-incomplete graph.
//
// THE NO-FABRICATION RULE (the whole point of this file)
// A ratio is only ever rendered from numbers the backend actually reported.
// Two shapes must NOT produce a ratio:
//   - `chunks_total == null`  → we do not know the denominator. Inventing one
//     ("18 of 18") is worse than saying nothing.
//   - `chunks_failed === 0`   → karma's OTHER partial-credit shape: every chunk
//     succeeded but extraction inside them was incomplete. "18 of 18 chunks
//     indexed" under a warning banner reads as a contradiction and trains the
//     researcher to ignore the warning.

/** Generic fallback used when the counts cannot honestly produce a ratio. */
export const DEGRADED_GENERIC = 'Partial / degraded indexing';

/** The three chunk counters, in whichever naming the caller happens to hold. */
export interface ChunkCounts {
  chunksIndexed?: number | null;
  chunksFailed?: number | null;
  chunksTotal?: number | null;
}

/**
 * `"<indexed> of <total> chunks indexed"`, or `null` when the reported counts
 * cannot support a ratio without fabricating part of it.
 *
 * `indexed` prefers the backend's own `chunksIndexed`; only when that is absent
 * does it derive `total - failed`. Both legs are still gated on a real
 * `chunksTotal` AND a non-zero `chunksFailed`.
 */
export function formatChunkRatio(counts: ChunkCounts): string | null {
  const { chunksIndexed, chunksFailed, chunksTotal } = counts;

  // No denominator, or nothing measurably failed → no ratio. `!= null` covers
  // both null and undefined; `> 0` is what rejects the 18/18 shape.
  if (chunksTotal == null || chunksFailed == null || !(chunksFailed > 0)) return null;

  const indexed = chunksIndexed ?? chunksTotal - chunksFailed;
  return `${indexed} of ${chunksTotal} chunks indexed`;
}

/**
 * The counts line for a degraded document: the honest ratio when we have one,
 * else the generic label. Callers that render a headline already carrying the
 * generic wording should skip the line when it equals `DEGRADED_GENERIC`.
 */
export function degradationLine(counts: ChunkCounts): string {
  return formatChunkRatio(counts) ?? DEGRADED_GENERIC;
}
