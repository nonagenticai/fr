// kagCitationGraph.ts
// ===================
// Pure, framework-free helpers that turn snowball / citation data into the
// generic `{ nodes, relationships }` shape KagGraph renders (P3-R1). Kept here so
// the graph-assembly logic (node/edge normalisation, trust colouring, hop merge)
// is unit-tested without mounting the D3 component.

import { paperIdOf, type PaperResult, type RelatedItem, type RelatedResponse } from '$lib/api/research';

/** A graph node fed to KagGraph — `id`/`title` plus the trust score for colour. */
export interface CitationNode extends Record<string, unknown> {
  id: string;
  title: string;
  trust_score?: number | null;
}

/** A directed citation edge (`cites` = forward, `references` = backward). */
export interface CitationEdge extends Record<string, unknown> {
  source: string;
  target: string;
  type: 'cites' | 'references';
}

export interface CitationGraph {
  nodes: CitationNode[];
  edges: CitationEdge[];
}

/** Colour a node by trust score: green ≥0.66, amber ≥0.33, red <0.33, muted when unknown. */
export function trustColor(score: number | null | undefined): string {
  if (typeof score !== 'number' || !Number.isFinite(score)) return 'var(--color-text-muted)';
  if (score >= 0.66) return 'var(--color-success)';
  if (score >= 0.33) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

function relatedIdOf(r: RelatedItem): string | undefined {
  return r.paper_id ?? r.id ?? undefined;
}

/** The related rows of a `getPaperRelated` response (`items` or `results`). */
export function relatedRows(res: RelatedResponse | null | undefined): RelatedItem[] {
  return res?.items ?? res?.results ?? [];
}

function paperNode(p: PaperResult): CitationNode | null {
  const id = paperIdOf(p);
  if (!id) return null;
  return {
    id,
    title: typeof p.title === 'string' && p.title.trim() ? p.title : id,
    trust_score: p.trust_score ?? null,
  };
}

function relatedNode(r: RelatedItem): CitationNode | null {
  const id = relatedIdOf(r);
  if (!id) return null;
  return {
    id,
    title: typeof r.title === 'string' && r.title.trim() ? r.title : id,
    trust_score: typeof r.trust_score === 'number' ? r.trust_score : null,
  };
}

/** Seed graph from a set of papers (nodes only; edges are loaded per-hop). */
export function seedGraph(papers: PaperResult[]): CitationGraph {
  const nodes: CitationNode[] = [];
  const seen = new Set<string>();
  for (const p of papers) {
    const n = paperNode(p);
    if (n && !seen.has(n.id)) {
      seen.add(n.id);
      nodes.push(n);
    }
  }
  return { nodes, edges: [] };
}

/**
 * Undirected canonical key for one underlying relationship, so a citation seen
 * from both endpoints (once as `cites`, once as `references`) collapses to a
 * single edge rather than two overlapping lines / an inflated link count.
 */
function relationshipKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/**
 * Merge one paper's related-hop into a graph: add any new neighbour nodes and
 * the directed citation edges. The neighbour always cites the citing→cited
 * direction (arrow points at the cited paper). `citations` = papers citing this
 * one (forward): neighbour → paper, type `cites`. `references` = papers this one
 * cites (backward): paper → neighbour, type `references`. When both endpoints of
 * one relationship are expanded the two hops describe the SAME edge, so dedup is
 * undirected (`relationshipKey`) — one relationship = one edge. Idempotent:
 * re-expanding a node adds nothing new. Returns a NEW graph (no mutation).
 */
export function mergeHop(
  graph: CitationGraph,
  paperId: string,
  kind: 'citations' | 'references',
  related: RelatedItem[],
): CitationGraph {
  const nodeIds = new Set(graph.nodes.map((n) => n.id));
  const edgeKeys = new Set(graph.edges.map((e) => relationshipKey(e.source, e.target)));
  const nodes = [...graph.nodes];
  const edges = [...graph.edges];

  for (const r of related) {
    const n = relatedNode(r);
    if (!n) continue;
    if (!nodeIds.has(n.id)) {
      nodeIds.add(n.id);
      nodes.push(n);
    }
    const type: CitationEdge['type'] = kind === 'citations' ? 'cites' : 'references';
    // citations: neighbour cites this paper → neighbour → paper.
    // references: this paper cites neighbour → paper → neighbour.
    const [source, target] = kind === 'citations' ? [n.id, paperId] : [paperId, n.id];
    if (source === target) continue;
    const key = relationshipKey(source, target);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ source, target, type });
    }
  }
  return { nodes, edges };
}
