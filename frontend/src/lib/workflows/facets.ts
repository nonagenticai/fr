// facets.ts
//
// The four orthogonal workflow facets — domain / purpose / stage / trigger
// — plus the non-namespaced "other" tag bucket. This is the single
// frontend definition of the facet vocabulary, URL encoding, and the
// multi-select filter predicate, shared by /workflows (the list) and
// /workflows/[id] (prev-next nav stays inside the same filter).
//
// The slug↔label tables MIRROR backend/src/lib/workflow-classify.ts. They
// are small and stable; if a facet value is added backend-side, add it
// here too. A slug the backend emits that is missing here still works —
// it just renders with the raw slug as its label.
//
// Filter semantics: multi-select OR *within* a facet, AND *across* facets.
// URL state is one CSV query param per facet (`?domain=kag,kanban`).

import type { WorkflowSummary } from '$lib/api/workflows';

/** Stage facet pseudo-slug: workflows that carry no `stage:` tag at all. */
export const STAGE_NONE = '__none__';

export type FacetKey = 'domain' | 'purpose' | 'stage' | 'trigger' | 'tag';

export interface FacetDef {
  /** Internal key + URL query param name. */
  key: FacetKey;
  /** Sidebar section heading. */
  label: string;
  /**
   * Canonical slug→label table. Display order in the sidebar follows the
   * backend's faceted `/tags` response, not this table — this is only the
   * label lookup. `tag` (the "other" bucket) has no fixed vocabulary.
   */
  slugToLabel: Record<string, string>;
}

export const FACETS: readonly FacetDef[] = [
  {
    key: 'domain',
    label: 'Domain',
    slugToLabel: {
      artifacts: 'Artifacts',
      coding: 'Coding',
      fr: 'FR',
      kag: 'KAG',
      kaizen: 'Kaizen',
      kanban: 'Kanban',
      keycloak: 'Keycloak',
      licenses: 'Licenses',
      mcp: 'MCP',
      'meta-prompt': 'Meta-Prompt',
      metering: 'Metering',
      observability: 'Observability',
      orchestration: 'Orchestration',
      reports: 'Reports',
      requirements: 'Requirements',
      secrets: 'Secrets',
      signal: 'Signal',
      'skill-builder': 'Skill Builder',
      tools: 'Tools',
      workers: 'Workers',
      general: 'General',
    },
  },
  {
    key: 'purpose',
    label: 'Purpose',
    slugToLabel: {
      improvement: 'Improvement',
      pattern: 'Pattern',
      authoring: 'Authoring',
      'card-flow': 'Card Flow',
      activity: 'Activity',
      demo: 'Demo',
      'test-monitoring': 'Test & Monitoring',
      operational: 'Operational',
    },
  },
  {
    key: 'stage',
    label: 'Stage',
    slugToLabel: {
      doing: 'Doing',
      done: 'Done',
      qa: 'QA',
      ready: 'Ready',
      blocked: 'Blocked',
      [STAGE_NONE]: '(none)',
    },
  },
  {
    key: 'trigger',
    label: 'Trigger',
    slugToLabel: {
      webhook: 'Webhook',
      manual: 'Manual',
      'sub-workflow': 'Sub-workflow',
      schedule: 'Schedule',
    },
  },
  {
    key: 'tag',
    label: 'Other tags',
    slugToLabel: {},
  },
] as const;

/** Look up a human label for a facet slug, falling back to the raw slug. */
export function facetLabel(key: FacetKey, slug: string): string {
  const def = FACETS.find((f) => f.key === key);
  return def?.slugToLabel[slug] ?? slug;
}

// --- Selection state <-> URL ------------------------------------------------

export type FacetSelection = Record<FacetKey, Set<string>>;

function emptySelection(): FacetSelection {
  return {
    domain: new Set(),
    purpose: new Set(),
    stage: new Set(),
    trigger: new Set(),
    tag: new Set(),
  };
}

/**
 * Parse the per-facet CSV query params into a {@link FacetSelection}.
 * Tolerant of the pre-faceted single-value URLs (`?domain=kanban`) — a
 * lone value is just a one-element set, so old bookmarks still work.
 */
export function parseFacetSelection(params: URLSearchParams): FacetSelection {
  const sel = emptySelection();
  for (const facet of FACETS) {
    const raw = params.get(facet.key);
    if (!raw) continue;
    for (const v of raw.split(',')) {
      const slug = v.trim();
      if (slug) sel[facet.key].add(slug);
    }
  }
  return sel;
}

/** True when no facet has any value selected. */
export function selectionIsEmpty(sel: FacetSelection): boolean {
  return FACETS.every((f) => sel[f.key].size === 0);
}

/**
 * Build the query-param patch for a {@link FacetSelection}: each facet
 * becomes a CSV value, or `null` (param deleted) when its set is empty.
 */
export function selectionToParams(
  sel: FacetSelection,
): Record<FacetKey, string | null> {
  const patch = {} as Record<FacetKey, string | null>;
  for (const facet of FACETS) {
    const values = [...sel[facet.key]];
    patch[facet.key] = values.length > 0 ? values.join(',') : null;
  }
  return patch;
}

// --- Filter predicate -------------------------------------------------------

/**
 * The four facet slug arrays for a workflow. Reads `w.facets` (sent by the
 * faceted backend); falls back to the legacy derived label fields so the
 * page still filters against a backend deployment that predates `facets`.
 */
export function effectiveFacets(w: WorkflowSummary): {
  domains: string[];
  purposes: string[];
  stages: string[];
  triggers: string[];
} {
  if (w.facets) return w.facets;
  // Legacy fallback: derive slugs from the old label fields.
  const domainSlug = (label: string): string =>
    Object.entries(FACETS[0]!.slugToLabel).find(
      ([, l]) => l === label,
    )?.[0] ?? label.toLowerCase();
  const purposeSlug = (label: string): string =>
    Object.entries(FACETS[1]!.slugToLabel).find(
      ([, l]) => l === label,
    )?.[0] ?? label.toLowerCase();
  return {
    domains: (w.domains ?? []).map(domainSlug),
    purposes: w.purpose ? [purposeSlug(w.purpose)] : [],
    stages: [],
    triggers: [],
  };
}

/**
 * Multi-criteria match: OR within each facet, AND across facets. An empty
 * facet selection is a pass (no constraint). The `stage` facet honours the
 * {@link STAGE_NONE} pseudo-slug — "workflows with no stage tag".
 */
export function matchesFacets(
  w: WorkflowSummary,
  sel: FacetSelection,
): boolean {
  const f = effectiveFacets(w);

  if (sel.domain.size > 0 && !f.domains.some((d) => sel.domain.has(d))) {
    return false;
  }
  if (sel.purpose.size > 0 && !f.purposes.some((p) => sel.purpose.has(p))) {
    return false;
  }
  if (sel.trigger.size > 0 && !f.triggers.some((t) => sel.trigger.has(t))) {
    return false;
  }
  if (sel.stage.size > 0) {
    const stageHit = [...sel.stage].some((s) =>
      s === STAGE_NONE ? f.stages.length === 0 : f.stages.includes(s),
    );
    if (!stageHit) return false;
  }
  if (sel.tag.size > 0 && !w.tags.some((t) => sel.tag.has(t))) {
    return false;
  }
  return true;
}
