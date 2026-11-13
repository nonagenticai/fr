-- 131_andon_singleton_reassert.sql — re-assert the GLOBAL ANDON SINGLETON ROW,
-- and nothing else migration 065 did.
-- Date: 2026-09-24
--
-- ⭐ THE DEFECT, MEASURED. `andon_state` is a singleton table whose ONE row
-- (id = 1) is inserted by migration 065. A freshly built database never gets
-- that row:
--
--   * `drizzle-kit push` creates the TABLE from src/db/schema.ts and nothing
--     else — push emits DDL, it has no mechanism that INSERTs a row; and
--   * `bun run migrate` against the resulting database takes the runner's
--     BACKFILL path (`_migrations` empty + `projects` present) and, because
--     065 carries no COLUMN_PROBES entry, merely STAMPS 065 applied WITHOUT
--     EXECUTING its `INSERT INTO andon_state`.
--
-- So `_migrations` says 065 shipped and the singleton is absent.
--
-- ⛔ WHY THAT IS FLEET-STOPPING NOW AND WAS NOT BEFORE. The router-dedupe
-- webhook (`POST /api/webhooks/n8n/router-dedupe`, routes/webhooks.ts
-- `consultAndonForRouterDedupe`) is the ONE synchronous call every Planka card
-- move makes, and it is FAIL-CLOSED BY OWNER RULE: it returns 'proceed' only
-- for an EXPLICIT release — `engaged:false` AND `reason:'released'`. An absent
-- singleton derives `reason:'uninitialised'` (routes/andon.ts
-- `handleGetAndonInternal`), which the brake refuses as `andon_uninitialised`.
-- ⇒ On a rebuilt prod or staging database the conveyor halts FLEET-WIDE from
-- the first card move, and a halted conveyor looks exactly like an idle one.
-- ⛔ Do NOT "fix" that by making the brake permissive; that inverts the brake.
-- The cord has to BE there. That is what this file does.
--
-- CI was red with 9 failures for exactly this reason. That is now handled for
-- CI ONLY, by `backend/scripts/ci-seed.ts` inserting the row after `push`.
-- ci-seed does not run for prod or staging, so it fixes the symptom on the one
-- environment that was noisy about it and leaves the two that are silent.
--
-- ⚠️ AND THE GRANDFATHER CLAUSE IS WHY NOBODY CAUGHT IT. 065 sits on
-- `check-migration-dml-probed`'s historical list, excused on the STATED premise
-- that its data effect "landed in production long ago, so re-running them is
-- not the risk". That premise is true of the database that exists and FALSE of
-- a fresh one — the grandfathering is a statement about history, not about
-- bootstrap. This file is the forward-only repair, so no grandfather entry is
-- added or needed: it is above the floor and it is PROBED.
--
-- ============================================================================
-- ⛔ THE TRAP: THIS IS NOT "RE-RUN 065".
--
-- 065 ends by creating `andon_state_history_trg()` and the AFTER UPDATE trigger
-- `trg_andon_state_history`. Migration 085 DELIBERATELY DROPPED BOTH and moved
-- history recording into the application (`routes/andon.ts recordAndonFlip`),
-- because the trigger copied `engaged_by` — which the release path NULLs — so
-- every RELEASE history row had a NULL actor. Re-running 065 whole would
-- RESURRECT that trigger and produce DOUBLE `andon_state_history` rows: one
-- from the app, one from the trigger.
--
-- So this file inserts THE ROW AND ONLY THE ROW. No trigger, no function, no
-- CREATE TABLE, no ALTER, no index. It is not a re-run of 065 and must never be
-- turned into one.
-- ============================================================================
--
-- WHAT IT SETS, COLUMN BY COLUMN, AND WHY EACH IS RIGHT FOR A NEW INSTALL:
--
--   id = 1 ................. the only value the table admits. `id INT PRIMARY
--                            KEY DEFAULT 1 CHECK (id = 1)` (065; mirrored in
--                            schema.ts as `andon_state_id_check`), and it is
--                            the key every reader queries — `readAndonRowFromDb`
--                            and `isGlobalAndonEngaged` both filter `id = 1`.
--   engaged = FALSE ........ ⭐ RELEASED. A brand-new install must not come up
--                            BRAKED: `engaged = true` would halt every card
--                            move fleet-wide until a super-admin pulled and
--                            released the cord, which is the same outage this
--                            file exists to prevent, arriving by the opposite
--                            route. FALSE is also 065's own value and the
--                            column default.
--
-- Every other column is LEFT UNSET (NULL), deliberately, and not one of them is
-- an oversight:
--
--   engaged_at  / engaged_by ....... NULL because nobody has pulled the cord.
--                            `engaged_by` means "who currently HOLDS the cord"
--                            (085's header); inventing a value would name an
--                            actor for an event that never happened.
--   paused_workflow_ids ............ NULL, NOT `'[]'::jsonb`. routes/andon.ts
--                            distinguishes these two: NULL means "no attempt is
--                            recorded", `[]` means "an attempt paused zero
--                            workflows", and the `n8n_pause` evidence count
--                            deliberately does NOT default so that distinction
--                            survives. No pull has happened, so NULL.
--   n8n_paused_at / n8n_pause_error  NULL for the same reason: no pull, so no
--                            pause attempt and no partial-failure summary.
--
-- ⚠️ `andon_state_history` IS NOT TOUCHED, and a fresh install must NOT gain a
-- history row: a row there asserts that somebody pulled or released the cord,
-- and nobody did. Two independent reasons it stays empty, both verified:
--   1. history has been APP-RECORDED since 085 — the trigger and its function
--      are dropped, so there is nothing in the database that could write one;
--   2. even on a database that somehow still carried 065's trigger, it is
--      `AFTER UPDATE OF engaged`. This is an INSERT. It would not fire.
--
-- ── IDEMPOTENCY ─────────────────────────────────────────────────────────────
-- The INSERT sits behind a ROW-PRESENCE PROBE (`WHERE NOT EXISTS (… id = 1)`),
-- so on the existing database — which already has the row — it inserts nothing,
-- and a second run of this file inserts nothing either.
--
-- ⛔ The guard is `WHERE NOT EXISTS` and NOT `ON CONFLICT (id) DO NOTHING`, on
-- purpose. They are equivalent in effect here, but not in FALSIFIABILITY: with
-- an `ON CONFLICT` swallow, deleting the guard would leave the file silently
-- idempotent anyway and the test below could not fail. With this shape, removing
-- the guard makes a second run raise `duplicate key value violates unique
-- constraint "andon_state_pkey"` — so the idempotency test can actually go red,
-- which is the only reason to trust it. Concurrency is not the guard's job: the
-- runner holds a Postgres advisory lock and applies each file inside one
-- transaction, so there is no second writer to conflict with.
--
-- ── PROBED, NOT GRANDFATHERED ───────────────────────────────────────────────
-- Registered in src/db/migration-runner.ts COLUMN_PROBES. The probe is a
-- CONJUNCTION and both halves are load-bearing:
--
--   (a) the RECEIPT this file writes for itself in `_migration_effects`.
--       ⭐ The only witness class the bootstrap cannot forge: `drizzle-kit push`
--       creates tables, columns, indexes and CHECK constraints — every one of
--       which has been a vacuous probe here at some point — and it cannot
--       INSERT A ROW. Neither can it be forged by ci-seed, which matters here
--       specifically: ci-seed DOES insert the singleton, so a row-presence-only
--       probe would read TRUE at backfill time on every CI database and stamp
--       this file applied without ever executing it.
--   (b) the singleton ROW being present.
--       ⚠️ This is the half that survives a DATA WIPE. A rebuild that drops the
--       whole database is covered by (a) alone; a wipe that TRUNCATEs data
--       tables while leaving `_migrations` and `_migration_effects` intact is
--       NOT — (a) would read TRUE forever over an empty `andon_state`, and the
--       brake would halt the fleet with every ledger saying the fix had
--       shipped. With (b) the probe reads FALSE, and because this entry sets
--       `reapplyIfProbeFails` the runner un-stamps the file and re-runs it,
--       which re-inserts the row. That self-heal is safe here for the reason
--       the flag's own documentation demands be checked statement by statement
--       rather than by analogy: every statement below is either
--       `CREATE TABLE IF NOT EXISTS`, a guarded INSERT, or an
--       `ON CONFLICT DO NOTHING` INSERT. There is no unconditional INSERT, no
--       DELETE, and no destructive ALTER in this file.
--
-- The receipt INSERT is `ON CONFLICT (migration) DO NOTHING`, so a re-run keeps
-- the ORIGINAL `singleton_inserted` count rather than overwriting it with a
-- re-run's zero — the forensic record of whether THIS database was one of the
-- ones that was missing its cord.
--
-- Pinned by tests/integration/migrations/131-andon-singleton-reassert.integration.test.ts
-- and by the SYNTHETIC_MIGRATIONS fixture in tests/unit/db/migration-runner.test.ts.

-- PRECONDITION, stated rather than discovered. This file re-asserts a ROW; it
-- deliberately does not create the TABLE (that is 065's and schema.ts's job, and
-- copying 065's DDL here is how its trigger would come back). If the table is
-- absent the database is broken at the schema level, and a named refusal is
-- worth more to the operator than a bare `relation "andon_state" does not exist`
-- from the statement below.
DO $$
BEGIN
  IF to_regclass('public.andon_state') IS NULL THEN
    RAISE EXCEPTION '131_andon_singleton_reassert: table andon_state is ABSENT. This migration re-asserts the singleton ROW only and must not create the table (065 creates it, and re-running 065 whole would resurrect the history trigger that 085 dropped). Restore the table via src/db/schema.ts / drizzle-kit push or migration 065, then re-run.';
  END IF;
END $$;

-- Runner-owned receipt table. Repeated here with IF NOT EXISTS so this file is
-- independently runnable rather than depending on 113/114/117 having gone first
-- (and so a missing receipt table can never abort the boot transaction).
CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The insert and its receipt in ONE statement.
--
-- ⭐ THE CTE IS LOAD-BEARING, for the same reason it is in 113 and 114: Postgres
-- runs a data-modifying WITH clause exactly once and to completion, so the
-- receipt cannot land unless the INSERT ran. Two separate statements would let a
-- later edit drop the INSERT while leaving a receipt asserting it happened —
-- and the receipt is half of this file's probe, so that receipt would keep the
-- cord's absence invisible on every boot.
WITH seeded AS (
  INSERT INTO andon_state (id, engaged)
  SELECT 1, FALSE
   WHERE NOT EXISTS (SELECT 1 FROM andon_state WHERE id = 1)
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '131_andon_singleton_reassert.sql',
       jsonb_build_object('singleton_inserted', (SELECT count(*) FROM seeded))
ON CONFLICT (migration) DO NOTHING;
