import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { withScopeProject, type ProjectCopyBody, type PromoteBody } from './_lib/governed-copy';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import {
  getCreatePrincipleUrl,
  getDeletePrincipleUrl,
  getGetPrincipleUrl,
  getListPrinciplesUrl,
  getListPrincipleVersionsUrl,
  getUpdatePrincipleUrl,
  type ListPrinciplesParams as GeneratedListPrinciplesParams,
  PUT_BODY_PROPERTIES,
  type PrincipleIn,
  type PrincipleOut,
} from '@fr/service-client-requirements';
import { listPrinciplesParamsSchema } from './_lib/asset-query-schemas';
import { bodyKeysOf, mergeReplacingUpdate } from './_lib/merge-update';

const PRINCIPLE_IN_KEYS = bodyKeysOf<PrincipleIn>()(PUT_BODY_PROPERTIES.PrincipleIn);

/**
 * Local extension of the generated `ListPrinciplesParams`. The generated URL
 * builder forwards every defined key via URLSearchParams, so anything added
 * here lands on the wire whether or not the callee declares it.
 *
 * - `project_id` — on the WIRE this is RM's PROVENANCE filter on
 *   `origin_project_id` ("the principles this project minted", rm#208), not a
 *   scoping filter. fr's caller-facing `?project_id=` means "fr's project
 *   scope" (effective set), a different predicate, so it is deliberately NOT
 *   in the parser schema below: only `routes/assets/principles.ts` sets the
 *   upstream `project_id`, from `?rm_project_id=`.
 * - `origin_kind` — upstream provenance filter, named for the column on the
 *   model (`PrincipleOut.origin_kind`, "Provenance: tenant | project |
 *   workflow"). This is the name to put on the wire.
 */
export type ListPrinciplesParams = GeneratedListPrinciplesParams & {
  project_id?: string;
  origin_kind?: 'tenant' | 'project' | 'workflow';
};

// ⛔ No `project_id` here: see `ListPrinciplesParams`. A caller's `?project_id=`
// is fr's project scope and must never reach RM's provenance filter.

export function parseListPrinciplesParams(
  sp: URLSearchParams,
): ListPrinciplesParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listPrinciplesParamsSchema.parse(raw) as ListPrinciplesParams;
}

// Principle CRUD is synchronous upstream; fail fast on dead upstream so the
// frontend doesn't hang. Shares the upstream requirements service — same
// baseUrl, same timeout budget.
const CRUD_TIMEOUT_MS = 30_000;

const SERVICE_NAME = 'requirements_management';

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: SERVICE_NAME,
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // requirements_management resolves the tenant from `X-Tenant-Id` alone
      // (kag_common/auth/__init__.py:409-414 "Pull the license token out of
      // `X-Tenant-Id: Bearer <token>` only"). It never reads `Authorization`.
      sendAuthorization: false,
      // fr's OWN RM licence in the ONLY header RM introspects, plus
      // `X-Effective-Tenant-Id` naming the customer tenant. Unset ⇒ every call
      // is refused before it is sent (R351 (7), `tenantBearerRequired`): no
      // plain-uuid request. See `REQUIREMENTS_SERVICE_TOKEN_ENV`.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // Never call RM without a tenant: a tenantless trusted-network call is
      // served RM's DEFAULT tenant — someone else's data — and fr must not
      // patch the gap with its own or the system tenant. No frame tenant ⇒
      // MISSING_TENANT before anything is sent (callers render 409/unavailable).
      requireTenant: true,
    });
  }
  return cachedClient;
}

export async function listPrinciples(
  params?: ListPrinciplesParams,
): Promise<PrincipleOut[]> {
  return await http().json<PrincipleOut[]>(
    getListPrinciplesUrl(params as GeneratedListPrinciplesParams | undefined),
    { method: 'GET' },
  );
}

/**
 * The exact upstream call getPrinciple() makes, and the `detail` requirements_management
 * puts in its 404 for it (entity_service `_get_readable`). Used to mask a
 * system-owned row as a byte-shape-identical upstream 404 for a customer tenant
 * (routes/assets/_lib/system-union.ts customerNotFoundError).
 */
export function getPrincipleTarget(pid: string) {
  return { service: SERVICE_NAME, method: 'GET', path: getGetPrincipleUrl(pid), detail: 'not found' };
}

export async function getPrinciple(pid: string): Promise<PrincipleOut> {
  return await http().json<PrincipleOut>(getGetPrincipleUrl(pid), { method: 'GET' });
}

export async function createPrinciple(body: PrincipleIn): Promise<PrincipleOut> {
  return await http().json<PrincipleOut>(getCreatePrincipleUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updatePrinciple(
  pid: string,
  body: PrincipleIn,
  scopeProjectId?: string,
): Promise<PrincipleOut> {
  // RM's PUT replaces (entity_service.py `update`): read-modify-write so every
  // field this body omits keeps its stored value (merge-update.ts).
  const merged = await mergeReplacingUpdate(() => getPrinciple(pid), body, PRINCIPLE_IN_KEYS);
  return await httpPutPrinciple(pid, merged, scopeProjectId);
}

/** RM's raw `PUT /principles/{id}` (a REPLACE): only `updatePrinciple` above calls it, with the merged row. */
async function httpPutPrinciple(pid: string, body: PrincipleIn, scopeProjectId?: string): Promise<PrincipleOut> {
  return await http().json<PrincipleOut>(withScopeProject(getUpdatePrincipleUrl(pid), scopeProjectId), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — copy-on-write of an INHERITED principle for one project
 * (RM `POST /principles/{id}/project-copy`). Idempotent per (original, project) upstream:
 * a second call patches the project's existing copy. The original is never written.
 */
export async function projectCopyPrinciple(
  pid: string,
  body: ProjectCopyBody,
  tenantId?: string,
): Promise<PrincipleOut> {
  return await http().json<PrincipleOut>(`${getGetPrincipleUrl(pid)}/project-copy`, {
    method: 'POST',
    ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — promote a project copy into its tenant original (RM
 * `POST /principles/{copy_id}/promote`, fr-delegated only). Called only by fr after an
 * approved `asset.promotion`; `tenantId` is the approval's tenant, sent explicitly.
 */
export async function promotePrinciple(
  pid: string,
  body: PromoteBody,
  tenantId: string,
): Promise<PrincipleOut> {
  return await http().json<PrincipleOut>(`${getGetPrincipleUrl(pid)}/promote`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: JSON.stringify(body),
  });
}

export async function deletePrinciple(pid: string): Promise<void> {
  await http().json<void>(getDeletePrincipleUrl(pid), { method: 'DELETE' });
}

/**
 * Immutable version history for a principle. Upstream treats every update as
 * a new version, so this is the canonical history verb on the principle
 * asset.
 */
export async function listPrincipleVersions(pid: string): Promise<PrincipleOut[]> {
  return await http().json<PrincipleOut[]>(getListPrincipleVersionsUrl(pid), {
    method: 'GET',
  });
}
