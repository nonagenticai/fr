-- Migration: 090_documents_project_id_restrict — stop project delete from
--            orphaning document PHI (HIPAA)
-- Date: 2026-07-16
-- Spec ref: PHI right-to-delete. `documents` is the sole PHI-pointer table
-- (kag_ingestion_id / kag_document_id / tenant_id → kag_graph chunks + entities
-- + Neo4j, orchestrator job state, MinIO images). The FK
-- documents.project_id → projects.id was created ON DELETE CASCADE, so deleting
-- a project silently DROPPED the document pointer rows WITHOUT purging any of
-- that downstream PHI — leaving it orphaned forever (a HIPAA violation). Change
-- the FK to ON DELETE RESTRICT so a project can no longer be deleted while it
-- still has document rows: the application (purgeAndDeleteProjectDocuments in
-- routes/documents.ts) must run the fail-closed KAG purge and delete the
-- document rows FIRST, then delete/archive the project.
--
-- Forward-only / additive (FK-semantics only; no data change). Idempotent: the
-- fk NAME is introspected (drizzle-kit push names it
-- `documents_project_id_projects_id_fk`, NOT `..._fkey`, so a hardcoded
-- DROP CONSTRAINT IF EXISTS would no-op and LEAVE the cascade) and the ADD is
-- skipped when a non-CASCADE fk on documents.project_id → projects already
-- exists (e.g. a fresh CI DB built by `drizzle-kit push` off the updated
-- schema.ts already has RESTRICT). Wrapped in BEGIN/COMMIT (the runner strips
-- the wrapper and supplies its own transaction).

BEGIN;

DO $$
DECLARE
    fk_name        text;
    fk_delete_rule char(1);
BEGIN
    -- Find the ACTUAL foreign-key constraint on documents.project_id that
    -- references projects, by introspection — never by a hardcoded name.
    -- confdeltype: 'c' = CASCADE, 'r' = RESTRICT, 'a' = NO ACTION.
    SELECT c.conname, c.confdeltype
      INTO fk_name, fk_delete_rule
      FROM pg_constraint c
      JOIN pg_class      t  ON t.oid = c.conrelid          -- referencing table (documents)
      JOIN pg_class      rt ON rt.oid = c.confrelid         -- referenced table (projects)
      JOIN pg_attribute  a  ON a.attrelid = c.conrelid
                           AND a.attnum = c.conkey[1]        -- single-column fk
     WHERE c.contype = 'f'
       AND t.relname  = 'documents'
       AND rt.relname = 'projects'
       AND a.attname  = 'project_id'
       AND array_length(c.conkey, 1) = 1
     LIMIT 1;

    IF fk_name IS NULL THEN
        RAISE NOTICE '090: no documents.project_id → projects FK found; nothing to alter.';
        RETURN;
    END IF;

    IF fk_delete_rule IN ('r', 'a') THEN
        -- Already RESTRICT or NO ACTION — both block a cascade purge-bypass.
        RAISE NOTICE '090: FK % already ON DELETE RESTRICT/NO ACTION; skipping.', fk_name;
        RETURN;
    END IF;

    EXECUTE format('ALTER TABLE documents DROP CONSTRAINT %I', fk_name);
    EXECUTE format(
        'ALTER TABLE documents ADD CONSTRAINT %I '
        || 'FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE RESTRICT',
        fk_name);
    RAISE NOTICE '090: FK % changed to ON DELETE RESTRICT.', fk_name;
END $$;

COMMIT;
