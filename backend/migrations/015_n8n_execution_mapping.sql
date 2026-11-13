-- 015_n8n_execution_mapping.sql
--
-- Slice: 2026-04-24-n8n-observability-kanban-liveness §Architecture decisions /
-- Project association. Maps n8n-issued execution_id → fr (project, user,
-- correlation) so the activity routes can join upstream execution data with
-- project scope.
--
-- Rows are written by `integrations/n8n.ts::triggerWorkflow()` BEFORE the
-- webhook call when the caller pre-generated an execution id (the spec's
-- `X-Execution-Id` path); otherwise immediately after the webhook reply
-- arrives. Either way every fr code path that fires an n8n workflow goes
-- through that one helper.
--
-- `counted_terminal` is the dedupe flag for the `fr_n8n_executions_total`
-- Prometheus counter: when the activity-list endpoint observes a terminal-
-- state execution it hasn't counted yet, it flips this to true.

CREATE TABLE n8n_execution_mapping (
  execution_id      TEXT PRIMARY KEY,
  workflow_id       TEXT NOT NULL,
  project_id        TEXT NOT NULL,
  user_id           TEXT NOT NULL,
  correlation_id    TEXT NOT NULL,
  initiated_via     TEXT NOT NULL,
  triggered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  counted_terminal  BOOLEAN NOT NULL DEFAULT false
);

CREATE INDEX idx_n8n_map_project ON n8n_execution_mapping (project_id, triggered_at DESC);
CREATE INDEX idx_n8n_map_user    ON n8n_execution_mapping (user_id,    triggered_at DESC);
