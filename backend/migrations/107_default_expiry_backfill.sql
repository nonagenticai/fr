-- 107_default_expiry_backfill.sql
--
-- ⛔ THIS MIGRATION REVERSES PART OF 105/106, KNOWINGLY. READ BEFORE RE-RUNNING OR REVERTING.
--
-- 105 made `expires_at` nullable and 106 restored 435 wrongly-expired approvals by setting it
-- to NULL, with a header that says: "Without this the reaper would re-expire every restored
-- row on its very next tick." src/lib/approval-deadline.ts argues at length, with measurements,
-- that a deadline on a card-BLOCKING approval is itself the defect (`grep -ci expir` = 0 across
-- all nine AA specification documents; BLOCKED *is* the wait state).
--
-- None of that has been retracted. It is OVERRIDDEN by an explicit operator decision, taken
-- twice with the consequences shown. Recording it here so the next reader sees a decision
-- rather than an accident.
--
-- MEASURED ON PRODUCTION IMMEDIATELY BEFORE WRITING THIS (2026-09-02):
--     794  pending approvals with expires_at IS NULL   <- the population this touches
--     791  of those carry a callback_path              <- reaper will fire that many
--                                                         sendN8nExpiryCallback invocations
--     297  of those were restored to NULL by 106       <- re-expired by this migration
--
-- ⚠️ THE 791 CALLBACKS ARE THE OPERATIONAL RISK, NOT THE UPDATE. They mature together, into an
-- n8n instance that is the subject of a 232 GB/day WAL incident. The reaper batches with
-- FOR UPDATE SKIP LOCKED, so they drain over several ticks rather than in one burst — verify
-- that is still true before the maturity date rather than assuming it.
--
-- ⚠️ NOT PROBED, DELIBERATELY, matching 105 and 106. `COLUMN_PROBES` in
-- src/db/migration-runner.ts stops at 104 and only covers SCHEMA migrations. A probe here
-- would be re-evaluated on EVERY boot, so a single future NULL-expiry pending row would
-- hard-error the backend at startup. A data backfill stamped-but-unrun on a fresh database
-- loses nothing: there is nothing to back-fill there.
--
-- IDEMPOTENT: the `?` guard means a re-run matches zero rows. The pre-image is stashed in
-- `metadata` (same shape as 106) because `approvals` has NO history table, NO audit trigger,
-- and `updated_at` has a default but no trigger — so this jsonb IS the only rollback path.
-- To reverse:
--   UPDATE approvals
--      SET expires_at = NULL
--    WHERE metadata ? 'default_expiry_backfill_107'
--      AND (metadata->'default_expiry_backfill_107'->>'previous_expires_at') IS NULL;

DO $$
DECLARE
  candidates integer;
  updated    integer;
BEGIN
  SELECT count(*) INTO candidates
    FROM approvals
   WHERE status = 'pending'
     AND expires_at IS NULL
     AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'default_expiry_backfill_107');

  -- ── THE DEADLINE IS SPREAD, NOT SHARED. Read this before collapsing it back to a
  -- single `now() + interval '7 days'`; that is what this migration said until an
  -- adversarial audit on 2026-09-02 traced where it ends.
  --
  -- A single now() stamps EVERY row with the SAME instant, so the whole population
  -- matures in one tick. Traced through the reaper that consumes it:
  --   approval-expiry.ts:135  BATCH_SIZE = 500
  --   approval-expiry.ts:127  DEFAULT_INTERVAL_MS = 900_000   (15 min)
  --   approval-expiry.ts:458  runOnce does NOT re-tick on more=true -- the second
  --                           batch waits a FULL 15 minutes
  --   approval-expiry.ts:318  callbacks are a SEQUENTIAL for-loop with await
  --   approval-expiry.ts:146  the whole phase has a 60s deadline
  --   n8n-callback.ts:207     per-send ceiling APPROVAL_EXPIRY_CALLBACK_TIMEOUT_MS = 2000
  --
  -- ⛔ AND THE PART THAT MAKES IT PERMANENT: rows that miss the 60s deadline go to
  -- `deferred` (approval-expiry.ts:325-327) AFTER the row is already status='expired'
  -- (:230). recordCallbacksDeferred (:360) only appends to error_message. expireBatch
  -- (:248) selects status='pending' ONLY. Verified 2026-09-02 across all 7 workers and
  -- every 'expired' reference in backend/src: there is NO sweep, NO nightly job and NO
  -- qualifying status that ever picks a deferred row back up. It is unreachable, not
  -- merely delayed -- an approval whose callback silently never fires.
  --
  -- ⚠️ HONEST ABOUT THE ARITHMETIC: 2000 is a TIMEOUT, not a measured latency. No p50
  -- exists in this repo (the "tens of milliseconds" at the worker header is prose, not
  -- a measurement). Healthy, ~800 rows would drain in ~40s and none of this would bite.
  -- The deadline bites exactly when n8n is DEGRADED -- which is the state this estate
  -- was in when the migration was written (232 GB/day WAL incident, see :21-24). So the
  -- spread is insurance against the bad day, not a fix for the good one.
  --
  -- 1 minute per row: ~800 rows spreads maturity over ~13h, giving the reaper ~15 rows
  -- per 15-min tick. That is far under BATCH_SIZE (500), and 15 x 2s = 30s stays under
  -- the 60s deadline even at the full per-send ceiling. No row is ever deferred, so the
  -- unreachable path above is never entered.
  --
  -- Ordering by (created_at, id) is deliberate: the OLDEST approvals -- the ones that
  -- have waited longest -- mature FIRST. id breaks ties so the ordering is total and the
  -- migration is deterministic on re-run.
  --
  -- ⭐ This is the narrow fix, chosen because it touches UNMERGED code only. The durable
  -- fix is to make deferred rows re-selectable by the reaper; that changes a DEPLOYED
  -- worker and belongs in its own PR. Nothing here removes the need for it, and there is
  -- currently NO test anywhere in backend/tests that exercises the deferred branch --
  -- `callbacksDeferred` appears in zero test files.
  WITH ordered AS (
    SELECT id,
           row_number() OVER (ORDER BY created_at, id) AS rn
      FROM approvals
     WHERE status = 'pending'
       AND expires_at IS NULL
       AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'default_expiry_backfill_107')
  ), stamped AS (
    UPDATE approvals a
       SET expires_at = now() + interval '7 days' + (o.rn * interval '1 minute'),
           updated_at = now(),
           metadata   = COALESCE(a.metadata, '{}'::jsonb) || jsonb_build_object(
                          'default_expiry_backfill_107', jsonb_build_object(
                            'backfilled_at',        now(),
                            'previous_expires_at',  a.expires_at,
                            'previous_status',      a.status,
                            'spread_rank',          o.rn,
                            'was_restored_by_106',  COALESCE(a.metadata, '{}'::jsonb) ? 'restored_by_migration_106'
                          )
                        )
      FROM ordered o
     WHERE a.id = o.id
       AND a.status = 'pending'
       AND a.expires_at IS NULL
       AND NOT (COALESCE(a.metadata, '{}'::jsonb) ? 'default_expiry_backfill_107')
    RETURNING 1
  )
  SELECT count(*) INTO updated FROM stamped;

  RAISE NOTICE '107_default_expiry_backfill: % candidate(s), % row(s) given expires_at = now() + 7 days, spread 1 minute apart by (created_at, id) so they do not mature in one tick', candidates, updated;

  -- A migration that silently matched nothing is indistinguishable from one that ran
  -- correctly on an already-migrated database. Say which happened.
  IF candidates = 0 THEN
    RAISE NOTICE '107_default_expiry_backfill: nothing to do (already applied, or no NULL-expiry pending rows)';
  END IF;
END $$;
