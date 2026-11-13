// Defensive normalisation for neo4j-shaped graph payloads.
//
// KAG's nodes/relationships come from several upstream endpoints (semantic
// search, graph traversal, similar-nodes) whose field names drift across
// versions and across graph-adapter vs kag-graph. Rather than couple the
// canvas to one shape, we probe a small set of aliases here. Node *display*
// label and node *type* (neo4j label) are deliberately resolved from different
// key sets — a node's human name (e.g. "Refund policy") is not its type
// (e.g. "Policy") — so colour-by-type and the on-node caption stay distinct.

export type GraphRecord = Record<string, unknown>;

function firstString(obj: GraphRecord, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return undefined;
}

/**
 * One displayable property row. Scalars/arrays are safe to show inline
 * (`raw:false`); an object value is pretty-printed into `value` and flagged
 * `raw:true` so every consumer can render it behind an opt-in disclosure rather
 * than dumping naked JSON into the customer-facing view.
 */
export type KagDetailRow = { key: string; value: string; raw: boolean };

// Keys whose value is usually the caller's own input echoed back by an analytic
// endpoint — surfacing them as "metrics" is a lie. Dropped when `dropInputEcho`.
const INPUT_ECHO_KEYS = new Set([
  'text', 'input', 'content', 'query', 'prompt', 'sentence', 'document',
]);

/**
 * Normalise a loosely-typed payload bag into displayable rows. The single place
 * `JSON.stringify` runs for property display: scalar → labeled value; array →
 * friendly `"N items"`; object → pretty JSON carried in `value` with `raw:true`
 * so callers gate it behind an opt-in `<details>`, never inline. Skips
 * null/undefined/empty and any `exclude`d (or, with `dropInputEcho`, echoed)
 * keys. Reused by `nodeDetailOf`/`edgeDetailOf` and the KAG tab detail trails.
 */
export function kagDetailRows(
  bag: GraphRecord,
  exclude: Iterable<string> = [],
  opts: { dropInputEcho?: boolean } = {},
): KagDetailRow[] {
  const ex = exclude instanceof Set ? exclude : new Set(exclude);
  const rows: KagDetailRow[] = [];
  for (const [k, v] of Object.entries(bag)) {
    if (ex.has(k)) continue;
    if (opts.dropInputEcho && INPUT_ECHO_KEYS.has(k)) continue;
    if (v === null || v === undefined || v === '') continue;
    if (Array.isArray(v)) {
      rows.push({ key: k, value: `${v.length} item${v.length === 1 ? '' : 's'}`, raw: false });
    } else if (typeof v === 'object') {
      rows.push({ key: k, value: JSON.stringify(v, null, 2), raw: true });
    } else {
      rows.push({ key: k, value: String(v), raw: false });
    }
  }
  return rows;
}

/** Stable id for a node; falls back to a positional id so unlabelled nodes still render. */
export function nodeIdOf(n: GraphRecord, fallbackIndex = 0): string {
  const id = firstString(n, ['id', 'entity_id', 'node_id', 'element_id', 'uuid']);
  if (id) return id;
  // Some payloads nest the id under `properties`.
  const props = n.properties;
  if (props && typeof props === 'object') {
    const pid = firstString(props as GraphRecord, ['id', 'entity_id', 'uuid']);
    if (pid) return pid;
  }
  const name = firstString(n, ['name', 'title']);
  return name ?? `idx-${fallbackIndex}`;
}

/** Human-readable caption for a node. */
export function nodeLabelOf(n: GraphRecord): string {
  const direct = firstString(n, ['name', 'title', 'display_name', 'text']);
  if (direct) return direct;
  const props = n.properties;
  if (props && typeof props === 'object') {
    // KAG entity/document nodes carry their name in `properties.text`
    // ("Stanford University", or "Title: … Abstract: …" for documents).
    const p = firstString(props as GraphRecord, ['name', 'title', 'display_name', 'text', 'value']);
    if (p) return p;
  }
  return firstString(n, ['label', 'id', 'entity_id']) ?? '(unnamed)';
}

/** neo4j label / category used for colour-by-type. */
export function nodeTypeOf(n: GraphRecord): string {
  // Array-of-labels shape (neo4j native): take the first.
  const labels = n.labels;
  if (Array.isArray(labels) && labels.length > 0 && typeof labels[0] === 'string') {
    return labels[0] as string;
  }
  const t = firstString(n, ['type', 'node_type', 'entity_type', 'category', 'kind']);
  if (t) return t;
  // `label` is only a type when it isn't already serving as the display name.
  const label = typeof n.label === 'string' ? n.label : undefined;
  const name = firstString(n, ['name', 'title']);
  if (label && label !== name) return label;
  return 'Entity';
}

/** Relationship endpoints + type, tolerating start|end|from|to|source_id|target_id. */
export function relEndpoints(r: GraphRecord): {
  source: string;
  target: string;
  type: string;
} {
  const source =
    firstString(r, [
      'source', 'start', 'from', 'source_id', 'start_id', 'from_id',
      'start_node_id', 'start_node', // neo4j graph_traversal path edges
    ]) ?? '';
  const target =
    firstString(r, [
      'target', 'end', 'to', 'target_id', 'end_id', 'to_id',
      'end_node_id', 'end_node',
    ]) ?? '';
  const type =
    firstString(r, ['type', 'relationship_type', 'rel_type', 'label']) ?? '';
  return { source, target, type };
}

/**
 * Pre-map subgraph API edges (`{source_id, target_id, type, properties}`) into the
 * `{source, target, type}` shape `KagGraph`'s internal edge picker understands. Its
 * picker only reads `source/start/from`+`target/end/to`, so raw `source_id/target_id`
 * edges would be silently dropped. Resolves endpoints via `relEndpoints` (spreading the
 * original record through, so `properties` and the source `*_id` keys survive).
 */
export function mapSubgraphEdges(edges: GraphRecord[]): GraphRecord[] {
  return edges.map((e) => {
    const { source, target, type } = relEndpoints(e);
    return { ...e, source, target, type };
  });
}

// Structural keys that carry an edge's identity/endpoints/type — everything the
// detail panel renders as first-class chrome — so they are excluded from the
// generic "properties" table (which shows only the domain payload). Mirrors the
// node-panel STRUCTURAL set but for the relationship shape.
const EDGE_STRUCTURAL = new Set([
  'id', 'edge_id', 'element_id', 'uuid',
  'source', 'start', 'from', 'source_id', 'start_id', 'from_id', 'start_node_id', 'start_node',
  'target', 'end', 'to', 'target_id', 'end_id', 'to_id', 'end_node_id', 'end_node',
  'type', 'relationship_type', 'rel_type', 'label',
  'properties', 'success',
]);

/**
 * Full inspectable shape of a relationship: its stable id (when the upstream
 * carried one), endpoints + type (reusing `relEndpoints`), and the domain
 * `properties` as display rows. Property rows prefer an explicit `properties`
 * bag, else the top-level keys minus the structural ones above — the same
 * strategy `KagNodeDetailPanel` uses for nodes.
 */
export function edgeDetailOf(r: GraphRecord): {
  id?: string;
  type: string;
  source: string;
  target: string;
  properties: KagDetailRow[];
} {
  const { source, target, type } = relEndpoints(r);
  const id = firstString(r, ['id', 'edge_id', 'element_id', 'uuid']);

  const bag =
    r.properties && typeof r.properties === 'object'
      ? (r.properties as GraphRecord)
      : r;
  // Only exclude the structural chrome when reading the top-level bag; an
  // explicit `properties` bag is all domain payload.
  const properties = kagDetailRows(bag, bag === r ? EDGE_STRUCTURAL : []);
  return { id, type, source, target, properties };
}

// Semantic-search hits carry a numeric retrieval score under one of a few names;
// probe them (top level, then the properties bag). Kept separate from the property
// table so a score renders as its own badge, not a row.
//
// ⚠️ These four names are NOT one scale, and none of them is a 0–1 confidence by
// construction. The producer says so itself — `kag_graph_service`
// `src/repositories/chunks_repo.py`:
//   :561  "`score` is `1 - cosine_distance` (higher is better, in [0, 2])"
//   :627  "`score` is `ts_rank_cd` (higher is better, unbounded)"
// so a field literally named `score` can arrive as 1.42 or 7.3. `relevance` and
// `_score` have no documented range at all. That is why `nodeDetailOf` also
// reports WHICH key the number came from (`scoreField`): the renderer must label
// the raw value with its field name and may only draw a meter for a name whose
// range we can vouch for. Multiplying any of these by 100 and printing a `%` is a
// fabrication — do not "restore" it.
const NODE_SCORE_KEYS = ['score', 'similarity', 'relevance', '_score'];

/**
 * The ONLY score key whose unit is a bounded similarity we are willing to draw a
 * meter for. `score` is documented as `[0, 2]` (cosine) or unbounded (`ts_rank_cd`);
 * `relevance`/`_score` are undocumented. A value from those may still be shown —
 * labeled with its field name — but never as a filled bar, because a bar asserts a
 * fraction of a known maximum. Renderers must ALSO range-check the value: a name
 * is a claim about the unit, not a guarantee about the number.
 */
export const NODE_SCORE_BOUNDED_KEYS: ReadonlySet<string> = new Set(['similarity']);

/**
 * True only when this number can be honestly drawn as a 0–1 meter: the field name
 * is one whose unit we can vouch for AND the value actually lies in [0, 1].
 * Both halves are required — see `NODE_SCORE_KEYS` above.
 */
export function nodeScoreIsBounded(value: number | null, field: string | null): boolean {
  if (value === null || field === null) return false;
  if (!NODE_SCORE_BOUNDED_KEYS.has(field)) return false;
  return Number.isFinite(value) && value >= 0 && value <= 1;
}

/**
 * The raw score rendered for a human: at most 3 decimal places, trailing zeros
 * dropped, and NO unit applied. It is deliberately not a percentage — the value's
 * scale is unknown (see `NODE_SCORE_KEYS`), and multiplying an unbounded
 * `ts_rank_cd` by 100 invents a confidence. Callers pair it with `scoreField` so
 * the reader sees `score 1.42`, never a bare `142%`.
 */
export function formatNodeScore(value: number): string {
  return String(Number(value.toFixed(3)));
}

/** The retrieval score AND the key it came from — the key is what names its unit. */
function nodeScoreOf(n: GraphRecord): { value: number; key: string } | null {
  const props =
    n.properties && typeof n.properties === 'object'
      ? (n.properties as GraphRecord)
      : {};
  for (const bag of [n, props]) {
    for (const k of NODE_SCORE_KEYS) {
      const v = bag[k];
      if (typeof v === 'number' && Number.isFinite(v)) return { value: v, key: k };
    }
  }
  return null;
}

// Structural keys already surfaced as node identity (id / name / type / labels) —
// excluded from the generic property table, alongside the score keys (rendered as a
// meter). Mirrors the inline set in `KagNodeDetailPanel` + the `EDGE_STRUCTURAL`
// pattern above, so a search-result card and the detail panel agree on what counts
// as a "property".
const NODE_STRUCTURAL = new Set([
  'id', 'entity_id', 'node_id', 'element_id', 'uuid', 'name', 'title',
  'label', 'labels', 'type', 'node_type', 'entity_type', 'properties',
  ...NODE_SCORE_KEYS,
]);

/**
 * Full inspectable shape of a node: its stable id (when present), human label +
 * neo4j type (reusing `nodeIdOf`/`nodeLabelOf`/`nodeTypeOf`), the raw retrieval
 * `score` (semantic-search hits) or null PLUS `scoreField` — the key that number
 * came from — and the domain `properties` as display rows. Property rows prefer an
 * explicit `properties` bag, else the top-level keys minus the structural ones
 * above — the same strategy `KagNodeDetailPanel` and `edgeDetailOf` use.
 *
 * `score` is deliberately NOT normalised to 0–1: the four probed keys are four
 * different units (see `NODE_SCORE_KEYS`), so the only honest thing to hand a
 * renderer is the number and the name of its unit. `scoreField` is an ADDED field —
 * `score` keeps its existing shape for existing callers.
 */
export function nodeDetailOf(n: GraphRecord): {
  id?: string;
  label: string;
  type: string;
  score: number | null;
  scoreField: string | null;
  properties: KagDetailRow[];
} {
  const id = firstString(n, ['id', 'entity_id', 'node_id', 'element_id', 'uuid']);
  const bag =
    n.properties && typeof n.properties === 'object'
      ? (n.properties as GraphRecord)
      : n;
  const properties = kagDetailRows(bag, bag === n ? NODE_STRUCTURAL : []);
  const scored = nodeScoreOf(n);
  return {
    id,
    label: nodeLabelOf(n),
    type: nodeTypeOf(n),
    score: scored === null ? null : scored.value,
    scoreField: scored === null ? null : scored.key,
    properties,
  };
}
