-- Migration: E-5 stale-executing reaper columns on approvals
-- Date: 2026-04-25
-- Reason: The action-approval bus (E-5) transitions rows
--         pending → approved → executing → done|failed. If the Bun process
--         is killed between the `approved → executing` claim and the
--         handler completing, the row is wedged in `executing` forever.
--         A periodic reaper (services/action-approvals.reapStaleExecutingActions)
--         finds rows whose updated_at is older than the threshold and
--         flips them to `failed` with a descriptive error_message.
--
--         These two columns are additive; defaults populate existing rows
--         with NOW() for updated_at and NULL for error_message, so the
--         reaper sees only fresh rows on first sweep after deploy and
--         won't flip historic data.

ALTER TABLE approvals
    ADD COLUMN IF NOT EXISTS updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
    ADD COLUMN IF NOT EXISTS error_message TEXT;

-- Reaper scan: cheap partial index for the common case where most rows are
-- terminal. The reaper hits this every 60s.
CREATE INDEX IF NOT EXISTS idx_approvals_executing_updated_at
    ON approvals(updated_at)
    WHERE status = 'executing';
