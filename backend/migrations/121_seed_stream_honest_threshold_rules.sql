-- 121_seed_stream_honest_threshold_rules.sql
--
-- WHY NOW. Measured live 2026-09-15: `streams.threshold_rules = '{}'::jsonb`
-- on 18 of the 19 rows in the table. Only `smoke-test-2026-05-01` carries
-- real rules. threshold_rules is what the detector evaluates per-asset
-- (`repository.ts` docstring: "See spec §3 'Default threshold rules'") --
-- a stream with `{}` here is a detector that can never fire for that
-- stream's assets, at any usage level, regardless of membership. Two of
-- the empty 18 are the system-owned streams this migration fixes:
-- `__system_prompt__` and `__system_procedure__`.
--
-- ROOT CAUSE, and why this is a migration and not a code fix alone.
-- `DEFAULT_THRESHOLD_RULES` (repository.ts:514) is applied by the CREATE
-- route handlers only (routes/assets/streams.ts:294 and
-- agui/actions/streams.ts:124: `thresholdRules: body.threshold_rules ??
-- { ...DEFAULT_THRESHOLD_RULES }`) -- it was never a DB column default
-- (schema default is `{}`, migration 017 line 72). `__system_workflow__`
-- was created through a handler and got rules. `__system_prompt__` and
-- `__system_procedure__` exist today with `{}` because whatever created
-- them did not go through that handler. This is an omission, not a
-- decision, and it has no code-only fix: the two rows already exist with
-- the wrong data and nothing re-runs their creation path.
--
-- ============================================================================
-- ⛔ ONLY THREE RULES, NOT THE DEFAULT FIVE. bounce_rate and fallback_rate
-- are DELIBERATELY EXCLUDED. Do not "complete the set" by adding them later
-- without re-reading this:
--
--   * bounce_count in asset_daily_stats is a TENANT-WIDE daily scalar
--     broadcast identically into every asset row in that tenant --
--     kanban_bounce_log has no asset_id column, and the subquery that
--     produces bounce_count sits outside the GROUP BY. Measured 2026-09-14,
--     tenant …0002: 3 asset rows, count(DISTINCT bounce_count) = 1. A
--     bounce_rate rule here would not be evaluating the asset it is
--     attached to.
--   * fallback_count is coalesce(sum(eq.fallback_count), 0) where
--     exec_quality.fallback_count is non-null on 0 of 6,531 rows. The
--     stored 0 means "never measured", not "no fallbacks occurred" -- a
--     fallback_rate rule would silently never fire, for a reason that
--     looks identical to success.
--
--   Both are structurally broken, not merely unpopulated -- a different
--   condition from the two facts below, which are recoverable. A sibling
--   PR, n8n_custom_nodes#1427, retracts a fix that tried to compute them
--   and documents the same finding.
--
-- ⚠️ HONEST STATE OF THE THREE RULES THIS MIGRATION DOES SEED, as of
-- 2026-09-15: p95_latency_ms is NULL on every asset_daily_stats row today
-- and cost_usd is 0.000000, so only failure_rate can evaluate TODAY.
-- p95_latency and cost_per_exec are structurally sound but DATA-STARVED --
-- they will start evaluating honestly once real numbers land in those
-- columns, with no further migration needed. That is unlike bounce/
-- fallback, which cannot ever evaluate honestly as currently computed.
--
-- ⚠️ BLAST RADIUS. `__system_procedure__` has 2 members, `__system_prompt__`
-- has 0. Both carry min_significance_n = 30, and today's max exec_count
-- across either stream's assets is 16 -- under the significance floor.
-- So this migration opens ZERO improvement cards in its first hour, and
-- will not until real usage and real latency/cost data accumulate. Dedupe
-- on card-open is the unique partial index
-- `detector_open_cards_one_open_per_tenant_asset` on
-- (tenant_id, stream_id, asset_kind, asset_id) WHERE closed_at IS NULL --
-- unaffected by this migration, noted here only so the "why did nothing
-- happen" question has an answer on record.
-- ============================================================================
--
-- ⚠️ NOT PROBED, DELIBERATELY. `COLUMN_PROBES` in src/db/migration-runner.ts
-- only covers SCHEMA migrations, and re-evaluates on every boot -- a probe
-- here would hard-error a fresh database that has no `__system_prompt__` /
-- `__system_procedure__` rows yet (nothing in backend/migrations inserts
-- into `streams` directly; both are created lazily by application code,
-- after this migration has already run once). A data correction
-- stamped-but-unrun on a fresh database loses nothing: there is nothing
-- to correct there yet, and the same UPDATE will match those rows the
-- first time it runs after they exist, same as any other idempotent
-- data migration in this tree.
--
-- IDEMPOTENT: the `AND threshold_rules = '{}'::jsonb` guard means a
-- re-run, or a run after someone has since set real rules on either
-- stream, matches zero rows. It is also what stops this migration from
-- clobbering rules a human sets between now and deploy.
--
-- Column confirmed jsonb NOT NULL DEFAULT '{}'::jsonb (migration 017,
-- line 72) -- '{}'::jsonb is the correct RHS type for the comparison.

DO $$
DECLARE
  candidates integer;
  updated    integer;
BEGIN
  SELECT count(*) INTO candidates
    FROM streams
   WHERE slug IN ('__system_prompt__', '__system_procedure__')
     AND threshold_rules = '{}'::jsonb;

  UPDATE streams
     SET threshold_rules = '{
           "failure_rate":  {"rule": "absolute",          "threshold": 0.1},
           "p95_latency":   {"rule": "ratio_to_baseline",  "threshold": 2.0},
           "cost_per_exec": {"rule": "ratio_to_baseline",  "threshold": 1.5}
         }'::jsonb,
         updated_at = now()
   WHERE slug IN ('__system_prompt__', '__system_procedure__')
     AND threshold_rules = '{}'::jsonb;

  GET DIAGNOSTICS updated = ROW_COUNT;

  RAISE NOTICE '121_seed_stream_honest_threshold_rules: % of % candidate system stream(s) given honest threshold_rules (failure_rate / p95_latency / cost_per_exec only)', updated, candidates;

  IF updated <> candidates THEN
    RAISE EXCEPTION '121_seed_stream_honest_threshold_rules: updated % but there were % candidates -- refusing to report success on a partial seed', updated, candidates;
  END IF;
END $$;
