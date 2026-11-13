-- Migration: 070_documents_drop_file_path
-- Date: 2026-05-22
-- Plan ref: ~/.claude/plans/kag-common-v0-4-0-a-dreamy-pascal.md (W2: drop fr upload disk persistence)
--
-- Customer document uploads no longer touch fr's local disk. Since #307 the
-- upload streams the file BYTES straight to the kag gateway
-- (`POST /ingest/documents` → ingestion → ClamAV); the old `./uploads/<id>`
-- copy that `documents.file_path` referenced was written, then orphaned (never
-- read back), and lost on every pod restart. kag/ingestion is the source of
-- truth. The handler now inserts no `file_path`, so the column is dead — drop
-- it. Existing rows lose only a stale, ephemeral pod-fs path string.
--
-- Idempotent. Pre-prod, forward-only.

BEGIN;

ALTER TABLE documents
  DROP COLUMN IF EXISTS file_path;

COMMIT;
