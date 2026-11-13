// src/domain/engagement/dedup-claim.ts
//
// Single-shot "claim this key" primitive over the `action_idempotency` table.
//
// Distinct from `runIdempotent` in ./idempotency.ts: that one CACHES a value
// and replays it to later callers; this one only answers "am I the first to
// see this record?" and is used by the connector intake paths (cron tick +
// inbound webhook) to guarantee exactly-once dispatch of a source record.
//
// ---------------------------------------------------------------------------
// Why the `expires_at <= NOW()` takeover predicate exists
// ---------------------------------------------------------------------------
// The claim is documented as a 7-day TTL (see DEDUP_TTL_SECS). Until 2026-07-30
// it was written with a bare `ON CONFLICT (user_id, key) DO NOTHING`, which has
// no notion of expiry: an already-EXPIRED row still won the conflict, so the
// claim returned false forever and the source record was suppressed for good.
// The TTL was fiction — measured on prod (worker4, db `fr`) as 6209 rows, 0 of
// them unexpired, none ever reaped, oldest from 2026-04-27.
//
// The fix is a conditional upsert, NOT a read-then-write:
//
//   INSERT ... ON CONFLICT (user_id, key) DO UPDATE
//      SET ... WHERE action_idempotency.expires_at <= NOW()
//
// Race semantics (this is the property the whole table exists for):
//   - Postgres takes a row lock on the conflicting row before evaluating the
//     DO UPDATE ... WHERE. A second session racing an expiring row BLOCKS on
//     that lock, and when it wakes it re-evaluates the predicate against the
//     WINNER'S COMMITTED ROW VERSION (the ON CONFLICT arbiter re-check /
//     EvalPlanQual path), where `expires_at` is already NOW() + TTL — in the
//     future. Its WHERE is therefore false, it updates nothing, RETURNING
//     yields zero rows, and it correctly reports "already claimed".
//   - Everything happens inside ONE statement, so there is no TOCTOU window
//     between "is it expired?" and "take it".
//   - Consequence: exactly one caller wins, whether the row is absent,
//     unexpired (nobody wins), or expiring under contention (one winner).
//
// A `WHERE`-less `DO UPDATE` would be WRONG here — it would let a second
// caller steal a live, unexpired claim and double-dispatch.
//
// The takeover predicate makes correctness independent of any reaper. The
// reaper (workers/idempotency-sweep.ts) exists only to bound table growth.

import { queryClient } from '../../db/client';

/**
 * Idempotency TTL for connector-intake claims: 7 days. A source record seen
 * within 7 days will not be re-dispatched; after 7 days the claim is stale and
 * a re-observation of the same record is treated as new.
 */
export const DEDUP_TTL_SECS = 7 * 24 * 60 * 60;

/**
 * Claim `key` for `tenantId`.
 *
 * Returns true if this caller took the claim (either the row was absent, or an
 * EXPIRED row was atomically taken over), false if a live unexpired claim
 * already exists or another concurrent caller won the race.
 *
 * `expires_at` is computed in SQL via `make_interval` so postgres.js does not
 * have to infer a param type for a JS Date (which trips on timestamptz).
 */
export async function claimIdempotencyKey(
  tenantId: string,
  key: string,
  ttlSeconds: number = DEDUP_TTL_SECS,
): Promise<boolean> {
  const rows = await queryClient<{ claimed: number }[]>`
    INSERT INTO action_idempotency (user_id, key, value_json, expires_at)
    VALUES (
      ${tenantId},
      ${key},
      'true'::jsonb,
      NOW() + make_interval(secs => ${ttlSeconds})
    )
    ON CONFLICT (user_id, key) DO UPDATE
       SET value_json = EXCLUDED.value_json,
           expires_at = EXCLUDED.expires_at,
           created_at = NOW()
     WHERE action_idempotency.expires_at <= NOW()
    RETURNING 1 AS claimed
  `;
  return rows.length === 1;
}

/**
 * Drop a previously-claimed dedup record so the same source record can be
 * re-attempted on a later tick.
 *
 * MUST run on the module-level `queryClient`, NOT inside a caller's
 * transaction: the claim autocommits immediately and therefore survives a
 * rollback of the enclosing transaction, so the release has to be an equally
 * independent statement.
 */
export async function releaseIdempotencyKey(
  tenantId: string,
  key: string,
): Promise<void> {
  await queryClient`
    DELETE FROM action_idempotency
     WHERE user_id = ${tenantId}
       AND key = ${key}
  `;
}

/**
 * Release that never throws. Returns a suffix to append to the caller's error
 * message so a failed DELETE is surfaced without masking the original failure.
 */
export async function releaseIdempotencyKeyQuietly(
  tenantId: string,
  key: string,
): Promise<string> {
  try {
    await releaseIdempotencyKey(tenantId, key);
    return '';
  } catch {
    return '; idempotency key not released';
  }
}
