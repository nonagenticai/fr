import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { withScopeProject, type ProjectCopyBody, type PromoteBody } from './_lib/governed-copy';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import {
  getCreateRequirementUrl,
  getDeleteRequirementUrl,
  getGetRequirementUrl,
  getListRequirementsUrl,
  getListRequirementVersionsUrl,
  getUpdateRequirementUrl,
  type ListRequirementsParams as GeneratedListRequirementsParams,
  PUT_BODY_PROPERTIES,
  type RequirementIn,
  type RequirementOut,
  type VersionInfo,
} from '@fr/service-client-requirements';
import { listRequirementsParamsSchema } from './_lib/asset-query-schemas';
import { bodyKeysOf, mergeReplacingUpdate } from './_lib/merge-update';

const REQUIREMENT_IN_KEYS = bodyKeysOf<RequirementIn>()(PUT_BODY_PROPERTIES.RequirementIn);

/**
 * Local extension of the generated `ListRequirementsParams` that adds the
 * Wave 6.10 cross-link filter `project_id`. The generated URL builder
 * forwards every defined key in the params object via URLSearchParams, so
 * passing the extra key through is transparent at runtime.
 */
/**
 * fr-local filter extension of the generated list params.
 *
 * - `project_id` — Wave 6.10 cross-link upstream filter (forwarded).
 * - `origin_kind` — upstream provenance filter. MEASURED: `origin_kind` is
 *   the name on the model (`RequirementOut.origin_kind`, "Provenance:
 *   tenant | project | workflow"), and it is the name to put on the wire.
 *   ⛔ There is deliberately NO `origin` key here any more. It used to be the
 *   fr-local legacy spelling of the same filter, and it was not a harmless
 *   alias: it survived this parser and went upstream spelled `origin`, which
 *   requirements_management does not declare. FastAPI drops an undeclared
 *   query param unconditionally and silently, so every caller that set it got
 *   a 200 carrying the whole unfiltered tenant while believing it was scoped.
 *   `routes/assets/requirements.ts` now validates the caller-facing `origin`
 *   itself and puts `origin_kind` on the wire.
 * - `bound_to` — fr-local filter against the `asset_bindings` table:
 *   strictly bound to this project (n8n scope view). NOT an upstream
 *   param; the caller must apply it with `applyBindingFilter`.
 * - `visible_in` — fr-local filter: union of (bound to this project) +
 *   (no bindings on any project — i.e. tenant-wide unbound). Human
 *   browse view inside a project workspace. Also NOT an upstream param.
 */
export type ListRequirementsParams = GeneratedListRequirementsParams & {
  project_id?: string;
  origin_kind?: 'tenant' | 'project' | 'workflow';
  bound_to?: string;
  visible_in?: string;
};

// `project_id` is a cross-link filter added by Wave 6.10. The generated
// `ListRequirementsParams` type doesn't declare it (orval is strict about
// the OpenAPI spec), but the generated URL builder forwards every defined
// key via URLSearchParams, so we can pass it through transparently.
// (`listRequirementsParamsSchema`: ./_lib/asset-query-schemas.ts.)

export function parseListRequirementsParams(
  sp: URLSearchParams,
): ListRequirementsParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listRequirementsParamsSchema.parse(raw) as ListRequirementsParams;
}

// Requirements CRUD is synchronous upstream; fail fast on dead upstream so the
// frontend doesn't hang.
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

export async function listRequirements(
  params?: ListRequirementsParams,
): Promise<RequirementOut[]> {
  // Cast: `project_id` is a fr-local extension; the generated URL builder
  // forwards arbitrary keys via URLSearchParams, so the runtime is correct.
  return await http().json<RequirementOut[]>(
    getListRequirementsUrl(params as GeneratedListRequirementsParams | undefined),
    { method: 'GET' },
  );
}

/**
 * The exact upstream call getRequirement() makes, and the `detail` requirements_management
 * puts in its 404 for it (entity_service `_get_readable`). Used to mask a
 * system-owned row as a byte-shape-identical upstream 404 for a customer tenant
 * (routes/assets/_lib/system-union.ts customerNotFoundError).
 */
export function getRequirementTarget(rid: string) {
  return { service: SERVICE_NAME, method: 'GET', path: getGetRequirementUrl(rid), detail: 'not found' };
}

export async function getRequirement(rid: string): Promise<RequirementOut> {
  return await http().json<RequirementOut>(getGetRequirementUrl(rid), { method: 'GET' });
}

export async function createRequirement(body: RequirementIn): Promise<RequirementOut> {
  return await http().json<RequirementOut>(getCreateRequirementUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateRequirement(
  rid: string,
  body: RequirementIn,
  scopeProjectId?: string,
): Promise<RequirementOut> {
  // RM's PUT replaces (entity_service.py `update`): read-modify-write so every
  // field this body omits keeps its stored value (merge-update.ts).
  const merged = await mergeReplacingUpdate(() => getRequirement(rid), body, REQUIREMENT_IN_KEYS);
  return await httpPutRequirement(rid, merged, scopeProjectId);
}

/** RM's raw `PUT /requirements/{id}` (a REPLACE): only `updateRequirement` above calls it, with the merged row. */
async function httpPutRequirement(rid: string, body: RequirementIn, scopeProjectId?: string): Promise<RequirementOut> {
  return await http().json<RequirementOut>(withScopeProject(getUpdateRequirementUrl(rid), scopeProjectId), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — copy-on-write of an INHERITED requirement for one project
 * (RM `POST /requirements/{id}/project-copy`). Idempotent per (original, project) upstream:
 * a second call patches the project's existing copy. The original is never written.
 */
export async function projectCopyRequirement(
  rid: string,
  body: ProjectCopyBody,
  tenantId?: string,
): Promise<RequirementOut> {
  return await http().json<RequirementOut>(`${getGetRequirementUrl(rid)}/project-copy`, {
    method: 'POST',
    ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — promote a project copy into its tenant original (RM
 * `POST /requirements/{copy_id}/promote`, fr-delegated only). Called only by fr after an
 * approved `asset.promotion`; `tenantId` is the approval's tenant, sent explicitly.
 */
export async function promoteRequirement(
  rid: string,
  body: PromoteBody,
  tenantId: string,
): Promise<RequirementOut> {
  return await http().json<RequirementOut>(`${getGetRequirementUrl(rid)}/promote`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: JSON.stringify(body),
  });
}

export async function deleteRequirement(rid: string): Promise<void> {
  await http().json<void>(getDeleteRequirementUrl(rid), { method: 'DELETE' });
}

/**
 * Immutable version history for a requirement. Upstream records a snapshot on
 * every create and update, so this is the canonical history verb on the
 * requirement asset.
 */
export async function listRequirementVersions(rid: string): Promise<VersionInfo[]> {
  return await http().json<VersionInfo[]>(getListRequirementVersionsUrl(rid), {
    method: 'GET',
  });
}
