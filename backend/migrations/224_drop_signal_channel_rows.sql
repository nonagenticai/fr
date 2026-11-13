-- Migration: 224_drop_signal_channel_rows
-- Date: 2026-10-31
--
-- Signal is REMOVED as a notification channel (owner ruling 2026-10-31). The code went in
-- fr#1692 (adapter, prompt, the `channel_kind` label — migration 222) and fr#1694 (the last
-- dead `channel === 'signal'` mask branch). What is left is the DATA: routing/linking rows
-- for a channel no adapter can deliver on and no producer can emit. Owner asked for the
-- cleanup ("cleanup:").
--
-- MEASURED ON PRODUCTION 2026-10-31, immediately before writing this:
--   notification_prefs   WHERE channel = 'signal'    17 rows  (2 users; BOTH also have
--                                                              non-signal channels, so no
--                                                              user loses their only route)
--   user_channel_prefs   WHERE channel = 'signal'     1 row
--   engagement_deliveries, notification_log, agent_runtime_sessions, analytics_rollups
--     WHERE channel = 'signal'                        0 rows each
--
-- SCOPE: both `channel` columns are bare TEXT with no CHECK, so the deletes filter on the
-- exact literal and nothing else — every other channel is untouched. Idempotent: re-running
-- deletes nothing.
--
-- NOT PROBED, DELIBERATELY: this migration introduces no column or table whose absence a
-- COLUMN_PROBES entry could check, and the rows it removes are read by nothing (no adapter
-- produces `channel = 'signal'`). In the "empty ledger, populated schema" bootstrap it is
-- stamped without running; that loses only the removal of rows CI seeds never create.
--
-- ⚠️ Migration 142's bulk-delete guard is deliberately NOT armed, and does not need to be:
-- it refuses only a DELETE that EMPTIES a protected table holding >= 50 rows, or one
-- removing > 2000 rows. This removes 17 + 1 on production and 0 on a fresh database.
--
-- RUNNER CONTRACT: DML only, no DDL. No BEGIN/COMMIT — the runner wraps each file in a
-- SAVEPOINT inside its outer transaction (migration 223's contract).

DELETE FROM notification_prefs WHERE channel = 'signal';

DELETE FROM user_channel_prefs WHERE channel = 'signal';
