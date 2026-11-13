-- Migration: 043_approvals_tenant_id — tenant-scope approvals + required_approvers
-- Date: 2026-05-01
-- Spec ref: PR #77 review — cross-tenant role-leak in /api/approvals?mine=1
-- (Renamed from 042 → 043 to avoid collision with main's 042_extend_trigger_run_status.sql.)
--
-- The problem: required_approvers.role is a plain text role (e.g. 'tech_lead')
-- shared across tenants. handleListMyApprovals matches via inArray(role, userRoles)
-- with no tenant predicate, so a tech_lead in tenant A can match a required-
-- approver row authored in tenant B. The 'SECURITY:' comment landed on PR #77
-- but the underlying schema gap was never closed.
--
-- This migration closes the gap by adding a NOT NULL tenant_id to both
-- approvals and required_approvers, backfilling from the most reliable
-- source available (stream metadata for improvement-* approvals; the
-- project → department → workspace chain for project-scoped approvals),
-- and failing loudly if any row cannot be backfilled (memory rule:
-- pre-prod, forward-only, fail loud — no name-mapping shims).
--
-- Forward-only / additive. Idempotent via IF NOT EXISTS. The DDL is wrapped
-- in BEGIN/COMMIT as a single transaction so a failure mid-migration leaves
-- the schema unchanged.

BEGIN;

-- 1. Add nullable columns first so we can backfill before flipping NOT NULL.
ALTER TABLE approvals          ADD COLUMN IF NOT EXISTS tenant_id UUID;
ALTER TABLE required_approvers ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- 2. Backfill approvals.tenant_id, two passes (most reliable source first).
--
-- Pass A — improvement-* kind: approvals.metadata->>'stream_id' is the
-- canonical link. Streams are tenant-owned (migration 026), so a join
-- through streams gives us the authoritative tenant for any approval
-- created via /api/improvement/approvals.
UPDATE approvals a
   SET tenant_id = s.tenant_id
  FROM streams s
 WHERE a.tenant_id IS NULL
   AND a.metadata->>'stream_id' IS NOT NULL
   AND s.id::text = a.metadata->>'stream_id';

-- Pass B — project-scoped: project_id → projects.dept_id → departments.workspace_id.
-- workspaces.id IS the tenant_id throughout the codebase (see streams,
-- user_roles, etc.).
UPDATE approvals a
   SET tenant_id = d.workspace_id
  FROM projects p
  JOIN departments d ON d.id = p.dept_id
 WHERE a.tenant_id IS NULL
   AND a.project_id = p.id;

-- Pass C — n8n card-approval kind: rows that came in via
-- POST /api/webhooks/n8n/card-approval before migration 043 carry only
-- `metadata.boardId`. Resolve via projects.planka_board_id (project-scoped)
-- first, then streams.planka_board_id (improvement-stream Planka boards).
-- Mirrors handleN8nCardApproval's runtime resolver in
-- src/routes/webhooks.ts (resolveCardApprovalTenant).
UPDATE approvals a
   SET tenant_id = d.workspace_id
  FROM projects p
  JOIN departments d ON d.id = p.dept_id
 WHERE a.tenant_id IS NULL
   AND a.metadata->>'boardId' IS NOT NULL
   AND p.planka_board_id = a.metadata->>'boardId';

UPDATE approvals a
   SET tenant_id = s.tenant_id
  FROM streams s
 WHERE a.tenant_id IS NULL
   AND a.metadata->>'boardId' IS NOT NULL
   AND s.planka_board_id = a.metadata->>'boardId';

-- 3. Backfill required_approvers.tenant_id from approvals (cascade after step 2).
UPDATE required_approvers ra
   SET tenant_id = a.tenant_id
  FROM approvals a
 WHERE ra.tenant_id IS NULL
   AND ra.approval_id = a.id;

-- 4. Strict check — fail loudly if any rows remain unbackfilled.
-- pre-prod, forward-only: no silent NULLs, no name-mapping fallback.
DO $$
DECLARE
  orphaned_approvals INT;
  orphaned_required  INT;
BEGIN
  SELECT COUNT(*) INTO orphaned_approvals FROM approvals          WHERE tenant_id IS NULL;
  SELECT COUNT(*) INTO orphaned_required  FROM required_approvers WHERE tenant_id IS NULL;

  IF orphaned_approvals > 0 THEN
    RAISE EXCEPTION
      'Migration 043: % approvals rows could not be backfilled with tenant_id (no stream_id in metadata, no project_id chain, no boardId mapping to projects.planka_board_id or streams.planka_board_id). Resolve before retrying.',
      orphaned_approvals;
  END IF;

  IF orphaned_required > 0 THEN
    RAISE EXCEPTION
      'Migration 043: % required_approvers rows could not be backfilled with tenant_id (parent approval lacks tenant_id). Resolve before retrying.',
      orphaned_required;
  END IF;
END$$;

-- 5. Promote both columns to NOT NULL now that the strict check has passed.
ALTER TABLE approvals          ALTER COLUMN tenant_id SET NOT NULL;
ALTER TABLE required_approvers ALTER COLUMN tenant_id SET NOT NULL;

-- 6. Indexes mirroring the streams convention (migration 026): leading
-- tenant_id so every tenant-scoped query can use a covering scan.
CREATE INDEX IF NOT EXISTS approvals_tenant_status_idx
    ON approvals (tenant_id, status);

CREATE INDEX IF NOT EXISTS required_approvers_tenant_role_idx
    ON required_approvers (tenant_id, role)
 WHERE role IS NOT NULL;

CREATE INDEX IF NOT EXISTS required_approvers_tenant_user_idx
    ON required_approvers (tenant_id, user_id);

COMMIT;
