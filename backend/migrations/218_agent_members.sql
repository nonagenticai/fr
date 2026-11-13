-- Migration: 218_agent_members
-- Date: 2026-10-31
--
-- fr #1683 (owner decision 2026-10-31): an agent product that acts in fr over the
-- `mcp` channel does so as its OWN member of the tenant, never as a linked person.
-- One row per (tenant, product). `user_id` is a synthetic principal, a version-8
-- UUID (Keycloak issues only v4, so it can never name a person, and it still fits
-- every uuid column such as approvals.requester_id), that also holds the tenant's
-- `user_roles` row and the admin-created `user_channel_prefs` link whose address
-- is `agent:<tenant_id>[:<product>]` (src/domain/engagement/agent-members.ts).
-- The member never decides an approval.
--
-- Attaches migration 142's destructive-statement guard (protected_tables lists it).
--
-- RUNNER CONTRACT: pure DDL plus TRIGGERs (no DML); mirrored in src/db/schema.ts. Probed for the
-- table and both guard triggers — push creates the table, never the triggers, so a push-built
-- database keeps this file pending until it runs. Idempotent — safe under `reapplyIfProbeFails`.
-- No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS agent_members (
  user_id     text PRIMARY KEY CHECK (user_id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  tenant_id   uuid NOT NULL,
  product     text NOT NULL CHECK (product ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  address     text NOT NULL CHECK (address LIKE 'agent:%'),
  created_by  text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_members_address_unique UNIQUE (address),
  CONSTRAINT agent_members_tenant_product_unique UNIQUE (tenant_id, product)
);

-- Attach migration 142's guard (functions fr_refuse_truncate / fr_refuse_bulk_delete).
-- Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_agent_members
  BEFORE TRUNCATE ON public.agent_members
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.agent_members
  ENABLE ALWAYS TRIGGER fr_guard_truncate_agent_members;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_agent_members
  AFTER DELETE ON public.agent_members
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.agent_members
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_agent_members;
