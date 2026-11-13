// src/integrations/kag-orchestrator.ts
//
// Hand-written client for kag_orchestrator's public GET /health/lag backlog
// gauge — the ONLY endpoint fr consumes from the ingestion-pipeline coordinator
// (distinct from the KAG unified gateway wired in integrations/kag.ts).
//
// /health/lag returns per-stage pending depth + the age of the oldest *visible*
// pending message (a worst-case backlog-age gauge). It is explicitly NOT a
// DONE→searchable end-to-end p95 — the orchestrator retains no completed-item
// durations. The control-tower fleet band surfaces max_oldest_age_seconds as a
// backlog-age proxy; nothing here fabricates a latency distribution.
//
// Auth: NONE. The route is in kag_orchestrator's PUBLIC_ENDPOINTS (like
// /health/ready); the shared http-client still auto-injects the caller's
// bearer / X-Tenant-Id headers, which the orchestrator ignores for /health/*.
//
// Upstream: kag_orchestrator/src/routes/health.py (GET /health/lag). Response is
// BARE (no {data, meta} envelope).

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { IntegrationError } from './_lib/errors';

// Resolved per call (not at module load) so tests can flip the env var after
// import.
function kagOrchestratorBaseUrl(): string {
  return process.env.KAG_ORCHESTRATOR_URL ?? config.services.kagOrchestrator.baseUrl;
}

let cachedClient: HttpClient | null = null;
let cachedClientBaseUrl: string | null = null;

function client(): HttpClient {
  const baseUrl = kagOrchestratorBaseUrl();
  if (!baseUrl) {
    // Fail loud — callers gate on isKagOrchestratorConfigured() first; the
    // control-tower block() wrapper turns this into available:false, never a 500.
    throw new IntegrationError({
      code: 'UPSTREAM_UNREACHABLE',
      message: 'KAG_ORCHESTRATOR_URL is not set — the KAG backlog gauge is disabled',
      service: 'kag-orchestrator',
    });
  }
  if (cachedClient && cachedClientBaseUrl === baseUrl) return cachedClient;
  cachedClient = createHttpClient({
    serviceName: 'kag-orchestrator',
    baseUrl,
    defaultTimeoutMs: 5_000,
    // the orchestrator DOES read `Authorization` in general (src/auth/middleware.py:207)
    // — but only for an on-behalf-of branch gated by an empty AUTH_ONBEHALF_SUBJECTS,
    // and fr calls only `/health/lag`, which middleware.py:92 lists in
    // PUBLIC_ENDPOINTS and returns before any header is read. Scoped to the route,
    // not to the service: widening fr's use of this client needs a re-check.
    sendAuthorization: false,
    // GET-only read; the default idempotent retry policy is fine.
    retry: { attempts: 2, backoffMs: 200 },
  });
  cachedClientBaseUrl = baseUrl;
  return cachedClient;
}

// ----- Types (mirror kag_orchestrator/src/schemas.py QueueLagStatus) ----------

interface StageLag {
  stage: string;
  pending: number;
  /** Seconds the oldest visible pending message has waited; null when idle. */
  oldest_age_seconds: number | null;
}

export interface KagLagStatus {
  stages: StageLag[];
  total_pending: number;
  /** Largest oldest_age_seconds across stages (worst-case backlog age); null when idle. */
  max_oldest_age_seconds: number | null;
  backend: string;
}

/**
 * GET /health/lag — per-stage backlog depth + worst-case backlog age.
 *
 * Throws IntegrationError when unset/unreachable/5xx (the orchestrator returns
 * 503 when its queue backend is down). Callers wrap this in the control-tower
 * block() seam so a dead upstream degrades to available:false.
 */
export async function getKagLag(): Promise<KagLagStatus> {
  return await client().json<KagLagStatus>('/health/lag', { method: 'GET' });
}

// ----- KAG completion-latency p95 (mirrors kag_orchestrator's KagLatencyStats) -

export interface KagLatencyStatus {
  /** p95 of DONE→searchable completion durations over the window; null when no samples. */
  p95_seconds: number | null;
  p50_seconds: number | null;
  max_seconds: number | null;
  sample_count: number;
  window_hours: number;
}

/**
 * GET /health/kag-latency — TRUE DONE→searchable completion-latency distribution
 * (p95/p50/max over completed items in the window). Same public base URL + auth
 * posture as GET /health/lag. Bare response (no {data, meta} envelope).
 *
 * Throws IntegrationError when unset/unreachable/5xx; the caller wraps this in
 * the control-tower block() seam so a dead upstream degrades to available:false.
 * When the window has no completed items the body carries sample_count:0 +
 * p95_seconds:null (no fabricated latency) and this resolves normally.
 */
export async function getKagLatency(): Promise<KagLatencyStatus> {
  return await client().json<KagLatencyStatus>('/health/kag-latency', { method: 'GET' });
}
