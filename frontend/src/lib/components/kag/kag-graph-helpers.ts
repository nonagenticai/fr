// Response-shape adapters for the graph-explorer analytics overlays.
//
// The analytics endpoints (stats / community / centrality / path) each return
// a loosely-typed payload whose exact field names vary by graph-adapter
// version. These helpers pull the one or two fields the explorer actually needs
// and normalise them, so the tab code stays about *interaction*, not parsing.

import { nodeIdOf, type GraphRecord } from './graph-normalise';

type Rec = Record<string, unknown>;

function num(obj: Rec, keys: string[]): number | undefined {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return undefined;
}

/** Stat tiles: concepts / relationships / documents. Everything defensive. */
export function readStats(raw: unknown): {
  entities?: number;
  relationships?: number;
  documents?: number;
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const entities = num(o, ['node_count', 'total_nodes', 'num_nodes', 'nodes', 'entity_count']);
  const relationships = num(o, [
    'edge_count', 'relationship_count', 'total_edges', 'num_edges', 'edges', 'total_relationships',
  ]);
  // A direct document count wins when the graph-adapter reports one; otherwise
  // fall back to counting the "document" bucket in the entity-type distribution.
  let documents = num(o, ['document_count', 'num_documents', 'total_documents', 'documents']);
  if (documents === undefined) {
    const dist = (o.entity_type_distribution ?? o.node_type_distribution ?? o.label_distribution) as Rec | undefined;
    if (dist && typeof dist === 'object') {
      for (const [k, v] of Object.entries(dist)) {
        if (/document/i.test(k) && typeof v === 'number') documents = v;
      }
    }
  }
  return { entities, relationships, documents };
}

/** community response → { nodeId: communityIndex } for colour-by-cluster. */
export function readCommunities(raw: unknown): {
  map: Record<string, number>;
  count: number;
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const src = (o.entity_communities ?? o.communities ?? o.node_communities) as Rec | undefined;
  const map: Record<string, number> = {};
  if (src && typeof src === 'object') {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v === 'number') map[k] = v;
      else if (typeof v === 'string' && /^\d+$/.test(v)) map[k] = Number(v);
    }
  }
  const count =
    num(o, ['number_of_communities', 'community_count', 'num_communities']) ??
    new Set(Object.values(map)).size;
  return { map, count };
}

/** centrality response → { nodeId: score } normalised to 0–1 by the max. */
export function readCentrality(raw: unknown): Record<string, number> {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const src = (o.entity_scores ?? o.scores ?? o.centrality) as Rec | undefined;
  const out: Record<string, number> = {};
  if (!src || typeof src !== 'object') return out;
  let max = 0;
  for (const v of Object.values(src)) if (typeof v === 'number' && v > max) max = v;
  const denom = max > 0 ? max : 1;
  for (const [k, v] of Object.entries(src)) {
    if (typeof v === 'number') out[k] = v / denom;
  }
  return out;
}

/**
 * path response → the first/shortest path, decomposed into: the ordered node
 * `ids` (for highlighting), plus any node/relationship OBJECTS the path carries
 * (so the tab can MERGE intermediate path hops into the working graph before
 * highlighting — otherwise a "path found" note draws nothing because the middle
 * nodes were never loaded). When the response carries only ids, `nodes`/`rels`
 * are empty and behaviour is unchanged.
 */
export function readPath(raw: unknown): {
  ids: string[];
  nodes: GraphRecord[];
  relationships: GraphRecord[];
} {
  const o = (raw && typeof raw === 'object' ? raw : {}) as Rec;
  const paths = o.paths;
  if (!Array.isArray(paths) || paths.length === 0)
    return { ids: [], nodes: [], relationships: [] };
  const head = paths[0];
  // A null/undefined head would throw on `.nodes` below — treat as "no path".
  if (head === null || head === undefined)
    return { ids: [], nodes: [], relationships: [] };
  const first = head as Rec;
  // A path item may be: an array of ids, an array of node objects, or an
  // object carrying `nodes`/`entities`/`path`.
  const seq =
    (Array.isArray(first) && first) ||
    (Array.isArray(first.nodes) && first.nodes) ||
    (Array.isArray(first.entities) && first.entities) ||
    (Array.isArray(first.path) && first.path) ||
    [];
  const ids: string[] = [];
  const nodes: GraphRecord[] = [];
  for (let i = 0; i < (seq as unknown[]).length; i++) {
    const item = (seq as unknown[])[i];
    if (typeof item === 'string') {
      ids.push(item);
    } else if (item && typeof item === 'object') {
      ids.push(nodeIdOf(item as GraphRecord, i));
      nodes.push(item as GraphRecord); // a node OBJECT → mergeable into the graph
    }
  }
  const relsRaw = (first.relationships ?? first.edges) as unknown;
  const relationships = Array.isArray(relsRaw)
    ? (relsRaw as unknown[]).filter(
        (r): r is GraphRecord => !!r && typeof r === 'object',
      )
    : [];
  return { ids, nodes, relationships };
}

