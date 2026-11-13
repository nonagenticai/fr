import type { PageLoad } from './$types';
import {
  listWorkflows,
  listTags,
  type WorkflowSummary,
  type FacetedTags,
} from '$lib/api/workflows';

// Client-side load — authFetch needs the Keycloak store, so SSR is
// disabled at the layout level (workflows are an authenticated surface).
export const ssr = false;

export interface WorkflowsPageData {
  /** Empty when `workflowsError` is set — see the note there before rendering it. */
  workflows: WorkflowSummary[];
  /** All-empty facets when `tagsError` is set. */
  tags: FacetedTags;
  /**
   * Non-null when the catalogue could not be read. The page MUST render this
   * instead of an empty list: `workflows: []` on a failed read means "we don't
   * know", and drawing it as "No workflows yet" is a confident wrong answer —
   * the same defect as the `0/0` the backend refuses to serve on the home card.
   */
  workflowsError: string | null;
  /** Non-null when the facet sidebar could not be read. The list still renders. */
  tagsError: string | null;
  /**
   * True when the backend served this catalogue out of its cache because n8n
   * was unreachable. `staleAsOf` is when the data was actually pulled from n8n
   * (up to MAX_STALE_MS = 60 minutes ago; past that the backend 504s instead
   * of serving it). The page MUST render a banner for this — the whole point of
   * the backend's ceiling is that stale-but-served is honest only if the UI
   * says so.
   */
  workflowsStale: boolean;
  staleAsOf: string | null;
}

const EMPTY_TAGS: FacetedTags = {
  domain: [],
  purpose: [],
  stage: [],
  trigger: [],
  other: [],
};

function messageOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  // Never stringify an object into "[object Object]" — an error panel that
  // says that is indistinguishable from no message at all.
  return 'Unknown error';
}

/**
 * Load the catalogue + facets, degrading per-source. NEVER rejects.
 *
 * WHY (measured 2026-08-11T04:45Z, Playwright against fr.nonagentic.ai as
 * fr-test): this used to be a bare `Promise.all` with no catch, so a 504 from
 * either endpoint escaped `load` and SvelteKit rendered its generic shell —
 * the whole page was `500 / Internal Error`, no message, no retry. The backend
 * logged 504s and no 500: the 500 was ours. `Promise.allSettled` is the house
 * pattern for per-source degradation.
 *
 * `allSettled` per promise rather than one try/catch around the pair, on
 * purpose: the workflow list is the page's CONTENT and the facets are a filter
 * aid over it. A `/tags` outage must not blank the catalogue, and a catalogue
 * outage should not throw away facet counts the sidebar can still show. They
 * fail for the same upstream reason most of the time, but coupling them in
 * code would make the better of the two outcomes unreachable.
 *
 * STALENESS: `$lib/api/workflows` now carries the backend's `degraded` /
 * `stale_as_of` envelope through instead of discarding it, so a cache-served
 * catalogue arrives flagged and `+page.svelte` renders the stale banner. Only
 * the LIST is flagged — `/tags` can degrade on its own read, but the sidebar is
 * a filter aid over the list and the list is what the banner is about, so a
 * degraded `/tags` alone does not raise it.
 */
export const load: PageLoad = async (): Promise<WorkflowsPageData> => {
  const [workflows, tags] = await Promise.allSettled([listWorkflows(), listTags()]);
  const wf = workflows.status === 'fulfilled' ? workflows.value : null;
  return {
    workflows: wf?.data ?? [],
    tags: tags.status === 'fulfilled' ? tags.value.data : EMPTY_TAGS,
    workflowsError:
      workflows.status === 'rejected' ? messageOf(workflows.reason) : null,
    tagsError: tags.status === 'rejected' ? messageOf(tags.reason) : null,
    workflowsStale: wf?.degraded === true,
    staleAsOf: wf?.stale_as_of ?? null,
  };
};
