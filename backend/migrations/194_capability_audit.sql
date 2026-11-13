-- Migration: 194_capability_audit
-- Date: 2026-10-16
--
-- fr-agui SPEC §10.5 (P1c): the audit trail of agent PROPOSALS and of the human
-- confirmations that executed them. Append-only, one row per event:
--   - status 'proposed'   — the agent loop shaped a confirm-card proposal
--                           (agent/loop.ts → services/capability-audit.ts);
--   - status 'executed:<http status>' — a route request that carried
--                           `X-Agent-Proposal-Id` (server.ts), i.e. the human's
--                           click on that card, initiator 'human-via-agent'.
-- EVERY row carries `project_id` when the action is project-scoped (SPEC §5.7
-- rule 5: every call carries the project). `input_hash` is the sha256 of the
-- REDACTED input (capabilities/redact.ts) — never the input itself.
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283): PROTECTED — an
-- audit trail has no regeneration path. Listed in 142's `protected_tables` AND
-- attached at the bottom of THIS file (as 160 / 191 do): in production 142 never
-- re-runs, so this attach is what guards the table; on a push-built CI database
-- 142 is re-applied and its loop attaches to it as well.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (IF NOT EXISTS) — safe
-- under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps each file in a
-- SAVEPOINT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS capability_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  capability_id text NULL,
  proposal_id text NOT NULL,
  thread_id text NULL,
  user_id text NOT NULL,
  tenant_id uuid NULL,
  project_id uuid NULL,
  initiator text NOT NULL,
  input_hash text NULL,
  status text NOT NULL,
  correlation_id text NULL,
  ts timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS capability_audit_proposal_idx ON capability_audit (proposal_id, user_id);
CREATE INDEX IF NOT EXISTS capability_audit_project_ts_idx ON capability_audit (project_id, ts);

-- Attach migration 142's guard (functions fr_refuse_truncate /
-- fr_refuse_bulk_delete). Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_capability_audit
  BEFORE TRUNCATE ON public.capability_audit
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.capability_audit
  ENABLE ALWAYS TRIGGER fr_guard_truncate_capability_audit;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_capability_audit
  AFTER DELETE ON public.capability_audit
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.capability_audit
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_capability_audit;
