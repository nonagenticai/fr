// src/services/inference-admin.ts
//
// Client for inference-router's tenant inference ADMIN API (PLAN
// tenant-inference-provisioning §3.4; IR#187 `src/routers/admin_tenants.py`):
//
//   GET  /api/admin/tenants/{t}/inference-policy           → {active_version, doc, versions[]}
//   POST /api/admin/tenants/{t}/inference-policy/activate  {"version": n} → {active_version}
//
// The policy PUT is NOT here: an edit goes through provisioning's apply (budget,
// markup, quote, policy and the ledger-verified smoke as one run), never a bare
// PUT from fr.
//
// AUTH (IR `admin_auth.py`, all three required): the mesh admits fr's SA; the
// `Authorization` bearer is fr's portal service-account JWT (azp must be in IR's
// ADMIN_AZP_ALLOWLIST); `X-Forwarded-User-Authorization: Bearer <owner JWT>` is
// the human IR authorises (`super_admin`). The owner JWT is relayed, never
// logged, stored or echoed in an error.
//
// Base URL = `config.services.inferenceRouter.baseUrl` (INFERENCE_ROUTER_URL).
// Empty → every call throws a 503 AppError (no silent empty answer).

import { config } from '../config';
import { getServiceAuthenticator } from '../lib/service-authenticators';
import { IntegrationError } from '../integrations/_lib/errors';
import { AppError } from '../utils/errors';

interface TenantInferencePolicyView {
  active_version: number | null;
  doc: Record<string, unknown> | null;
  versions: { version: number; created_at: string; actor_kind: string }[];
}

async function call<T>(
  method: 'GET' | 'POST',
  path: string,
  ownerPortalToken: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const base = config.services.inferenceRouter.baseUrl;
  if (!base) {
    // fr's own configuration gap, not an upstream answer: no request was sent.
    throw new AppError(503, 'inference-router is not configured (INFERENCE_ROUTER_URL is empty)');
  }
  let res: Response;
  try {
    res = await getServiceAuthenticator().authenticatedFetch(`${base}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        'X-Forwarded-User-Authorization': `Bearer ${ownerPortalToken}`,
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const isTimeout = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new IntegrationError({
      code: isTimeout ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_UNREACHABLE',
      message: `inference-router ${method} ${path} failed: ${e instanceof Error ? e.message : String(e)}`,
      service: 'inference_router',
      method,
      path,
      cause: e,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    let parsed: unknown = text;
    try {
      parsed = text ? JSON.parse(text) : text;
    } catch {
      // keep raw text
    }
    const code =
      res.status === 401
        ? 'UPSTREAM_UNAUTHORIZED'
        : res.status === 403
          ? 'UPSTREAM_FORBIDDEN'
          : res.status === 404
            ? 'UPSTREAM_NOT_FOUND'
            : res.status === 409
              ? 'UPSTREAM_CONFLICT'
              : 'UPSTREAM_BAD_STATUS';
    throw new IntegrationError({
      code,
      message: `inference-router ${method} ${path} ${res.status}: ${
        typeof parsed === 'string' ? parsed : JSON.stringify(parsed)
      }`,
      service: 'inference_router',
      method,
      path,
      upstreamStatus: res.status,
      upstreamBody: parsed,
    });
  }
  return (await res.json()) as T;
}

export function getTenantInferencePolicy(
  tenantId: string,
  ownerPortalToken: string,
): Promise<TenantInferencePolicyView> {
  return call<TenantInferencePolicyView>(
    'GET',
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/inference-policy`,
    ownerPortalToken,
  );
}

export function activateTenantInferencePolicy(
  tenantId: string,
  version: number,
  ownerPortalToken: string,
): Promise<{ active_version: number }> {
  return call<{ active_version: number }>(
    'POST',
    `/api/admin/tenants/${encodeURIComponent(tenantId)}/inference-policy/activate`,
    ownerPortalToken,
    { version },
  );
}
