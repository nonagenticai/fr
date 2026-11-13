-- Migration: 083_documents_tenant_id — record the upload tenant on documents
-- Date: 2026-06-19
-- Spec ref: ingestion-progress UX + background settle. The document status
-- reconcile needs to run OUTSIDE a request frame (a background interval that
-- settles docs whose uploader navigated away + catches the ~21% of jobs whose
-- orchestrator terminal-callback is lost). The kag job-status fetch forwards
-- X-Tenant-Id from the request context; with no frame it would fall back to
-- DEFAULT_TENANT_ID and read the WRONG tenant's job. So persist the upload's
-- tenant on the row and rebuild a minimal context per document in the reconcile.
--
-- Doubles as the tenant-fragmentation diagnostic: a single user's uploads were
-- observed landing under different tenants (see memory
-- kag-rag-architecture-embedding-gap-2026-06-19). Recording tenant_id at upload
-- time makes that directly inspectable on the fr side.
--
-- Forward-only / additive. Nullable: legacy rows + any upload made before this
-- ships stay NULL and are simply skipped by the background reconcile (the live
-- on-page poll still settles them, exactly as today). Idempotent via IF NOT
-- EXISTS. Wrapped in BEGIN/COMMIT (the runner supplies its own transaction).

BEGIN;

ALTER TABLE documents ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- Partial index for the reconcile selector: in-flight rows with a kag job and a
-- known tenant. Keeps the periodic scan cheap as the documents table grows.
CREATE INDEX IF NOT EXISTS documents_reconcile_idx
    ON documents (updated_at)
    WHERE status IN ('pending', 'processing')
      AND kag_ingestion_id IS NOT NULL
      AND tenant_id IS NOT NULL;

COMMIT;
