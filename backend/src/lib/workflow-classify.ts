/**
 * src/lib/workflow-classify.ts
 *
 * Workflow facet classification — the single source of truth shared by the
 * `/api/workflows` route handler and the `scripts/tag-n8n-workflows.ts`
 * tagging script. Keeping both consumers on this module means the tags the
 * script writes into n8n and the facets the route expects to read back can
 * never drift.
 *
 * Four orthogonal facets, each encoded as a namespaced n8n tag
 * (`<facet>:<slug>`, see {@link FACET_SEP} / {@link facetTag}):
 *   · domain   — which subsystem the flow operates on (from node packages)
 *   · purpose  — what the flow is for (from the workflow name + node signal)
 *   · stage    — card/authoring lifecycle stage (from the workflow name)
 *   · trigger  — how the flow starts (from its trigger node types)
 *
 * domain/purpose classification was originally derived live in
 * routes/workflows.ts; it was lifted here unchanged so the tagging script
 * can reuse it. trigger/stage classification is new.
 */

// ---------------------------------------------------------------------------
// Facet tag encoding
// ---------------------------------------------------------------------------

/**
 * Delimiter between a facet namespace and its slug in an n8n tag string.
 * Probe-verified 2026-05-14: n8n's Public API stores `zzz:probe` verbatim,
 * so `:` is safe. If a future n8n version mangles it, flip this to `-` —
 * it is the ONLY place the separator is defined.
 */
export const FACET_SEP = ':';

/** The four facet namespaces this module owns. */
export const FACET_NAMESPACES = [
  'domain',
  'purpose',
  'stage',
  'trigger',
] as const;
export type FacetNamespace = (typeof FACET_NAMESPACES)[number];

/** Build a namespaced tag string, e.g. `facetTag('domain', 'kanban')`. */
export function facetTag(facet: FacetNamespace, slug: string): string {
  return `${facet}${FACET_SEP}${slug}`;
}

/**
 * Parse a tag string into `{ facet, slug }` if it is one this module owns,
 * else `null` (plain / manual tags pass through untouched).
 */
export function parseFacetTag(
  tag: string,
): { facet: FacetNamespace; slug: string } | null {
  const idx = tag.indexOf(FACET_SEP);
  if (idx <= 0) return null;
  const facet = tag.slice(0, idx);
  const slug = tag.slice(idx + FACET_SEP.length);
  if (!slug) return null;
  if ((FACET_NAMESPACES as readonly string[]).includes(facet)) {
    return { facet: facet as FacetNamespace, slug };
  }
  return null;
}

/** lowercase, collapse any run of non-alphanumerics to a single `-`. */
export function slugify(label: string): string {
  return label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ---------------------------------------------------------------------------
// Domain — which subsystem the flow operates on (from node packages)
// ---------------------------------------------------------------------------

/**
 * Custom-node package prefix → Domain label. n8n emits node types as
 * `@nonagentic/n8n-nodes-<pkg>.<name>`; the trailing `.` in each prefix
 * keeps the matches disjoint (no package name is a prefix of another up
 * to the dot). A workflow with no `@nonagentic` nodes is `General`.
 */
export const DOMAIN_NODE_PREFIXES: ReadonlyArray<readonly [string, string]> = [
  ['@nonagentic/n8n-nodes-kaizen-core-actions.', 'Kaizen'],
  ['@nonagentic/n8n-nodes-kaizen-discover-actions.', 'Kaizen'],
  ['@nonagentic/n8n-nodes-meta-prompt-core-actions.', 'Meta-Prompt'],
  ['@nonagentic/n8n-nodes-meta-prompt-discover-actions.', 'Meta-Prompt'],
  ['@nonagentic/n8n-nodes-skill-builder.', 'Skill Builder'],
  ['@nonagentic/n8n-nodes-kanban.', 'Kanban'],
  ['@nonagentic/n8n-nodes-coding.', 'Coding'],
  ['@nonagentic/n8n-nodes-workers.', 'Workers'],
  ['@nonagentic/n8n-nodes-kag.', 'KAG'],
  ['@nonagentic/n8n-nodes-observability.', 'Observability'],
  ['@nonagentic/n8n-nodes-requirements.', 'Requirements'],
  ['@nonagentic/n8n-nodes-licenses.', 'Licenses'],
  ['@nonagentic/n8n-nodes-signal.', 'Signal'],
  ['@nonagentic/n8n-nodes-secrets.', 'Secrets'],
  ['@nonagentic/n8n-nodes-metering.', 'Metering'],
  ['@nonagentic/n8n-nodes-keycloak.', 'Keycloak'],
  ['@nonagentic/n8n-nodes-mcp.', 'MCP'],
  ['@nonagentic/n8n-nodes-artifacts.', 'Artifacts'],
  ['@nonagentic/n8n-nodes-tools.', 'Tools'],
  ['@nonagentic/n8n-nodes-workflows.', 'Orchestration'],
  ['@nonagentic/n8n-nodes-fr.', 'FR'],
] as const;

export const GENERAL_DOMAIN = 'General';

/** Every Domain label the classifier can emit, in sidebar display order. */
export const DOMAINS: readonly string[] = [
  ...new Set(DOMAIN_NODE_PREFIXES.map(([, label]) => label)),
  GENERAL_DOMAIN,
].sort((a, b) =>
  a === GENERAL_DOMAIN ? 1 : b === GENERAL_DOMAIN ? -1 : a.localeCompare(b),
);

export interface DomainClassification {
  /** Every domain the workflow touches, by node-instance count desc. */
  domains: string[];
  /** The single dominant domain (most node instances; ties → alphabetical). */
  primaryDomain: string;
}

/**
 * Classify a workflow's domain(s) from its node types. Counts node
 * instances per domain so `primaryDomain` reflects where the workflow's
 * weight actually sits, not just which packages it happens to touch once.
 */
export function classifyDomains(nodeTypes: string[]): DomainClassification {
  const counts = new Map<string, number>();
  for (const nt of nodeTypes) {
    const match = DOMAIN_NODE_PREFIXES.find(([prefix]) => nt.startsWith(prefix));
    if (match) counts.set(match[1], (counts.get(match[1]) ?? 0) + 1);
  }
  if (counts.size === 0) {
    return { domains: [GENERAL_DOMAIN], primaryDomain: GENERAL_DOMAIN };
  }
  const ranked = [...counts.entries()].sort(
    (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
  );
  return {
    domains: ranked.map(([label]) => label),
    primaryDomain: ranked[0]![0],
  };
}

// ---------------------------------------------------------------------------
// Purpose — what the flow is for (from the workflow name + node signal)
// ---------------------------------------------------------------------------

export type WorkflowPurpose =
  | 'Improvement'
  | 'Pattern'
  | 'Authoring'
  | 'Test & Monitoring'
  | 'Demo'
  | 'Card Flow'
  | 'Activity'
  | 'Operational';

/** Every Purpose label, in sidebar display order. */
export const PURPOSES: readonly WorkflowPurpose[] = [
  'Improvement',
  'Pattern',
  'Authoring',
  'Card Flow',
  'Activity',
  'Demo',
  'Test & Monitoring',
  'Operational',
] as const;

const IMPROVEMENT_NODE_PREFIXES = [
  '@nonagentic/n8n-nodes-kaizen-core-actions.',
  '@nonagentic/n8n-nodes-kaizen-discover-actions.',
  '@nonagentic/n8n-nodes-meta-prompt-core-actions.',
  '@nonagentic/n8n-nodes-meta-prompt-discover-actions.',
] as const;

/**
 * Purpose — a single "what is this flow for" label, first match wins.
 * Driven by the workflow name (the naming convention carries the intent:
 * `improve::*`, `AA Pattern - *`, `authoring::*`, `smoke::*`, `* Demo`)
 * plus the kaizen/meta-prompt node signal for improvement flows whose
 * names don't say so.
 */
export function classifyPurpose(
  name: string,
  nodeTypes: string[] = [],
): WorkflowPurpose {
  const n = name.trim();
  const hasImprovementNode = nodeTypes.some((nt) =>
    IMPROVEMENT_NODE_PREFIXES.some((p) => nt.startsWith(p)),
  );
  if (hasImprovementNode || /^improve\b|^improve::/i.test(n)) {
    return 'Improvement';
  }
  if (/^AA\s+Pattern\b/i.test(n)) return 'Pattern';
  if (/^authoring::/i.test(n)) return 'Authoring';
  // Card Flow is checked BEFORE Test & Monitoring: an `AA Card - …-qa`
  // name carries `qa` as a lifecycle *stage* suffix (now its own facet),
  // not a purpose — the test-monitoring `\bqa\b` token would otherwise
  // mis-claim it.
  if (/^(AA[\s-]+)?Card\b/i.test(n)) return 'Card Flow';
  if (/\b(smoke|test|qa|watchdog|canary|detector|probe)\b/i.test(n)) {
    return 'Test & Monitoring';
  }
  if (/\b(demo|sample|example)\b/i.test(n)) return 'Demo';
  if (/^Activity\b/i.test(n)) return 'Activity';
  return 'Operational';
}

// ---------------------------------------------------------------------------
// Stage — card / authoring lifecycle stage (from the workflow name)
// ---------------------------------------------------------------------------

/**
 * Lifecycle stage slugs. Note there is no `(none)` slug — a workflow with
 * no stage signal in its name simply gets NO `stage:` tag. "(none)" as a
 * filter is the ABSENCE of any stage tag, handled frontend-side.
 */
export const STAGES = ['doing', 'done', 'qa', 'ready', 'blocked'] as const;
export type WorkflowStage = (typeof STAGES)[number];

/** Display labels for stage slugs (the slug `qa` capitalises oddly). */
export const STAGE_LABELS: Record<WorkflowStage, string> = {
  doing: 'Doing',
  done: 'Done',
  qa: 'QA',
  ready: 'Ready',
  blocked: 'Blocked',
};

const STAGE_TOKEN =
  /(?:^|[.\-:\s])(doing|done|qa|ready|blocked)(?=$|[.\-:\s])/gi;

/**
 * Derive a lifecycle stage from a workflow name, or `null` if the name
 * carries no stage signal. The card/authoring naming convention puts the
 * stage in a delimited segment — trailing in the namespace styles
 * (`improve::workflow.workflow_development.doing`,
 * `AA Card - development-feature-new-qa`) and sometimes leading
 * (`Ready - Prefetch Context`, `Done - Publish`). We take the LAST
 * delimited `doing|done|qa|ready|blocked` token so the deepest suffix wins.
 */
export function classifyStage(name: string): WorkflowStage | null {
  let last: WorkflowStage | null = null;
  for (const m of name.matchAll(STAGE_TOKEN)) {
    last = m[1]!.toLowerCase() as WorkflowStage;
  }
  return last;
}

// ---------------------------------------------------------------------------
// Trigger — how the flow starts (from its trigger node types)
// ---------------------------------------------------------------------------

export const TRIGGERS = [
  'webhook',
  'manual',
  'sub-workflow',
  'schedule',
] as const;
export type WorkflowTrigger = (typeof TRIGGERS)[number];

export const TRIGGER_LABELS: Record<WorkflowTrigger, string> = {
  webhook: 'Webhook',
  manual: 'Manual',
  'sub-workflow': 'Sub-workflow',
  schedule: 'Schedule',
};

/**
 * Trigger-node `type` suffix → trigger slug. A workflow can legitimately
 * have several trigger nodes, so {@link classifyTriggers} returns 0..n
 * slugs. A workflow with no trigger node (sub-nodes, fully disabled
 * triggers) gets none — that is a valid state, not an error.
 */
const TRIGGER_NODE_SUFFIXES: ReadonlyArray<readonly [string, WorkflowTrigger]> =
  [
    ['.webhook', 'webhook'],
    ['.formTrigger', 'webhook'],
    ['.chatTrigger', 'webhook'],
    ['.manualTrigger', 'manual'],
    ['.executeWorkflowTrigger', 'sub-workflow'],
    ['.scheduleTrigger', 'schedule'],
    ['.cron', 'schedule'],
    ['.interval', 'schedule'],
  ] as const;

/** Distinct trigger slugs for a workflow, in {@link TRIGGERS} order. */
export function classifyTriggers(nodeTypes: string[]): WorkflowTrigger[] {
  const found = new Set<WorkflowTrigger>();
  for (const nt of nodeTypes) {
    for (const [suffix, slug] of TRIGGER_NODE_SUFFIXES) {
      if (nt.endsWith(suffix)) found.add(slug);
    }
  }
  return TRIGGERS.filter((t) => found.has(t));
}

// ---------------------------------------------------------------------------
// Slug ↔ label tables (consumed by the route + tagging script + frontend)
// ---------------------------------------------------------------------------

function buildSlugLabelTable(
  labels: readonly string[],
): { slugToLabel: Record<string, string>; labelToSlug: Record<string, string> } {
  const slugToLabel: Record<string, string> = {};
  const labelToSlug: Record<string, string> = {};
  for (const label of labels) {
    const slug = slugify(label);
    slugToLabel[slug] = label;
    labelToSlug[label] = slug;
  }
  return { slugToLabel, labelToSlug };
}

const domainTable = buildSlugLabelTable(DOMAINS);
const purposeTable = buildSlugLabelTable(PURPOSES);

export const DOMAIN_SLUG_TO_LABEL = domainTable.slugToLabel;
export const DOMAIN_LABEL_TO_SLUG = domainTable.labelToSlug;
export const PURPOSE_SLUG_TO_LABEL = purposeTable.slugToLabel;
export const PURPOSE_LABEL_TO_SLUG = purposeTable.labelToSlug;

/**
 * Compute the full desired set of namespaced facet tags for a workflow
 * from its name + node types. This is what the tagging script writes into
 * n8n and what the route's fallback would derive. Stage is omitted when
 * the name carries no stage signal.
 */
export function computeFacetTags(
  name: string,
  nodeTypes: string[],
): string[] {
  const tags: string[] = [];
  for (const domain of classifyDomains(nodeTypes).domains) {
    tags.push(facetTag('domain', DOMAIN_LABEL_TO_SLUG[domain] ?? slugify(domain)));
  }
  const purpose = classifyPurpose(name, nodeTypes);
  tags.push(
    facetTag('purpose', PURPOSE_LABEL_TO_SLUG[purpose] ?? slugify(purpose)),
  );
  const stage = classifyStage(name);
  if (stage) tags.push(facetTag('stage', stage));
  for (const trigger of classifyTriggers(nodeTypes)) {
    tags.push(facetTag('trigger', trigger));
  }
  return tags;
}
