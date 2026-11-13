-- Migration: 074_project_stakeholders
-- Date: 2026-06-05
-- Plan ref: ~/.claude/plans/exec-tenant-has-staged-clock.md (Part A)
--
-- The auditable source-of-truth for who must sign off on a project's
-- execution gate. Until now project-create stashed `approvers` / `stakeholders`
-- in `projects.project_data` JSONB — fine for round-tripping the AG-UI brief,
-- but not a queryable, FK-backed record of who-signs-off. The
-- POST /api/execution/approvals create-path reads this table (role
-- 'execution_signoff') to build the approval's required_approvers and fan out
-- to each approver's engagement channel.
--
-- `user_id` is a Keycloak subject UUID — same type/shape as
-- required_approvers.user_id (which this feeds). `role` participates in the
-- primary key so one user may hold multiple roles on a project (and the same
-- role can be held by many users). The (project_id, user_id, role) PK gives
-- insert idempotency for free — project-create can re-insert without a
-- conflict guard beyond ON CONFLICT DO NOTHING.
--
-- The existing `project_data.approvers` JSONB stays written as a denormalised
-- mirror so no existing reader of the brief breaks; this table is the
-- authoritative record. Additive, forward-only, idempotent on re-run.

CREATE TABLE IF NOT EXISTS project_stakeholders (
  project_id  uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL,
  role        text        NOT NULL DEFAULT 'execution_signoff',
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id, role)
);

-- Reverse lookup: "what does this user need to sign off on" + role filtering.
CREATE INDEX IF NOT EXISTS project_stakeholders_user_id_idx
  ON project_stakeholders (user_id);
