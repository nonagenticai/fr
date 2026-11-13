-- backend/migrations/051_agent_runtime_sessions_project_id.sql
--
-- Streams Frontend Removal plan, Task 1.2 (2026-05-04).
--
-- Adds nullable `project_id` to agent_runtime_sessions so an agent thread
-- can be optionally bound to a project (Q5c — locked-in 2026-05-04).
-- No consumer is wired in this migration; the column is groundwork for the
-- future thread→project binding UI. Existing threads stay project-less
-- (NULL); FK is ON DELETE SET NULL so deleting a project doesn't cascade
-- and orphan thread history.
--
-- A partial index on project_id covers the future "list threads for this
-- project" lookup without paying for a full-table index on the (mostly
-- NULL) column.

ALTER TABLE agent_runtime_sessions
  ADD COLUMN project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

CREATE INDEX agent_runtime_sessions_project_id_idx
  ON agent_runtime_sessions (project_id)
  WHERE project_id IS NOT NULL;
