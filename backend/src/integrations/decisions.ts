import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { withScopeProject, type ProjectCopyBody, type PromoteBody } from './_lib/governed-copy';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import {
  getCreateDecisionUrl,
  getDeleteDecisionUrl,
  getGetDecisionUrl,
  getListDecisionsUrl,
  getListDecisionVersionsUrl,
  getUpdateDecisionUrl,
  PUT_BODY_PROPERTIES,
  type DecisionIn,
  type DecisionOut,
  type ListDecisionsParams as GeneratedListDecisionsParams,
} from '@fr/service-client-requirements';
import { listDecisionsParamsSchema } from './_lib/asset-query-schemas';
import { bodyKeysOf, mergeReplacingUpdate } from './_lib/merge-update';

const DECISION_IN_KEYS = bodyKeysOf<DecisionIn>()(PUT_BODY_PROPERTIES.DecisionIn);

/**
 * Local extension of the generated `ListDecisionsParams`. (`project_id` is
 * already declared upstream and is a real `DecisionOut` column.) The
 * generated URL builder forwards every defined key via URLSearchParams, so
 * anything added here lands on the wire whether or not the callee declares it.
 *
 * - `card_id` — Wave 6.10 cross-link filter. MEASURED: `card_id` exists on NO
 *   model anywhere and is not a column of `asset_bindings` either, so it
 *   filters nothing. Kept only because `routes/assets/decisions.ts` still
 *   parses it out of the query string.
 * - `origin_kind` — upstream provenance filter, named for the column on the
 *   model (`DecisionOut.origin_kind`, "Provenance: tenant | project |
 *   workflow"). This is the name to put on the wire.
 */
export type ListDecisionsParams = GeneratedListDecisionsParams & {
  card_id?: string;
  origin_kind?: 'tenant' | 'project' | 'workflow';
};

export function parseListDecisionsParams(
  sp: URLSearchParams,
): ListDecisionsParams | undefined {
  const raw = Object.fromEntries(sp.entries());
  if (Object.keys(raw).length === 0) return undefined;
  return listDecisionsParamsSchema.parse(raw) as ListDecisionsParams;
}

// Decision CRUD is synchronous upstream; fail fast on dead upstream so the
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

export async function listDecisions(
  params?: ListDecisionsParams,
): Promise<DecisionOut[]> {
  // Cast: `card_id` is a fr-local extension; the generated URL builder
  // forwards arbitrary keys via URLSearchParams.
  return await http().json<DecisionOut[]>(
    getListDecisionsUrl(params as GeneratedListDecisionsParams | undefined),
    { method: 'GET' },
  );
}

/**
 * The exact upstream call getDecision() makes, and the `detail` requirements_management
 * puts in its 404 for it (entity_service `_get_readable`). Used to mask a
 * system-owned row as a byte-shape-identical upstream 404 for a customer tenant
 * (routes/assets/_lib/system-union.ts customerNotFoundError).
 */
export function getDecisionTarget(did: string) {
  return { service: SERVICE_NAME, method: 'GET', path: getGetDecisionUrl(did), detail: 'not found' };
}

export async function getDecision(did: string): Promise<DecisionOut> {
  return await http().json<DecisionOut>(getGetDecisionUrl(did), { method: 'GET' });
}

export async function createDecision(body: DecisionIn): Promise<DecisionOut> {
  return await http().json<DecisionOut>(getCreateDecisionUrl(), {
    method: 'POST',
    body: JSON.stringify(body),
  });
}

export async function updateDecision(
  did: string,
  body: DecisionIn,
  scopeProjectId?: string,
): Promise<DecisionOut> {
  // RM's PUT replaces (entity_service.py `update`): read-modify-write so every
  // field this body omits keeps its stored value (merge-update.ts).
  const merged = await mergeReplacingUpdate(() => getDecision(did), body, DECISION_IN_KEYS);
  return await httpPutDecision(did, merged, scopeProjectId);
}

/** RM's raw `PUT /decisions/{id}` (a REPLACE): only `updateDecision` above calls it, with the merged row. */
async function httpPutDecision(did: string, body: DecisionIn, scopeProjectId?: string): Promise<DecisionOut> {
  return await http().json<DecisionOut>(withScopeProject(getUpdateDecisionUrl(did), scopeProjectId), {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — copy-on-write of an INHERITED decision for one project
 * (RM `POST /decisions/{id}/project-copy`). Idempotent per (original, project) upstream:
 * a second call patches the project's existing copy. The original is never written.
 */
export async function projectCopyDecision(
  did: string,
  body: ProjectCopyBody,
  tenantId?: string,
): Promise<DecisionOut> {
  return await http().json<DecisionOut>(`${getGetDecisionUrl(did)}/project-copy`, {
    method: 'POST',
    ...(tenantId ? { headers: { 'X-Tenant-Id': tenantId } } : {}),
    body: JSON.stringify(body),
  });
}

/**
 * G8 / R313 — promote a project copy into its tenant original (RM
 * `POST /decisions/{copy_id}/promote`, fr-delegated only). Called only by fr after an
 * approved `asset.promotion`; `tenantId` is the approval's tenant, sent explicitly.
 */
export async function promoteDecision(
  did: string,
  body: PromoteBody,
  tenantId: string,
): Promise<DecisionOut> {
  return await http().json<DecisionOut>(`${getGetDecisionUrl(did)}/promote`, {
    method: 'POST',
    headers: { 'X-Tenant-Id': tenantId },
    body: JSON.stringify(body),
  });
}

export async function deleteDecision(did: string): Promise<void> {
  await http().json<void>(getDeleteDecisionUrl(did), { method: 'DELETE' });
}

/**
 * Immutable version history for a decision. Upstream treats every update as
 * a new version, so this is the canonical history verb on the decision
 * asset.
 */
export async function listDecisionVersions(did: string): Promise<DecisionOut[]> {
  return await http().json<DecisionOut[]>(getListDecisionVersionsUrl(did), {
    method: 'GET',
  });
}
