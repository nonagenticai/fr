// src/lib/api/workflows.ts
//
// Typed client for the fr-backend Workflows Viewer surface
// (GET /api/workflows{,/tags,/:id}). Mirrors the route handlers in
// backend/src/routes/workflows.ts — keep in sync until/unless we
// extract a shared types package.
//
// All calls go through authFetch (Keycloak Bearer header). Use only
// from client-side code — SSR has no auth store and would 401.
//
// Facets: workflows are filtered by four orthogonal facets — domain /
// purpose / stage / trigger — encoded backend-side as namespaced n8n tags
// and returned parsed in `WorkflowSummary.facets`. The slug↔label tables
// and the filter predicate live in `$lib/workflows/facets.ts`.

import { authFetch } from './auth-fetch';
import type { N8nWorkflow } from '$lib/workflows/adapter';

/**
 * Legacy single-purpose label. Still emitted by the backend as a
 * transition-fallback field (`WorkflowSummary.purpose`) for a frontend
 * that predates `facets`; the live filter surface is `facets` instead.
 */
export type WorkflowPurpose =
  | 'Improvement'
  | 'Pattern'
  | 'Authoring'
  | 'Test & Monitoring'
  | 'Demo'
  | 'Card Flow'
  | 'Activity'
  | 'Operational';

/** Parsed facet slugs for one workflow — the multi-criteria filter surface. */
export interface WorkflowFacets {
  /** domain slugs the workflow touches (>=1). */
  domains: string[];
  /** purpose slugs (normally exactly 1). */
  purposes: string[];
  /** stage slugs (0 or 1 — absence is the "(none)" filter state). */
  stages: string[];
  /** trigger slugs (0..n). */
  triggers: string[];
}

export interface WorkflowSummary {
  id: string;
  name: string;
  active: boolean;
  /** Every raw tag (namespaced + plain) — rendered as card chips. */
  tags: string[];
  /**
   * Parsed facets. Optional only so the page still renders against a
   * backend deployment that predates this field — `effectiveFacets()` in
   * `$lib/workflows/facets.ts` applies the legacy fallback.
   */
  facets?: WorkflowFacets;
  /** Legacy derived label fields — kept for the transition window. */
  domains?: string[];
  primaryDomain?: string;
  purpose?: WorkflowPurpose;
  updatedAt: string;
  nodeCount: number;
}

/** One facet slug + its count in the faceted `/tags` response. */
export interface FacetCount {
  slug: string;
  label: string;
  workflowCount: number;
}

/** A non-namespaced ("manual") tag and how many workflows carry it. */
export interface OtherTagCount {
  tag: string;
  workflowCount: number;
}

/** The faceted `/api/workflows/tags` response. */
export interface FacetedTags {
  domain: FacetCount[];
  purpose: FacetCount[];
  stage: FacetCount[];
  trigger: FacetCount[];
  other: OtherTagCount[];
}

/**
 * Every read from this client, WITH the backend's honesty markers attached.
 *
 * `backend/src/routes/workflows.ts cacheResponse` serves a cached catalogue as
 * `{ data, degraded: true, stale_as_of }` when n8n is unreachable — up to
 * `MAX_STALE_MS` (60 minutes) old, past which it 504s instead. This client used
 * to do `return ((await res.json()) as { data: T }).data`, dropping the
 * envelope, so up to an hour-old catalogue rendered as live with nothing
 * anywhere saying otherwise. The markers travel with the payload now; the
 * /workflows pages render the stale banner off them.
 *
 * Both markers are NORMALISED here, never passed through raw: a fresh read is
 * `{ degraded: false, stale_as_of: null }`, so a caller can test `degraded`
 * without also having to defend against `undefined`.
 */
export interface WorkflowsRead<T> {
  data: T;
  /** True only when the backend explicitly said so. */
  degraded: boolean;
  /** ISO timestamp the served data was actually fetched from n8n; null when fresh. */
  stale_as_of: string | null;
}

async function readEnvelope<T>(res: Response, what: string): Promise<WorkflowsRead<T>> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Failed to ${what} (${res.status}): ${body || res.statusText}`);
  }
  const wrapped = (await res.json()) as {
    data: T;
    degraded?: unknown;
    stale_as_of?: unknown;
  };
  return {
    data: wrapped.data,
    // Strict `=== true`: a truthy-but-not-true value (or a missing key) must
    // never light the banner, and a *falsy* one must never suppress it wrongly.
    degraded: wrapped.degraded === true,
    stale_as_of: typeof wrapped.stale_as_of === 'string' ? wrapped.stale_as_of : null,
  };
}

export async function listWorkflows(): Promise<WorkflowsRead<WorkflowSummary[]>> {
  const res = await authFetch('/api/workflows');
  return readEnvelope<WorkflowSummary[]>(res, 'list workflows');
}

export async function listTags(): Promise<WorkflowsRead<FacetedTags>> {
  const res = await authFetch('/api/workflows/tags');
  return readEnvelope<FacetedTags>(res, 'list workflow tags');
}

/**
 * NOTE: `handleGet` returns a bare `{ data }` — it has no cache to serve from,
 * so it never carries the degraded markers today. It returns the same envelope
 * type anyway so this module has ONE rule ("nothing here discards the
 * envelope") rather than a per-endpoint exception a future change can trip on.
 */
export async function getWorkflow(id: string): Promise<WorkflowsRead<N8nWorkflow>> {
  const res = await authFetch(`/api/workflows/${encodeURIComponent(id)}`);
  return readEnvelope<N8nWorkflow>(res, 'get workflow');
}
