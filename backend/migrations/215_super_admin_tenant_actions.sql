-- Migration: 215_super_admin_tenant_actions
-- Date: 2026-10-27
--
-- George 2026-10-27 (memory george-2026-10-27-super-admin-is-tenant-admin-everywhere): a
-- super_admin operates as TENANT-ADMIN in ANY existing, non-archived tenant it switches into
-- (X-Active-Tenant), and every such action is audited. This is the durable half of that audit:
-- one row per WRITE (any method other than GET/HEAD/OPTIONS) a super_admin sends while switched
-- into a tenant other than their own JWT tenant, written by server.ts after the handler answered
-- (lib/super-admin-tenant-audit.ts). Reads are audited by the `[super-admin-switch]` log line only.
--
--   actor_user_id   the SIGNED Keycloak sub of the super_admin
--   tenant_id       the switched (active) tenant the write ran in
--   home_tenant_id  the caller's own JWT tenant (NULL when the token carried none)
--   method, route   HTTP method and path (no query string); for an AGENT ACTION row method is
--                   'ACTION' and route is `action:<name>`
--   status          the HTTP status the handler answered (an action row: 200 executed, 202 parked or
--                   proposed, the error's status when it threw)
--   action_name     the registry action an in-process agent write ran (NULL on an HTTP row)
--   outcome         an action row's outcome: executed | parked | proposed | failed (NULL on HTTP)
--   correlation_id  X-Correlation-Id of the request
--
-- Two writers (lib/super-admin-tenant-audit.ts): server.ts, one row per HTTP write; and the agent
-- registry (`invokeAction`), one row per WRITE action — so a Copilot chat turn that runs several
-- writes in-process (no confirm card) leaves one row per action, not one opaque chat row.
--
-- APPEND-ONLY, enforced: a row-level trigger refuses every UPDATE and every DELETE
-- (`fr_refuse_super_admin_audit_mutation`, no escape hatch — an audit row that can be edited
-- proves nothing), and migration 142's statement guard refuses TRUNCATE / bulk DELETE
-- (protected_tables lists it). No FK on tenant_id: an audit row outlives the workspace it names.
-- Indexed by (tenant_id, ts) — "what happened in this tenant" — and (actor_user_id, ts) — "what
-- did this super_admin do".
--
-- RUNNER CONTRACT: pure DDL plus a FUNCTION and TRIGGERs (no DML); mirrored in src/db/schema.ts.
-- Probed for the table, both indexes, the append-only trigger and both 142 guard triggers — push
-- creates the table and indexes, never the function or triggers, so a push-built database keeps
-- this file pending until it runs. Idempotent (IF NOT EXISTS, CREATE OR REPLACE) — safe under
-- `reapplyIfProbeFails`. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS super_admin_tenant_actions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id   text NOT NULL,
  tenant_id       uuid NOT NULL,
  home_tenant_id  text NULL,
  method          text NOT NULL,
  route           text NOT NULL,
  status          integer NOT NULL,
  action_name     text NULL,
  outcome         text NULL,
  correlation_id  text NULL,
  ts              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS super_admin_tenant_actions_tenant_ts_idx
  ON super_admin_tenant_actions (tenant_id, ts DESC);
CREATE INDEX IF NOT EXISTS super_admin_tenant_actions_actor_ts_idx
  ON super_admin_tenant_actions (actor_user_id, ts DESC);

-- Append-only: refuse any UPDATE or DELETE of a row, whoever issues it.
CREATE OR REPLACE FUNCTION fr_refuse_super_admin_audit_mutation() RETURNS trigger
  LANGUAGE plpgsql AS $fn$
BEGIN
  RAISE EXCEPTION 'super_admin_tenant_actions is append-only: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$fn$;

CREATE OR REPLACE TRIGGER fr_append_only_super_admin_tenant_actions
  BEFORE UPDATE OR DELETE ON public.super_admin_tenant_actions
  FOR EACH ROW EXECUTE FUNCTION fr_refuse_super_admin_audit_mutation();
ALTER TABLE public.super_admin_tenant_actions
  ENABLE ALWAYS TRIGGER fr_append_only_super_admin_tenant_actions;

-- Attach migration 142's guard (functions fr_refuse_truncate / fr_refuse_bulk_delete).
-- Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_super_admin_tenant_actions
  BEFORE TRUNCATE ON public.super_admin_tenant_actions
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.super_admin_tenant_actions
  ENABLE ALWAYS TRIGGER fr_guard_truncate_super_admin_tenant_actions;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_super_admin_tenant_actions
  AFTER DELETE ON public.super_admin_tenant_actions
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.super_admin_tenant_actions
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_super_admin_tenant_actions;
