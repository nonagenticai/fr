// src/routes/settings/llm-provider.ts
//
// Per-tenant BYO LLM provider settings. Proxies the worker_management
// tenant-config endpoints (worker_management/src/api/tenant_config/_router.py)
// through fr-backend's existing trusted-network workers integration.
//
// AUTHORIZATION: worker_management enforces tenant-scope only (a valid
// license = full access — no role model). So the workspace-admin gate that
// protects a tenant's provider key from being rewritten by a plain member is
// enforced HERE, at the fr route layer. Mirrors the gate in
// `routes/admin/departments.ts`, extended to also admit platform super-admins
// (e.g. operating in a switched-tenant view).
//
// Per-tier rows: GET/PUT/DELETE accept an optional `?tier=small|medium|high`
// query param selecting the tenant's provider for that work-size tier; absent
// ⇒ the `__default__` row (unchanged Phase-1 behavior). GET .../all lists every
// configured row for the multi-tier editor.
//
// RBAC:
//   * GET    /api/settings/llm-provider[?tier=]   — workspace-admin | super-admin
//   * GET    /api/settings/llm-provider/all        — workspace-admin | super-admin
//   * GET    /api/settings/llm-provider/catalog    — workspace-admin | super-admin
//   * PUT    /api/settings/llm-provider[?tier=]    — workspace-admin | super-admin
//   * DELETE /api/settings/llm-provider[?tier=]    — workspace-admin | super-admin
//   * POST   /api/settings/llm-provider/test       — workspace-admin | super-admin
//       body {tier?} | {provider, model?}; proxies WM POST /tenant-config/llm/test
//       (one live call with the tenant row's key → {ok, provider, model,
//       latency_ms, error?, warning?}). Drives the per-tier green/red dot.
//   * GET    /api/settings/llm-provider/audit[?limit=1..200]
//                                                — workspace-admin | super-admin
//       proxies WM GET /tenant-config/llm/audit: who set / removed / tested
//       this tenant's keys, newest first (owner ruling 2026-10-02 — the
//       customer must see what the platform operator did to its BYO key).
//
// The proxy bodies live in the `*Op(req, scope)` functions below and are
// SHARED with the owner's per-customer-tenant routes in
// `routes/admin/tenant-llm-provider.ts`. The only difference between the two
// surfaces is the gate and the `TenantScope`: here the WM call runs in the
// ambient request frame (the caller's own / switched tenant); there it runs in
// a nested frame whose tenant is the TARGET customer tenant.

import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { isSuperAdmin } from '../../lib/super-admin-gate';
import { AppError, BadRequestError } from '../../utils/errors';
import { jsonResponse, noContentResponse } from '../../utils/response';
import { handle } from '../assets/_lib/handler';
import { userRolesService } from '../../services/user-roles';
import {
  deleteTenantLlmConfig,
  getTenantLlmCatalog,
  getTenantLlmAudit,
  getTenantLlmConfig,
  listTenantLlmConfigs,
  putTenantLlmConfig,
  testTenantLlmConfig,
  type LlmAuditEntry,
  type LlmCatalog,
  type LlmConfigRow,
  type LlmConfigUpdate,
  type LlmConfigView,
  type LlmKeyTestRequest,
  type LlmKeyTestResult,
  type WorkTier,
} from '../../integrations/workers';

const WORK_TIERS: readonly WorkTier[] = ['small', 'medium', 'high'];

/**
 * Read and validate the optional `?tier=` query param. Absent/empty ⇒ undefined
 * (the `__default__` row). An unknown value is rejected at the fr layer with 400
 * before reaching worker_management.
 */
function parseTier(req: Request): WorkTier | undefined {
  const raw = new URL(req.url).searchParams.get('tier');
  if (raw === null || raw === '') return undefined;
  if (!WORK_TIERS.includes(raw as WorkTier)) {
    throw new BadRequestError(`Unknown tier '${raw}' (expected one of ${WORK_TIERS.join(', ')})`);
  }
  return raw as WorkTier;
}

async function isTenantAdmin(user: {
  id: string;
  roles: string[];
  tenantId: string;
}): Promise<boolean> {
  // Platform super-admin always passes (out-of-band from workspace membership).
  if (isSuperAdmin(user)) return true;
  // Keycloak claim path — cheap, no DB.
  // Delegates to the single canonical implementation. This used to be an
  // inline copy of it; four files carried near-identical copies and a fifth
  // (routes/assets/kag.ts) carried a copy that had lost the DB fallback
  // entirely, which is how six destructive verbs ended up gated on a claim
  // nobody holds. One implementation, so the next drift has nowhere to hide.
  return userRolesService.isWorkspaceAdminVia(
    user,
    ctxTenantId(user.tenantId),
    userRolesService.hasRole,
  );
}

async function requireTenantAdmin(req: Request): Promise<void> {
  const user = await validateAuth(req);
  if (!(await isTenantAdmin(user))) {
    throw new AppError(403, 'workspace-admin role required');
  }
}

/**
 * Runs a worker_management call in the tenant this request acts for. The WM
 * client (`integrations/workers.ts`) reads the tenant from the ALS request
 * frame, so a scope is either "the ambient frame" (settings routes) or "a
 * nested frame naming the target tenant" (owner admin routes).
 */
export type TenantScope = <T>(fn: () => Promise<T>) => Promise<T>;

/** The ambient request frame — the caller's own (or super-admin-switched) tenant. */
const AMBIENT_TENANT: TenantScope = (fn) => fn();

// The six WM operations, bound to a request + scope and returned as thunks for
// `handle(...)`. Input is validated EAGERLY (a bad `?tier=` / body is a 400
// before any WM call). Each route keeps its own `handle(op, (data) =>
// jsonResponse({ data }))` line so the response envelope stays visible at the
// handler.

/** GET [?tier=] — tenant LLM config for a tier (key masked). Caller has gated. */
export function getLlmProviderOp(req: Request, scope: TenantScope): () => Promise<LlmConfigView> {
  const tier = parseTier(req);
  return () => scope(() => getTenantLlmConfig(tier));
}

/** GET .../all — every configured row (default + tiers). Caller has gated. */
export function listLlmProvidersOp(scope: TenantScope): () => Promise<{ configs: LlmConfigRow[] }> {
  return () => scope(() => listTenantLlmConfigs());
}

/** GET .../catalog — available BYO providers. Caller has gated. */
export function getLlmCatalogOp(scope: TenantScope): () => Promise<LlmCatalog> {
  return () => scope(() => getTenantLlmCatalog());
}

/** PUT [?tier=] — create/update the tier's LLM config. Caller has gated. */
export async function putLlmProviderOp(
  req: Request,
  scope: TenantScope,
): Promise<() => Promise<LlmConfigView>> {
  const tier = parseTier(req);
  const raw = await req.json().catch(() => {
    throw new BadRequestError('Invalid JSON request body');
  });
  const body = buildLlmUpdate(raw);
  return () => scope(() => putTenantLlmConfig(body, tier));
}

/** DELETE [?tier=] — revert that tier to platform routing (local-llm). Caller has gated. */
export function deleteLlmProviderOp(req: Request, scope: TenantScope): () => Promise<void> {
  const tier = parseTier(req);
  return () => scope(() => deleteTenantLlmConfig(tier));
}

/** POST .../test — live-test the tenant's key for a tier. Caller has gated. */
export async function testLlmProviderOp(
  req: Request,
  scope: TenantScope,
): Promise<() => Promise<LlmKeyTestResult>> {
  const raw = await req.json().catch(() => ({}));
  const body = buildKeyTestRequest(raw);
  return () => scope(() => testTenantLlmConfig(body));
}

const AUDIT_LIMIT_MAX = 200;

/**
 * Read and validate the optional `?limit=` query param for the audit list.
 * Absent/empty ⇒ undefined (WM's default, 50). Anything but an integer in
 * 1..200 is a 400 here, before worker_management.
 */
function parseAuditLimit(req: Request): number | undefined {
  const raw = new URL(req.url).searchParams.get('limit');
  if (raw === null || raw === '') return undefined;
  if (!/^[0-9]+$/.test(raw)) {
    throw new BadRequestError(`limit must be an integer between 1 and ${AUDIT_LIMIT_MAX}`);
  }
  const n = Number(raw);
  if (!Number.isSafeInteger(n) || n < 1 || n > AUDIT_LIMIT_MAX) {
    throw new BadRequestError(`limit must be an integer between 1 and ${AUDIT_LIMIT_MAX}`);
  }
  return n;
}

/** GET .../audit[?limit=] — the tenant's BYO change history, newest first. Caller has gated. */
export function getLlmAuditOp(
  req: Request,
  scope: TenantScope,
): () => Promise<{ entries: LlmAuditEntry[] }> {
  const limit = parseAuditLimit(req);
  return () => scope(() => getTenantLlmAudit(limit));
}

/** GET /api/settings/llm-provider[?tier=] — tenant LLM config for a tier (key masked). */
export async function handleGetLlmProvider(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(getLlmProviderOp(req, AMBIENT_TENANT), (data) => jsonResponse({ data }));
}

/** GET /api/settings/llm-provider/all — every configured row (default + tiers). */
export async function handleListLlmProviders(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(listLlmProvidersOp(AMBIENT_TENANT), (data) => jsonResponse({ data }));
}

/** GET /api/settings/llm-provider/catalog — available BYO providers. */
export async function handleGetLlmCatalog(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(getLlmCatalogOp(AMBIENT_TENANT), (data) => jsonResponse({ data }));
}

/**
 * Build the outbound PUT body, preserving the apiKey tri-state. `apiKey` is
 * included IFF the client sent the property (even when '') so worker_management
 * can tell "preserve existing" (absent) from "clear" ('') from "set" (value).
 */
export function buildLlmUpdate(raw: unknown): LlmConfigUpdate {
  if (!raw || typeof raw !== 'object') {
    throw new BadRequestError('body must be an object');
  }
  const b = raw as Record<string, unknown>;

  if (typeof b.provider !== 'string' || b.provider.length === 0) {
    throw new BadRequestError('provider is required');
  }
  if (typeof b.model !== 'string' || b.model.length === 0) {
    throw new BadRequestError('model is required');
  }

  const out: LlmConfigUpdate = { provider: b.provider, model: b.model };

  if (b.baseUrl !== undefined) {
    if (b.baseUrl !== null && typeof b.baseUrl !== 'string') {
      throw new BadRequestError('baseUrl must be a string');
    }
    if (typeof b.baseUrl === 'string' && b.baseUrl.length > 0) out.baseUrl = b.baseUrl;
  }
  if (b.temperature !== undefined && b.temperature !== null) {
    if (typeof b.temperature !== 'number' || Number.isNaN(b.temperature)) {
      throw new BadRequestError('temperature must be a number');
    }
    out.temperature = b.temperature;
  }
  if (b.maxTokens !== undefined && b.maxTokens !== null) {
    if (typeof b.maxTokens !== 'number' || !Number.isInteger(b.maxTokens)) {
      throw new BadRequestError('maxTokens must be an integer');
    }
    out.maxTokens = b.maxTokens;
  }
  if (b.params !== undefined && b.params !== null) {
    if (typeof b.params !== 'object' || Array.isArray(b.params)) {
      throw new BadRequestError('params must be an object');
    }
    out.params = b.params as Record<string, unknown>;
  }
  // Tri-state: include apiKey only when the client explicitly sent the key.
  if (Object.prototype.hasOwnProperty.call(b, 'apiKey')) {
    if (typeof b.apiKey !== 'string') {
      throw new BadRequestError('apiKey must be a string');
    }
    out.apiKey = b.apiKey;
  }
  return out;
}

/** PUT /api/settings/llm-provider[?tier=] — create/update the tier's LLM config. */
export async function handlePutLlmProvider(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(await putLlmProviderOp(req, AMBIENT_TENANT), (data) => jsonResponse({ data }));
}

/** DELETE /api/settings/llm-provider[?tier=] — revert that tier to platform routing. */
export async function handleDeleteLlmProvider(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(deleteLlmProviderOp(req, AMBIENT_TENANT), () => noContentResponse());
}

/**
 * Validate the key-test body: `{tier?}` (absent/null ⇒ the default row) OR
 * `{provider, model?}`. Both, an unknown tier, or a non-string field is a 400
 * here rather than a WM 422.
 */
function buildKeyTestRequest(raw: unknown): LlmKeyTestRequest {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const hasTier = b.tier !== undefined && b.tier !== null && b.tier !== '';
  const hasProvider = b.provider !== undefined && b.provider !== null && b.provider !== '';
  if (hasTier && hasProvider) {
    throw new BadRequestError('Send either {tier} or {provider, model}, not both.');
  }
  if (hasProvider) {
    if (typeof b.provider !== 'string') throw new BadRequestError('provider must be a string');
    if (b.model !== undefined && b.model !== null && typeof b.model !== 'string') {
      throw new BadRequestError('model must be a string');
    }
    return typeof b.model === 'string' && b.model
      ? { provider: b.provider, model: b.model }
      : { provider: b.provider };
  }
  if (!hasTier) return {};
  if (typeof b.tier !== 'string' || !WORK_TIERS.includes(b.tier as WorkTier)) {
    throw new BadRequestError(`Unknown tier '${String(b.tier)}' (expected one of ${WORK_TIERS.join(', ')})`);
  }
  return { tier: b.tier as WorkTier };
}

/** POST /api/settings/llm-provider/test — live-test the tenant's key for a tier. */
export async function handleTestLlmProvider(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(await testLlmProviderOp(req, AMBIENT_TENANT), (data) => jsonResponse({ data }));
}

/** GET /api/settings/llm-provider/audit[?limit=] — who changed this workspace's BYO keys. */
export async function handleGetLlmProviderAudit(req: Request): Promise<Response> {
  await requireTenantAdmin(req);
  return handle(getLlmAuditOp(req, AMBIENT_TENANT), (data) => jsonResponse({ data }));
}
