-- Migration: 066_procedure_improvement_tenant
-- Plan ref: ~/.claude/plans/users-georgedekker-claude-plans-squishy-quiet-iverson.md (PR 4)
--
-- Adds the third internal improvement-loop tenant — `procedure-improvement` —
-- so the n8n observability sweep (Plan 5 PR 6) can post
-- `procedure_performance_statistics_analysis` cards to a dedicated Planka
-- board, mirroring the existing `workflow_statistics_analysis` (kaizen) and
-- `prompt_performance_statistics_analysis` (meta_prompt) loops.
--
-- Three changes:
--   1. Extend the `stream_kind` enum with `procedure` (idempotent via
--      ADD VALUE IF NOT EXISTS).
--   2. Insert the `procedure-improvement` workspace row
--      (0195f48b-d000-7000-8000-000000000005 — keep in lock-step with
--      INTERNAL_PROCEDURE_TENANT_ID in
--      backend/src/middleware/internal-tenant-only.ts).
--   3. Rebuild `streams_kind_tenant_check` to additionally pin
--      kind=procedure → INTERNAL_PROCEDURE_TENANT_ID. Mirrors migration
--      062 step 7 exactly. Uses `kind::text = 'procedure'` so the parser
--      does not need to resolve the just-added enum value as an enum
--      literal (Postgres forbids using a same-tx ADD VALUE result as a
--      typed enum literal; the text cast sidesteps that — same trick used
--      in migration 060's rewrite).
--
-- Planka board bootstrap is NOT in this migration — the
-- `bun src/scripts/provision-improvement-planka.ts` script (extended in
-- this PR to recognise INTERNAL_PROCEDURE_TENANT_ID) provisions the
-- board on first deploy after the row exists. Operators run that script
-- the same way they did for the workflow + prompt boards.

ALTER TYPE stream_kind ADD VALUE IF NOT EXISTS 'procedure';

INSERT INTO workspaces (id, name, created_at)
VALUES
  ('0195f48b-d000-7000-8000-000000000005', 'procedure-improvement', NOW())
ON CONFLICT (id) DO NOTHING;

ALTER TABLE streams DROP CONSTRAINT IF EXISTS streams_kind_tenant_check;

ALTER TABLE streams
  ADD CONSTRAINT streams_kind_tenant_check
  CHECK (
    (kind::text = 'workflow'
       AND tenant_id = '0195f48b-d000-7000-8000-000000000002'::uuid)
    OR
    (kind::text = 'prompt'
       AND tenant_id = '0195f48b-d000-7000-8000-000000000004'::uuid)
    OR
    (kind::text = 'procedure'
       AND tenant_id = '0195f48b-d000-7000-8000-000000000005'::uuid)
    OR (kind::text = 'principle')
    OR (kind::text = 'requirement')
    OR (kind::text = 'decision')
  );
