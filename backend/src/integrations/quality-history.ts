/**
 * Asset quality history — requirements_management's append-only evaluation log
 * behind an entity's `quality_score` (src/routers/_quality_history.py):
 * `GET <entity>/{id}/quality/history?limit=`.
 *
 * READ-ONLY. fr no longer triggers evaluations: requirements_management removed
 * its LLM quality judges (`POST <entity>/{id}/evaluate`, RM #238, 2026-10-26),
 * so fr's Evaluate proxies, capabilities, AG-UI actions and buttons went with
 * them. Any future evaluation comes from callers outside RM; fr only shows the
 * runs RM has recorded.
 *
 * Returned VERBATIM: `{entity_type, entity_id, n, items:[{score, issues,
 * suggestions, evaluator_kind, evaluator, model_id, served_by, prompt_version,
 * prompt_sha, correlation_id, created_at, id}]}` — a never-evaluated entity is
 * `n: 0`, `items: []`, never a fabricated score.
 */

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';

const QUALITY_HISTORY_TIMEOUT_MS = 15_000;

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'requirements_management',
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: QUALITY_HISTORY_TIMEOUT_MS,
      // requirements_management resolves the tenant from `X-Tenant-Id` alone
      // (kag_common/auth/__init__.py:409-414 "Pull the license token out of
      // `X-Tenant-Id: Bearer <token>` only"). It never reads `Authorization`.
      // Same upstream, same answer as the CRUD adapters that already talk to it
      // — integrations/{principles,decisions,architecture,requirements}.ts all
      // declare `false`.
      sendAuthorization: false,
      // fr's OWN RM licence in the ONLY header RM introspects, plus
      // `X-Effective-Tenant-Id` naming the customer tenant. See
      // `REQUIREMENTS_SERVICE_TOKEN_ENV`.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // Never call RM without a tenant: a tenantless trusted-network call is
      // served RM's DEFAULT tenant — someone else's data. No frame tenant ⇒
      // MISSING_TENANT before anything is sent.
      requireTenant: true,
    });
  }
  return cachedClient;
}

/** The asset kinds with a quality history upstream, keyed by fr's kind name. */
export const QUALITY_HISTORY_PATHS = {
  principle: 'principles',
  decision: 'decisions',
  architectureElement: 'architecture/elements',
  architectureView: 'architecture/views',
} as const;

export type QualityHistoryKind = keyof typeof QUALITY_HISTORY_PATHS;

export const QUALITY_HISTORY_KINDS = Object.keys(QUALITY_HISTORY_PATHS) as [
  QualityHistoryKind,
  ...QualityHistoryKind[],
];

export function isQualityHistoryKind(k: string): k is QualityHistoryKind {
  return Object.prototype.hasOwnProperty.call(QUALITY_HISTORY_PATHS, k);
}

export async function getQualityHistory(
  kind: QualityHistoryKind,
  id: string,
  limit?: number,
): Promise<unknown> {
  const qs = limit !== undefined ? `?limit=${limit}` : '';
  return await http().json<unknown>(
    `/${QUALITY_HISTORY_PATHS[kind]}/${encodeURIComponent(id)}/quality/history${qs}`,
    { method: 'GET', timeoutMs: QUALITY_HISTORY_TIMEOUT_MS },
  );
}
