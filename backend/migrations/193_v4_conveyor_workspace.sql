-- Migration: 193_v4_conveyor_workspace
-- Date: 2026-10-14
--
-- The v4 conveyor tenant aaaaaaaa-0000-4000-8000-0000000000a6
-- (svc-n8n-local-conveyor; every cluster n8n conveyor credential holds a licence
-- for it) is a PLATFORM tenant (V4_CONVEYOR_TENANT_ID in
-- backend/src/middleware/internal-tenant-only.ts, George 10-14) so a super_admin
-- can switch into it (X-Active-Tenant) and decide the approvals the conveyor's
-- ask_fr mints there. The switcher (lib/accessible-tenants.ts source 2) and the
-- /api/me/approval-workspaces hint offer a SUPER_ADMIN_SWITCHABLE_IDS entry ONLY
-- when a `workspaces` row exists for it, and production had none (measured
-- 2026-10-14: 12 rows, the v4 conveyor tenant absent) — so this row is what makes the tenant
-- reachable from the UI, not only by a hand-set header.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. Probed in src/db/migration-runner.ts
-- (row exists) with reapplyIfProbeFails, because `drizzle-kit push` cannot
-- reproduce an INSERT.

INSERT INTO workspaces (id, name, created_at)
VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a6', 'conveyor (v4)', NOW())
ON CONFLICT (id) DO NOTHING;
