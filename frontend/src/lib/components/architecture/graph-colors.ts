// Honest colour + label vocabulary for the Architecture map (coding D1/D2).
//
// GROUND TRUTH (traced against the coding read surface, not assumed):
//   backend/src/routes/coding/adapters.ts `adaptAugmentedGraph` maps each
//   upstream node to `{ id, label, type, metadata }` where:
//     • `type`     = the raw upstream node kind (module | class | function |
//                    service | …) — a CODE-GRAPH TYPE, not an architectural
//                    LAYER. There is NO presentation/business/data/integration/
//                    infrastructure signal anywhere upstream.
//     • `metadata` = the raw upstream `properties` bag (name, label, …). The
//                    fixtures (tests/unit/routes/coding/adapters.test.ts) carry
//                    only `name`/`label`. There is NO `complexity`,
//                    `cyclomatic_complexity`, `issues`, or `issue_count`.
//
// Consequences (why this module exists):
//   D2  Colour by the REAL `type` vocabulary and build the legend from the types
//       actually present — never a fixed five-layer legend whose keys
//       (presentation/business/…) can never match `type`, which made every node
//       fall through to the grey default.
//   D1  "Hotspot" mode encodes the ONLY risk proxy the data provides — node
//       connection degree (how many edges touch a node) — so it is labelled as
//       connectivity, never "High complexity / issues".

// Categorical palette (Tableau-10-ish). A type is mapped deterministically so a
// given type keeps its colour across re-renders AND matches its legend swatch.
// Raw hex lives here (a plain .ts module) rather than in a Svelte `style=`/class
// context, so it is outside the design-tokens linter's rule surface; d3 paints
// these into SVG `fill` attributes where CSS custom properties don't resolve.
export const TYPE_PALETTE: readonly string[] = [
  '#3b82f6', // blue
  '#10b981', // emerald
  '#8b5cf6', // violet
  '#f59e0b', // amber
  '#ec4899', // pink
  '#14b8a6', // teal
  '#6366f1', // indigo
  '#f97316', // orange
];

// Grey — used ONLY when a node genuinely has no `type`. This is honest: an
// untyped node is grey; a typed node always gets a categorical colour.
export const TYPE_FALLBACK = '#6b7280';

/** Deterministic categorical colour for a code-graph node `type`. */
export function typeColor(type: string | null | undefined): string {
  const key = (type ?? '').trim();
  if (!key || key === 'default') return TYPE_FALLBACK;
  let h = 0;
  for (let i = 0; i < key.length; i++) {
    h = (h * 31 + key.charCodeAt(i)) >>> 0;
  }
  return TYPE_PALETTE[h % TYPE_PALETTE.length];
}

/**
 * Distinct node types present in the graph, first-seen order — the source for
 * an honest legend (its keys are exactly the data's `type` values). Accepts
 * either `type` or the legacy `layer` alias the graph node still carries.
 *
 * The empty/missing sentinel MUST match what the graph feeds `typeColor` so the
 * legend swatch equals the on-canvas colour. The graph builds its node fill from
 * `node.type || 'default'` (ArchitectureView), so an untyped node is `'default'`
 * here too — `typeColor('default')` returns the grey fallback on BOTH paths.
 * (Using a different sentinel, e.g. 'unknown', made the legend invent a non-grey
 * swatch for nodes the graph drew grey — coding D2 regression.)
 */
export function distinctTypes(
  nodes: ReadonlyArray<{ type?: string; layer?: string }>,
): string[] {
  const seen: string[] = [];
  for (const n of nodes) {
    const t = (n.type ?? n.layer ?? '') || 'default';
    if (!seen.includes(t)) seen.push(t);
  }
  return seen;
}

/**
 * Connectivity heat: a node's degree relative to the busiest node in the graph,
 * clamped to 0..1 (1 = the most-connected node / hub). This is the actual and
 * ONLY signal the "hotspot" toggle encodes — there is no complexity/issue data
 * upstream, so nothing else feeds it.
 */
export function connectivityScore(
  connectionCount: number,
  maxConnections: number,
): number {
  if (maxConnections <= 0) return 0;
  return Math.min(1, Math.max(0, connectionCount / maxConnections));
}

// Heat ramp for the connectivity score. Raw hex for the same SVG-fill reason as
// the palette above.
export function connectivityColor(score: number): string {
  if (score > 0.66) return '#ef4444'; // red — hub (highest degree)
  if (score > 0.33) return '#f59e0b'; // amber — moderately connected
  return '#22c55e'; // green — sparsely connected
}

/**
 * Legend for connectivity mode — the honest replacement for the old
 * "High complexity / issues · Medium · Low / healthy" legend, which advertised
 * a signal the data never carried. Labels describe DEGREE, the real encoding.
 */
export const CONNECTIVITY_LEGEND: ReadonlyArray<{ color: string; label: string }> = [
  { color: '#ef4444', label: 'Highly connected (hub)' },
  { color: '#f59e0b', label: 'Moderately connected' },
  { color: '#22c55e', label: 'Sparsely connected' },
];
