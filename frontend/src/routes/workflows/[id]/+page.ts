import type { PageLoad } from './$types';
import { getWorkflow, listWorkflows, type WorkflowSummary } from '$lib/api/workflows';
import type { N8nWorkflow } from '$lib/workflows/adapter';

export const ssr = false;

export interface WorkflowDetailPageData {
  /** Null when `workflowError` is set. The page renders an error, not a blank canvas. */
  workflow: N8nWorkflow | null;
  /** Empty when `workflowsError` is set — prev/next is disabled, the canvas is not. */
  workflows: WorkflowSummary[];
  workflowError: string | null;
  workflowsError: string | null;
  breadcrumbLabel: string;
  /**
   * True when the prev/next CATALOGUE was served from the backend cache because
   * n8n was unreachable. Note the scope: `getWorkflow` has no cache behind it
   * (`handleGet` returns a bare `{data}`), so the canvas is always live or an
   * error — it is the list driving prev/next that can be up to an hour old.
   */
  workflowsStale: boolean;
  staleAsOf: string | null;
}

function messageOf(reason: unknown): string {
  if (reason instanceof Error && reason.message) return reason.message;
  if (typeof reason === 'string' && reason) return reason;
  return 'Unknown error';
}

/**
 * Load one workflow + the list used for prev/next, degrading per source.
 * NEVER rejects.
 *
 * WHY: this was `await Promise.all([...])` with no catch — the exact shape that
 * made the /workflows INDEX page render a bare SvelteKit `500 / Internal Error`
 * shell (measured in Playwright 2026-08-11T04:45Z; the backend logged 504s and
 * no 500, so the 500 was ours). Fixing only the index would have moved that
 * crash one click away: during the cold-pod window this whole PR exists for —
 * the ~40 s the backend's boot prime takes, several times a day as fr rolls —
 * both endpoints 504, and clicking any card from the now-working list landed
 * here.
 *
 * Per-source `allSettled` rather than one try/catch, for the same reason as the
 * index page: `getWorkflow` is a single cheap upstream GET while `listWorkflows`
 * is the 28-166 s catalogue crawl. They fail independently and often will, and
 * the list is needed ONLY for prev/next. Losing it must not blank the canvas.
 *
 * STALENESS: `$lib/api/workflows` carries the backend's `degraded` /
 * `stale_as_of` envelope through now. Only `listWorkflows` can raise it here —
 * see `workflowsStale` above for why the canvas itself cannot be stale.
 */
export const load: PageLoad = async ({ params }): Promise<WorkflowDetailPageData> => {
  const [workflow, workflows] = await Promise.allSettled([
    getWorkflow(params.id),
    listWorkflows(),
  ]);

  const wf = workflow.status === 'fulfilled' ? workflow.value.data : null;
  const list = workflows.status === 'fulfilled' ? workflows.value : null;
  return {
    workflow: wf,
    workflows: list?.data ?? [],
    workflowError: workflow.status === 'rejected' ? messageOf(workflow.reason) : null,
    workflowsError: workflows.status === 'rejected' ? messageOf(workflows.reason) : null,
    workflowsStale: list?.degraded === true,
    staleAsOf: list?.stale_as_of ?? null,
    // The workflow name for the page heading (+page.svelte), "Multi-output IF"
    // rather than "wf-fixture-1". Falls back to the id when the read failed —
    // a label must never be the thing that throws.
    breadcrumbLabel: wf?.name ?? params.id,
  };
};
