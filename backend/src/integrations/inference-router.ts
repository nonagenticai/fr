// src/integrations/inference-router.ts
//
// Thin client for the inference-router served-model timeline read
// (`GET /api/internal/served-models/timeline`). Hand-authored (there is no
// generated `@fr/service-client-*` package for inference-router) mirroring the
// shape of `integrations/workers.ts`.
//
// Base URL = `config.services.inferenceRouter.baseUrl` (`INFERENCE_ROUTER_URL`).
// It is intentionally NOT in the required-URL validation list, so fr is safe to
// deploy before the env is wired.

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { IntegrationError } from './_lib/errors';
import { INTERNAL_SYSTEM_TENANT_ID } from '../middleware/internal-tenant-only';

const CRUD_TIMEOUT_MS = 10_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'inference_router',
      baseUrl: config.services.inferenceRouter.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // inference-router's own src/security.py states the scheme is
      // "license-token-as-X-Tenant-Id (never an `Authorization` bearer)", and the
      // X-Tenant-Id below is already explicit and fixed. The JWT was inert.
      sendAuthorization: false,
      // X-Tenant-Id is EXPLICIT + FIXED, not the ALS ambient tenant: the mesh
      // does NOT inject X-Tenant-Id on service-to-service calls. buildHeaders
      // only fills the ALS tenant when the header is ABSENT, so this default
      // always wins.
      defaultHeaders: { 'X-Tenant-Id': INTERNAL_SYSTEM_TENANT_ID },
    });
  }
  return cachedClient;
}

/** True when INFERENCE_ROUTER_URL is configured. */
function inferenceRouterConfigured(): boolean {
  return config.services.inferenceRouter.baseUrl.length > 0;
}

// ---------------------------------------------------------------------------
// Served-model timeline (judge-oracle tournament review, PHASE 2 / J1)
// ---------------------------------------------------------------------------
//
// GET /api/internal/served-models/timeline?days= — per day × requested alias:
// the model root that actually SERVED the call, the provider, n, and the T=0 /
// seed / licensed shares. Read verbatim for /operate/verification (Judge tab);
// fr recomputes nothing. System data from the ledger. inference-router gates
// /api/internal/* on `X-Internal-Secret` (env INFERENCE_ROUTER_INTERNAL_SECRET
// here); the fixed X-Tenant-Id this client already sends rides along. A 401
// (bad secret) or 503 (upstream secret unset) is an IntegrationError →
// available:false.
//
// ⚠️ An UNCONFIGURED client is not `null`: a null here would be indistinguishable from "no calls served", so it THROWS and
// the verification block degrades to available:false — never an empty timeline.

const TIMELINE_TIMEOUT_MS = 15_000;

export async function getServedModelsTimeline(params: { days?: number } = {}): Promise<unknown> {
  if (!inferenceRouterConfigured()) {
    throw new IntegrationError({
      code: 'INTERNAL_PRECONDITION',
      message: 'INFERENCE_ROUTER_URL is not set',
      service: 'inference_router',
    });
  }
  const secret = config.services.inferenceRouter.internalSecret;
  if (!secret) {
    // Fail loud before any call: omitting it would 401 upstream and read as
    // "inference-router unreachable" with the cause hidden.
    throw new IntegrationError({
      code: 'INTERNAL_PRECONDITION',
      message: 'INFERENCE_ROUTER_INTERNAL_SECRET is not set — /api/internal/* reads require X-Internal-Secret',
      service: 'inference_router',
    });
  }
  const qs = new URLSearchParams();
  if (params.days !== undefined) qs.set('days', String(params.days));
  const q = qs.toString();
  return await http().json<unknown>(`/api/internal/served-models/timeline${q ? `?${q}` : ''}`, {
    method: 'GET',
    headers: { 'X-Internal-Secret': secret },
    timeoutMs: TIMELINE_TIMEOUT_MS,
  });
}
