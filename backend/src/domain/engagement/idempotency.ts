/**
 * E-4: Idempotency store.
 *
 * Durable cache for agent-callable action invocations. A retry with the same
 * key inside the TTL returns the cached value without re-running `fn`.
 *
 * Design:
 *   - Backed by the `action_idempotency` table (Postgres), not Redis. Channel
 *     fan-in windows can be minutes; the critical path is already Postgres.
 *   - Concurrent callers with the same key SERIALIZE: exactly one runs `fn`,
 *     the rest wait and receive the cached result. Achieved via
 *     `pg_advisory_xact_lock(hashtext(key))` held for the transaction.
 *   - `fn` that throws is NOT cached — a transient failure should not
 *     permanently poison the cache key.
 *
 * Signature frozen; used by the registry (E-2) and by direct callers
 * (channel webhooks wanting to dedupe by provider message id, etc.).
 */

import { queryClient } from '../../db/client';

export interface IdempotentResult<T> {
  cached: boolean;
  value: T;
}

export async function runIdempotent<T>(
  userId: string,
  key: string,
  ttlSeconds: number,
  fn: () => Promise<T>,
): Promise<IdempotentResult<T>> {
  if (!userId) throw new Error('runIdempotent: userId must be non-empty');
  if (!key) throw new Error('runIdempotent: key must be non-empty');
  if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error('runIdempotent: ttlSeconds must be a positive finite number');
  }

  // Fast path: no locking, no transaction — just check for a fresh entry.
  // Correctness isn't hurt because if two callers both miss here, the slow
  // path's advisory lock + re-check guarantees exactly one runs `fn`.
  //
  // Cache is scoped by (user_id, key) — see migration 019. Two users with
  // the same client_idempotency_key MUST get distinct cache entries.
  const fast = await queryClient<{ value_json: unknown }[]>`
    SELECT value_json
      FROM action_idempotency
     WHERE user_id = ${userId}
       AND key = ${key}
       AND expires_at > NOW()
     LIMIT 1
  `;
  if (fast.length > 0) {
    return { cached: true, value: fast[0]!.value_json as T };
  }

  // Slow path: acquire advisory lock, re-check, run, write.
  //
  // pg_advisory_xact_lock releases automatically on COMMIT/ROLLBACK. Using
  // hashtext(userId || ':' || key) keeps the lock keyspace bounded to int4
  // and scoped to the (user, key) tuple; collisions cause rare spurious
  // serialization, which is benign.
  //
  // The transaction holds a DB connection for the full duration of `fn`.
  // That is acceptable for Wave-1; if future actions have long-running
  // handlers (minutes), we can revisit by running `fn` outside the lock
  // with a two-phase reservation row. Not optimizing prematurely.
  const lockKey = `${userId}:${key}`;
  const value = await queryClient.begin(async (tx) => {
    await tx`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

    const recheck = await tx<{ value_json: unknown }[]>`
      SELECT value_json
        FROM action_idempotency
       WHERE user_id = ${userId}
         AND key = ${key}
         AND expires_at > NOW()
       LIMIT 1
    `;
    if (recheck.length > 0) {
      return { cached: true as const, value: recheck[0]!.value_json as T };
    }

    const result = await fn();

    // ON CONFLICT handles the rare case where another process inserted for
    // the same (user_id, key) AFTER our recheck but before our INSERT —
    // only possible if two sessions somehow both got the advisory lock
    // (shouldn't happen, but belt-and-suspenders with the hashtext
    // collision consideration). expires_at is computed in SQL via
    // make_interval so postgres.js doesn't have to infer a param type for
    // a JS Date (which trips on timestamptz).
    await tx`
      INSERT INTO action_idempotency (user_id, key, value_json, expires_at)
      VALUES (
        ${userId},
        ${key},
        ${JSON.stringify(result)}::jsonb,
        NOW() + make_interval(secs => ${ttlSeconds})
      )
      ON CONFLICT (user_id, key) DO UPDATE
         SET value_json = EXCLUDED.value_json,
             expires_at = EXCLUDED.expires_at,
             created_at = NOW()
    `;

    return { cached: false as const, value: result };
  });

  return value;
}

/** Rows deleted per sweep statement. */
export const IDEMPOTENCY_SWEEP_BATCH_SIZE = 1000;

/**
 * Delete at most IDEMPOTENCY_SWEEP_BATCH_SIZE (`limit`) expired rows. Returns how many were deleted.
 *
 * Called by the sweep worker (workers/idempotency-sweep.ts), which is the only
 * production caller — until 2026-07-30 this function had ZERO callers and the
 * table simply grew forever (6209 rows on prod, none ever reaped).
 *
 * `FOR UPDATE SKIP LOCKED` on the selection subquery: a concurrent
 * `claimIdempotencyKey` takeover row-locks the row it is stealing, and we must
 * not (a) block behind it nor (b) delete a row it has just extended into the
 * future. Skipping it leaves it for the next sweep, which is correct — the row
 * is no longer expired.
 *
 * Batched because an unbounded `DELETE ... WHERE expires_at <= NOW()` on a
 * table that has never been reaped is an unbounded write transaction.
 *
 * ⚠️ The selection MUST be a `MATERIALIZED` CTE, not an inline
 * `DELETE ... USING (SELECT ... LIMIT n) d` subquery. The inline form was the
 * first shape written here and it intermittently deleted MORE than `limit`
 * (observed: 5 deleted for limit=2 on a freshly-created, never-ANALYZEd table
 * — the same shape CI creates from scratch every run). The planner is free to
 * put the sub-select on the re-scannable side of the join, and each re-scan
 * re-applies the LIMIT to whatever is left, so the effective cap is
 * `limit × rescans`. `AS MATERIALIZED` is an explicit optimisation fence:
 * the CTE is evaluated exactly once, so `limit` means what it says.
 * (Safety was never at risk — `expires_at <= NOW()` is re-evaluated on every
 * re-scan too, so an unexpired row could not be deleted either way. Only the
 * pacing was wrong.)
 */
export async function sweepExpiredIdempotency(): Promise<number> {
  const rows = await queryClient`
    WITH doomed AS MATERIALIZED (
      SELECT user_id, key
        FROM action_idempotency
       WHERE expires_at <= NOW()
       ORDER BY expires_at
       LIMIT ${IDEMPOTENCY_SWEEP_BATCH_SIZE}
         FOR UPDATE SKIP LOCKED
    )
    DELETE FROM action_idempotency t
     USING doomed d
     WHERE t.user_id = d.user_id
       AND t.key = d.key
  `;
  return (rows as unknown as { count?: number }).count ?? 0;
}
