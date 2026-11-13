// src/lib/readiness.ts
//
// WHICH dependency failures take this pod out of rotation — the policy behind
// `GET /health`, extracted so it can be argued in one place and tested without
// importing `server.ts` (which starts a listener on import).
//
// ── THE ARGUMENT (fr#947, second occurrence 2026-09-06) ──────────────────
//
// Postgres IS fatal. It is the system of record. With it unreachable this pod
// cannot serve a correct answer to almost any route and there is nothing to
// degrade to, so 503 — "do not send me traffic" — is honest.
//
// Redis is NOT fatal, and treating it as fatal has now cost two outages.
// `services/redis.ts` is a CACHE: `get`/`set` with a TTL, `del`, `exists`, plus
// the download-token store. Every cached read has a Postgres path behind it.
// The one surface that genuinely REQUIRES Redis for correctness —
// `services/download-tokens.ts`, single-use `GETDEL` — must fail PER REQUEST,
// which is where a per-surface dependency failure belongs.
//
// MEASURED COST OF THE OLD POLICY. On 2026-09-06 fr and kag-frontend/kag (the
// same image digest, one binary deployed twice) served ZERO endpoints for
// 2h45m — 01:59:58Z to 04:44Z — while answering
// `{"status":"degraded","db":"ok","redis":"error"}`. Postgres was fine and had
// recovered by itself at 02:14. The application was fine. A CACHE emptied the
// Service's endpoint list for both services and only a manual restart cleared
// it. The 2026-08-14 occurrence was the same policy killing the pod through
// the liveness probe; `server.ts` split liveness off then. This is the same
// argument one rung further out: a dependency outage must not KILL the pod,
// and a cache outage must not DESCHEDULE it either.
//
// WHY IT IS THE WRONG SHAPE, not just an unlucky trade. Readiness expresses a
// PER-POD condition — "this replica cannot serve right now" — and the
// scheduler's response is to route around it, which only works if some other
// replica can. A dependency every replica shares turns readiness into a
// CORRELATED, fleet-wide kill switch: there is nothing to route to, so a
// partial degradation becomes a total outage of a service that was still able
// to serve most of its traffic.
//
// THE SIGNAL IS NOT DROPPED, which is the other half of the trade. `status`
// still reads `degraded`, `redis` still reads `error`, `degraded[]` names the
// failing dependency, and `[health] redis error` still warns on every probe.
// Alerting belongs on those and on `/api/metrics/prom` — on something that
// pages a human — not on removing a working pod from rotation and hoping
// somebody notices the 503.
//
// ⚠️ The counter-argument, stated so it can be re-opened rather than
// rediscovered: a cache miss storm against Postgres is a real risk when Redis
// dies, and shedding load via readiness is one way to protect the database.
// It is rejected here because it protects the database by deleting the
// service, the protection is untargeted (it sheds 100% of traffic, including
// the routes that never touch Redis), and fr's cache TTLs are 300s of
// convenience rather than a load-bearing shield. If Postgres is the thing at
// risk, the lever is a Postgres-side limit, not a health probe.

export type DependencyStatus = 'ok' | 'error';

export interface ReadinessVerdict {
  /** false -> 503 and out of rotation. */
  ready: boolean;
  /** Body `status` field: 'ok' | 'degraded' | 'unhealthy'. */
  status: 'ok' | 'degraded' | 'unhealthy';
  /** Names every dependency that is down but non-fatal. */
  degraded: string[];
}

/**
 * FATAL dependencies. Adding a name here takes every replica out of rotation
 * when that dependency fails — read the header before you do.
 */
export const FATAL_DEPENDENCIES = ['db'] as const;

export function readinessVerdict(deps: Record<string, DependencyStatus>): ReadinessVerdict {
  const fatal = (FATAL_DEPENDENCIES as readonly string[]).filter((name) => deps[name] === 'error');
  const degraded = Object.keys(deps)
    .filter((name) => deps[name] === 'error' && !(FATAL_DEPENDENCIES as readonly string[]).includes(name))
    .sort();

  if (fatal.length > 0) return { ready: false, status: 'unhealthy', degraded };
  return { ready: true, status: degraded.length > 0 ? 'degraded' : 'ok', degraded };
}
