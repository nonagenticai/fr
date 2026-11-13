// src/lib/require-kag-license.ts
//
// Per-tenant kag PACKAGE license gate. fr-backend's image serves BOTH products
// (fr.nonagentic.ai and kag.nonagentic.ai), but which one a given POD serves is
// a DEPLOYMENT fact, derived once at boot from the gate flags
// (`lib/package-license-gate.ts servingAppKey`) — NOT selected per-request from
// a header. The old claim that the edge-injected `X-App-Key` picked the gate was
// the defect: only the PUBLIC VirtualServices overwrite that header, so on
// `fr-backend.example.com` any in-mesh caller could send `X-App-Key: kag`, land on
// this module's branch while `KAG_LICENSE_GATE_ENABLED` was off there, and skip
// the licence check entirely. `resolveAppKey` is now CONFIRM-ONLY: a client
// header may only agree with the served product, never change it. This module
// runs when the kag-frontend Deployment is the one serving the request.
//
// Model (George, 2026-06-18): kag-frontend is licensed per-tenant, NOT per
// user — one active `kag` license per customer org grants every Keycloak user
// in that tenant. This is the SAME `kag` entitlement n8n-nodes-kag requires, so
// one entitlement covers both the n8n node and the kag-frontend web app.
// Mirrors the fr package gate (`require-fr-license.ts`).
//
// This gate looks the tenant up via the licenses service
// (`GET /licenses/active?tenant_id=&app_key=kag`, see
// `services/licenses.ts hasActiveLicense`) and denies access when absent.
// No-op when the flag is off (`config.kagLicense.gateEnabled` — default OFF),
// `AUTH_BYPASS=true`, or the request carries no tenant.

import { config } from '../config';
import { ForbiddenError } from '../utils/errors';
import { licensesClient } from '../services/licenses';
import { redis } from '../services/redis';
import { createSingleFlight } from './single-flight';

const KAG_APP_KEY = 'kag';

// This module OWNS the kag cache key shape — see the twin note in
// `require-fr-license.ts`. The two caches live in SEPARATE Redis instances
// (distinct REDIS_URL / SOPS blob), so they are invalidated independently.
const cacheKeyFor = (tenantId: string) => `kag-license:tenant:${tenantId}`;

// Coalesces concurrent cache misses for one tenant into a single upstream call.
const inFlight = createSingleFlight<boolean>();

// Bumped by every invalidation; suppresses a stale write-back from a check that
// started before it. See `require-fr-license.ts` for the full rationale.
let cacheEpoch = 0;

/**
 * Whether `tenantId` holds an active `kag` license, with a short-lived Redis
 * cache. The POSITIVE TTL (60s) is the revocation lag and is deliberately
 * SHORTER than the negative one (120s) — see `config.ts frLicense` for why the
 * two are not symmetric. Cache faults are non-fatal (fall through to a
 * live check). A live licenses-service error PROPAGATES — `requireKagLicense`
 * turns it into a fail-closed denial; `/api/license/status` swallows it.
 *
 * Concurrent MISSES for one tenant are single-flighted: they all join one
 * upstream call rather than each issuing their own, so added licenses-service
 * load is capped at one call per tenant per TTL regardless of concurrency.
 */
export async function tenantHasKagLicense(tenantId: string): Promise<boolean> {
  const key = cacheKeyFor(tenantId);

  const cached = await redis.get<boolean>(key).catch(() => null);
  if (cached !== null) return cached;

  return inFlight.run(key, async () => {
    const epochAtStart = cacheEpoch;

    const has = await licensesClient.hasActiveLicense(tenantId, KAG_APP_KEY);

    const ttl = has
      ? config.kagLicense.cacheTtlSeconds
      : config.kagLicense.negativeCacheTtlSeconds;
    // Skip the write if an invalidation landed while we were upstream.
    if (cacheEpoch === epochAtStart) {
      await redis.set(key, has, ttl).catch(() => {
        /* cache write best-effort */
      });
    }

    return has;
  });
}

/**
 * Drop the cached kag entitlement for `tenantId` so the very next request
 * re-checks the licenses service, instead of waiting out
 * `config.kagLicense.cacheTtlSeconds`. Also drops any in-flight lookup and
 * bumps the epoch so a mid-flight check cannot write back a pre-revocation
 * answer. Errors PROPAGATE — a swallowed failure would look like a successful
 * revocation while access silently continued.
 *
 * kag runs its OWN Redis instance; this does not touch the fr cache.
 */
export async function invalidateKagLicenseCache(tenantId: string): Promise<void> {
  const key = cacheKeyFor(tenantId);
  cacheEpoch += 1;
  inFlight.forget(key);
  await redis.del(key);
}

/**
 * Throw `ForbiddenError('kag_license_required')` unless `tenantId` holds an
 * active `kag` license. No-ops when the gate is disabled, AUTH_BYPASS is on, or
 * `tenantId` is falsy. Fail-closed: a licenses-service error denies access.
 */
export async function requireKagLicense(
  tenantId: string | null | undefined,
): Promise<void> {
  if (!config.kagLicense.gateEnabled) return;
  if (process.env.AUTH_BYPASS === 'true') return;
  if (!tenantId) return;

  let has: boolean;
  try {
    has = await tenantHasKagLicense(tenantId);
  } catch (err) {
    console.error(
      `[kag-license] entitlement check failed for tenant ${tenantId}; failing closed`,
      err,
    );
    throw new ForbiddenError('kag_license_required');
  }
  if (!has) throw new ForbiddenError('kag_license_required');
}
