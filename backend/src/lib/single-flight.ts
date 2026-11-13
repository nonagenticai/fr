// src/lib/single-flight.ts
//
// In-process request coalescing ("single-flight"): concurrent callers that miss
// a cache for the SAME key collapse to ONE upstream call instead of N.
//
// Why this exists: the per-tenant license gates (`require-fr-license.ts`,
// `require-kag-license.ts`) cache an entitlement in Redis with a TTL. Without
// coalescing, every TTL expiry is a thundering herd — each concurrent request
// for that tenant issues its own licenses-service call — so the upstream load a
// TTL implies is proportional to CONCURRENCY. With coalescing it is capped at
// one call per key per TTL regardless of concurrency, which is what makes
// shortening the TTL a safe, load-independent change.
//
// Scope is deliberately in-PROCESS (a plain Map), not distributed: fr-backend
// and kag-backend both run `replicas: 1`, so per-process dedupe IS per-cluster
// dedupe here. A multi-replica rollout would degrade this to "one call per
// replica per TTL" — still bounded, never a herd.

export interface SingleFlight<T> {
  /**
   * Run `fn` for `key`, or join the call already in flight for that key.
   * Every joiner observes the same settlement (value OR rejection). The entry
   * is dropped when the call settles, so the NEXT call after settlement starts
   * a fresh flight — a failure is never cached and a value is never pinned.
   */
  run(key: string, fn: () => Promise<T>): Promise<T>;
  /** Drop any in-flight entry for `key` without disturbing its joiners. */
  forget(key: string): void;
  /** In-flight key count. Observability + tests. */
  readonly size: number;
}

export function createSingleFlight<T>(): SingleFlight<T> {
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key: string, fn: () => Promise<T>): Promise<T> {
      const existing = inFlight.get(key);
      if (existing !== undefined) return existing;

      // The async wrapper turns a SYNCHRONOUS throw from `fn` into a rejection,
      // so a bad `fn` can never leave a permanent entry in the map.
      const flight = (async () => fn())().finally(() => {
        // Only clear the entry if it is still OURS — `forget()` (invalidation)
        // may already have removed it and a newer flight taken the slot.
        if (inFlight.get(key) === flight) inFlight.delete(key);
      });

      // Set AFTER attaching `.finally`, but this is still race-free: `run` is
      // synchronous up to here and the finally callback can only fire on a
      // later microtask.
      inFlight.set(key, flight);
      return flight;
    },

    forget(key: string): void {
      inFlight.delete(key);
    },

    get size(): number {
      return inFlight.size;
    },
  };
}
