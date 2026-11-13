-- Migration: 145_n8n_execution_mapping_tenant
-- Date: 2026-09-30
--
-- fr#1322 item 2 — TENANT-SCOPE THE EXECUTION MAPPING.
--
-- `n8n_execution_mapping` (migration 015) keys a run to (project, user) but
-- never to a tenant, so a user who belongs to several tenants saw their own
-- executions from EVERY tenant on the customer executions list. Every writer
-- (`integrations/n8n.ts::triggerWorkflow`, the AG-UI `n8n.trigger_workflow`
-- action) now stamps `tenant_id` on insert and on the upsert's update.
--
-- ⛔ NULLABLE ON PURPOSE, NO BACKFILL (pre-prod is forward-only). Legacy rows
-- stay NULL and are therefore deliberately NOT shown on the customer path —
-- the tenant filter fails closed on an unknown tenant rather than guessing one.
--
-- Plain CREATE INDEX (not CONCURRENTLY): the migration runner wraps every file
-- in a transaction + savepoint, where CONCURRENTLY is not allowed.

ALTER TABLE n8n_execution_mapping ADD COLUMN IF NOT EXISTS tenant_id TEXT;

CREATE INDEX IF NOT EXISTS idx_n8n_execution_mapping_user_tenant
  ON n8n_execution_mapping (user_id, tenant_id, triggered_at DESC);
