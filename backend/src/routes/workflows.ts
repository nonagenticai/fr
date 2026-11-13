/**
 * src/routes/workflows.ts
 *
 * Read-only Workflows Viewer surface. Proxies n8n's Public API through the
 * existing `integrations/n8n.ts` adapter so the customer-facing browser at
 * /workflows in the SvelteKit app never has to talk to n8n directly.
 *
 * Spec: docs/superpowers/plans/2026-05-09-workflows-viewer.md (Task 2).
 *
 * Endpoints (all behind validateAuth):
 *   GET /api/workflows         -> [{id, name, active, tags, facets,
 *                                  domains, primaryDomain, purpose,
 *                                  updatedAt, nodeCount}]
 *   GET /api/workflows/tags    -> { domain[], purpose[], stage[], trigger[],
 *                                   other[] } — faceted counts
 *   GET /api/workflows/:id     -> full workflow JSON (nodes + connections + settings)
 *
 * ⛔ THE READ PATH NEVER TALKS TO n8n.
 *
 * The list and tags endpoints serve a process-global in-memory entry that is
 * populated exclusively by `workers/workflows-cache.ts` on a
 * REFRESH_INTERVAL_MS tick (plus an immediate kick at boot). `readCache()`
 * decides what to serve synchronously and returns; a stale or missing entry
 * kicks a background refresh with `void` and answers immediately. The detail
 * endpoint (`/:id`) is a single cheap upstream GET and stays uncached — when a
 * customer opens one workflow we want the latest definition.
 *
 * Why: n8n's `/workflows` costs ~110 ms PER WORKFLOW (measured 2026-08-10 from
 * inside the fr pod; unconditional `activeVersion` eager join + a per-row tags
 * fan-out, ~50 MB for the 255-workflow catalogue). A full crawl was 28 s typical
 * / 82,635 ms worst MEASURED at the old 250-item page; at the 20-item page this
 * change introduces it is ~35.7 s typical and up to ~166 s pessimistic (13 round
 * trips — see `integrations/n8n.ts WORKFLOW_PAGE_SIZE` for the derivation and
 * why 166 s is an extrapolation, not a measurement). Smaller pages make the
 * crawl SLOWER overall; what they buy is that each individual request survives
 * its 15 s budget. GET /api/workflows 504'd on 10 of 27 requests over 30 h
 * of pod logs and the home page rendered `— Workflows active`. That cost is
 * upstream and irreducible from fr, so the only fix available here is that no
 * user request may ever await it. Caching harder does not do it: with the
 * page-size fix the crawl stops timing out at 30 s and starts SUCCEEDING in
 * ~36–166 s, which would turn a 30 s 504 into a multi-minute held connection
 * (nothing caps it server-side — `Bun.serve` runs with `idleTimeout: 0`).
 *
 * A served entry past CACHE_MS carries `degraded: true` + `stale_as_of` BESIDE
 * `data` on the envelope and logs `[workflows] upstream refresh failed …`.
 * Past MAX_STALE_MS, and on a cold cache, the recorded upstream error is
 * returned — immediately, not after a timeout budget.
 *
 * ---------------------------------------------------------------------------
 * Facets
 *
 * Workflows are filtered by four orthogonal facets — domain / purpose /
 * stage / trigger. These now come from **namespaced n8n tags**
 * (`domain:kanban`, `purpose:demo`, `stage:qa`, `trigger:webhook`); the
 * tag vocabulary is written into n8n by `scripts/tag-n8n-workflows.ts`,
 * which classifies every workflow with the SAME `lib/workflow-classify.ts`
 * module this route reads.
 *
 * Transition fallback: if a workflow carries no tag for a given facet
 * (e.g. the tagging script has not run yet, or a brand-new workflow), that
 * facet is derived live from the workflow's name + node types so the page
 * never renders blank. The legacy label fields `domains` / `primaryDomain`
 * / `purpose` are likewise kept for one release for a frontend that
 * predates `facets`. Both fallbacks are slated for removal once tagging is
 * confirmed to cover the whole catalogue.
 * ---------------------------------------------------------------------------
 */

import { validateAuth } from '../middleware/auth';
import { createSingleFlight } from '../lib/single-flight';
import { jsonResponse } from '../utils/response';
import { handle } from './assets/_lib/handler';
import {
  IntegrationError,
  isIntegrationError,
} from '../integrations/_lib/errors';
import {
  listWorkflows,
  getWorkflow,
  type Workflow,
} from '../integrations/n8n';
import {
  classifyDomains,
  classifyPurpose,
  classifyStage,
  classifyTriggers,
  parseFacetTag,
  slugify,
  DOMAIN_LABEL_TO_SLUG,
  DOMAIN_SLUG_TO_LABEL,
  PURPOSE_LABEL_TO_SLUG,
  PURPOSE_SLUG_TO_LABEL,
  STAGES,
  STAGE_LABELS,
  TRIGGERS,
  TRIGGER_LABELS,
  type WorkflowPurpose,
} from '../lib/workflow-classify';
import { withIntegrationCatch } from './_lib';
import {
  canReadProductionWorkflows,
  productionWorkflowNotFoundError,
} from '../lib/production-workflows-gate';

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * How often `workers/workflows-cache.ts` re-crawls n8n. The default for the
 * worker's `WORKFLOWS_CACHE_REFRESH_INTERVAL_MS` override.
 *
 * The crawl is upstream-bound and, at the 20-item page size this change also
 * introduces, costs ≈35.7 s typical and up to ≈166 s pessimistic for today's
 * 255 workflows over 13 pages (derivation + the caveat that 166 s is an
 * EXTRAPOLATION rather than a measurement: see
 * `integrations/n8n.ts WORKFLOW_PAGE_SIZE`). The only real knob is therefore
 * how much n8n DB time fr is willing to burn:
 *
 *   10 min (this)  duty cycle 35.7/600 = 6.0% typical, 166/600 = 27.7% pessimistic
 *    5 min         11.9% / 55.4% — the pessimistic arm would overlap itself
 *   30 min          2.0% /  9.2%, but a newly created workflow stays invisible
 *                  for up to half an hour, which is user-visible nonsense on a
 *                  page whose whole job is showing the fleet
 *
 * ⚠️ Note the honest comparison: the 30 s TTL this replaces cost 2.19 h of n8n
 * DB time per 42 h (5.2%) at the OLD 2-page shape, so 6.0% is marginally MORE
 * upstream load, not less. What changes is where it is spent — on a background
 * tick instead of on a user request that 504'd 10 of 27 times.
 */
export const REFRESH_INTERVAL_MS = 10 * 60_000;

/**
 * How long an entry is considered FRESH: one refresh interval plus 2 minutes of
 * slack, so a tick that starts at T and lands later still finds the previous
 * entry fresh rather than flapping a healthy pod into `degraded`.
 *
 * ⚠️ Be precise about what the 2 min does and does not cover. `setInterval`
 * fires on a fixed cadence, so consecutive writes are spaced
 * `600 s + (Dₙ₊₁ − Dₙ)` apart where D is crawl duration — the slack has to
 * absorb the SWING in crawl time, not its absolute value. Measured/derived
 * D ranges ≈35.7 s (typical) to ≈166 s (pessimistic extrapolation), a maximum
 * swing of ≈130 s, which is just over the 120 s of slack. So the honest claim
 * is NOT "a healthy pod can never show `degraded`" — it is that a healthy pod
 * shows it only if the crawl time jumps by more than two minutes between two
 * consecutive ticks, and then for ~10 s. `degraded` therefore means "refreshes
 * are failing, or the crawl time just swung by >2 min", with the first
 * overwhelmingly more likely. The 2 min also fully covers the worst crawl ever
 * actually MEASURED (82,635 ms).
 */
const CACHE_MS = REFRESH_INTERVAL_MS + 2 * 60_000;

/**
 * Hard ceiling on how old an entry may be and still be served. Past it the
 * recorded upstream error is returned instead.
 *
 * ⚠️ RAISED from 15 min to 60 min, which WEAKENS a bound #793 chose on purpose.
 * The justification is arithmetic, not appetite: #793's 15 min was 30× a 30 s
 * TTL, i.e. "thirty missed refresh opportunities". Against a 12-minute TTL the
 * same 15 min is 1.25 — ONE missed refresh cycle would hard-504 the page, so a
 * single failed tick (an n8n pod restart, a rolling redeploy — exactly the
 * transient class stale-serving exists for) would produce the em-dash this
 * whole change exists to remove. 60 min restores the intent: six consecutive
 * FAILED refreshes, each of them logged, before fr stops answering.
 *
 * WHY THERE IS A CEILING AT ALL — and note this reasoning has MOVED. #793's
 * original argument was that the frontend client dropped the `degraded` marker,
 * so an unbounded fallback would render a six-hour-old fleet count with total
 * confidence and nothing anywhere would say otherwise. That is no longer true:
 * `frontend/src/lib/api/workflows.ts` carries the envelope through and both
 * /workflows pages render a staleness banner off it (see `cacheResponse`).
 * The ceiling stays regardless, on the weaker but sufficient ground: a banner
 * makes stale data HONEST, not USEFUL, and an unbounded cache would let fr
 * answer indefinitely for an n8n that is simply gone. `integrations/coding/
 * spine.ts` renders its staleness too and does NOT bound its snapshot fallback;
 * that is a deliberate difference, not an inconsistency — its snapshot is a
 * point-in-time record, this is a live fleet inventory.
 */
const MAX_STALE_MS = 60 * 60_000;

// ---------------------------------------------------------------------------
// Row + facet shapes
// ---------------------------------------------------------------------------

interface Facets {
  /** domain slugs the workflow touches (>=1; falls back to a derived slug). */
  domains: string[];
  /** purpose slugs (normally exactly 1; falls back to a derived slug). */
  purposes: string[];
  /** stage slugs (0 or 1 — absence is the "(none)" filter state). */
  stages: string[];
  /** trigger slugs (0..n). */
  triggers: string[];
}

export interface ListRow {
  id: string;
  name: string;
  active: boolean;
  /** Every raw tag on the workflow, namespaced + plain, for the card chips. */
  tags: string[];
  /** Parsed facet slugs — the filter surface. */
  facets: Facets;
  /**
   * Legacy derived label fields. Kept for one release so a frontend that
   * predates `facets` still renders; remove with the derive fallback once
   * tagging covers the whole catalogue.
   */
  domains: string[];
  primaryDomain: string;
  purpose: WorkflowPurpose;
  updatedAt: string;
  nodeCount: number;
}

/** One row of the faceted `/tags` response. */
interface FacetCount {
  slug: string;
  label: string;
  workflowCount: number;
}

/** A non-namespaced ("manual") tag and how many workflows carry it. */
interface OtherTagCount {
  tag: string;
  workflowCount: number;
}

interface FacetedTags {
  domain: FacetCount[];
  purpose: FacetCount[];
  stage: FacetCount[];
  trigger: FacetCount[];
  other: OtherTagCount[];
}

interface CacheEntry {
  rows: ListRow[];
  tags: FacetedTags;
  /** Wall clock at which the upstream crawl that produced this entry finished. */
  fetchedAt: number;
  expiresAt: number;
}

let cache: CacheEntry | null = null;

/**
 * The last refresh failure, kept so a user request can report WHY it has
 * nothing fresh without ever attempting the crawl itself. Cleared on every
 * successful refresh. Null also when the last failure was one of OUR bugs (a
 * non-IntegrationError) — those are never surfaced to a client as an upstream
 * fault; see `primeWorkflowsCache`.
 */
let lastRefreshError: IntegrationError | null = null;

/** Wall clock of the last refresh ATTEMPT (success or failure). */
let lastRefreshAt: number | null = null;

/**
 * Coalesces concurrent refreshes onto one upstream crawl.
 *
 * Since the read path stopped refreshing (see `readCache`), the callers that
 * collide here are the background worker's tick and the opportunistic
 * `void primeWorkflowsCache()` kicked by an expired read — plus, at boot, the
 * worker's immediate kick racing the first user requests. Without coalescing,
 * N of those issue N full crawls against the upstream that is already the slow
 * party.
 *
 * Historic note, and the reason this arm exists at all: the observed incident
 * was a COLD cache, not a stale one. `/workflows/+page.ts` fires
 * `listWorkflows()` and `listTags()` in one `Promise.all`, so a first page load
 * after a pod restart started two crawls at once. Live pod log — the second
 * request began during the first's 25s crawl and burned its own full timeout
 * budget:
 *   14:36:20.979 GET /api/workflows 200 24985.1ms
 *   14:36:46.876 GET /api/workflows 504 30206.8ms
 *
 * One key: this cache is a single process-global entry, not per-tenant.
 */
const refreshFlight = createSingleFlight<CacheEntry>();
const REFRESH_KEY = 'workflows';

// ---------------------------------------------------------------------------
// Row shaping
// ---------------------------------------------------------------------------

function nodeTypesOf(w: Workflow): string[] {
  const rawNodes = Array.isArray(w.nodes) ? (w.nodes as unknown[]) : [];
  const nodeTypes: string[] = [];
  for (const n of rawNodes) {
    if (n && typeof n === 'object' && 'type' in n) {
      const t = (n as { type?: unknown }).type;
      if (typeof t === 'string') nodeTypes.push(t);
    }
  }
  return nodeTypes;
}

function rawTagsOf(w: Workflow): string[] {
  const rawTags = Array.isArray(w.tags) ? (w.tags as unknown[]) : [];
  return rawTags
    .map((t) => {
      if (typeof t === 'string') return t;
      if (t && typeof t === 'object' && 'name' in t) {
        const name = (t as { name?: unknown }).name;
        return typeof name === 'string' ? name : undefined;
      }
      return undefined;
    })
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}

/**
 * Build the four-facet structure for a workflow. Each facet is read from
 * the workflow's namespaced tags; if a facet has no tag, it is derived
 * live from name + node types (the transition fallback — see file header).
 */
function buildFacets(
  name: string,
  nodeTypes: string[],
  tags: string[],
): Facets {
  const domains: string[] = [];
  const purposes: string[] = [];
  const stages: string[] = [];
  const triggers: string[] = [];
  for (const tag of tags) {
    const parsed = parseFacetTag(tag);
    if (!parsed) continue;
    if (parsed.facet === 'domain') domains.push(parsed.slug);
    else if (parsed.facet === 'purpose') purposes.push(parsed.slug);
    else if (parsed.facet === 'stage') stages.push(parsed.slug);
    else if (parsed.facet === 'trigger') triggers.push(parsed.slug);
  }

  // Per-facet derive fallback — only fills a facet that has no tag at all.
  if (domains.length === 0) {
    for (const d of classifyDomains(nodeTypes).domains) {
      domains.push(DOMAIN_LABEL_TO_SLUG[d] ?? slugify(d));
    }
  }
  if (purposes.length === 0) {
    const p = classifyPurpose(name, nodeTypes);
    purposes.push(PURPOSE_LABEL_TO_SLUG[p] ?? slugify(p));
  }
  if (stages.length === 0) {
    const s = classifyStage(name);
    if (s) stages.push(s);
  }
  if (triggers.length === 0) {
    triggers.push(...classifyTriggers(nodeTypes));
  }

  return {
    domains: [...new Set(domains)],
    purposes: [...new Set(purposes)],
    stages: [...new Set(stages)],
    triggers: [...new Set(triggers)],
  };
}

function shapeRow(w: Workflow): ListRow | null {
  if (!w.id) return null;
  const name = w.name ?? w.id;
  const tags = rawTagsOf(w);
  const nodeTypes = nodeTypesOf(w);
  const updatedAt = typeof w.updatedAt === 'string' ? w.updatedAt : '';
  const rawNodes = Array.isArray(w.nodes) ? (w.nodes as unknown[]) : [];

  const facets = buildFacets(name, nodeTypes, tags);

  // Legacy label fields — always derived, independent of tags. Drop with
  // the rest of the transition fallback once tagging is confirmed.
  const { domains, primaryDomain } = classifyDomains(nodeTypes);

  return {
    id: w.id,
    name,
    active: Boolean(w.active),
    tags,
    facets,
    domains,
    primaryDomain,
    purpose: classifyPurpose(name, nodeTypes),
    updatedAt,
    nodeCount: rawNodes.length,
  };
}

// ---------------------------------------------------------------------------
// Faceted tag counts
// ---------------------------------------------------------------------------

function bumpFacet(
  bucket: Map<string, number>,
  slugs: string[],
): void {
  for (const slug of slugs) bucket.set(slug, (bucket.get(slug) ?? 0) + 1);
}

/**
 * Order a facet's slug→count map into the canonical display order, using
 * the slug→label table for the human label. Slugs not in the canonical
 * order (e.g. a derived slug that fell outside the known set) are appended
 * alphabetically so nothing is silently dropped.
 */
function orderedFacet(
  counts: Map<string, number>,
  order: readonly string[],
  labelOf: (slug: string) => string,
): FacetCount[] {
  const seen = new Set<string>();
  const out: FacetCount[] = [];
  for (const slug of order) {
    if (counts.has(slug)) {
      out.push({ slug, label: labelOf(slug), workflowCount: counts.get(slug)! });
      seen.add(slug);
    }
  }
  const extras = [...counts.keys()].filter((s) => !seen.has(s)).sort();
  for (const slug of extras) {
    out.push({ slug, label: labelOf(slug), workflowCount: counts.get(slug)! });
  }
  return out;
}

/**
 * Stage facet pseudo-slug for workflows that carry no `stage:` tag — the
 * "(none)" filter row in the sidebar. Mirrors `STAGE_NONE` in the
 * frontend's `$lib/workflows/facets.ts`.
 */
const STAGE_NONE_SLUG = '__none__';

function deriveFacetedTags(rows: ListRow[]): FacetedTags {
  const domain = new Map<string, number>();
  const purpose = new Map<string, number>();
  const stage = new Map<string, number>();
  const trigger = new Map<string, number>();
  const other = new Map<string, number>();
  let stagelessCount = 0;

  for (const row of rows) {
    bumpFacet(domain, row.facets.domains);
    bumpFacet(purpose, row.facets.purposes);
    bumpFacet(stage, row.facets.stages);
    bumpFacet(trigger, row.facets.triggers);
    if (row.facets.stages.length === 0) stagelessCount += 1;
    // "other" = raw tags that are NOT one of our namespaced facet tags.
    for (const tag of row.tags) {
      if (parseFacetTag(tag) === null) {
        other.set(tag, (other.get(tag) ?? 0) + 1);
      }
    }
  }
  if (stagelessCount > 0) stage.set(STAGE_NONE_SLUG, stagelessCount);

  const domainOrder = Object.keys(DOMAIN_SLUG_TO_LABEL).sort((a, b) => {
    const la = DOMAIN_SLUG_TO_LABEL[a]!;
    const lb = DOMAIN_SLUG_TO_LABEL[b]!;
    if (la === 'General') return 1;
    if (lb === 'General') return -1;
    return la.localeCompare(lb);
  });

  return {
    domain: orderedFacet(
      domain,
      domainOrder,
      (s) => DOMAIN_SLUG_TO_LABEL[s] ?? s,
    ),
    purpose: orderedFacet(
      purpose,
      Object.keys(PURPOSE_SLUG_TO_LABEL),
      (s) => PURPOSE_SLUG_TO_LABEL[s] ?? s,
    ),
    stage: orderedFacet(
      stage,
      [...STAGES, STAGE_NONE_SLUG],
      (s) =>
        s === STAGE_NONE_SLUG
          ? '(none)'
          : (STAGE_LABELS[s as keyof typeof STAGE_LABELS] ?? s),
    ),
    trigger: orderedFacet(
      trigger,
      TRIGGERS,
      (s) => TRIGGER_LABELS[s as keyof typeof TRIGGER_LABELS] ?? s,
    ),
    other: [...other.entries()]
      .map(([tag, workflowCount]) => ({ tag, workflowCount }))
      .sort(
        (a, b) =>
          b.workflowCount - a.workflowCount || a.tag.localeCompare(b.tag),
      ),
  };
}

// ---------------------------------------------------------------------------
// Cache plumbing
// ---------------------------------------------------------------------------

/**
 * The raw crawl. REJECTS on failure and records the outcome. Exported so the
 * background worker (and tests) can drive one refresh deterministically.
 *
 * This is the ONLY function in this module that talks to n8n, and it must never
 * be reachable from a request handler — it costs ~36 s typical, up to ~166 s.
 */
async function refreshWorkflowsCatalogue(): Promise<CacheEntry> {
  try {
    // No `limit` — listWorkflows follows n8n's cursor across every page and
    // returns the whole catalogue. (It used to fetch a single page of 250
    // and silently drop the tail once the catalogue grew past that.)
    const upstream = await listWorkflows();
    const rows = upstream.workflows
      .map(shapeRow)
      .filter((r): r is ListRow => r !== null);
    const tags = deriveFacetedTags(rows);
    const now = Date.now();
    const entry: CacheEntry = {
      rows,
      tags,
      fetchedAt: now,
      expiresAt: now + CACHE_MS,
    };
    cache = entry;
    lastRefreshAt = now;
    lastRefreshError = null;
    return entry;
  } catch (err) {
    lastRefreshAt = Date.now();
    // Only an *upstream* failure is recorded as one. A TypeError thrown by
    // shapeRow/deriveFacetedTags is OUR bug; recording it here would let a
    // request handler report it to a client as `service: n8n`, blaming the
    // upstream for something fr did. It is surfaced by `primeWorkflowsCache`
    // as a console.error instead — see there.
    lastRefreshError = isIntegrationError(err) ? err : null;
    throw err;
  }
}

/**
 * Refresh in the background, coalesced, and NEVER reject.
 *
 * This is what both the worker tick and the read path's opportunistic kick
 * call. A rejecting version would be a floating rejection at boot — the failure
 * mode documented at `server.ts` (the coverage-check block): a
 * `[FATAL] Unhandled rejection` on every boot while the pod happily serves
 * traffic, which reads like a crash and acts like a warning.
 */
export function primeWorkflowsCache(): Promise<void> {
  return refreshFlight.run(REFRESH_KEY, refreshWorkflowsCatalogue).then(
    (entry) => {
      console.log(
        `[workflows] catalogue refreshed: ${entry.rows.length} workflows`,
      );
    },
    (err: unknown) => {
      if (isIntegrationError(err)) {
        // n8n is down/slow. Expected class, one line, warn.
        console.warn(
          `[workflows] background refresh failed (${err.code}: ${err.message})`,
        );
        return;
      }
      // This is the surviving form of the guarantee the old `ensureCache` held
      // with `if (!cache || !isIntegrationError(err)) throw err`: a TypeError
      // out of shapeRow/deriveFacetedTags used to surface as a 500 on the
      // request that hit it. That request no longer exists — the crawl runs on
      // a background tick where nothing user-facing can see it — so `error`
      // (not `warn`) is the only thing standing between one of OUR bugs and
      // permanent silence. Deliberately a DIFFERENT level and a DIFFERENT
      // prefix from the upstream-failure line above, so the two are separable
      // in a log query.
      console.error(
        '[workflows] background refresh threw a NON-UPSTREAM error — this is a bug in fr, not n8n:',
        err,
      );
    },
  );
}

/** What `readCache` served, and whether it is honest to call it fresh. */
interface CacheRead {
  entry: CacheEntry;
  /**
   * True when the entry is past its declared freshness (`CACHE_MS`) and no
   * refresh has replaced it yet. On a healthy pod this never happens: the
   * worker refreshes every REFRESH_INTERVAL_MS and CACHE_MS is a whole worst
   * crawl longer than that, so `degraded` means refreshes are FAILING.
   */
  degraded: boolean;
}

/**
 * The error to report when there is nothing FRESH to serve and no upstream
 * failure has been recorded — a cold start whose boot prime has not landed, an
 * entry that aged out while a refresh is still running, or a last failure that
 * was one of OUR bugs (deliberately not recorded as an upstream fault).
 *
 * ⚠️ Only call this from `readCache`, immediately after kicking
 * `primeWorkflowsCache()` — the message asserts a refresh is in progress, and
 * that is only true there.
 *
 * UPSTREAM_TIMEOUT because it is the only code that maps to 504, and 504 is the
 * contract this route already had for "no catalogue": the frontend's `readJson`
 * throws on a non-ok, `OperateSummaryCard` renders `—`, and an em-dash is the
 * correct rendering of "we don't know". A 2xx here would render `0/0` — a wrong
 * number, stated confidently.
 */
function noFreshEntryError(): IntegrationError {
  const since =
    lastRefreshAt === null
      ? 'no refresh has completed yet'
      : `last refresh attempt was ${Math.round((Date.now() - lastRefreshAt) / 1000)}s ago`;
  return new IntegrationError({
    code: 'UPSTREAM_TIMEOUT',
    message: `n8n workflow catalogue has no fresh entry (${since}; a background refresh is in progress)`,
    service: 'n8n',
    path: '/workflows',
    method: 'GET',
  });
}

/**
 * Decide what to serve — SYNCHRONOUSLY, with no `await` anywhere on the path.
 *
 * This is the whole fix. n8n's `/workflows` costs ~36–166 s for fr's 255
 * workflows (~110 ms each, upstream-bound), so any design where a user request
 * can end up awaiting it is a design where the home page 504s — which is
 * exactly what it did, on 10 of 27 requests over 30 h. Note the cure is NOT
 * just "cache harder": after the page-size fix the crawl stops TIMING OUT at
 * 30 s and starts SUCCEEDING in ~36–166 s, so a blocking request would get
 * strictly worse: a multi-minute held connection instead of a 30 s 504, with
 * no server-side cap (`Bun.serve` runs with `idleTimeout: 0`) and Cloudflare's
 * 100 s proxy limit turning the slow arm into a 524.
 *
 *   fresh entry              -> serve it, touch nothing
 *   expired, age<=MAX_STALE  -> serve it `degraded`, kick a background refresh
 *   expired, age >MAX_STALE  -> 504 immediately, kick a background refresh
 *   no entry at all          -> 504 immediately, kick a background refresh
 *
 * The kick is `void`-ed on purpose: it is a hint to the worker's cadence, not
 * something this request has any interest in the outcome of.
 */
function readCache(): CacheRead {
  const now = Date.now();
  if (cache && now < cache.expiresAt) {
    return { entry: cache, degraded: false };
  }

  // Everything below is "not fresh". Nudge a refresh; never wait for it.
  void primeWorkflowsCache();

  // Two genuinely different situations, and the log must not conflate them:
  // a refresh that FAILED (n8n is down — name the upstream error), versus an
  // entry that simply aged out while a refresh is still running (nothing has
  // failed yet). Claiming "upstream refresh failed" in the second case would be
  // a false statement in the one log line that is fr's only outage signal.
  const err = lastRefreshError ?? noFreshEntryError();
  const cause = lastRefreshError
    ? `upstream refresh failed (${lastRefreshError.code}: ${lastRefreshError.message})`
    : `no refresh has replaced the cached catalogue yet (${err.message})`;

  if (cache) {
    const ageMs = now - cache.fetchedAt;
    const ageS = Math.round(ageMs / 1000);
    // This log is the ONLY signal that an upstream failure happened: a degraded
    // serve turns what used to be a `504` access-log line into a `200`, fr
    // exports no HTTP-status metric (see routes/metrics.ts) and there is no fr
    // 5xx alert rule. One line per served request — the same cardinality as
    // the 504 access-log line it replaces.
    if (ageMs > MAX_STALE_MS) {
      console.warn(
        `[workflows] ${cause} — ` +
          `cached catalogue age=${ageS}s exceeds MAX_STALE_MS=${MAX_STALE_MS / 1000}s, returning the error`,
      );
      throw err;
    }
    console.warn(
      `[workflows] ${cause} — serving cached catalogue age=${ageS}s as degraded`,
    );
    return { entry: cache, degraded: true };
  }

  // Cold. There is nothing honest to serve and we will NOT wait for the crawl
  // that is now running. A total outage must not be laundered into an empty
  // 200 — and neither must a cold start.
  console.warn(
    `[workflows] no catalogue to serve (${err.code}: ${err.message}) — ` +
      `returning the error while a background refresh runs`,
  );
  throw err;
}

/**
 * Envelope a cache read. A fresh read keeps the bare `{data}` shape unchanged;
 * a degraded read additionally carries `degraded` + `stale_as_of`.
 *
 * Placement differs from the `getDependencyReport` precedent and that matters:
 * `routes/coding/adapters.ts buildDegradedDependencyReport` spreads the markers
 * INSIDE the payload (`{...report, degraded, stale_as_of}`), which is what lets
 * `ArchitectureView.svelte` render "Showing the last stored report (as of …)".
 * Here `data` is an array (list) or a facet map (tags), so the markers go
 * BESIDE it on the envelope. Same honesty contract, different position.
 *
 * These markers ARE read by a caller now: `frontend/src/lib/api/workflows.ts`
 * returns them alongside `data` (`WorkflowsRead<T>`), and both /workflows pages
 * render a "Showing a cached workflow catalogue (as of …)" banner off them.
 * (It did not used to — `readJson` returned `wrapped.data` and dropped the
 * envelope, so the `console.warn` above was the ONLY signal an outage had
 * happened, and a stale catalogue drew as live. That is fixed on the frontend
 * side; nothing about this function's behaviour changed.)
 */
function cacheResponse(read: CacheRead, data: unknown): Response {
  if (!read.degraded) return jsonResponse({ data });
  return jsonResponse({
    data,
    degraded: true,
    stale_as_of: new Date(read.entry.fetchedAt).toISOString(),
  });
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------


/**
 * The catalogue read, exported for OTHER routes that need the same rows.
 *
 * ⛔ It exists so that no second surface ever re-derives the crawl. The
 * Library asset route `routes/assets/workflows.ts` used to call
 * `listWorkflows()` directly on a user request — the exact thing
 * `refreshWorkflowsCatalogue` is documented as forbidding — which cost the
 * caller ~36 s typical / 82,635 ms worst MEASURED, long enough for Cloudflare
 * to replace fr's JSON envelope with its own "Bad gateway" HTML. That was
 * broken with a perfectly healthy n8n.
 *
 * This is a thin projection over `readCache()` and deliberately adds NO policy
 * of its own: it delegates the fresh / degraded / too-stale decision, the
 * background kick and the throw verbatim, so both surfaces age out together.
 * It is SYNCHRONOUS for the same reason `readCache` is — there must be no
 * `await` on a path a user request takes.
 *
 *   fresh                    -> { degraded: false }
 *   expired, age<=MAX_STALE  -> { degraded: true }, background refresh kicked
 *   too stale / cold         -> THROWS the recorded IntegrationError (504/502)
 */
interface WorkflowsCatalogueRead {
  rows: ListRow[];
  /** True when the rows are past CACHE_MS — serve them, but say so. */
  degraded: boolean;
  /** Wall clock at which the crawl that produced these rows finished. */
  fetchedAt: number;
}

export function readWorkflowsCatalogue(): WorkflowsCatalogueRead {
  const read = readCache();
  return {
    rows: read.entry.rows,
    degraded: read.degraded,
    fetchedAt: read.entry.fetchedAt,
  };
}

/**
 * ⛔ STRICT TENANT SEPARATION (2026-09-30). This catalogue is the PRODUCTION
 * n8n instance — the conveyor. A customer tenant gets the SAME envelope with
 * an empty `data` (so the page draws its empty state, not an error), never the
 * rows; a customer `/:id` gets exactly the 404 an unknown id produces. Only a
 * super-admin or a caller whose ACTIVE tenant is a platform tenant reads it.
 * See `lib/production-workflows-gate.ts`.
 */
export async function handleList(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    if (!canReadProductionWorkflows(user)) return jsonResponse({ data: [] });
    return await handle(
      // `async` so a synchronous throw from `readCache` becomes a rejection
      // `handle` can map to an integration error response.
      async () => readCache(),
      (read) => cacheResponse(read, read.entry.rows),
    );
  });
}

export async function handleTags(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    if (!canReadProductionWorkflows(user)) {
      return jsonResponse({ data: deriveFacetedTags([]) });
    }
    return await handle(
      // `async` so a synchronous throw from `readCache` becomes a rejection
      // `handle` can map to an integration error response.
      async () => readCache(),
      (read) => cacheResponse(read, read.entry.tags),
    );
  });
}

export async function handleGet(
  req: Request,
  workflowId: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const allowed = canReadProductionWorkflows(user);
    return await handle(
      // A customer never reaches n8n: answer exactly as a genuine miss would.
      async () => {
        if (!allowed) throw productionWorkflowNotFoundError(workflowId);
        return await getWorkflow(workflowId);
      },
      (data) => jsonResponse({ data }),
    );
  });
}
