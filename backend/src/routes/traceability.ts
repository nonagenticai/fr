// GET /api/traceability/graph?root_type=<table>&root_id=<uuid>&depth=<1..3>[&project_id=<uuid>]
//
// `project_id` scopes either mode to one project: the whole graph passes it to
// the RM list op; a rooted walk keeps only edges stamped with that project.
//
// The cross-domain traceability graph (control-plane roadmap Phase 8). One
// compose-endpoint that turns requirements_management's polymorphic
// `architecture_relationships` edge set into a renderable `{nodes, links}`
// graph spanning the 5D asset space (architecture ↔ requirement ↔ decision ↔
// principle ↔ pm_*). It adds NO new upstream service and NO schema change —
// it reads the relationship rows the architecture integration already exposes.
//
// Two modes:
//   • Whole graph (no root)     — every relationship visible to the tenant
//     (`listArchitectureRelationships`, capped). Powers the /knowledge/graph
//     overview.
//   • Rooted graph (root_type   — breadth-first from one entity out to `depth`
//     + root_id [+ depth])        hops via the upstream entity-graph endpoint
//                                 (`getArchitectureEntityGraph`). Powers the
//                                 per-asset neighbour panel (depth=1) and
//                                 root-focused exploration.
//
// Node labels: relationship rows carry no endpoint display-name (only typed
// ids), so v1 labels each node `<TypeLabel> <shortId>` and lets the click-route
// carry the user to the asset's own detail page for the real title. Richer
// name-resolution is deferred (the roadmap defers heavy tooling) — it would
// cost one list call per dimension and the live tenant data is sparse.

import { validateAuth } from '../middleware/auth';
import { BadRequestError } from '../utils/errors';
import { jsonResponse } from '../utils/response';
import { handle } from './assets/_lib/handler';
import {
  getArchitectureEntityGraph,
  listArchitectureRelationships,
} from '../integrations/architecture';
import type { ArchitectureRelationshipOut } from '@fr/service-client-requirements';

// ---------------------------------------------------------------------------
// Dimension / route / label mapping (pure — unit-tested)
// ---------------------------------------------------------------------------

/** 5D dimension a node belongs to (drives graph colouring). */
export type Dimension =
  | 'architecture'
  | 'requirement'
  | 'decision'
  | 'principle'
  | 'pm'
  | 'other';

/** Map an upstream table name (entity_type) to its 5D dimension. */
export function dimensionOf(entityType: string): Dimension {
  if (entityType.startsWith('architecture_')) return 'architecture';
  if (entityType.startsWith('pm_')) return 'pm';
  switch (entityType) {
    case 'requirements':
      return 'requirement';
    case 'decisions':
      return 'decision';
    case 'principles':
      return 'principle';
    default:
      return 'other';
  }
}

// Short, human label prefix per entity_type — keeps node text under D3's
// 14-char truncation while still naming the kind of asset.
const TYPE_LABEL: Record<string, string> = {
  architecture_elements: 'Element',
  architecture_views: 'View',
  architecture_standards: 'Standard',
  architecture_relationships: 'Relationship',
  requirements: 'Requirement',
  decisions: 'Decision',
  principles: 'Principle',
  pm_programmes: 'Programme',
  pm_projects: 'Project',
  pm_resources: 'Resource',
  pm_risks: 'Risk',
  pm_benefits: 'Benefit',
};

function typeLabel(entityType: string): string {
  return TYPE_LABEL[entityType] ?? entityType;
}

/** Node label: `<TypeLabel> <shortId>` (the click-route carries the real title). */
export function nodeLabel(entityType: string, entityId: string): string {
  const short = entityId.length > 8 ? entityId.slice(0, 8) : entityId;
  return `${typeLabel(entityType)} ${short}`;
}

// Frontend detail-route per entity_type. Types without a wired detail page
// (every pm_* table — the /library/pm/* pages are retired — and anything
// unknown) get no route → the node still renders but is not clickable.
const ROUTE_BASE: Record<string, string> = {
  architecture_elements: '/library/architecture/elements',
  architecture_views: '/library/architecture/views',
  architecture_standards: '/library/architecture/standards',
  architecture_relationships: '/library/architecture/relationships',
  requirements: '/requirements',
  decisions: '/decisions',
  principles: '/principles',
};

/** Frontend href for an entity, or null when no detail route is wired. */
export function routeOf(entityType: string, entityId: string): string | null {
  const base = ROUTE_BASE[entityType];
  return base ? `${base}/${encodeURIComponent(entityId)}` : null;
}

// ---------------------------------------------------------------------------
// Graph assembly (pure — unit-tested)
// ---------------------------------------------------------------------------

export interface TraceNode {
  /** `<entity_type>:<entity_id>` — stable node id used by D3 + link refs. */
  id: string;
  label: string;
  dimension: Dimension;
  entity_type: string;
  entity_id: string;
  /** Frontend detail href, or null when no route is wired. */
  route: string | null;
  /** True for the entity a rooted graph was centred on. */
  is_root: boolean;
}

export interface TraceLink {
  source: string;
  target: string;
  /** relationship_type (e.g. `realizes`, `depends_on`). */
  type: string;
  /** Optional human label from the relationship row. */
  label: string | null;
}

export interface TraceGraph {
  nodes: TraceNode[];
  links: TraceLink[];
}

function nodeId(entityType: string, entityId: string): string {
  return `${entityType}:${entityId}`;
}

/**
 * Fold a flat list of relationship rows into a deduped `{nodes, links}` graph.
 * `rootKey` (a `type:id` string) flags the centred node when present. Links are
 * deduped on `source|target|type` so the same pairing under one relationship
 * type collapses while distinct types between the same pair both survive.
 */
export function buildGraph(
  rows: ArchitectureRelationshipOut[],
  rootKey?: string,
): TraceGraph {
  const nodes = new Map<string, TraceNode>();
  const links = new Map<string, TraceLink>();

  const ensureNode = (entityType: string, entityId: string): void => {
    const id = nodeId(entityType, entityId);
    if (nodes.has(id)) {
      if (rootKey && id === rootKey) nodes.get(id)!.is_root = true;
      return;
    }
    nodes.set(id, {
      id,
      label: nodeLabel(entityType, entityId),
      dimension: dimensionOf(entityType),
      entity_type: entityType,
      entity_id: entityId,
      route: routeOf(entityType, entityId),
      is_root: rootKey === id,
    });
  };

  for (const r of rows) {
    ensureNode(r.source_entity_type, r.source_id);
    ensureNode(r.target_entity_type, r.target_id);
    const source = nodeId(r.source_entity_type, r.source_id);
    const target = nodeId(r.target_entity_type, r.target_id);
    const key = `${source}|${target}|${r.relationship_type}`;
    if (!links.has(key)) {
      links.set(key, {
        source,
        target,
        type: r.relationship_type,
        label: r.name ?? null,
      });
    }
  }

  return { nodes: [...nodes.values()], links: [...links.values()] };
}

// ---------------------------------------------------------------------------
// Request handling
// ---------------------------------------------------------------------------

export const DEFAULT_DEPTH = 2;
export const MAX_DEPTH = 3;
const WHOLE_GRAPH_LIMIT = 1000;
// Bound a rooted BFS so a densely-connected entity can't fan out unboundedly.
const MAX_EXPANSIONS = 200;

/**
 * `?depth=` -> an integer in 1..MAX_DEPTH, absent -> DEFAULT_DEPTH.
 *
 * ⚠️ MEASURED by driving the real handler 2026-09-08. The body was
 *
 *     const n = Number(raw);
 *     if (!Number.isFinite(n)) return DEFAULT_DEPTH;
 *     return Math.max(1, Math.min(MAX_DEPTH, Math.trunc(n)));
 *
 * and `Number(null)` is 0, which IS finite — so the `DEFAULT_DEPTH` line was
 * unreachable for an ABSENT param, which instead clamped 0 up to 1. Measured:
 *
 *     absent -> 1   ''    -> 1   '-1'    -> 1   '999' -> 3
 *     '2.7'  -> 2   'abc' -> 2   '1e400' -> 2
 *
 * i.e. DEFAULT_DEPTH was reachable ONLY via an unparseable value, so GARBAGE
 * returned a deeper graph than omitting the param, and a named constant
 * advertised a default the code could not produce.
 *
 * ⛔ The `raw === null || raw.trim() === ''` guard is LOAD-BEARING and is not
 * a tidy-up: `Number('')` is also 0, so without it the same finite-zero
 * swallows the absent/blank case again and DEFAULT_DEPTH stays unreachable.
 *
 * Junk is REFUSED, not defaulted — substituting a depth the caller never asked
 * for is the behaviour this closes, and a `?depth=` that cannot be honoured
 * cannot be answered.
 *
 * ⚠️ `BadRequestError` (400), matching `requireRootPair` below. This first
 * shipped as `ValidationError` on the reasoning that it copied
 * `approvals.ts parseApprovalsPaging`, "the repo's existing refusal for a
 * malformed NUMERIC query param". That precedent does not say what it appears
 * to say: `parseApprovalsPaging`'s own docblock (approvals.ts ~:614) claims it
 * "throws `ValidationError` (400)", and `approvals.ts` ~:587 already records
 * the MEASURED refutation twenty-five lines above it — `ValidationError` in
 * `utils/errors.ts` carries statusCode **422**, and "that docblock is simply
 * wrong about its own class". So copying the class from a comment that
 * misstates its own status code would have imported a 422 while believing it
 * was a 400, and split this file across two codes for one kind of input.
 * A malformed query string is a malformed request: 400, as `requireRootPair`
 * argues directly below.
 *
 * Parsed UNCONDITIONALLY, before the rooted/whole-graph mode is chosen. The
 * whole-graph mode ignores `depth`, so parsing only inside the rooted branch
 * would keep silently accepting `?depth=abc` there — the same silent discard,
 * relocated to the other mode.
 */
export function parseDepth(raw: string | null): number {
  if (raw === null || raw.trim() === '') return DEFAULT_DEPTH;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > MAX_DEPTH) {
    throw new BadRequestError(
      `depth must be an integer between 1 and ${MAX_DEPTH}`,
    );
  }
  return n;
}

/**
 * Breadth-first collection of relationship rows out to `depth` hops from a
 * root entity. Each unvisited frontier node is expanded via the upstream
 * one-hop entity-graph endpoint; rows are deduped by relationship id.
 */
async function collectRooted(
  rootType: string,
  rootId: string,
  depth: number,
  projectId: string | null,
): Promise<{ rows: ArchitectureRelationshipOut[]; truncated: boolean }> {
  const rowsById = new Map<string, ArchitectureRelationshipOut>();
  const expanded = new Set<string>();
  let frontier: Array<{ type: string; id: string }> = [{ type: rootType, id: rootId }];
  let expansions = 0;
  let truncated = false;

  for (let level = 0; level < depth && frontier.length > 0; level++) {
    const next: Array<{ type: string; id: string }> = [];
    for (const node of frontier) {
      const key = nodeId(node.type, node.id);
      if (expanded.has(key)) continue;
      if (expansions >= MAX_EXPANSIONS) {
        truncated = true;
        break;
      }
      expanded.add(key);
      expansions++;

      const edges = await getArchitectureEntityGraph(node.type, node.id);
      for (const e of edges) {
        // The entity-graph op takes no project filter, so a project-scoped walk
        // keeps only the edges RM stamped with that project.
        if (projectId && e.project_id !== projectId) continue;
        rowsById.set(e.id, e);
        const src = { type: e.source_entity_type, id: e.source_id };
        const tgt = { type: e.target_entity_type, id: e.target_id };
        for (const n of [src, tgt]) {
          if (!expanded.has(nodeId(n.type, n.id))) next.push(n);
        }
      }
    }
    frontier = next;
  }

  return { rows: [...rowsById.values()], truncated };
}

/**
 * A query param, with empty/whitespace-only folded to `null`.
 *
 * `?root_type=` already read as absent before this change (`''` is falsy, and
 * the old `Boolean(rootType && rootId)` therefore treated it as "no root"), so
 * keeping that is what makes the pair check below a REFUSAL of a half-supplied
 * root rather than a new rejection of an empty form field.
 */
function trimmedParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * `root_type` and `root_id` are a PAIR. Both, or neither.
 *
 * ⚠️ MEASURED by driving the real handler 2026-09-08. The mode selector was:
 *
 *     const rooted = Boolean(rootType && rootId);
 *
 * so a half-supplied root — `?root_type=architecture_elements` with no
 * `root_id`, or `?root_id=<uuid>` with no `root_type` — fell through to the
 * WHOLE-GRAPH branch. Both spellings hit `/architecture/relationships` (not the
 * entity-graph endpoint) and answered **200** with `root: null` and every edge
 * the tenant can see, up to `WHOLE_GRAPH_LIMIT` (1000). Supplying both hit the
 * rooted path, so the fall-through was silent and total.
 *
 * The consequence is not a cosmetic one. The per-asset neighbour panel calls
 * this endpoint to ask "what is THIS asset connected to" and renders whatever
 * comes back as that asset's neighbours — so a dropped `root_id` (a null id, a
 * mis-spelt param, a half-built querystring) renders the entire tenant graph as
 * one asset's lineage, with nothing in the response saying so. `root: null` is
 * the only tell and it is the field a rooted caller has no reason to read.
 *
 * NEITHER param stays the deliberate whole-graph request — that is a documented
 * mode (see this file's header) and powers /knowledge/graph. Only the
 * half-supplied case is refused, and the message names the param that is
 * MISSING, because that is the one the caller has to add.
 *
 * `BadRequestError` (400) for the same reason `routes/approvals.ts` (~:587)
 * records: a malformed query string is a malformed request, and `ValidationError`
 * in `utils/errors.ts` is 422. Thrown BEFORE `handle()` so no upstream call is
 * made for a request that cannot be answered.
 */
function requireRootPair(rootType: string | null, rootId: string | null): void {
  if (Boolean(rootType) === Boolean(rootId)) return;
  const missing = rootType === null ? 'root_type' : 'root_id';
  const supplied = rootType === null ? `root_id=${rootId}` : `root_type=${rootType}`;
  throw new BadRequestError(
    `${missing} is required when ${supplied} is supplied: root_type and root_id ` +
      'are a pair. Omit both to request the whole graph.',
  );
}

export async function handleGetTraceabilityGraph(req: Request): Promise<Response> {
  await validateAuth(req);

  const url = new URL(req.url);
  const rootType = trimmedParam(url, 'root_type');
  const rootId = trimmedParam(url, 'root_id');
  const depth = parseDepth(url.searchParams.get('depth'));
  const projectId = trimmedParam(url, 'project_id');
  requireRootPair(rootType, rootId);
  const rooted = Boolean(rootType && rootId);

  return handle(
    async () => {
      if (rooted) {
        const { rows, truncated } = await collectRooted(rootType!, rootId!, depth, projectId);
        return {
          graph: buildGraph(rows, nodeId(rootType!, rootId!)),
          root: { entity_type: rootType, entity_id: rootId, depth },
          truncated,
        };
      }
      const rows = await listArchitectureRelationships({
        limit: String(WHOLE_GRAPH_LIMIT),
        ...(projectId ? { project_id: projectId } : {}),
      });
      return {
        graph: buildGraph(rows),
        root: null,
        truncated: rows.length >= WHOLE_GRAPH_LIMIT,
      };
    },
    ({ graph, root, truncated }) =>
      jsonResponse({
        data: { nodes: graph.nodes, links: graph.links, root },
        meta: {
          node_count: graph.nodes.length,
          link_count: graph.links.length,
          truncated,
        },
      }),
  );
}
