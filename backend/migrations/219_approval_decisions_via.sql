-- Migration: 219_approval_decisions_via
-- Date: 2026-10-31
--
-- fr #1683, owner ruling 2026-10-31 (option A): a staff member may answer an approval
-- through their tenant's agent member (mcp address `agent:<tenant>` + `on_behalf_of`
-- = that person's sub). The decision is THAT person's (approver_id, decided_by_kind
-- 'human'); `via` records how it arrived: {channel, agent_member_id, product, job_id?}.
-- NULL for every other decision. Pure DDL; push creates the column too. Idempotent.

SET LOCAL lock_timeout = '10s';

ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS via jsonb;

COMMENT ON COLUMN approval_decisions.via IS
  'How a decision arrived when it was not the decider''s own seat: {channel, agent_member_id, product, job_id?} '
  'for a staff member answering through the tenant agent member (fr #1683). NULL otherwise.';
