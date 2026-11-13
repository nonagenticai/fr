// Command-palette entity search: a thin fan-out over the EXISTING search/list
// endpoints. No new backend. Sources:
//   - requirements / principles / decisions — server `?q=` search (uuid id, title, slug)
//   - workflows — NO server text search; client-filter the full list by name
// Each source is independent (`Promise.allSettled`) so one failing source never
// blanks the others. Results normalize to `{ kind, id, label, sublabel?, href }`.
//
// IMPORTANT: the backend search schemas read `q` (+ `k`) and
// `.strip()` unknown keys — passing `search` would silently no-op. The
// `QueryParams` index signature permits `q`/`k`.

import { apiClient } from '$lib/api/unified-client';
import { listWorkflows, type WorkflowSummary } from '$lib/api/workflows';

export type EntityKind = 'requirement' | 'principle' | 'decision' | 'workflow';

export interface EntityResult {
  kind: EntityKind;
  /** Route param. */
  id: string;
  label: string;
  sublabel?: string;
  href: string;
}

const PER_SOURCE_LIMIT = 5;
const MIN_QUERY_LEN = 2;

// --- defensive narrowing (responses are typed `unknown`; mirror loadRecents) --

function asRecord(x: unknown): Record<string, unknown> | null {
  return typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : null;
}

function str(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

/** requirements / principles / decisions share `{ id:uuid, title, slug }`. */
function mapAssetRows(
  rows: unknown,
  kind: 'requirement' | 'principle' | 'decision',
  base: string,
): EntityResult[] {
  if (!Array.isArray(rows)) return [];
  const out: EntityResult[] = [];
  for (const row of rows) {
    const r = asRecord(row);
    if (!r) continue;
    const id = str(r.id);
    const label = str(r.title) ?? str(r.name);
    if (!id || !label) continue;
    out.push({ kind, id, label, sublabel: str(r.slug), href: `${base}/${id}` });
  }
  return out;
}

// workflows have no server text search — fetch the full list once per palette
// session (staleness is fine for a nav-jump) and client-filter by name.
let workflowsPromise: Promise<WorkflowSummary[]> | null = null;

function allWorkflows(): Promise<WorkflowSummary[]> {
  if (!workflowsPromise) {
    // `listWorkflows` returns the backend envelope (`{ data, degraded,
    // stale_as_of }`). The command palette drops the staleness markers ON
    // PURPOSE — see the note above: this is a nav-jump index, the destination
    // page is what renders live state, and a palette row cannot be wrong in a
    // way the user acts on. The /workflows pages are where the banner belongs.
    workflowsPromise = listWorkflows()
      .then((read) => read.data)
      .catch((e: unknown) => {
        workflowsPromise = null; // let the next keystroke retry after a failure
        throw e;
      });
  }
  return workflowsPromise;
}

async function searchWorkflows(q: string): Promise<EntityResult[]> {
  const lower = q.toLowerCase();
  const all = await allWorkflows();
  return all
    .filter((w) => w.name.toLowerCase().includes(lower))
    .slice(0, PER_SOURCE_LIMIT)
    .map((w) => ({
      kind: 'workflow' as const,
      id: w.id,
      label: w.name,
      sublabel: w.primaryDomain ?? w.facets?.domains?.[0] ?? w.domains?.[0],
      href: `/workflows/${w.id}`,
    }));
}

/** Fan out across all sources; tolerant of any single source failing. */
export async function searchEntities(query: string): Promise<EntityResult[]> {
  const q = query.trim();
  if (q.length < MIN_QUERY_LEN) return [];
  const tasks: Array<Promise<EntityResult[]>> = [
    apiClient.requirements
      .search({ q, k: PER_SOURCE_LIMIT })
      .then((r) => mapAssetRows(r, 'requirement', '/requirements')),
    apiClient.principles
      .search({ q, k: PER_SOURCE_LIMIT })
      .then((r) => mapAssetRows(r, 'principle', '/principles')),
    apiClient.decisions
      .search({ q, k: PER_SOURCE_LIMIT })
      .then((r) => mapAssetRows(r, 'decision', '/decisions')),
    searchWorkflows(q),
  ];
  const settled = await Promise.allSettled(tasks);
  return settled.flatMap((s) => (s.status === 'fulfilled' ? s.value : []));
}
