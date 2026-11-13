// src/services/redis-connection-options.ts
//
// ONE definition of how fr's Redis clients survive losing their transport,
// shared by every client rather than copied per call site — fr has two
// (`services/redis.ts` -> fr-redis, `services/metering-emit.ts` ->
// billing-redis) and the incident below took out BOTH in the same second.
//
// ── THE INCIDENT (fr#947, 2026-09-04) ────────────────────────────────────
// fr served 503 for ~1h45m (13:00:54Z -> 14:46Z) and only a manual
// `rollout restart` cleared it. An Istio ambient `ztunnel` pod was recreated
// under the running fr pod; 39s later both Redis clients logged disconnect in
// the same second, then `ERR_REDIS_CONNECTION_CLOSED` forever. A live TCP
// connect from INSIDE the wedged container succeeded at 13:43:50Z, and the
// matching ztunnel access log showed `connection complete` — so the mesh was
// healthy and the defect was above the socket.
//
// ⚠️ The issue's stated cause — "the client is constructed once and never
// re-established" — is NOT what is wrong. `Bun.RedisClient` DOES auto-reconnect
// (`autoReconnect` defaults to true). What it does not do is keep trying:
// `maxRetries` defaults to **10**, and a ztunnel roll outlasts that budget.
// Once exhausted the client is dead for the life of the process.
//
// ── MEASURED, not reasoned (local repro, redis in docker) ────────────────
// Identical 45s outage, identical code, only these options differ:
//
//   defaults   connects=1  ping ok=13  err=107  finalConnected=false
//              lastErr=RedisError [ERR_REDIS_CONNECTION_CLOSED]
//   hardened   connects=2  ping ok=120 err=0    finalConnected=true
//
// The default run never reconnected even though redis was answering PONG
// again — the production shape exactly, down to the error string. The
// hardened run reconnected at t=59.3s and lost ZERO commands, because
// `enableOfflineQueue` (default true) held them across the gap.
export const REDIS_MAX_RETRIES = 2_147_483_647;

/**
 * Options for every `new Bun.RedisClient(...)` in fr.
 *
 * `maxRetries` is effectively unbounded on purpose. The failure being fixed is
 * "gave up permanently", and for a cache/stream client that is strictly worse
 * than retrying: a client that keeps trying costs a backed-off reconnect loop,
 * while one that stops costs a 503 until a human notices. `GET /health` already
 * reports the outage correctly either way (it awaits `redis.ping()`), so an
 * unreachable Redis stays visible — it just stops being PERMANENT.
 *
 * ⚠️ CORRECTED 2026-09-06 — "one lever is the whole fix" was WRONG, and fr paid
 * for it twice. These exact options were in the RUNNING IMAGE when the wedge
 * recurred: fr and kag served no endpoints again until a manual restart. #978
 * added `redis-supervisor.ts` for that. `maxRetries` is still correct and stays
 * — it is simply not SUFFICIENT.
 *
 * Why the original repro missed it: it bounced the SERVER. A server bounce
 * hands the client a clean FIN, which Bun reconnects from perfectly —
 * re-measured against a real socket, that arm still recovers. Production lost
 * the TRANSPORT instead, so the reconnect ATTEMPT timed out
 * (`ERR_REDIS_CONNECTION_TIMEOUT`) and the client then stopped forever; an
 * UNSUPERVISED client stays dead even after the transport comes back.
 *
 * The paragraph that stood here also rejected "drop the cached client on close"
 * as a client LEAK, on the grounds that "onclose fires while Bun is still
 * retrying". Measured in the wedged pod, that was not true of the recurrence:
 * over 3h it logged `Redis disconnected` ONCE, `Redis connected` zero times,
 * and ztunnel recorded ZERO connection attempts to the redis pod IP. Bun was
 * not still retrying. A brand-new client in that same process PINGed in 4 ms.
 *
 * The leak concern was real, though, and is what `redis-supervisor.ts` guards:
 * it replaces a client only after a grace window has proven it terminal, and
 * single-flights the rebuild.
 */
export const REDIS_CONNECTION_OPTIONS = {
  maxRetries: REDIS_MAX_RETRIES,
  connectionTimeout: 10_000,
} as const;
