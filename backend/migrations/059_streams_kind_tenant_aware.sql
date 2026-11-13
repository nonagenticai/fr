-- Migration: 055_streams_kind_tenant_aware
-- Plan 7 Stage 0a — extend stream_kind with three asset kinds.
--
-- Postgres requires `ALTER TYPE … ADD VALUE` to commit BEFORE the new
-- value can be used in another statement. Splitting this from the
-- companion 056 (CHECK rewrite that USES the new values) is mandatory:
-- the migration-runner wraps each file in a transaction, so each file
-- becomes its own commit boundary. Combining both in one file fails
-- with "unsafe use of new value of enum type" at apply time.
--
-- Forward-only / idempotent: ADD VALUE IF NOT EXISTS guards re-runs.

ALTER TYPE stream_kind ADD VALUE IF NOT EXISTS 'principle';
ALTER TYPE stream_kind ADD VALUE IF NOT EXISTS 'requirement';
ALTER TYPE stream_kind ADD VALUE IF NOT EXISTS 'decision';
