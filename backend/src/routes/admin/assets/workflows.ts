// src/routes/admin/assets/workflows.ts
//
// Super-admin asset console — workflows proxy.
//
// Surface (rooted at /api/admin/assets/workflows):
//   GET    /                  — list workflows visible to the n8n API key
//   GET    /:id                — fetch one workflow
//
// Read-only by design. n8n owns workflow create/update/delete via its own
// UI and Public API; the asset console links out rather than proxying
// write verbs. There is also no system-UNION here: n8n scopes workflows
// via its tenant model on the upstream side, and the X-Active-Tenant
// header is forwarded by the http-client without fr having to merge.

import {
  listWorkflows,
  getWorkflow,
} from '../../../integrations/n8n';
import { getRequestContext } from '../../../integrations/_lib/context';
import {
  isIntegrationError,
  integrationErrorResponse,
} from '../../../integrations/_lib/errors';
import { INTERNAL_SYSTEM_TENANT_ID } from '../../../middleware/internal-tenant-only';
import { jsonResponse } from '../../../utils/response';
import { BadRequestError } from '../../../utils/errors';
import { gateReadAsset } from './_lib/gate';
import {
  canReadProductionWorkflows,
  productionWorkflowNotFoundError,
} from '../../../lib/production-workflows-gate';

/**
 * `?limit=` -> a positive integer, or `undefined` for "no cap".
 *
 * ⚠️ MEASURED 2026-09-08. The body was
 *
 *     const parsed = Number.parseInt(limitParam, 10);
 *     if (Number.isFinite(parsed) && parsed > 0) params.limit = parsed;
 *
 * so `?limit=abc`, `?limit=0` and `?limit=-1` set NOTHING and fell through to
 * the same code path as no `limit` at all. That is not a harmless default
 * here: `integrations/n8n.ts listWorkflows` reads an absent limit as
 * `totalCap = Infinity` and CRAWLS THE WHOLE CATALOGUE by cursor. So a caller
 * who asked for 10 workflows and mistyped it received every workflow the API
 * key can see — the opposite of what was asked — and paid for it: that file
 * records a measured 82,635 ms full crawl over 255 workflows. Silently
 * ignoring the one parameter whose job is to BOUND the work is the defect.
 *
 * `Number` + `Number.isInteger`, not `parseInt`: `parseInt('2.7', 10)` is 2 and
 * `parseInt('1e400', 10)` is 1, both of which pass a `> 0` guard and answer
 * confidently about a number the caller did not write.
 *
 * ⛔ NOT `routes/assets/_lib/page-cap.ts resolveListLimit`, though it is the
 * repo's helper for this shape and was the first thing considered. Two of its
 * three behaviours are wrong for THIS route:
 *   * it maps absent -> 200, which would replace the documented full-catalogue
 *     mode the Workflows Viewer depends on with a truncated page, for every
 *     caller, as a side effect of rejecting junk; and
 *   * its 1000 ceiling is the requirements_management `le=1000` bound, which
 *     n8n's cursor-paged API does not have — a ceiling copied from a different
 *     upstream is exactly the "compare against a limit that was never applied"
 *     failure that file's own docblock warns about.
 * It also maps junk -> the default silently, which is the behaviour being
 * removed. No ceiling is added: absent already means unbounded, so capping an
 * EXPLICIT limit would make the stated request stricter than the unstated one.
 *
 * ⚠️ `BadRequestError` (400), NOT `ValidationError`. This first shipped as
 * `ValidationError` "following `routes/approvals.ts parseApprovalsPaging`, the
 * repo's existing numeric-query-param refusal" — but that precedent does not
 * say what it appears to. `parseApprovalsPaging`'s own docblock (approvals.ts
 * ~:614) claims it "throws `ValidationError` (400)", and twenty-five lines
 * ABOVE it, ~:587, the same file already records the MEASURED refutation:
 * `ValidationError` in `utils/errors.ts` is `super(422, …)` and "that docblock
 * is simply wrong about its own class". Copying the class from a comment that
 * misstates its own status code imports a 422 while believing it is a 400.
 * A malformed query string is a malformed request: 400 — and this handler's
 * own `no_active_tenant` refusal twelve lines below is already 400.
 */
export function parseWorkflowLimit(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    throw new BadRequestError('limit must be an integer >= 1');
  }
  return n;
}

type AnyRecord = Record<string, unknown>;
function tagSystem<T extends AnyRecord>(row: T, isSystem: boolean): T & { is_system: boolean } {
  return { ...row, is_system: isSystem };
}

export async function handleListAdminWorkflows(req: Request): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;

  const url = new URL(req.url);
  const activeParam = url.searchParams.get('active');
  const params: { active?: boolean; limit?: number } = {};
  if (activeParam !== null) params.active = activeParam === 'true';
  const limit = parseWorkflowLimit(url.searchParams.get('limit'));
  if (limit !== undefined) params.limit = limit;

  const ctx = getRequestContext();
  const active = ctx.tenantId;
  if (!active) return jsonResponse({ error: 'no_active_tenant' }, 400);
  const isSystem = active === INTERNAL_SYSTEM_TENANT_ID;

  // ⛔ STRICT TENANT SEPARATION (2026-09-30): production n8n is platform data.
  // A customer tenant gets the same envelope, empty, and n8n is never called.
  if (!canReadProductionWorkflows(gate.user, active)) {
    return jsonResponse({ workflows: [] });
  }

  try {
    const { workflows } = await listWorkflows(params);
    const tagged = workflows.map((w) => tagSystem(w as unknown as AnyRecord, isSystem));
    return jsonResponse({ workflows: tagged });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}

export async function handleGetAdminWorkflow(
  req: Request,
  id: string,
): Promise<Response> {
  const gate = await gateReadAsset(req);
  if (!gate.ok) return gate.response;
  try {
    // A customer tenant gets exactly the 404 a genuine unknown id produces.
    if (!canReadProductionWorkflows(gate.user, getRequestContext().tenantId)) {
      throw productionWorkflowNotFoundError(id);
    }
    const wf = await getWorkflow(id);
    const ctx = getRequestContext();
    const isSystem = ctx.tenantId === INTERNAL_SYSTEM_TENANT_ID;
    return jsonResponse({
      workflow: tagSystem(wf as unknown as AnyRecord, isSystem),
    });
  } catch (e) {
    if (isIntegrationError(e)) return integrationErrorResponse(e);
    throw e;
  }
}
