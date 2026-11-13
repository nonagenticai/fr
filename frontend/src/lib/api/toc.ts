// Client for the Theory-of-Constraints (TOC / Dettmer Logical Thinking
// Process) surface — fr proxies requirements_management's `/toc` API under
// `/api/assets/toc/*` (see backend `routes/assets/toc.ts`). Reads the `{data}`
// envelope the backend emits; pure helpers (`cloudConflictEdges`,
// `clrCategoryLabel`, `qualityScoreColor`, `stratifyTree`) are unit-tested and
// decoupled from the network, mirroring `lib/api/traceability.ts`.

import { authFetch } from './auth-fetch';

// RM's shapes are the GENERATED ones (`@fr/service-client-requirements`), types only.
import type {
  ArchitectureRelationshipOut,
  ClrReport,
  TocNodeOut,
  TocSettingsOut,
  TocTreeInTreeType,
  TocTreeOut,
} from '@fr/service-client-requirements';

export type TocTreeType = TocTreeInTreeType;

/**
 * Edge semantics in a TOC logic tree, as fr's views compare them: RM's
 * `toc_necessity` … with the `toc_` prefix stripped by {@link normalizeEdgeKind}.
 */
export type TocEdgeKind = 'necessity' | 'sufficiency' | 'conflict' | 'assumption' | string;

export type TocTree = TocTreeOut;
export type TocNode = TocNodeOut;
/** RM answers a TOC edge as an architecture relationship; fr carries its kind normalised. */
export type TocEdge = Omit<ArchitectureRelationshipOut, 'relationship_type'> & { relationship_type: TocEdgeKind };

/** A tree's graph as fr's views read it: RM's TocGraph with lists defaulted and edge kinds normalised. */
export interface TocGraph {
  tree: TocTree;
  nodes: TocNode[];
  edges: TocEdge[];
}

/** The structural 8-CLR quality report (`POST /toc/{id}/quality`); `score` is 0..1. */
export type ClrQuality = ClrReport;
export type TocSettings = TocSettingsOut;

/**
 * The eight Dettmer Categories of Legitimate Reservation, in canonical order.
 * These key the CLR lens panel and the quality report category map.
 */
export const CLR_CATEGORIES = [
  'clarity',
  'entity_existence',
  'causality_existence',
  'cause_sufficiency',
  'additional_cause',
  'cause_effect_reversal',
  'predicted_effect_existence',
  'tautology',
] as const;
export type ClrCategory = (typeof CLR_CATEGORIES)[number];

const CLR_CATEGORY_LABELS: Record<ClrCategory, string> = {
  clarity: 'Clarity',
  entity_existence: 'Entity existence',
  causality_existence: 'Causality existence',
  cause_sufficiency: 'Cause sufficiency',
  additional_cause: 'Additional cause',
  cause_effect_reversal: 'Cause–effect reversal',
  predicted_effect_existence: 'Predicted-effect existence',
  tautology: 'Tautology',
};

/** Human label for a CLR category key (falls back to a title-cased key). */
export function clrCategoryLabel(key: string): string {
  if (key in CLR_CATEGORY_LABELS) return CLR_CATEGORY_LABELS[key as ClrCategory];
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Token-bucket colour for a 0..1 CLR quality score. Returns a CSS custom
 * property so the badge tracks the theme: ≥0.8 success, ≥0.5 warning, else
 * danger; null/undefined → muted.
 */
export function qualityScoreColor(score: number | null | undefined): string {
  if (score == null) return 'var(--color-text-muted)';
  if (score >= 0.8) return 'var(--color-success)';
  if (score >= 0.5) return 'var(--color-warning)';
  return 'var(--color-danger)';
}

/**
 * The CLR quality fields an asset (requirement / decision) carries directly on
 * its `*Out` schema (`quality_score` / `quality_issues` / `quality_suggestions`
 * from RM's QualityMixin). These ARE REST-queryable — distinct from the
 * per-statement CLR lens booleans the n8n AA subroutine authors, which are NOT
 * persisted in RM (verified live 2026-05-31). The detail-page panel renders
 * THESE.
 */
export interface AssetQualityFields {
  quality_score?: number | null;
  quality_issues?: unknown;
  quality_suggestions?: unknown;
}

/** Coerce an open `unknown` value into a string[] of non-empty trimmed items. */
export function toStringList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((x) => (typeof x === 'string' ? x : x == null ? '' : String(x)))
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Adapt an asset's own quality fields into the {@link ClrQuality} shape the
 * CLRLensPanel consumes. The asset carries an aggregate CLR score plus its
 * reservations (issues) and suggestions, but NO per-category breakdown — so
 * `categories` is empty (the panel renders the asset case with
 * `showCategories=false`). Returns `null` when the asset has no CLR signal at
 * all (no score and no issues), so the caller can show an empty state. Pure.
 */
export function assetClrQuality(
  asset: AssetQualityFields | null | undefined,
): ClrQuality | null {
  if (!asset) return null;
  const issues = toStringList(asset.quality_issues);
  const hasScore = typeof asset.quality_score === 'number';
  if (!hasScore && issues.length === 0) return null;
  return {
    score: hasScore ? (asset.quality_score as number) : 0,
    passes: [],
    issues,
    categories: {},
  };
}

/**
 * The per-asset CLR reasoning lenses the AA author subroutine writes back to
 * requirements_management (free-form `lens_metadata` JSONB, RM PR #41). Distinct
 * from the aggregate `quality_*` summary: this is the real per-statement signal.
 */
export interface AssetLensFields extends AssetQualityFields {
  lens_metadata?: Record<string, unknown> | null;
}

// The AA author's clr_assessment keys → fr CLR_CATEGORIES keys. The AA booleans
// are "reservation passes" (true = good), and fr's CLRLensPanel reads a boolean
// category as pass(true)/reservation(false), so the mapping is 1:1 with NO
// inversion — only the four trailing keys are renamed (no_* → bare).
const AA_CLR_KEY_TO_FR: Record<string, ClrCategory> = {
  clarity: 'clarity',
  entity_existence: 'entity_existence',
  causality_existence: 'causality_existence',
  cause_sufficiency: 'cause_sufficiency',
  no_additional_cause: 'additional_cause',
  no_cause_effect_reversal: 'cause_effect_reversal',
  predicted_effect_exists: 'predicted_effect_existence',
  no_tautology: 'tautology',
};

export interface AssetLensView {
  hasLenses: boolean;
  /** ClrQuality keyed to fr CLR_CATEGORIES, for CLRLensPanel showCategories. */
  report: ClrQuality | null;
  /** 0..1 (relevant→1, not-relevant→0); null when the AA didn't assess it. */
  goalTreeRelevance: number | null;
  tracesTo: string | null;
  notes: string | null;
}

/**
 * Parse an asset's `lens_metadata` (clr_assessment 8 booleans + notes,
 * goal_tree_relevance {relevant, traces_to}) into the shape CLRLensPanel
 * renders. Defensive: tolerates missing keys / shape drift. Pure (unit-tested).
 */
export function parseAssetLenses(
  asset: AssetLensFields | null | undefined,
): AssetLensView {
  const empty: AssetLensView = {
    hasLenses: false,
    report: null,
    goalTreeRelevance: null,
    tracesTo: null,
    notes: null,
  };
  const lm = asset?.lens_metadata;
  if (!lm || typeof lm !== 'object') return empty;
  const bag = lm as Record<string, unknown>;

  const categories: Record<string, boolean> = {};
  let trueCount = 0;
  let total = 0;
  let notes: string | null = null;
  const clr = bag.clr_assessment;
  if (clr && typeof clr === 'object') {
    const clrBag = clr as Record<string, unknown>;
    for (const [aaKey, frKey] of Object.entries(AA_CLR_KEY_TO_FR)) {
      const v = clrBag[aaKey];
      if (typeof v === 'boolean') {
        categories[frKey] = v;
        total += 1;
        if (v) trueCount += 1;
      }
    }
    if (typeof clrBag.notes === 'string' && clrBag.notes.trim()) {
      notes = clrBag.notes.trim();
    }
  }

  let goalTreeRelevance: number | null = null;
  let tracesTo: string | null = null;
  const gtr = bag.goal_tree_relevance;
  if (gtr && typeof gtr === 'object') {
    const gtrBag = gtr as Record<string, unknown>;
    if (typeof gtrBag.relevant === 'boolean') {
      goalTreeRelevance = gtrBag.relevant ? 1 : 0;
    }
    if (typeof gtrBag.traces_to === 'string' && gtrBag.traces_to.trim()) {
      tracesTo = gtrBag.traces_to.trim();
    }
  }

  if (total === 0 && goalTreeRelevance === null && tracesTo === null) {
    return empty;
  }
  const report: ClrQuality | null =
    total > 0
      ? { score: trueCount / total, passes: [], issues: [], categories }
      : null;
  return { hasLenses: true, report, goalTreeRelevance, tracesTo, notes };
}

/**
 * The outcome of choosing ONE tree to render out of the set a project owns.
 * The counts exist so the UI can SAY that a choice was made, rather than
 * presenting one arbitrary row as if it were the only one.
 */
export interface TocTreeSelection {
  /** The chosen tree, or null when the project has none. */
  tree: TocTree | null;
  /** How many trees the query returned (the ambiguity, if > 1). */
  candidates: number;
  /** How many of those were eligible to be "current" (not retired). */
  eligible: number;
  /**
   * true ⇒ EVERY candidate was retired and the most recent retired one is
   * being shown. The UI must label it; a deprecated tree rendered silently is
   * the defect this function exists to prevent.
   */
  deprecatedFallback: boolean;
}

/** `version_status` values that disqualify a tree from being "current". */
const RETIRED_TREE_STATUSES = new Set(['deprecated', 'superseded', 'archived', 'retired']);

/** Latest of `updated_at` / `created_at` as epoch ms; NaN-free (0 when absent). */
function treeRecency(t: TocTree): number {
  const u = t.updated_at ? Date.parse(t.updated_at) : NaN;
  const c = t.created_at ? Date.parse(t.created_at) : NaN;
  const uu = Number.isNaN(u) ? -Infinity : u;
  const cc = Number.isNaN(c) ? -Infinity : c;
  const best = Math.max(uu, cc);
  return best === -Infinity ? 0 : best;
}

/**
 * Choose which of a project's TOC trees is THE current one, by an explicit,
 * total, deterministic rule. Pure — unit-tested.
 *
 * ⛔ WHY THIS EXISTS. Callers took `trees[0]`. That is not a rule, it is
 * whatever order the upstream happened to return. Measured against
 * `requirements_api.toc_trees` (1,965 rows, read directly on worker4):
 *   · 84 of 135 project-scoped projects own MORE THAN ONE tree
 *   · `version_status` is DRAFT 1,701 / DEPRECATED 264, and nothing else
 *   · 109 of 135 projects own ONLY deprecated trees
 * So the page could — and did — present a DEPRECATED decomposition as the
 * project's current goal, with nothing on screen saying which one it picked.
 *
 * ⭐ THE RULE IS DECIDED HERE, NOT DERIVED — because there is nothing to derive
 * it from. `superseded_by`, `supersedes`, `published_at` and `approved_at` have
 * ZERO non-null rows and `version` has ONE distinct value ('1.0.0'), so the
 * version chain the schema implies has never been written. A chain-walk would
 * silently degrade to "first row" again. What IS populated is `version_status`
 * and the timestamps, and `created_at` has zero ties across all 1,965 rows.
 *
 * THE RULE, in order:
 *  1. A tree whose `version_status` is deprecated/superseded/archived/retired
 *     is NEVER current. It can only be shown as an explicit fallback (4).
 *  2. Among the rest, newest first by `max(updated_at, created_at)`.
 *  3. Ties break on `id` descending. This is what makes the rule TOTAL:
 *     without it, two trees stamped in one transaction resolve by upstream row
 *     order, i.e. by nothing.
 *  4. If EVERY tree is retired, return the most recent one and set
 *     `deprecatedFallback`. Returning null instead would blank the page for
 *     109 of 135 projects whose decomposition genuinely exists; rendering it
 *     unlabelled would assert it is current. The caller must label it.
 *
 * ⚠️ WHAT CHANGING THIS COSTS. `version_status` carries no CHECK constraint
 * upstream, so it is unvalidated free text: the filter is a denylist
 * (`!== retired`) rather than an allowlist, so an unknown future status counts
 * as LIVE. That is the deliberate direction — wrongly hiding a current tree is
 * worse than wrongly showing one, and the label makes the second recoverable.
 * If upstream ever starts writing `superseded_by`, replace steps 2-3 with the
 * chain and delete this note.
 */
export function selectCurrentTree(trees: TocTree[]): TocTreeSelection {
  const candidates = trees.length;
  if (candidates === 0) {
    return { tree: null, candidates: 0, eligible: 0, deprecatedFallback: false };
  }
  const isRetired = (t: TocTree): boolean =>
    RETIRED_TREE_STATUSES.has((t.version_status ?? '').trim().toLowerCase());

  const byNewest = (a: TocTree, b: TocTree): number => {
    const d = treeRecency(b) - treeRecency(a);
    if (d !== 0) return d;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  };

  const live = trees.filter((t) => !isRetired(t));
  if (live.length > 0) {
    return {
      tree: [...live].sort(byNewest)[0] ?? null,
      candidates,
      eligible: live.length,
      deprecatedFallback: false,
    };
  }
  return {
    tree: [...trees].sort(byNewest)[0] ?? null,
    candidates,
    eligible: 0,
    deprecatedFallback: true,
  };
}

/**
 * The subset of a tree's edges that encode a conflict (the D↔D′ edge in an
 * Evaporating Cloud, or any `conflict` relationship in a logic tree). Pure —
 * unit-tested.
 */
export function cloudConflictEdges(edges: TocEdge[]): TocEdge[] {
  return edges.filter((e) => e.relationship_type === 'conflict');
}

export interface TreeHierarchyRow {
  id: string;
  parentId: string | null;
  node: TocNode;
}

/**
 * Turn a TOC graph into rows with a `parentId`, for the IO-Map / logic-tree
 * layouts. Edges point prerequisite → objective (necessity / sufficiency), so a
 * node's parent is the TARGET of its first non-conflict OUTGOING edge: the goal
 * is the root, its critical success factors hang under it, their necessary
 * conditions under those. Nodes with no such edge are roots (parentId null).
 *
 * ⚠️ CORRECTED 2026-10-07 (UI review): this used the edge SOURCE as the parent,
 * which inverts every IO map — the GOAL rendered nested under the first
 * condition's success factor ("the tree is upside-down").
 *
 * Cycle-safe: an edge with an endpoint that is not a known node is ignored, and
 * a node is never made its own ancestor. Pure — unit-tested.
 */
export function stratifyTree(
  nodes: TocNode[],
  edges: TocEdge[],
): TreeHierarchyRow[] {
  const ids = new Set(nodes.map((n) => n.id));
  const parentOf = new Map<string, string>();
  const createsCycle = (child: string, parent: string): boolean => {
    for (let p: string | undefined = parent; p !== undefined; p = parentOf.get(p)) {
      if (p === child) return true;
    }
    return false;
  };
  for (const e of edges) {
    if (e.relationship_type === 'conflict') continue;
    if (!ids.has(e.source_id) || !ids.has(e.target_id)) continue;
    if (parentOf.has(e.source_id) || e.source_id === e.target_id) continue;
    if (createsCycle(e.source_id, e.target_id)) continue;
    parentOf.set(e.source_id, e.target_id);
  }
  return nodes.map((n) => ({
    id: n.id,
    parentId: parentOf.get(n.id) ?? null,
    node: n,
  }));
}

// --- Fetchers -------------------------------------------------------------

interface Envelope<T> {
  data?: T;
  error?: { message?: string };
}

async function readData<T>(res: Response, fallback: T): Promise<T> {
  let body: Envelope<T> | null = null;
  try {
    body = (await res.json()) as Envelope<T>;
  } catch {
    // fall through to generic error
  }
  if (!res.ok) {
    throw new Error(body?.error?.message ?? `${res.status} ${res.statusText}`);
  }
  return body?.data ?? fallback;
}

export interface ListTocTreesParams {
  treeType?: TocTreeType | string;
  projectId?: string;
  limit?: number;
  offset?: number;
}

export async function fetchTocTrees(
  params: ListTocTreesParams = {},
): Promise<TocTree[]> {
  const sp = new URLSearchParams();
  if (params.treeType) sp.set('tree_type', params.treeType);
  if (params.projectId) sp.set('project_id', params.projectId);
  if (params.limit != null) sp.set('limit', String(params.limit));
  if (params.offset != null) sp.set('offset', String(params.offset));
  const qs = sp.toString();
  const res = await authFetch(`/api/assets/toc${qs ? `?${qs}` : ''}`);
  return readData<TocTree[]>(res, []);
}

export async function fetchTocTree(treeId: string): Promise<TocTree> {
  const res = await authFetch(`/api/assets/toc/${encodeURIComponent(treeId)}`);
  const data = await readData<TocTree | null>(res, null);
  if (!data) throw new Error(`TOC tree ${treeId} not found`);
  return data;
}

/**
 * The upstream (requirements_management `TOC_EDGE_TYPES`) names edge kinds
 * `toc_necessity | toc_sufficiency | toc_conflict | toc_assumption`; every fr
 * consumer compares against the bare `TocEdgeKind` names. MEASURED 2026-10-07
 * on prod (`architecture_relationships`): 5711 + 4019 `toc_necessity`, 4
 * `toc_conflict`, 12 `toc_assumption` — and zero bare names. So every
 * `=== 'conflict'` check in fr matched nothing: conflict edges were taken as
 * parent links and the evaporating cloud found no conflict. Normalised once,
 * here, at the boundary. Pure — unit-tested.
 */
export function normalizeEdgeKind(kind: string | null | undefined): TocEdgeKind {
  const k = (kind ?? '').trim().toLowerCase();
  return k.startsWith('toc_') ? k.slice(4) : k;
}

export async function fetchTocGraph(treeId: string): Promise<TocGraph> {
  const res = await authFetch(
    `/api/assets/toc/${encodeURIComponent(treeId)}/graph`,
  );
  const graph = await readGraph(res, treeId);
  return {
    ...graph,
    nodes: graph.nodes ?? [],
    edges: (graph.edges ?? []).map((e) => ({
      ...e,
      relationship_type: normalizeEdgeKind(e.relationship_type),
    })),
  };
}

function readGraph(res: Response, treeId: string): Promise<TocGraph> {
  return readData<TocGraph>(res, {
    tree: {
      id: treeId,
      slug: treeId,
      title: '',
      tenant_id: '',
      tree_type: 'io_map',
    },
    nodes: [],
    edges: [],
  });
}

/** Run / fetch the 8-CLR structural quality report (the upstream verb is POST). */
export async function fetchTocQuality(treeId: string): Promise<ClrQuality> {
  const res = await authFetch(
    `/api/assets/toc/${encodeURIComponent(treeId)}/quality`,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' },
  );
  return readData<ClrQuality>(res, {
    score: 0,
    passes: [],
    issues: [],
    categories: {},
  });
}

export async function fetchTocConfig(
  projectId?: string,
): Promise<TocSettings> {
  const qs = projectId
    ? `?${new URLSearchParams({ project_id: projectId })}`
    : '';
  const res = await authFetch(`/api/assets/toc/config${qs}`);
  return readData<TocSettings>(res, {
    tenant_id: '',
    settings: {},
  });
}
