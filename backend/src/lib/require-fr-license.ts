// src/lib/require-fr-license.ts
//
// Per-tenant fr PACKAGE license gate, enforced at fr-backend.
//
// Model (George, 2026-06-18): fr/kanban/n8n are sold as one package. Customers'
// users only ever touch fr; fr drives kanban/n8n/kag/requirements on their
// behalf over the trusted network, so those need NO per-user license. The only
// entitlement that must exist and be checked is an `fr` license, granted
// per-tenant (whole customer org).
//
// This gate looks the tenant up via the licenses service
// (`GET /licenses/active?tenant_id=&app_key=fr`, see
// `services/licenses.ts hasActiveLicense`) and denies access when absent.
//
// Enforcement is wired centrally in `server.ts` (one call before the route
// handler) so the whole package is gated and no handler can forget it. The
// gate is a no-op when:
//   - the feature flag is off (`config.frLicense.gateEnabled` — default OFF),
//   - `AUTH_BYPASS=true` (dev/test),
//   - the request carries no tenant (unauthenticated — the route's own
//     `validateAuth` returns 401; SA/machine callers have no user tenant).

import { config } from '../config';
import { ForbiddenError } from '../utils/errors';
import { licensesClient } from '../services/licenses';
import { redis } from '../services/redis';
import { createSingleFlight } from './single-flight';

// The gate's app_key — ONE literal, owned by `fr-app-key.ts` (side-effect free) and re-exported
// here, so the paths that license a tenant for fr (signup approve, provision-user) name the same key.
import { FR_APP_KEY } from './fr-app-key';
export { FR_APP_KEY };

// This module OWNS the fr cache key shape. Nothing outside it may rebuild the
// literal — invalidation goes through `invalidateFrLicenseCache` below, so the
// key never drifts between a writer and a deleter.
const cacheKeyFor = (tenantId: string) => `fr-license:tenant:${tenantId}`;

// Coalesces concurrent cache misses for one tenant into a single upstream call.
// See `single-flight.ts` for why the TTL choice depends on this existing.
const inFlight = createSingleFlight<boolean>();

// Bumped by every invalidation. A live check that STARTED before an
// invalidation must not write its (now known-stale) answer back into the cache
// afterwards, which would resurrect exactly the staleness the invalidation was
// issued to clear. The counter is global rather than per-key so it cannot leak;
// the only cost of a cross-tenant false positive is one skipped cache write.
let cacheEpoch = 0;

/**
 * Whether `tenantId` holds an active `fr` license, with a short-lived Redis
 * cache. The POSITIVE TTL (60s) is the revocation lag and is deliberately
 * SHORTER than the negative one (120s) — see `config.ts frLicense` for why the
 * two are not symmetric. Cache faults are non-fatal (fall through to a
 * live check). A live licenses-service error PROPAGATES — `requireFrLicense`
 * turns it into a fail-closed denial; `/api/license/status` swallows it.
 *
 * Concurrent MISSES for one tenant are single-flighted: they all join one
 * upstream call rather than each issuing their own. That caps added
 * licenses-service load at one call per tenant per TTL no matter how
 * concurrent the traffic is, which is what makes the short TTL affordable.
 */
export async function tenantHasFrLicense(tenantId: string): Promise<boolean> {
  const key = cacheKeyFor(tenantId);

  const cached = await redis.get<boolean>(key).catch(() => null);
  if (cached !== null) return cached;

  return inFlight.run(key, async () => {
    const epochAtStart = cacheEpoch;

    const has = await licensesClient.hasActiveLicense(tenantId, FR_APP_KEY);

    const ttl = has
      ? config.frLicense.cacheTtlSeconds
      : config.frLicense.negativeCacheTtlSeconds;
    // Skip the write if an invalidation landed while we were upstream — see
    // `cacheEpoch`. The answer is still returned to THIS caller; only the
    // caching of it is dropped, so the next caller re-checks live.
    if (cacheEpoch === epochAtStart) {
      await redis.set(key, has, ttl).catch(() => {
        /* cache write best-effort */
      });
    }

    return has;
  });
}

/**
 * Drop the cached fr entitlement for `tenantId` so the very next request
 * re-checks the licenses service. This is the seam a licence revocation should
 * call to make the change effective immediately instead of waiting out
 * `config.frLicense.cacheTtlSeconds`.
 *
 * Also drops any in-flight lookup and bumps the epoch, so a check that is
 * mid-upstream-call cannot write its pre-revocation answer back afterwards.
 *
 * Errors PROPAGATE: a swallowed failure here would look like a successful
 * revocation while access silently continued. NB fr and kag use SEPARATE Redis
 * instances — this clears the fr cache only (see `invalidateKagLicenseCache`).
 */
export async function invalidateFrLicenseCache(tenantId: string): Promise<void> {
  const key = cacheKeyFor(tenantId);
  cacheEpoch += 1;
  inFlight.forget(key);
  await redis.del(key);
}

/**
 * Throw `ForbiddenError('fr_license_required')` unless `tenantId` holds an
 * active `fr` license. No-ops when the gate is disabled, AUTH_BYPASS is on, or
 * `tenantId` is falsy. Fail-closed: a licenses-service error denies access.
 */
export async function requireFrLicense(
  tenantId: string | null | undefined,
): Promise<void> {
  if (!config.frLicense.gateEnabled) return;
  if (process.env.AUTH_BYPASS === 'true') return;
  if (!tenantId) return;

  let has: boolean;
  try {
    has = await tenantHasFrLicense(tenantId);
  } catch (err) {
    console.error(
      `[fr-license] entitlement check failed for tenant ${tenantId}; failing closed`,
      err,
    );
    throw new ForbiddenError('fr_license_required');
  }
  if (!has) throw new ForbiddenError('fr_license_required');
}
