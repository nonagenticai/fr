-- backend/migrations/027_dept_member_roles.sql
-- Foundation Plan 2 — Task 3
--
-- Per-department role assignments for users. Distinct from `user_roles`,
-- which is workspace-scoped (admin/auditor/etc). Spec 1 §11 defines the
-- four dept-scoped roles: dept-admin, dept-manager, dept-member, dept-viewer.
--
-- (dept_id, user_id) is unique so re-adding a member upserts the role.
-- The `user_id` index supports the "list departments for user" query that
-- the effective-set helper uses on every asset list call.
BEGIN;

CREATE TABLE IF NOT EXISTS department_members (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dept_id     uuid NOT NULL REFERENCES departments(id) ON DELETE CASCADE,
  user_id     text NOT NULL,
  role        text NOT NULL CHECK (role IN ('dept-admin','dept-manager','dept-member','dept-viewer')),
  joined_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (dept_id, user_id)
);

CREATE INDEX IF NOT EXISTS department_members_user_id_idx ON department_members(user_id);

COMMIT;
