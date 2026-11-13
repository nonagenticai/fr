-- Migration: 195_agent_skill_pins
-- Date: 2026-10-16
--
-- fr-agui SPEC §11.2 / §13 P1.5: the tenant's PINNED skill_builder capability
-- packs. A tenant_admin enables a pack in the classic tenant UI
-- (`agent_skills.enable`, never the agent — OQ-6); the project agent then loads
-- exactly the pinned (skill_id, version, per-file content_hash) and refuses a
-- pack whose served version or any file hash no longer matches. The agent never
-- fetches "latest" per turn.
--
--   file_hashes  { "<filename>": "<sha256 hex>" } for instructions.md and
--                capabilities.json, as verified at enable time (agent/skills.ts).
--   enabled_by   the fr user id of the tenant_admin who pinned it.
--
-- One pin per (tenant, skill): re-enabling re-pins (upsert). Disabling deletes
-- the row (`agent_skills.disable`), a single-row DELETE by primary key scope.
--
-- RUNNER CONTRACT: pure DDL, no DML; mirrored in src/db/schema.ts (so a
-- push-built database satisfies the probe). Idempotent (IF NOT EXISTS) — safe
-- under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps each file in a
-- SAVEPOINT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS agent_skill_pins (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL,
  skill_id uuid NOT NULL,
  name text NOT NULL,
  version integer NOT NULL,
  file_hashes jsonb NOT NULL,
  enabled_by text NOT NULL,
  enabled_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS agent_skill_pins_tenant_skill_key ON agent_skill_pins (tenant_id, skill_id);

-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283): PROTECTED — a
-- pin is a tenant_admin's decision with no regeneration path. Listed in 142's
-- `protected_tables` AND attached here (as 194 does): in production 142 never
-- re-runs, so this attach is what guards the table; on a push-built CI database
-- 142 is re-applied and its loop attaches to it as well. `agent_skills.disable`
-- deletes ONE row, which the bulk-delete trigger admits.
CREATE OR REPLACE TRIGGER fr_guard_truncate_agent_skill_pins
  BEFORE TRUNCATE ON public.agent_skill_pins
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.agent_skill_pins
  ENABLE ALWAYS TRIGGER fr_guard_truncate_agent_skill_pins;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_agent_skill_pins
  AFTER DELETE ON public.agent_skill_pins
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.agent_skill_pins
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_agent_skill_pins;
