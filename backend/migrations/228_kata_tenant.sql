-- Migration: 228_kata_tenant
-- Date: 2026-11-03
--
-- The `kata` tenant (docs/design/kata-super-admin.md §3a, George 2026-11-03 Q2): ONE internal
-- workspace that holds every kata project. It replaces the three improvement tenants (…0002,
-- …0004, …0005, deleted by a later migration). It is a NEW id, deliberately not one of those
-- three: upstreams (RM, Planka, kag) may still hold rows keyed on the old ids, and reusing one
-- would make that stale data reappear inside the kata tenant.
--
-- KATA_TENANT_ID in backend/src/middleware/internal-tenant-only.ts. It is in INTERNAL_TENANT_IDS,
-- PLATFORM_TENANT_IDS and SUPER_ADMIN_SWITCHABLE_IDS; the switcher offers a switchable id only
-- when its `workspaces` row exists, so this row is what makes it reachable.
--
-- Idempotent: ON CONFLICT (id) DO NOTHING. Probed in src/db/migration-runner.ts (row exists) with
-- reapplyIfProbeFails, because `drizzle-kit push` cannot reproduce an INSERT (as 193).

INSERT INTO workspaces (id, name, created_at)
VALUES
  ('0195f48b-d000-7000-8000-000000000006', 'kata', NOW())
ON CONFLICT (id) DO NOTHING;
