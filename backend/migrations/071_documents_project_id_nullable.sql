-- Migration: 071_documents_project_id_nullable
-- Date: 2026-05-24
-- Plan ref: ~/.claude/plans/fr-after-all-the-gentle-muffin.md (KAG-library upload, workspace-scoped)
--
-- KAG-library document upload is workspace-scoped by default: a document
-- uploaded without a project (`project_id = NULL`) becomes tenant-wide
-- knowledge usable by every workflow. The drizzle schema already declares
-- `documents.project_id` nullable, and fresh CI databases (built via
-- `drizzle-kit push` from the schema) match — but the long-lived prod table
-- was originally created with a NOT NULL constraint, so a workspace upload
-- failed with `null value in column "project_id" violates not-null constraint`
-- (HTTP 500). Drop the constraint so prod matches the schema.
--
-- Idempotent (DROP NOT NULL on an already-nullable column is a no-op).
-- Pre-prod, forward-only.

BEGIN;

ALTER TABLE documents
  ALTER COLUMN project_id DROP NOT NULL;

COMMIT;
