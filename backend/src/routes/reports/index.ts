// src/routes/reports/index.ts
//
// Reporting surface — read-only, composes the domain/reporting functions.
// Registered under /api/reports/<specific-path>; the pre-existing
// /api/reports/:reportId (project-reports lookup) must be registered AFTER
// these to preserve first-match routing.
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { jsonResponse } from '../../utils/response';
import { BadRequestError } from '../../utils/errors';
import { isUuidShape } from '../../lib/uuid-shape';
import * as reportingDomain from '../../domain/reporting';
import type { AssetType } from '../../domain/reporting';

/** GET /api/reports/approval-backlog */
export async function handleApprovalBacklogReport(req: Request): Promise<Response> {
  const user = await validateAuth(req);
  const data = await reportingDomain.approvalBacklog(user.id, ctxTenantId(user.tenantId));
  return jsonResponse({ data });
}

/** GET /api/reports/project-status/:projectId */
export async function handleProjectStatusReport(
  req: Request,
  projectId: string,
): Promise<Response> {
  // projectId is attacker-controlled — projectStatus resolves the project's
  // tenant and 404s any cross-tenant id (no existence leak). The data lives in
  // FR's own DB, so FR must enforce the tenant boundary here.
  const user = await validateAuth(req);

  // Shape-check BEFORE the query. Without this a non-UUID reached a `uuid`
  // column and Postgres raised 22P02 `invalid input syntax for type uuid`,
  // which escaped as a bare 500 — measured in production against the id fr's
  // OWN `/api/projects` hands out for a stream-backed pseudo-project
  // (`stream:9b9fc446-…`). A malformed id is the caller's error, not an
  // internal fault, and 500 told the caller to retry something that can never
  // succeed. Same family as #908, one route further out.
  //
  // 400, not 404, and that distinction is deliberate: 404 is this route's
  // answer for "no such project / not your tenant" and must stay reserved for
  // it, so that a well-formed id reveals nothing about existence. A syntax
  // rejection leaks nothing — it is decided without touching the database.
  if (!isUuidShape(projectId)) {
    throw new BadRequestError('projectId must be a UUID');
  }

  const data = await reportingDomain.projectStatus(projectId, ctxTenantId(user.tenantId));
  return jsonResponse({ data });
}

/** GET /api/reports/worker-activity/:workerId?since=ISO8601 */
export async function handleWorkerActivityReport(
  req: Request,
  workerId: string,
): Promise<Response> {
  // Tenant isolation is enforced UPSTREAM: workerActivity reads via the workers
  // adapter, and the integration HTTP client (integrations/_lib/http-client.ts)
  // forwards the caller's bearer token + X-Tenant-Id (from request context) to
  // worker_management, which scopes by tenant. FR holds no local worker tenancy
  // to re-check, so there is nothing to scope here. Verified not-unscoped.
  await validateAuth(req);
  const since = new URL(req.url).searchParams.get('since') ?? undefined;
  const data = await reportingDomain.workerActivity(workerId, since);
  return jsonResponse({ data });
}

const ASSET_TYPES = new Set<AssetType>(['requirements', 'decisions', 'principles']);

/** GET /api/reports/asset-changes/:assetType?since=ISO8601&assetId=... */
export async function handleAssetChangesReport(
  req: Request,
  assetType: string,
): Promise<Response> {
  // Tenant isolation is enforced UPSTREAM: assetChangeHistory reads via the
  // decisions/principles/requirements adapters, all of which forward
  // the caller's bearer token + X-Tenant-Id to requirements_management (see
  // integrations/_lib/http-client.ts), which scopes by tenant. FR holds no local
  // asset tenancy to re-check. Verified not-unscoped.
  await validateAuth(req);
  if (!ASSET_TYPES.has(assetType as AssetType)) {
    throw new BadRequestError(`Unsupported assetType '${assetType}'`);
  }
  const url = new URL(req.url);
  const since = url.searchParams.get('since') ?? undefined;
  const assetId = url.searchParams.get('assetId') ?? undefined;
  const data = await reportingDomain.assetChangeHistory(assetType as AssetType, since, assetId);
  return jsonResponse({ data });
}
