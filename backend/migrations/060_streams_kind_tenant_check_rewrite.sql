-- Migration: 056_streams_kind_tenant_check_rewrite
-- Plan 7 Stage 0a — kind-aware streams_kind_tenant_check rewrite.
--
-- Compares `kind::text` against string literals instead of enum literals
-- like `'principle'::stream_kind`. Postgres forbids referencing an enum
-- value added in the same transaction (the migration-runner uses ONE
-- outer transaction with savepoints per file — splitting into separate
-- files does NOT cross the tx boundary). Casting the column to text
-- sidesteps the restriction: the parser doesn't need the enum value to
-- be visible because we're comparing strings.
--
-- Idempotent: DROP IF EXISTS + ADD heals partial applies.

ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_kind_tenant_check;

ALTER TABLE streams
  ADD CONSTRAINT streams_kind_tenant_check
  CHECK (
    (kind::text = 'workflow'
       AND tenant_id = '00000000-0000-4000-8000-000000000001'::uuid)
    OR
    (kind::text = 'prompt'
       AND tenant_id = '00000000-0000-4000-8000-000000000002'::uuid)
    OR (kind::text = 'principle')
    OR (kind::text = 'requirement')
    OR (kind::text = 'decision')
  );
