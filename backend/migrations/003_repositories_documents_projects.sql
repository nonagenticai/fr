-- Migration 003: Repositories table, Documents standalone, Projects JSONB expansion
-- Run: psql $DATABASE_URL -f backend/migrations/003_repositories_documents_projects.sql

BEGIN;

-- 1a. New repositories table
CREATE TABLE IF NOT EXISTS repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL,
  name TEXT,
  url TEXT NOT NULL,
  branch TEXT DEFAULT 'main',
  path TEXT,
  description TEXT,
  secret_id UUID REFERENCES user_secrets(id) ON DELETE SET NULL,
  created_at TIMESTAMP NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_repositories_user_id ON repositories(user_id);

-- 1b. Documents: nullable project_id, add user_id
ALTER TABLE documents ADD COLUMN IF NOT EXISTS user_id UUID;
UPDATE documents d SET user_id = p.owner_id FROM projects p WHERE d.project_id = p.id AND d.user_id IS NULL;
DELETE FROM documents WHERE user_id IS NULL;
ALTER TABLE documents ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE documents ALTER COLUMN project_id DROP NOT NULL;
CREATE INDEX IF NOT EXISTS idx_documents_user_id ON documents(user_id);

-- 1c. Projects: add JSONB + queryable columns
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_data JSONB;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_type TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS scope_level TEXT;

COMMIT;
