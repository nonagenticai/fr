// Client for the Phase-8 traceability graph compose-endpoint
// (`GET /api/traceability/graph`). The backend assembles
// requirements_management's polymorphic architecture_relationships into a
// renderable {nodes, links} graph spanning the 5D asset space.
//
// Unlike the manifest assetFetch helper, this reads the full envelope so the
// `meta.truncated` flag survives — the graph page surfaces it honestly.

import { authFetch } from './auth-fetch';

export type TraceDimension =
  | 'architecture'
  | 'requirement'
  | 'decision'
  | 'principle'
  | 'pm'
  | 'other';

export interface TraceNode {
  id: string;
  label: string;
  dimension: TraceDimension;
  entity_type: string;
  entity_id: string;
  route: string | null;
  is_root: boolean;
}

export interface TraceLink {
  source: string;
  target: string;
  type: string;
  label: string | null;
}

export interface TraceRoot {
  entity_type: string;
  entity_id: string;
  depth: number;
}

export interface TraceGraph {
  nodes: TraceNode[];
  links: TraceLink[];
  root: TraceRoot | null;
  meta: { node_count: number; link_count: number; truncated: boolean };
}

export interface Neighbour {
  node: TraceNode;
  /** relationship_type connecting self to this neighbour. */
  relType: string;
  /** Whether the edge points away from (outgoing) or toward (incoming) self. */
  direction: 'outgoing' | 'incoming';
}

/**
 * Reduce a rooted graph to the list of direct neighbours of `selfId` (a
 * `<type>:<id>` node id), tagging each with the relationship type and
 * direction. Self-loops are skipped. Pure — unit-tested.
 */
export function deriveNeighbours(
  nodes: TraceNode[],
  links: TraceLink[],
  selfId: string,
): Neighbour[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const out: Neighbour[] = [];
  for (const l of links) {
    if (l.source === selfId && l.target !== selfId) {
      const node = byId.get(l.target);
      if (node) out.push({ node, relType: l.type, direction: 'outgoing' });
    } else if (l.target === selfId && l.source !== selfId) {
      const node = byId.get(l.source);
      if (node) out.push({ node, relType: l.type, direction: 'incoming' });
    }
  }
  return out;
}

export interface TraceGraphParams {
  /** Upstream table name to centre on (e.g. `architecture_elements`). */
  rootType?: string;
  /** Entity UUID to centre on. */
  rootId?: string;
  /** Hop depth for a rooted query (1–3). Ignored for the whole graph. */
  depth?: number;
  /** Scope either mode to one project's relationships. */
  projectId?: string;
}

interface Envelope {
  data?: { nodes?: TraceNode[]; links?: TraceLink[]; root?: TraceRoot | null };
  meta?: { node_count?: number; link_count?: number; truncated?: boolean };
  error?: { message?: string };
}

/**
 * Fetch the traceability graph. With no root, returns the whole tenant-visible
 * relationship graph; with `rootType` + `rootId`, returns the BFS neighbourhood
 * out to `depth` hops.
 */
export async function fetchTraceabilityGraph(
  params: TraceGraphParams = {},
): Promise<TraceGraph> {
  const sp = new URLSearchParams();
  if (params.rootType && params.rootId) {
    sp.set('root_type', params.rootType);
    sp.set('root_id', params.rootId);
    if (params.depth != null) sp.set('depth', String(params.depth));
  }
  if (params.projectId) sp.set('project_id', params.projectId);
  const qs = sp.toString();
  const res = await authFetch(`/api/traceability/graph${qs ? `?${qs}` : ''}`);

  let body: Envelope | null = null;
  try {
    body = (await res.json()) as Envelope;
  } catch {
    // fall through to generic error
  }
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `${res.status} ${res.statusText}`);
  }

  const data = body?.data ?? {};
  const nodes = data.nodes ?? [];
  const links = data.links ?? [];
  return {
    nodes,
    links,
    root: data.root ?? null,
    meta: {
      node_count: body?.meta?.node_count ?? nodes.length,
      link_count: body?.meta?.link_count ?? links.length,
      truncated: body?.meta?.truncated ?? false,
    },
  };
}
