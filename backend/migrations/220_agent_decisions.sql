-- Migration: 220_agent_decisions
-- Date: 2026-10-31
--
-- fr #1683, owner clarification 2026-10-31 (supersedes "the agent never decides"): the
-- agent platform is fr's autonomous user over mcp. Its agent member is a normal member
-- with an admin-assigned role and MAY decide approvals; fr enforces roles and records
-- honestly:
--   * approval_decisions.decided_by_kind gains 'agent' (a decision by an agent member
--     without a resolvable on_behalf_of; `via` names the agent member and job).
--   * workspaces.agent_denied_approval_kinds: the per-tenant approval kinds an agent
--     member may NOT decide (default empty = fully autonomous). Such an approval is
--     routed to the tenant's humans as usual.
-- Pure DDL; push builds both from schema.ts. Idempotent. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE approval_decisions DROP CONSTRAINT IF EXISTS approval_decisions_decided_by_kind_check;
ALTER TABLE approval_decisions ADD CONSTRAINT approval_decisions_decided_by_kind_check
  CHECK (decided_by_kind IN ('human', 'triage_agent', 'rule', 'agent'));

ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS agent_denied_approval_kinds approval_kind[] NOT NULL DEFAULT '{}';
COMMENT ON COLUMN workspaces.agent_denied_approval_kinds IS
  'Approval kinds this tenant''s agent members may NOT decide (fr #1683). Empty = fully autonomous.';
