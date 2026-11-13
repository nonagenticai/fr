-- Migration: 080_project_reports_tenant_id — tenant-scope project_reports
-- Date: 2026-06-14
-- Spec ref: fr security audit — cross-tenant IDOR in GET /api/reports and
-- GET /api/reports/:reportId (handleListReports / handleGetReport,
-- src/routes/reports.ts). Both read project_reports with NO tenant predicate,
-- so any authenticated user could list or fetch any tenant's reports
-- (status/quality/dependency/security summaries + JSONB details).
--
-- The fix adds a tenant_id column so the read paths can filter by the caller's
-- tenant. Mirrors migration 047 (approvals_tenant_id): add nullable column,
-- backfill via the project → department → workspace chain (workspaces.id IS the
-- tenant_id) with a planka_board_id fallback, then index tenant-leading.
--
-- DELIBERATE DIVERGENCE FROM 047: project_reports.project_id is nullable and
-- some rows carry only a Planka card_id/board_id that maps to no FR project or
-- stream, so they CANNOT be attributed to a tenant. We therefore:
--   * keep tenant_id NULLABLE (do NOT promote to NOT NULL),
--   * do NOT RAISE on un-backfillable rows (RAISE NOTICE the count instead),
--   * do NOT delete the orphan rows (non-destructive).
-- Once the read paths filter on tenant_id, NULL-tenant rows are fail-closed:
-- invisible to every tenant rather than leaked. The write path
-- (handleN8nReport) derives tenant_id going forward; only legacy/edge rows
-- stay NULL.
--
-- Forward-only / additive. Idempotent via IF NOT EXISTS. Wrapped in
-- BEGIN/COMMIT (the runner strips them and supplies its own transaction).

BEGIN;

-- 1. Add the nullable column (stays nullable — see header).
ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS tenant_id UUID;

-- 2. Backfill, most-reliable source first. All passes guard on tenant_id IS NULL.
--
-- Pass A — project-scoped: project_id → projects.dept_id → departments.workspace_id.
-- workspaces.id IS the tenant_id throughout the codebase (streams, user_roles,
-- approvals, etc.). dept_id is nullable in production, so this INNER JOIN
-- skips workspace-scope projects (no dept); those fall through to NULL, which
-- is acceptable — a report whose project has no department cannot be assigned
-- a single tenant via this chain (the report stays fail-closed-invisible).
UPDATE project_reports r
   SET tenant_id = d.workspace_id
  FROM projects p
  JOIN departments d ON d.id = p.dept_id
 WHERE r.tenant_id IS NULL
   AND r.project_id = p.id;

-- Pass A2 — dept-less projects: dept_id IS NULL (legacy / workspace-scope),
-- whose authoritative tenant is stamped on projects.project_data
-- ->>'keycloak_tenant_id' (see routes/projects.ts — the same field the project
-- board's keycloak_tenant_id custom field carries). UUID-format guarded so one
-- malformed value can't abort the whole migration.
UPDATE project_reports r
   SET tenant_id = (p.project_data->>'keycloak_tenant_id')::uuid
  FROM projects p
 WHERE r.tenant_id IS NULL
   AND r.project_id = p.id
   AND p.project_data->>'keycloak_tenant_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

-- Pass B — board fallback (project boards): rows with no resolvable project_id
-- but a board_id that maps to a known FR project's planka_board_id.
-- Mirrors resolveCardApprovalTenant (src/routes/webhooks.ts) + migration 047 Pass C.
UPDATE project_reports r
   SET tenant_id = d.workspace_id
  FROM projects p
  JOIN departments d ON d.id = p.dept_id
 WHERE r.tenant_id IS NULL
   AND r.board_id IS NOT NULL
   AND p.planka_board_id = r.board_id;

-- Pass C — board fallback (improvement-stream boards): board_id maps to a
-- stream's planka_board_id; streams are tenant-owned (migration 026).
UPDATE project_reports r
   SET tenant_id = s.tenant_id
  FROM streams s
 WHERE r.tenant_id IS NULL
   AND r.board_id IS NOT NULL
   AND s.planka_board_id = r.board_id;

-- 3. Report (do NOT fail) how many rows could not be attributed to a tenant.
-- These rows stay NULL and are fail-closed-invisible once reads are scoped.
DO $$
DECLARE
  orphaned INT;
BEGIN
  SELECT COUNT(*) INTO orphaned FROM project_reports WHERE tenant_id IS NULL;
  IF orphaned > 0 THEN
    RAISE NOTICE
      'Migration 080: % project_reports rows have no resolvable tenant_id (no project_id chain, no board_id mapping). They remain NULL and are now invisible to every tenant (fail-closed). This is expected for legacy Planka-only reports — not an error.',
      orphaned;
  END IF;
END$$;

-- 4. Indexes (tenant-leading, mirroring the streams/approvals convention) so
-- the scoped list query (WHERE tenant_id = $1 ORDER BY created_at DESC) and the
-- per-project filter both use a covering scan.
CREATE INDEX IF NOT EXISTS project_reports_tenant_created_idx
    ON project_reports (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS project_reports_tenant_project_idx
    ON project_reports (tenant_id, project_id);

COMMIT;
