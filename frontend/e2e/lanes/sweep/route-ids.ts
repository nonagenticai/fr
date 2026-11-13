// e2e/lanes/sweep/route-ids.ts
//
// The binding table that lets the route sweep visit a [param] route with a REAL
// id instead of a fabricated one.
//
// ── PROVENANCE ───────────────────────────────────────────────────────────────
// Every id below was MEASURED on 2026-09-10 against https://fr.nonagentic.ai in
// tenant 0195f48b-d000-7000-8000-000000000003 (`aa-agents`): the list form was
// fetched live and each sampleId re-verified with a live GET of the detail form.
// Source record: scratchpad/sweep/id-sources.json.
//
// ⚠️ These are POINT-IN-TIME and they WILL ROT. Rows get deleted, boards get
// re-created, workers get renamed. A 404 from a rotted id is a defect in this
// file, not in the app.
//
// ⛔ The sweep MUST run with that same active tenant. Several of these sources
// return zero rows without the tenant header (projects, kag entities), so a
// sweep run elsewhere will 404 across the board for reasons that are not app
// defects — which is precisely the false-positive this module exists to prevent.
//
// ── WHY A ROUTE CAN BE MISSING ───────────────────────────────────────────────
// A parameterised route is in exactly one of the two maps below, never both:
//   ROUTE_PARAM_SOURCES — a real id was obtained, so the route is sweepable.
//   UNRESOLVED_ROUTES   — the measured reason no id exists for this identity.
// `resolveRouteUrl` returns null rather than substituting a placeholder. The
// caller must report NOT-SWEPT-NO-ID; a fake id renders the app's 404 page,
// which would be recorded as an app defect when it is an instrument defect.
//
// ⚠️ 20 of the 73 measured bindings named a source key that produced no id
// (department, channel, secret, thread, bridge, report, repoJob,
// pmDependency, pmRisk, archStandard, archView, delivery; the pm
// routes were since retired). Those
// bindings are NOT transcribed here — an entry whose source cannot yield a value
// is indistinguishable from a typo, and would silently resolve to null forever.
// They are recorded in UNRESOLVED_ROUTES with the measured reason instead.

/** routeId (layout groups stripped) -> ordered source keys, one per [param]. */
export const ROUTE_PARAM_SOURCES: Record<string, string[]> = {
  '/admin/tenants/[nameOrId]': ['tenant'],
  '/approvals/[id]': ['approval'],
  '/cards/[id]': ['card'],
  '/decisions/[id]': ['decision'],
  '/decisions/[id]/edit': ['decision'],
  '/kag/entities/[id]': ['kagEntity'],
  '/library/[type]': ['libraryType'],
  '/library/architecture/elements/[id]': ['archElement'],
  '/library/architecture/elements/[id]/edit': ['archElement'],
  '/library/architecture/relationships/[id]': ['archRelationship'],
  '/principles/[id]': ['principle'],
  '/principles/[id]/edit': ['principle'],
  '/projects/[id]': ['project'],
  // The one two-param route. Order matters and the pair must be COHERENT:
  // approval 744190c1 genuinely belongs to project 26ccf7ec, so the page has a
  // real parent to render. Swapping these yields a 200 that shows nothing.
  '/projects/[id]/approve/[approvalId]': ['projectForApproval', 'approval'],
  // /projects/[id]/architecture and /projects/[id]/assets are 308 stubs since
  // the nav-standard validator round (2026-10-03); the architecture views are
  // their own routes now. Same project binding.
  '/projects/[id]/architecture/dependencies': ['project'],
  '/projects/[id]/architecture/graph': ['project'],
  '/projects/[id]/architecture/quality-gate': ['project'],
  '/projects/[id]/artifacts': ['project'],
  '/projects/[id]/board': ['project'],
  '/projects/[id]/executions': ['project'],
  '/projects/[id]/goal': ['project'],
  '/projects/[id]/governance': ['project'],
  '/projects/[id]/knowledge': ['project'],
  '/projects/[id]/library/channels': ['project'],
  '/projects/[id]/library/decisions': ['project'],
  '/projects/[id]/library/kag-documents': ['project'],
  '/projects/[id]/library/principles': ['project'],
  '/projects/[id]/library/requirements': ['project'],
  '/projects/[id]/library/triggers': ['project'],
  '/projects/[id]/library/workflows': ['project'],
  '/projects/[id]/needs-you': ['project'],
  '/projects/[id]/quality': ['project'],
  '/projects/[id]/reasoning': ['project'],
  '/projects/[id]/repositories': ['project'],
  '/projects/[id]/settings': ['project'],
  '/projects/requests/[id]': ['projectRequest'],
  '/reports/asset-changes/[assetType]': ['assetType'],
  '/reports/project-status/[projectId]': ['project'],
  '/reports/worker-activity/[workerId]': ['worker'],
  '/requirements/[id]': ['requirement'],
  '/requirements/[id]/edit': ['requirement'],
  '/workers/[name]': ['worker'],
  '/workflows/[id]': ['workflow'],
};

/**
 * routeId (layout groups stripped) -> the MEASURED reason no id could be
 * obtained. Exists so a sweep report can say why a route was skipped instead of
 * leaving a silent hole that reads as coverage.
 */
export const UNRESOLVED_ROUTES: Record<string, string> = {
  '/admin/departments/[id]':
    '200 with {"data":[]} in all 15 internal tenants swept. Corroborated by ' +
    "backend/src/routes/kanban/reads.ts:186 — 'In prod dept_id is NULL', i.e. the " +
    'departments table is genuinely unpopulated in production.',
  '/admin/departments/[id]/knowledge':
    'Same `department` source as /admin/departments/[id], which yielded no id: 200 with ' +
    '{"data":[]} in all 15 internal tenants swept; the departments table is unpopulated ' +
    'in production. (Sibling route — the measurement covers the source, not just the ' +
    'one routeId listed in id-sources.json.)',
  '/bridge/[id]':
    'NO LIST ENDPOINT EXISTS. backend/src/routes/tools/bridge.ts registers only POST ' +
    '/api/tools/bridge/drafts (create), GET/PATCH /api/tools/bridge/drafts/:id, and the ' +
    'submit/reject/commit POSTs — there is no GET collection. A draft id can only be ' +
    'obtained by POSTing a draft, which this read-only pass may not do.',
  '/channels/[id]':
    '200 with zero rows. Swept 15 internal tenants — [] everywhere. Both unified ' +
    'sources (/api/channels, /api/scheduled-triggers) are empty.',
  '/engagements/deliveries/[id]':
    'zero rows in tenant 0003 (the sweep tenant); the earlier id belonged to a tenant ' +
    'fr-test cannot read.',
  '/library/architecture/standards/[id]':
    '200 with {"data":[]} in all 15 internal tenants swept.',
  '/library/architecture/standards/[id]/edit':
    'Same `archStandard` source as /library/architecture/standards/[id], which yielded no ' +
    'id: 200 with {"data":[]} in all 15 internal tenants swept. (Sibling route.)',
  '/library/architecture/views/[id]': '200 with {"data":[]} in all 15 internal tenants swept.',
  '/library/architecture/views/[id]/edit':
    'Same `archView` source as /library/architecture/views/[id], which yielded no id: 200 ' +
    'with {"data":[]} in all 15 internal tenants swept. (Sibling route.)',
  '/reports/[reportId]':
    '200 with {"items":[],"total":0} in all 15 internal tenants swept. handleListReports ' +
    '(backend/src/routes/reports.ts:184) applies a mandatory tenant predicate and ' +
    'NULL-tenant rows are fail-closed, so any legacy un-attributable report is invisible ' +
    'by design.',
  '/repositories/jobs/[id]':
    '200 with {"data":[],"meta":{"next_cursor":null}} in all 15 internal tenants, and also ' +
    'with ?project_id= set to a live aa-agents project. No coding-analysis jobs exist.',
  '/secrets/[secret_id]':
    '200 with {"data":{"secrets":[],"total":0}} in all 15 internal tenants swept.',
  '/threads/[id]':
    '401 on every attempt. backend/src/routes/agui-threads.ts:73 requires the fr-AGENT ' +
    'token (HS256, aud: fr-agent) — a different token class from the user token ' +
    'claude_mint issues. No id obtainable with this identity.',
};

const PARAM = /\[[^\]]+\]/g;

// Map lookup, not bare bracket access: `ROUTE_PARAM_SOURCES['constructor']`
// on an object literal returns a truthy value from Object.prototype, which
// would sail past a `?? null` guard and resolve a route that does not exist.
const SOURCES_BY_ROUTE = new Map<string, string[]>(Object.entries(ROUTE_PARAM_SOURCES));

/**
 * Turn a SvelteKit routeId into a URL a sweep can actually visit.
 *
 * Returns `null` — never a partial substitution, never a placeholder — whenever
 * the route cannot be resolved with real measured ids. The caller reports that
 * as NOT-SWEPT-NO-ID. Sweeping a fabricated id would render the 404 page and
 * bank it as clean, or as an app defect; both are lies about the app.
 */
export function resolveRouteUrl(routeId: string, ids: Record<string, string>): string | null {
  if (!routeId.includes('[')) return routeId;

  const sources = SOURCES_BY_ROUTE.get(routeId);
  if (!sources) return null;

  const paramCount = routeId.match(PARAM)?.length ?? 0;
  // A binding shorter than the route's params can only substitute some of them.
  if (sources.length < paramCount) return null;

  let i = 0;
  let missing = false;
  const url = routeId.replace(PARAM, () => {
    const key = sources[i++];
    const value = key !== undefined && Object.prototype.hasOwnProperty.call(ids, key)
      ? ids[key]
      : undefined;
    if (typeof value !== 'string' || value === '') {
      missing = true;
      return '';
    }
    // One measured id is a NAME (`aa-trilogy-doing`), not a uuid, and names may
    // carry `/` or spaces — unencoded they would change the path shape.
    return encodeURIComponent(value);
  });

  return missing ? null : url;
}
