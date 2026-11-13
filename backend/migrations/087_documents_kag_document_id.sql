-- 087: documents.kag_document_id — the STABLE, content-derived document identity.
--
-- `kag_ingestion_id` is the per-RUN job_id ingestion returned at upload. It is NOT
-- the document's identity: re-ingesting the same artifact mints a fresh job_id, so
-- keying purge/dedupe on it means two runs of one document look like two documents.
--
-- ingestion_service now derives a stable `document_id` = uuid5(tenant:source:sha256(content))
-- (its `document_identity` module) — the key kag_graph/Neo4j chunks are actually written
-- under, and the key the HIPAA purge resolves to. It is only known once the worker has
-- PARSED (the async upload response carries just the job_id), so it lands here via the
-- status poll / background reconcile, not at upload time.
--
-- Nullable: pre-087 rows stay NULL, and an in-flight row has no document_id yet. The
-- delete path therefore prefers kag_document_id and falls back to kag_ingestion_id —
-- both resolve downstream (ingestion's `document_runs` bridge maps job_id → document_id).
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kag_document_id text;

-- Purge/dedupe lookups key on this id.
CREATE INDEX IF NOT EXISTS ix_documents_kag_document_id
  ON documents (kag_document_id);
