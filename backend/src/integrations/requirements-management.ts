// Architecture-element binding validator (req_man PR 1 → fr PR 2 hop).
//
// PR 1/3 of task #25 scope B shipped `GET /architecture/containers/{name}
// ?projectId=…` on requirements_management — a 200/404 validator returning
// `{name, scope, element_count, valid}` if any architecture element in the
// project's effective view (project ∪ tenant) binds the container. fr's
// attach + primary-promote handlers call it as a guardrail:
//
//   * attach   = soft → 404 lets the caller proceed with a warning. Onboarding
//                a repo before the architecture is modelled is the common case.
//   * promote  = hard → 404 returns 409 so the dispatched-from-primary path
//                never runs against an unmodelled container.
//
// 60s in-memory TTL keyed on (tenantId, projectId, containerName).
// `getContainerBinding` is the only export — the cached client is reused
// from `integrations/architecture.ts` (same upstream).

import { config } from '../config';
import { createHttpClient, type HttpClient } from './_lib/http-client';
import { REQUIREMENTS_SERVICE_TOKEN_ENV } from './_lib/service-credential';
import { getTenantId } from './_lib/context';
import { isIntegrationError } from './_lib/errors';
import {
  getGetArchitectureContainerUrl,
  getListPrincipleConflictsUrl,
  type ArchitectureContainerDetail,
  type ListPrincipleConflictsParams,
  type PrincipleConflictOut,
} from '@fr/service-client-requirements';

const CRUD_TIMEOUT_MS = 30_000;
const TTL_MS = 60_000;
/**
 * Negative TTL for an upstream FAILURE, deliberately much shorter than TTL_MS.
 *
 * Every result used to be cached for the full 60s, failures included. So a
 * one-second blip in requirements_management kept answering
 * `reason: 'upstream_error'` for a full minute after the service had recovered
 * — the cache masked the recovery, and the caller could not tell a service that
 * is down from one that WAS down. A cache is supposed to save work, not pin a
 * stale verdict about someone else's health.
 *
 * Not zero: a sustained outage would then hammer the upstream once per call.
 * 5s damps that while keeping recovery effectively immediate from a user's
 * point of view.
 *
 * A 404 `not_bound` is NOT a failure — it is a stable, correct answer about
 * this container — so it keeps the full TTL.
 */
const ERROR_TTL_MS = 5_000;

/** RM's container binding (`GET /architecture/containers/{name}`), as generated. */
type ContainerBinding = ArchitectureContainerDetail;

export type ContainerBindingResult =
  | { ok: true; binding: ContainerBinding }
  | { ok: false; reason: 'not_bound'; status: 404 }
  | { ok: false; reason: 'upstream_error'; status: number; message: string };

let cachedClient: HttpClient | undefined;

function http(): HttpClient {
  if (!cachedClient) {
    cachedClient = createHttpClient({
      serviceName: 'requirements_management',
      baseUrl: config.services.requirements.baseUrl,
      defaultTimeoutMs: CRUD_TIMEOUT_MS,
      // requirements_management resolves the tenant from `X-Tenant-Id` alone
      // (kag_common/auth/__init__.py:409-414 "Pull the license token out of
      // `X-Tenant-Id: Bearer <token>` only"). It never reads `Authorization`.
      sendAuthorization: false,
      // fr's OWN RM licence in the ONLY header RM introspects, plus
      // `X-Effective-Tenant-Id` naming the customer tenant. Unset ⇒ every call
      // is refused before it is sent (R351 (7), `tenantBearerRequired`): no
      // plain-uuid request. See `REQUIREMENTS_SERVICE_TOKEN_ENV`.
      tenantBearerEnvVar: REQUIREMENTS_SERVICE_TOKEN_ENV,
      tenantBearerRequired: true,
      // Never call RM without a tenant: a tenantless trusted-network call is
      // served RM's DEFAULT tenant — someone else's data — and fr must not
      // patch the gap with its own or the system tenant. No frame tenant ⇒
      // MISSING_TENANT before anything is sent (callers render 409/unavailable).
      requireTenant: true,
    });
  }
  return cachedClient;
}

interface CacheEntry {
  result: ContainerBindingResult;
  expiresAtMs: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(
  tenantId: string,
  projectId: string,
  containerName: string,
): string {
  return `${tenantId}::${projectId}::${containerName}`;
}

/**
 * Validate that the given coding-containers container is bound to at least
 * one architecture element in the project's effective view (project-scope ∪
 * tenant-scope on requirements_management). 60s TTL keyed on
 * (tenantId, projectId, containerName); the caller passes the resolved
 * X-Tenant-Id verbatim from request context so cross-tenant probes don't
 * cross the cache.
 *
 * NOTE: `getTenantId()` reads from the per-request context (set by
 * `withRequestContext`), which the HTTP client also reads for `X-Tenant-Id`
 * — passing it explicitly keeps the cache key local to the call so this
 * helper stays mockable without spinning up an AsyncLocalStorage.
 */
/**
 * How long a given result may be cached.
 *
 * A function, not an inline ternary, because it is the DECISION and a decision
 * needs to be testable. Inline, the only way to observe it was to wait out a
 * real 5s vs 60s window, so the obvious test used `fresh: true` instead — which
 * bypasses the cache entirely and passes just as happily against the bug. That
 * test was written, passed, and died under mutation before this refactor.
 *
 * A failure is cached BRIEFLY; a real answer for the full TTL. Caching them
 * alike is what let a recovered upstream keep reading as broken for the rest of
 * the minute. A 404 `not_bound` counts as a real ANSWER, not a failure.
 */
function cacheTtlFor(result: ContainerBindingResult): number {
  return result.ok === false && result.reason === 'upstream_error'
    ? ERROR_TTL_MS
    : TTL_MS;
}

export async function getContainerBinding(opts: {
  projectId: string;
  containerName: string;
  fresh?: boolean;
}): Promise<ContainerBindingResult> {
  // No `?? 'default'`: a tenantless call is refused by the client
  // (`requireTenant`), and caching that refusal under a shared 'default' key
  // would hand it to nobody in particular. Answer it here, uncached and unsent.
  const tenantId = getTenantId()?.trim();
  if (!tenantId) {
    return {
      ok: false,
      reason: 'upstream_error',
      status: 409,
      message: 'MISSING_TENANT: no tenant could be resolved, so requirements_management was not called',
    };
  }
  const key = cacheKey(tenantId, opts.projectId, opts.containerName);
  const now = Date.now();

  if (!opts.fresh) {
    const hit = cache.get(key);
    if (hit && hit.expiresAtMs > now) return hit.result;
  }

  const path = getGetArchitectureContainerUrl(encodeURIComponent(opts.containerName), { projectId: opts.projectId });

  let result: ContainerBindingResult;
  try {
    const response = await http().fetch(path, { method: 'GET', noRetry: true });
    if (response.status === 404) {
      result = { ok: false, reason: 'not_bound', status: 404 };
    } else if (!response.ok) {
      let message = `requirements_management returned ${response.status}`;
      try {
        const body = await response.text();
        if (body) message = body.slice(0, 500);
      } catch {
        // ignore
      }
      result = { ok: false, reason: 'upstream_error', status: response.status, message };
    } else {
      const body = (await response.json()) as ContainerBinding;
      result = { ok: true, binding: body };
    }
  } catch (err) {
    result = {
      ok: false,
      reason: 'upstream_error',
      status: 502,
      message: err instanceof Error ? err.message : String(err),
    };
  }

  cache.set(key, { result, expiresAtMs: now + cacheTtlFor(result) });
  return result;
}

// ---------------------------------------------------------------------------
// Principle-conflict records (C3) — persisted governance verdicts served by
// `GET /principle-conflicts` (requirements_management routes are unprefixed —
// no `/api`). Tenant resolves from the ambient X-Tenant-Id the http client
// injects (the caller pins the lens tenant via withTenantFrame). Returns null
// when unconfigured or the route 404s (older upstream) so the block degrades to
// available:false rather than 500.
// ---------------------------------------------------------------------------

export type PrincipleConflict = PrincipleConflictOut;
type PrincipleConflictQuery = ListPrincipleConflictsParams;

/** True when the requirements_management base URL is configured. */
function requirementsManagementConfigured(): boolean {
  return config.services.requirements.baseUrl.length > 0;
}

/**
 * List persisted principle-conflict records for the ambient tenant. Returns
 * null when the client is unconfigured or the route 404s; an empty array is a
 * real "no conflicts" answer.
 */
export async function getPrincipleConflicts(
  params: PrincipleConflictQuery = {},
): Promise<PrincipleConflict[] | null> {
  if (!requirementsManagementConfigured()) return null;
  try {
    return await http().json<PrincipleConflict[]>(getListPrincipleConflictsUrl(params), { method: 'GET' });
  } catch (err) {
    if (isIntegrationError(err) && err.upstreamStatus === 404) return null;
    throw err;
  }
}
