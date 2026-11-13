// requirements_management (RM) tenant PM catalogue — the SINGLE seam fr uses to
// read (and, for tenant admins, write) RM vocabulary: project phases,
// capabilities, card types, project types and gates, plus the
// project-type ↔ card-type matrix and the import-defaults bootstrap.
//
// ⛔ fr is a FACILITATOR here (George's ruling): this client FORWARDS. It never
// validates a body, never decides whether a phase/capability/card type is
// "valid", and never fills in defaults. RM validates; its 4xx (status + body)
// reach the caller through the ordinary IntegrationError → response converter.
// The only thing fr decides is WHICH resource names may be forwarded at all
// (`PM_CATALOGUE_RESOURCES`), so a caller cannot use this seam to reach an
// arbitrary RM path.
//
// Every call names its tenant EXPLICITLY (the route passes the tenant it
// authorised against), and the client is built exactly like the other RM
// clients: fr's own licence via `REQUIREMENTS_SERVICE_TOKEN` (see that constant
// — do not set it before RM lists fr's subject) and `requireTenant`.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';

const CRUD_TIMEOUT_MS = 30_000;

/** The RM `/pm/<resource>` collections fr may forward to. Nothing else. */
export const PM_CATALOGUE_RESOURCES = [
  'project-phases',
  'capabilities',
  'card-types',
  'project-types',
  'gates',
  'wip-limits',
  'priority-levels',
  'deliverable-kinds',
  'milestone-kinds',
  'board-templates',
] as const;

export type PmCatalogueResource = (typeof PM_CATALOGUE_RESOURCES)[number];

export function isPmCatalogueResource(value: string): value is PmCatalogueResource {
  return (PM_CATALOGUE_RESOURCES as readonly string[]).includes(value);
}

/**
 * List query keys forwarded verbatim to RM. RM decides what each means for each
 * resource (and ignores or 422s the rest); fr only refuses to forward keys it
 * was never asked to carry. Filters are IDS (`project_type_id`, `phase_id`, …):
 * RM silently ignores a name-keyed `project_type` / `phase`, so those are not
 * forwarded. Pinned against the snapshot's list query params.
 */
export const PM_CATALOGUE_LIST_PARAMS = [
  'limit',
  'offset',
  'capability_id',
  'project_type_id',
  'phase_id',
  'card_type_id',
  'size',
] as const;

// --- update = passthrough, because RM's PUT is PARTIAL ----------------------
//
// Since rm#208 every catalogue PUT is a partial update: an omitted field is
// left unchanged and an explicit `null` sets it to NULL ("not set"; the
// import-defaults fills it), while `[]` / `""` clear it and stay cleared. So fr
// forwards the caller's body verbatim — no GET, no merge, no key filtering.
// A merge here would be actively wrong: it would re-send every stored value,
// turning each edit into a full overwrite that races a concurrent writer.
// Required fields (name, capability_id, rank, the gate's phase_id, wip_limit) are RM's to refuse; its 422 passes
// through.

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'requirements_management',
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // RM resolves the tenant from `X-Tenant-Id` alone; it never reads
      // `Authorization` (kag_common/auth/__init__.py:409-414).
      sendAuthorization: false,
      // Same delegated-licence contract as every other RM client — see
      // `REQUIREMENTS_SERVICE_TOKEN_ENV`. Unset ⇒ refused, nothing sent.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // No tenant ⇒ MISSING_TENANT, nothing sent (never RM's default tenant).
      requireTenant: true,
    });
  }
  return cachedClient;
}

function seg(value: string): string {
  return encodeURIComponent(value);
}

function tenantHeaders(tenantId: string): Record<string, string> {
  return { 'x-tenant-id': tenantId };
}

/** Only the allowlisted list params, in a stable order; empty ⇒ no `?`. */
function pmCatalogueListQuery(params: URLSearchParams): string {
  const out = new URLSearchParams();
  for (const key of PM_CATALOGUE_LIST_PARAMS) {
    const value = params.get(key);
    if (value !== null) out.set(key, value);
  }
  const qs = out.toString();
  return qs ? `?${qs}` : '';
}

export async function listPmCatalogue(
  tenantId: string,
  resource: PmCatalogueResource,
  params: URLSearchParams = new URLSearchParams(),
): Promise<unknown> {
  return await http().json<unknown>(`/pm/${seg(resource)}${pmCatalogueListQuery(params)}`, {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

export async function getPmCatalogueItem(
  tenantId: string,
  resource: PmCatalogueResource,
  id: string,
): Promise<unknown> {
  return await http().json<unknown>(`/pm/${seg(resource)}/${seg(id)}`, {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

export async function createPmCatalogueItem(
  tenantId: string,
  resource: PmCatalogueResource,
  body: unknown,
): Promise<unknown> {
  return await http().json<unknown>(`/pm/${seg(resource)}`, {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    body: JSON.stringify(body),
  });
}

/**
 * PUT, forwarded as-is (RM's PUT is partial — see the block above). Whatever
 * the caller sent is what RM receives, including a non-object body, which RM
 * (not fr) answers with a 422.
 */
export async function updatePmCatalogueItem(
  tenantId: string,
  resource: PmCatalogueResource,
  id: string,
  body: unknown,
): Promise<unknown> {
  return await http().json<unknown>(`/pm/${seg(resource)}/${seg(id)}`, {
    method: 'PUT',
    headers: tenantHeaders(tenantId),
    body: JSON.stringify(body),
  });
}

export async function deletePmCatalogueItem(
  tenantId: string,
  resource: PmCatalogueResource,
  id: string,
): Promise<unknown> {
  return await http().json<unknown>(`/pm/${seg(resource)}/${seg(id)}`, {
    method: 'DELETE',
    headers: tenantHeaders(tenantId),
  });
}

/** `GET /pm/project-types/{id}/card-types` — the project type's card-type matrix. */
export async function getProjectTypeCardTypes(tenantId: string, projectTypeId: string): Promise<unknown> {
  return await http().json<unknown>(`/pm/project-types/${seg(projectTypeId)}/card-types`, {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/** `PUT /pm/project-types/{id}/card-types` — replace the matrix (RM validates). */
export async function setProjectTypeCardTypes(
  tenantId: string,
  projectTypeId: string,
  body: unknown,
): Promise<unknown> {
  return await http().json<unknown>(`/pm/project-types/${seg(projectTypeId)}/card-types`, {
    method: 'PUT',
    headers: tenantHeaders(tenantId),
    body: JSON.stringify(body),
  });
}

/** Query keys `GET /pm/wip-limits/resolve` takes; RM decides what matches. */
const PM_WIP_RESOLVE_PARAMS = ['project_type_id', 'phase_id', 'capability_id', 'card_type_id'] as const;

/** `GET /pm/wip-limits/resolve` — RM picks the most specific WIP limit for the given dimensions. */
export async function resolvePmWipLimit(tenantId: string, params: URLSearchParams): Promise<unknown> {
  const out = new URLSearchParams();
  for (const key of PM_WIP_RESOLVE_PARAMS) {
    const value = params.get(key);
    if (value !== null) out.set(key, value);
  }
  const qs = out.toString();
  return await http().json<unknown>(`/pm/wip-limits/resolve${qs ? `?${qs}` : ''}`, {
    method: 'GET',
    headers: tenantHeaders(tenantId),
  });
}

/** `POST /pm/catalogue/import-defaults` — RM seeds the tenant's catalogue from its defaults. */
export async function importPmCatalogueDefaults(tenantId: string, body: unknown): Promise<unknown> {
  return await http().json<unknown>('/pm/catalogue/import-defaults', {
    method: 'POST',
    headers: tenantHeaders(tenantId),
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
