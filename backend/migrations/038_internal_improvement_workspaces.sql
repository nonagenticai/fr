-- Migration: 034_internal_improvement_workspaces
-- Date: 2026-04-29
-- Slice: 2026-04-27-continuous-improvement-design (Spec 3 §6.0)
--
-- Continuous improvement is system-level. Streams are owned by exactly
-- two internal/service tenants — one per stream kind:
--
--   __system_workflow__  (kind=workflow streams)
--   __system_prompt__    (kind=prompt streams)
--
-- This migration:
--   1. Reserves their two frozen workspace UUIDs.
--   2. Wipes any pre-existing rows in streams / asset_stream_membership /
--      tenant_improvement_projects (those rows were created when streams
--      were per-workspace; the model is now system-level so they are
--      no longer meaningful).
--   3. Adds a CHECK constraint on streams that pins kind → tenant_id to
--      one of the two reserved UUIDs.
--
-- Forward-only / idempotent. Re-runnable via the migration-runner contract.

BEGIN;

INSERT INTO workspaces (id, name)
VALUES
    ('00000000-0000-4000-8000-000000000001', '__system_workflow__'),
    ('00000000-0000-4000-8000-000000000002', '__system_prompt__')
ON CONFLICT (id) DO NOTHING;

-- streams under the per-workspace model are gone. Wipe before adding
-- the kind→tenant CHECK so the constraint can be VALID, not NOT VALID.
TRUNCATE TABLE asset_stream_membership;
TRUNCATE TABLE tenant_improvement_projects;
DELETE FROM streams;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'streams_kind_tenant_check'
          AND conrelid = 'streams'::regclass
    ) THEN
        ALTER TABLE streams
            ADD CONSTRAINT streams_kind_tenant_check
            CHECK (
                (kind = 'workflow' AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid)
                OR (kind = 'prompt' AND tenant_id = '00000000-0000-4000-8000-000000000002'::uuid)
            );
    END IF;
END$$;

COMMIT;
