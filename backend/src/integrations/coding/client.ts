/**
 * coding-gateway HTTP client (cached per process).
 *
 * Spec: docs/superpowers/specs/completed/2026-04-24-coding-analysis-ui.md §"Error mapping".
 * Trigger calls override retry to 0 to prevent duplicate runs; that decision
 * lives in the adapter, not here. This module only owns the HttpClient
 * lifecycle and the shared timeout constants.
 */

import { config } from '../../config';
import { createHttpClient, type HttpClient } from '../_lib/http-client';
import { CODING_SERVICE_TOKEN_ENV } from '../_lib/service-credential';

const POLL_TIMEOUT_MS = 30_000;
export const TRIGGER_TIMEOUT_MS = 60_000;
export const DEDUP_WINDOW_MINUTES = 10;

/**
 * Max wall-clock a job may sit in queued/running before the adapter declares it stale and
 * writes a terminal SCAN_STALE failure. ~8x the upstream 300s scan budget, far below the
 * upstream 24h result TTL, so a dead scan worker never spins fr forever.
 */
export const MAX_RUNNING_AGE_MS = 40 * 60 * 1000; // 40 minutes

let cachedClient: HttpClient | undefined;

export function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'coding-gateway',
      baseUrl: config.services.codingGateway,
      defaultTimeoutMs: POLL_TIMEOUT_MS,
      // Never forward the end-user Keycloak JWT to coding-gateway. Tenant is
      // resolved from X-Tenant-Id (coding-client auth/tenant.py require_tenant,
      // priority 1b — wins before the Bearer is read), so the JWT is unused
      // here; forwarding it only risks it being POSTed to license introspection
      // on any hop where the ALS tenant is absent (the 2026-04-26 outage vector).
      sendAuthorization: false,
      // ...but DO send fr's own licence. The coding-* backends stopped trusting
      // a bare X-Tenant-Id (TRUST_TENANT_HEADER=false), so a call carrying only
      // a tenant header now reaches them with nothing to introspect and 401s.
      // The credential answers "who is asking"; X-Tenant-Id still answers "whose
      // data", and coding-gateway honours the pair because svc-fr-backend is in
      // its CODING_ONBEHALF_SUBJECTS.
      serviceTokenEnvVar: CODING_SERVICE_TOKEN_ENV,
    });
  }
  return cachedClient;
}
