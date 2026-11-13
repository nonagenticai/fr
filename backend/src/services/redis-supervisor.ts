// src/services/redis-supervisor.ts
//
// The piece `redis-connection-options.ts` does not cover: what to do when a
// Redis client stops being recoverable *by itself*.
//
// ── THE RECURRENCE (fr#947 again, 2026-09-06) ────────────────────────────
// fr AND kag-frontend/kag — the SAME image digest, one binary deployed twice —
// served zero endpoints for 2h45m (01:59:58Z -> 04:44Z). Only a manual
// `rollout restart` cleared it. Measured, not reasoned:
//
//   01:58:58Z  worker4 k3s node-lease starts failing `Client.Timeout exceeded`
//   01:59:28Z  every watch dies with `http2: client connection lost`
//              — a control-plane blip resetting long-lived TCP
//   01:59:17Z  both pods: `Redis disconnected — reconnecting (see fr#947)`
//              then `ERR_REDIS_CONNECTION_TIMEOUT: Connection timeout reached
//              after 10000ms`
//   02:14Z     Postgres recovers ON ITS OWN (the pg pool re-dials; walsender
//              re-established). The app was never broken.
//   01:59+     Redis does not. Both pods log, every ~10s for 2.5h:
//              `ERR_REDIS_CONNECTION_CLOSED: Connection has failed`
//              (that cadence is the readiness probe, not a retry loop)
//   live body from both wedged pods:
//              {"status":"degraded","db":"ok","redis":"error"}
//
// DECISIVE MEASUREMENT: a fresh TCP connect + AUTH + PING issued from INSIDE
// each wedged container reached `fr-redis.fr.svc:6379` in 8ms and
// `kag-redis.kag-frontend.svc:6379` in 4ms, both `+PONG`. ztunnel/istio-cni at
// 39h with 0 restarts. So: mesh healthy, Redis healthy, socket available —
// and the client in the process still could not use it.
//
// ── WHY `maxRetries` COULD NOT REACH THIS ────────────────────────────────
// The running image ALREADY carried `maxRetries: 2_147_483_647` (commit
// 5d7b9ec2, fr#955). That fix was validated against a **Redis outage** — the
// server going away in Docker and coming back — and for that shape it is
// correct and sufficient. This event is a different shape: the **transport**
// was reset while the server stayed up and answering.
//
// `maxRetries` is a BUDGET, and a budget only binds a process that is still
// spending. It answers "how many times may this client redial?" It cannot
// answer "this client has stopped redialling" — and the observable evidence
// says that is where both clients ended up: an in-process state, above the
// socket, from which no number of remaining retries is ever drawn. Raising a
// ceiling cannot restart a loop that is no longer running. That is why #955
// held for a server outage and did not hold here, and why the lever has to be
// OUTSIDE the client instance.
//
// ── THE LEVER, AND THE ONE THE FILE NEXT DOOR REJECTS ────────────────────
// `redis-connection-options.ts` explicitly rejects "drop the cached client on
// `onclose`" as a client LEAK, and it is right: `onclose` fires while Bun is
// still retrying, so discarding on it builds a second client racing the first,
// and another per disconnect.
//
// This supervisor is not that. It is gated on TIME, not on the event:
//
//   * `onclose` only records WHEN the disconnect began. It discards nothing.
//   * A rebuild happens only when a command has actually FAILED *and* the
//     client has been continuously disconnected for longer than
//     `graceMs` (default 60s) — i.e. long past the point where the client's
//     own unbounded retries would have succeeded if they were still running.
//   * The old client is `close()`d, so it is disposed rather than leaked.
//   * `lastRebuildAt` floors the rate at one rebuild per grace window, so a
//     genuinely-down Redis produces a slow rebuild trickle, not a storm.
//
// A blip that Bun heals inside the window therefore rebuilds NOTHING — the
// `onclose`-drop leak is exactly what the grace window buys immunity from.
//
// Deliberately NOT dependent on any Bun-internal state flag. The detection is
// behavioural — "a command failed AND we have been down too long" — because
// the failure being fixed is precisely that the client's own notion of its
// state stopped tracking reality.

/** The subset of `Bun.RedisClient` a supervised client must provide. */
interface SupervisableRedisClient {
  onconnect?: unknown;
  onclose?: unknown;
  close(): void;
}

/**
 * How long a client may stay continuously disconnected before a failing
 * command is read as terminal rather than as in-flight recovery.
 *
 * 60s, because Bun's reconnect backoff plus `connectionTimeout: 10_000` puts
 * an honest recovery well inside it, while the production wedge sat in this
 * state for 9,900s. Env-overridable so a test can collapse it; there is no
 * value in tuning this in production.
 */
export const REDIS_TERMINAL_GRACE_MS = 60_000;

/**
 * Ceiling for a single Redis command. Generous — normal commands are sub-ms;
 * this exists only so a HELD command cannot park the supervisor forever.
 */
const REDIS_OP_TIMEOUT_MS = 10_000;

/**
 * Hard floor on how often a client may be rebuilt, independent of `graceMs`.
 *
 * `isTerminal()`'s second clause is the rate floor, and it is expressed in
 * `graceMs` — so a zero window removes the floor along with the window. This
 * keeps the floor when the window is gone. It never blocks the FIRST rebuild
 * (`lastRebuildAt` starts at 0), so a collapsed window still heals instantly;
 * it only stops the Nth rebuild in the same instant.
 */
export const MIN_REBUILD_INTERVAL_MS = 50;

interface SupervisedRedisOptions<C extends SupervisableRedisClient> {
  /** Log prefix — `fr-redis`, `billing-redis`. */
  name: string;
  /** Builds a fresh client. Called once eagerly, then once per rebuild. */
  factory: () => C;
  onConnect?: () => void;
  onClose?: () => void;
}

/**
 * Owns ONE live Redis client and replaces it when — and only when — it has
 * demonstrably stopped recovering.
 *
 * Every call site goes through {@link run}, so the swap is invisible to
 * callers and no caller holds a reference that can go stale.
 */
/**
 * Grace window from the environment, or the default.
 *
 * ⚠️ `Number('')` and `Number('   ')` are **0**, and `Number.isFinite(0)` is
 * true — so a naive `isFinite(Number(env))` check reads an EMPTY env var as a
 * zero grace window. `REDIS_TERMINAL_GRACE_MS: ""` is an ordinary ConfigMap
 * shape, and a `graceMs` of 0 makes the rate floor in `isTerminal()`
 * (`t - lastRebuildAt >= graceMs`) always true, so EVERY failing command would
 * build a new client — exactly the storm `redis-connection-options.ts` rejects,
 * arrived at by an empty string.
 *
 * Two separate guards, because they answer different questions: this one stops
 * an ACCIDENTALLY empty variable from configuring a zero window, and
 * {@link MIN_REBUILD_INTERVAL_MS} stops any zero window — however it arrives —
 * from turning into a storm.
 */
export function graceFromEnv(raw: string | undefined): number {
  // Unset, empty, whitespace, non-numeric or negative all mean "not configured".
  // An explicit "0" is honoured — a test collapses the window that way — and is
  // safe because the rebuild RATE is floored separately, below.
  if (raw === undefined || raw.trim() === '') return REDIS_TERMINAL_GRACE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return REDIS_TERMINAL_GRACE_MS;
  return n;
}

export class SupervisedRedisClient<C extends SupervisableRedisClient = SupervisableRedisClient> {
  private client: C;
  private disconnectedSince: number | null = null;
  private lastRebuildAt = 0;
  private rebuildCount = 0;
  private rebuilding: Promise<void> | null = null;
  private readonly graceMs: number;
  private readonly opTimeoutMs: number;

  constructor(private readonly opts: SupervisedRedisOptions<C>) {
    this.graceMs = graceFromEnv(process.env.REDIS_TERMINAL_GRACE_MS);
    this.opTimeoutMs = REDIS_OP_TIMEOUT_MS;
    // Eager, like the construction it replaces: `redis-reconnect-options.test.ts`
    // pins that importing the module builds a client with the hardened options.
    this.client = this.build();
  }

  private build(): C {
    const client = this.opts.factory();
    // The handlers are OURS. A call site that wants to log wires `onConnect` /
    // `onClose` through the options, so a rebuild carries them to the new
    // client automatically — assigning them at the call site would silence
    // every client after the first.
    (client as { onconnect?: unknown }).onconnect = () => {
      this.disconnectedSince = null;
      this.opts.onConnect?.();
    };
    (client as { onclose?: unknown }).onclose = () => {
      // Records only. Never discards — see the header: dropping here is the
      // leak `redis-connection-options.ts` rejects.
      if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
      this.opts.onClose?.();
    };
    return client;
  }

  /**
   * True when the client has stopped recovering on its own.
   *
   * Both clauses matter. The first is the actual signal; the second floors the
   * rebuild rate at one per window so a Redis that is genuinely gone does not
   * spawn a client per failed command.
   */
  private isTerminal(): boolean {
    if (this.disconnectedSince === null) return false;
    const t = Date.now();
    return (
      t - this.disconnectedSince >= this.graceMs &&
      t - this.lastRebuildAt >= Math.max(this.graceMs, MIN_REBUILD_INTERVAL_MS)
    );
  }

  private async rebuild(): Promise<void> {
    // Single-flight: N concurrent failing commands must produce ONE new client.
    if (this.rebuilding) return this.rebuilding;
    this.rebuilding = (async () => {
      const previous = this.client;
      const next = this.build();
      this.client = next;
      this.disconnectedSince = null;
      this.lastRebuildAt = Date.now();
      this.rebuildCount += 1;
      console.warn(
        `[redis-supervisor] ${this.opts.name}: client stopped recovering after ` +
          `${this.graceMs}ms disconnected — replaced (rebuild #${this.rebuildCount}, see fr#947/#955)`,
      );
      // Disposed, not leaked.
      try {
        previous.close();
      } catch {
        /* a terminal client may throw on close; it is going away regardless */
      }
    })();
    try {
      await this.rebuilding;
    } finally {
      this.rebuilding = null;
    }
  }

  /**
   * Run one command against the live client.
   *
   * On failure: if the client is terminal, replace it and retry the command
   * ONCE against the fresh one. Otherwise rethrow untouched — a command that
   * fails for its own reasons (WRONGTYPE, a real Redis outage inside the grace
   * window) must still surface as a failure.
   */
  /**
   * Runs `op` with a ceiling. A command that never settles is the one failure
   * this supervisor cannot survive: `run()` would never return, so
   * `isTerminal()` would never be consulted and the client could never be
   * rebuilt — the wedge again, one level up. `Bun.RedisClient` defaults to
   * `enableOfflineQueue: true`, so a command issued while disconnected is HELD
   * rather than rejected, which is exactly that shape. A timeout is a failure
   * like any other and flows into the terminal check below.
   */
  private async bounded<T>(op: () => Promise<T> | T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(op),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`redis command exceeded ${this.opTimeoutMs}ms — treating as failed`)),
            this.opTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async run<T>(op: (client: C) => Promise<T> | T): Promise<T> {
    // Generation, captured BEFORE the attempt. Under concurrency the first
    // failing command rebuilds and every later one would then see a freshly
    // connected client and read `isTerminal()` as false — rethrowing a failure
    // that has already been repaired. The generation says "the client I failed
    // against is not the client that is live now", which is a retry, not a
    // second rebuild.
    const generation = this.rebuildCount;
    try {
      const out = await this.bounded(() => op(this.client));
      // A command that SUCCEEDS is the only honest evidence the client works.
      // Clearing here is what keeps the failure clock behavioural rather than
      // a one-way latch that a single old error could leave armed forever.
      this.disconnectedSince = null;
      return out;
    } catch (err) {
      // ⚠️ Detection must NOT depend solely on `onclose`. The header claims the
      // signal is behavioural, and until this line it was not: `disconnectedSince`
      // was set only by the close handler, so a client that wedges while it still
      // believes it is connected — commands failing, no close event — would never
      // be rebuilt. Starting the clock on a failed command makes the claim true.
      if (this.disconnectedSince === null) this.disconnectedSince = Date.now();
      if (this.rebuilding) {
        await this.rebuilding.catch(() => {
          /* the rebuild's own failure is logged there */
        });
        return await this.bounded(() => op(this.client));
      }
      if (this.rebuildCount > generation) {
        return await this.bounded(() => op(this.client));
      }
      if (!this.isTerminal()) throw err;
      await this.rebuild();
      return await this.bounded(() => op(this.client));
    }
  }

  close(): void {
    try {
      this.client.close();
    } catch {
      /* ignore */
    }
  }

  /** Observability + test assertions. */
  stats(): { rebuilds: number; disconnectedSince: number | null; graceMs: number } {
    return {
      rebuilds: this.rebuildCount,
      disconnectedSince: this.disconnectedSince,
      graceMs: this.graceMs,
    };
  }
}
