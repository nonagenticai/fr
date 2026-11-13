// src/workers/workflows-cache.ts
//
// Keeps the n8n workflow catalogue warm so that GET /api/workflows{,/tags}
// never has to crawl n8n on a user request.
//
// WHY THIS IS A WORKER AND NOT A TTL
// ----------------------------------
// n8n's Public API `/workflows` costs ~110 ms PER WORKFLOW (measured 2026-08-10
// from inside the fr pod: an unconditional `activeVersion` eager join plus a
// per-row tags fan-out, ~50 MB of body for the 255-workflow catalogue). A full
// crawl was 28 s typical / 82,635 ms worst MEASURED at the old 250-item page,
// and is ~35.7 s typical / up to ~166 s pessimistic at the 20-item page this
// change introduces (13 round trips; see integrations/n8n.ts WORKFLOW_PAGE_SIZE
// for the derivation and the extrapolation caveat). That is upstream and unfixable from
// fr. Under the old 30 s TTL the crawl ran ON the request that found the cache
// expired, so GET /api/workflows 504'd on 10 of 27 requests over 30 h of pod
// logs and the home page rendered `— Workflows active`.
//
// A longer TTL would not have fixed it — the request that loses the TTL race
// still pays. Only moving the crawl OFF the request path does, which is what
// this worker is. `routes/workflows.ts readCache()` is now synchronous and
// serves whatever this worker last produced.
//
// WHERE THE TIMER LIVES, AND WHY IT MATTERS
// -----------------------------------------
// Deliberately here rather than in `routes/workflows.ts`: a
// `setInterval` at route-module scope would arm on every test file that touches
// a workflows route and keep the bun-test event loop alive. The `.unref()`
// below is the second half of that defence.
//
// Shape is copied from `workers/idempotency-sweep.ts` on purpose — module-level
// `timer` + `tickInFlight`, idempotent start, immediate kick before the
// interval, plain `stop`. The one addition is `.unref()`, which that worker
// omits and `services/document-reconcile.ts` has.

import {
  primeWorkflowsCache,
  REFRESH_INTERVAL_MS,
} from '../routes/workflows';

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

let timer: ReturnType<typeof setInterval> | null = null;
let tickInFlight = false;

/**
 * Wall-clock bound on ONE prime, above which the tick gives up waiting.
 *
 * ⛔ This is not a performance knob — it is the only thing standing between a
 * hung n8n socket and a cache that is never populated again. Sizing:
 *
 *   * FLOOR — the crawl itself is ~35.7 s typical and up to ~166 s pessimistic
 *     at the 20-item page (see the header). A bound under that would abandon
 *     healthy slow crawls and leave the cache permanently cold, which is the
 *     very failure it exists to prevent.
 *   * CEILING — `REFRESH_INTERVAL_MS` is 10 min. The bound must be comfortably
 *     under it, or a stuck tick still blocks the next scheduled one.
 *
 * 5 min sits ~1.8× above the pessimistic crawl and half the interval.
 */
export const DEFAULT_TICK_TIMEOUT_MS = 5 * 60_000;

function tickTimeoutMs(): number {
  const raw = Number(process.env.WORKFLOWS_CACHE_TICK_TIMEOUT_MS ?? DEFAULT_TICK_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TICK_TIMEOUT_MS;
}

/**
 * Reject after `ms` if `p` has not settled.
 *
 * ⚠️ READ WHAT THIS DOES NOT DO. It does not cancel `p`; the underlying crawl
 * keeps whatever socket it is stuck on. What it bounds is how long THIS TICK
 * waits — which is the whole point, because the tick is what holds
 * `tickInFlight`. Abandoning a hung prime is strictly better than inheriting
 * it: the abandoned one may still land and populate the cache, while a tick
 * that waits forever guarantees nothing ever does.
 *
 * Local rather than shared: the backend has no promise-timeout utility (the
 * production idiom is `AbortSignal.timeout` on a `fetch`, which does not reach
 * a crawl helper behind a deps seam), and `withTimeout` in the tree exists only
 * as per-file copies in three frontend `.svelte` routes.
 */
function withDeadline<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const bell = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(
      () => reject(new Error(`${what} exceeded ${ms}ms`)),
      ms,
    );
    // Never keep the process (or `bun test`) alive on account of the bound.
    if (typeof handle.unref === 'function') handle.unref();
  });
  return Promise.race([p, bell]).finally(() => {
    if (handle !== undefined) clearTimeout(handle);
  }) as Promise<T>;
}

/**
 * Start the periodic catalogue refresh. Idempotent — calling twice is a no-op.
 * Interval override: `WORKFLOWS_CACHE_REFRESH_INTERVAL_MS`.
 */
export function startWorkflowsCacheWorker(): void {
  if (timer !== null) return;
  const intervalMs = Number(
    process.env.WORKFLOWS_CACHE_REFRESH_INTERVAL_MS ?? REFRESH_INTERVAL_MS,
  );
  // Floor, not just a NaN guard: the crawl is tens of seconds of n8n DB time,
  // so a sub-second interval would be a self-inflicted denial of service on the
  // upstream. `tickInFlight` would mask most of it, which is exactly why the
  // misconfiguration has to be refused loudly instead.
  if (!Number.isFinite(intervalMs) || intervalMs < 1000) {
    console.warn('[workflows-cache] interval invalid, refusing to start');
    return;
  }

  const runOnce = async () => {
    if (tickInFlight) return;
    tickInFlight = true;
    try {
      // `primeWorkflowsCache` never rejects and does its own logging (warn for
      // an upstream failure, error for one of OUR bugs). The catch is for a
      // dep that breaks that contract — a tick must never take the loop down.
      //
      // ⛔ "Never rejects" IS NOT "always settles", and this worker is where the
      // difference is fatal. n8n's `/workflows` crawl is 13 HTTP round trips;
      // if one of them hangs (this estate drops packets at a FORWARD rule with
      // no RST, so a socket really can go quiet forever) the await below never
      // returns, the `finally` never runs, `tickInFlight` stays true, and every
      // later tick takes the silent `if (tickInFlight) return`. This worker is
      // the SOLE populator of the catalogue cache (server.ts calls
      // `startWorkflowsCacheWorker` and `readCache()` is synchronous), so the
      // observable result is `GET /api/workflows` 504ing forever with not one
      // log line — the exact user-visible failure the worker was built to fix,
      // reintroduced one layer in.
      //
      // The guard cannot be released before the work here the way it is in
      // `approval-expiry`: the prime IS the guarded work, and two overlapping
      // 166-second n8n crawls are a self-inflicted DoS on the upstream (see the
      // interval floor above). So the bound goes on the WAIT instead — the tick
      // stops waiting, releases the guard, and the next tick is free to try.
      await withDeadline(primeWorkflowsCache(), tickTimeoutMs(), 'workflows-cache prime');
    } catch (err) {
      console.error('[workflows-cache] tick failed:', err);
    } finally {
      tickInFlight = false;
    }
  };

  // Kick off immediately: THIS is the boot prime. Until it lands the cache is
  // cold and every request 504s, so there is nothing to gain by waiting a full
  // interval first.
  void runOnce();
  timer = setInterval(() => {
    void runOnce();
  }, intervalMs);
  // Don't keep the event loop alive on shutdown (and don't hang `bun test`).
  if (typeof timer.unref === 'function') timer.unref();
  console.log(`[workflows-cache] scheduler started, interval=${intervalMs}ms`);
}

export function stopWorkflowsCacheWorker(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
