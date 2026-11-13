/**
 * `/api/coding/*` spine handlers — the namespaced Stack-2 read+write surface
 * over coding-gateway. Each handler authenticates, resolves the effective
 * tenant (honouring the super-admin workspace override), forwards to the pinned
 * upstream via the coding spine (integrations/coding/spine.ts — a pure
 * pass-through returning raw upstream wire shapes), and wraps the payload in
 * `{ data }` (the fr integration convention). Declared by capabilities/platform/coding.ts.
 *
 * The read handlers are the SHAPING surface: they run the pure adapters
 * (./adapters.ts) over the spine's raw payloads and wrap the result — reads are
 * NO LONGER a raw pass-through. They also carry a tenant-scoped, best-effort
 * redis cache (300s for graph/quality, 600s for a live dep-report; degraded
 * dep-reports are never cached). Every cache op swallows its own errors so a
 * redis outage degrades to an uncached live read, never a 500.
 *
 * This subsumes the retired Stack-1 routes (routes/quality.ts + the
 * services/codeGraph.ts client), deleted in the Stack-1 retirement PR.
 */

import type {
  GithubGitHubRepoRequest,
  CodebaseInitRequest,
  AnalysisRequest,
} from '@fr/service-client-coding';

import {
  getAugmentedGraph,
  getQualityGate,
  listCodingContainers,
  getDependencyReport,
  getDependencySnapshot,
  provisionRepository,
  initializeGraph,
  analyzeCodebase,
  triggerQualityScan,
} from '../../integrations/coding';
import {
  IntegrationError,
} from '../../integrations/_lib/errors';
import { validateAuth } from '../../middleware/auth';
import { ctxTenantId } from '../../middleware/request-context';
import { redis } from '../../services/redis';
import { jsonResponse } from '../../utils/response';
import { platformRepoRefusalResponse } from '../project-request-repo-gate';

import {
  adaptAugmentedGraph,
  adaptQualityGateResult,
  buildDegradedDependencyReport,
} from './adapters';
import { withIntegrationCatch } from '../_lib';

// ---------------------------------------------------------------------------
// Best-effort cache. The wrapper delegates to redis but swallows every error —
// a cache outage must degrade to a live upstream read, never surface a 500.
// ---------------------------------------------------------------------------
interface CodingCache {
  get<T = unknown>(key: string): Promise<T | null>;
  set(key: string, value: unknown, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

const cache: CodingCache = {
  get: async (k) => {
    try {
      return await redis.get(k);
    } catch {
      return null;
    }
  },
  set: async (k, v, ttl) => {
    try {
      await redis.set(k, v, ttl);
    } catch {
      /* best-effort: a cache write failure must never fail the read */
    }
  },
  del: async (k) => {
    try {
      await redis.del(k);
    } catch {
      /* best-effort */
    }
  },
};


/** Parse a JSON request body into a plain object, or throw a 400-mapped error. */
async function parseJsonObject(req: Request): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    const text = await req.text();
    parsed = text.length === 0 ? {} : JSON.parse(text);
  } catch (err) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: `Invalid JSON body: ${err instanceof Error ? err.message : String(err)}`,
    });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IntegrationError({
      code: 'BAD_REQUEST',
      message: 'Request body must be a JSON object',
    });
  }
  return parsed as Record<string, unknown>;
}

// GET /api/coding/graphs/:container/augmented
export function handleGetCodingGraph(
  req: Request,
  container: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const cacheKey = `architecture:${tenantId}:${container}`;

    const cached = await cache.get(cacheKey);
    if (cached) return jsonResponse({ data: cached });

    const raw = await getAugmentedGraph(container, tenantId);
    const adapted = adaptAugmentedGraph(raw);
    await cache.set(cacheKey, adapted, 300);
    return jsonResponse({ data: adapted });
  });
}

// GET /api/coding/quality/:container/gate
export function handleGetCodingQualityGate(
  req: Request,
  container: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const cacheKey = `quality:gate:${tenantId}:${container}`;

    const cached = await cache.get(cacheKey);
    if (cached) return jsonResponse({ data: cached });

    const raw = await getQualityGate(container, tenantId);
    const adapted = adaptQualityGateResult(container, raw);
    await cache.set(cacheKey, adapted, 300);
    return jsonResponse({ data: adapted });
  });
}

// GET /api/coding/dependencies/:container/report
export function handleGetCodingDependencyReport(
  req: Request,
  container: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const cacheKey = `dependencies:${tenantId}:${container}`;

    const cached = await cache.get(cacheKey);
    if (cached) return jsonResponse({ data: cached });

    // The spine flattens: a live report is `{report, degraded:false}`; a
    // deprovisioned container degrades to the persisted snapshot
    // `{report, degraded:true, stale_as_of}`. The frontend expects the
    // DependencyReport fields at the top level, so we unwrap `report` — and,
    // when degraded, re-attach the honest degraded/stale markers. A degraded
    // report is NEVER cached so a later live scan wins immediately.
    const { report, degraded, stale_as_of } = await getDependencyReport(
      container,
      tenantId,
    );
    if (degraded) {
      return jsonResponse({
        data: buildDegradedDependencyReport(
          report as Record<string, unknown>,
          stale_as_of ?? undefined,
        ),
      });
    }
    await cache.set(cacheKey, report, 600);
    return jsonResponse({ data: report });
  });
}

// GET /api/coding/dependencies/:container/snapshot
export function handleGetCodingDependencySnapshot(
  req: Request,
  container: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const data = await getDependencySnapshot(container, tenantId);
    return jsonResponse({ data });
  });
}

// GET /api/coding/containers
export function handleListCodingContainers(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const data = await listCodingContainers(tenantId);
    return jsonResponse({ data });
  });
}

// POST /api/coding/repositories/provision
export function handleProvisionRepository(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    // Untyped JSON at the BFF boundary → the generated request shape. The
    // upstream is the real validator (pass-through); the type documents intent.
    const body = (await parseJsonObject(req)) as unknown as GithubGitHubRepoRequest;
    // ⛔ PLATFORM-REPO OWNERSHIP GATE (ruling 2026-09-30): a non-platform
    // ACTIVE tenant may not have fr clone an internal-owner repo, public or not.
    // Pure, before the upstream hop. A non-string repo_url is left to the
    // upstream validator (the helper ignores non-strings).
    const refused = platformRepoRefusalResponse([body.repo_url], tenantId);
    if (refused) return refused;
    const data = await provisionRepository(body, tenantId);
    return jsonResponse({ data });
  });
}

// POST /api/coding/graphs/initialize
export function handleInitializeGraph(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const body = (await parseJsonObject(req)) as unknown as CodebaseInitRequest;
    const data = await initializeGraph(body, tenantId);
    return jsonResponse({ data });
  });
}

// POST /api/coding/analysis/analyze
export function handleAnalyzeCodebase(req: Request): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const body = (await parseJsonObject(req)) as unknown as AnalysisRequest;
    const data = await analyzeCodebase(body, tenantId);
    return jsonResponse({ data });
  });
}

// POST /api/coding/dependencies/:container/scan
export function handleTriggerCodingScan(
  req: Request,
  container: string,
): Promise<Response> {
  return withIntegrationCatch(async () => {
    const user = await validateAuth(req);
    const tenantId = ctxTenantId(user.tenantId);
    const data = await triggerQualityScan(container, tenantId);
    // Bust EVERY cache key this scan invalidates, so the next read reflects the
    // fresh scan.
    //
    // ⛔ The upstream is `POST /api/tests/quality-scan` — a dependency AND
    // QUALITY scan (see integrations/coding/spine.ts). Only the `dependencies:`
    // key was busted here, so `GET /api/coding/quality/:container/gate` kept
    // serving its 300s-TTL entry for up to five minutes AFTER a scan. A gate
    // that has just gone red therefore rendered as the previous PASS — a stale
    // verdict presented as a fresh measurement, which is worse than showing
    // nothing.
    //
    // (Legacy Stack-1 busted an un-tenant-scoped key `dependencies:${container}`
    // — a separate, already-fixed bug that never invalidated the tenant-scoped
    // entries the read path writes. Both keys below are tenant-scoped: another
    // tenant's cache is not this scan's to invalidate.)
    await Promise.all([
      cache.del(`dependencies:${tenantId}:${container}`),
      cache.del(`quality:gate:${tenantId}:${container}`),
    ]);
    return jsonResponse({ data });
  });
}
