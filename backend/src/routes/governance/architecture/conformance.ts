// GET /api/governance/architecture/conformance?projectId=<uuid>
//
// Architecture Governance dashboard BFF (P3.1 of the lane), also the route the
// project agent's `architecture.get_governance_conformance` runs as the human
// (agui/actions/project-assets.ts). Thin wrapper
// over `integrations/architecture.ts:analyzeArchitectureConformance` with a
// 60s in-memory TTL cache keyed on (tenantId, projectId) so the dashboard
// can poll/re-render cheaply.
//
// The upstream tool is per-project and tenant-scoped via the shared http()
// factory's X-Tenant-Id injection (see integrations/_lib/http-client.ts).
// No `code_units` / `layer_order` are passed — when gitops P3.0 has
// `CODING_ANALYSIS_URL` set on the requirements Deployment, the upstream
// pulls code-graph facts itself for every bound container. Keeps fr thin.
//
// Empty-state honesty: when a tenant has zero bound Application Components,
// the upstream returns `realization_coverage = 1.0` (perfect score on an
// empty model — see conformance.py:175). The dashboard branches on
// `summary.unrealized_components + orphan_artifacts === 0` *together with*
// `realization_coverage.total_application_components === 0` to render an
// honest "No model yet" state, not "100% — perfect compliance".

import {
  analyzeArchitectureConformance,
  type ArchitectureConformanceResult,
} from '../../../integrations/architecture';
import { validateAuth } from '../../../middleware/auth';
import { ctxTenantId } from '../../../middleware/request-context';
import { UnauthorizedError } from '../../../utils/errors';
import { jsonResponse } from '../../../utils/response';

const TTL_MS = 60_000;

interface CacheEntry {
  result: ArchitectureConformanceResult;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, projectId: string): string {
  return `${tenantId}::${projectId}`;
}

function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}

export async function handleGetArchitectureConformance(
  req: Request,
): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }

  const url = new URL(req.url);
  const projectId = url.searchParams.get('projectId');
  if (!projectId) {
    return jsonResponse({ error: 'projectId query param required' }, 400);
  }
  // ?fresh=true is the explicit cache-bypass: it re-runs the upstream analysis
  // instead of answering from the 60s TTL cache (the project agent's
  // `architecture.get_governance_conformance` forwards it when asked to re-check).
  const fresh = url.searchParams.get('fresh') === 'true';

  const tenantId = ctxTenantId(user.tenantId);
  const key = cacheKey(tenantId, projectId);
  const now = Date.now();

  const hit = cache.get(key);
  if (!fresh && hit && hit.expiresAtMs > now) {
    return jsonResponse({ data: hit.result, meta: { cached: true } });
  }

  const result = await analyzeArchitectureConformance({ project_id: projectId });
  cache.set(key, { result, expiresAtMs: now + TTL_MS });
  return jsonResponse({ data: result, meta: { cached: false } });
}
