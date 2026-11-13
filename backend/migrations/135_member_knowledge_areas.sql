-- Migration: 135_member_knowledge_areas
-- Date: 2026-09-27
-- Lane notes: ~/.claude/plans/fr-s12-scratch/s12-members/NOTES.md
--
-- PER-MEMBER KNOWLEDGE AREAS, SO A CONSULTATION CAN BE ROUTED TO A HUMAN.
--
-- ── WHAT AN "AREA" IS, AND WHAT IT IS NOT ───────────────────────────────────
-- An area is a KNOWLEDGE DOMAIN used to pick who to ask — "for api questions
-- member A, for business decisions member B". It is NOT a job title, NOT a
-- RACI letter and NOT an access grant. Holding `architecture` here confers no
-- permission whatsoever; it says a human is the right person to consult.
--
-- ── WHY THIS IS NOT A NEW VALUE IN `user_roles.role` ────────────────────────
-- ⛔ `user_roles.role` is CHECK-locked by migration 104 to exactly
-- 'workspace-admin' | 'workspace-member', and 104's own header forbids
-- widening it without deciding what a new value means to
-- services/user-roles.ts. Every one of the ~13 gates that reads that table
-- reads it as AUTHORITY. Putting a knowledge area in the same column would
-- make `isWorkspaceAdminVia` and `listUsersByRole` answer a question they were
-- never asked, and the first symptom would be an authorization bug, not a
-- routing bug. Knowledge areas therefore get their own table.
--
-- ── THE VOCABULARY IS THE CONVEYOR'S OWN TAXONOMY ──────────────────────────
-- The 15 permitted values are exactly the `card_groups` keys of
-- src/services/improvement-cards/spec/card_type_descriptions.json (15 groups /
-- 80 card types — measured on this tree 2026-09-27), surfaced in TypeScript as
-- `CARD_GROUPS` in services/improvement-cards/card-types.ts. That is deliberate
-- and load-bearing: because the conveyor already stamps every card with a
-- card_type, `getCardGroup(card_type)` maps a question to an area with NO
-- human tagging step. A different vocabulary here would need one.
--
-- ⚠️ THE LIST BELOW IS AN UNAVOIDABLE LITERAL COPY of those 15 names — a CHECK
-- constraint cannot import a TypeScript module. It is NOT the only one:
-- CORRECTED 2026-09-27, this line said "the only literal copy in the system" and
-- `frontend/src/lib/utils/cardTypeColors.ts` already held a diverged 14-key copy
-- (no `meta_asset`, taken from the stale n8n catalog). See the four-copy
-- inventory in src/lib/knowledge-areas.ts. Each literal copy now has a test that
-- reds when it drifts from `CARD_GROUPS`; this one's is
-- `tests/unit/services/knowledge-areas-vocabulary.test.ts`. It was GENERATED from `Object.keys(CARD_GROUPS).sort()`, not typed,
-- and `tests/unit/services/knowledge-areas-vocabulary.test.ts` parses it back
-- out of this file and asserts equality with `CARD_GROUPS`. Adding a 16th group
-- to the JSON without editing this file turns that test RED. Do not "fix" a
-- mismatch by editing only one side. (fr#1251 / fr#1253 are the same defect
-- class: a vocabulary enumerated more than once, with the copies disagreeing
-- and the stale one winning.)
--
-- A CHECK and deliberately NOT a postgres enum, and deliberately not a seeded
-- lookup table — same reasoning as migration 104: adding a value to an enum is
-- a schema migration, and a seeded lookup table would be DML (needing a
-- migration-runner probe) plus a SECOND copy of the vocabulary that could
-- disagree with this one. A CHECK is alterable in one statement and reads
-- identically in \d output.
--
-- ── COLUMN CHOICES ─────────────────────────────────────────────────────────
-- * `user_id` is TEXT, not uuid, to match `user_roles.user_id` (schema.ts:1907
--   — also text). Membership is the population this table annotates; a uuid
--   column here would refuse exactly the legacy non-uuid Keycloak subjects
--   `user_roles` accepts, so the directory and its areas would disagree about
--   who exists. ⚠️ `project_stakeholders.user_id` IS uuid — that asymmetry is
--   pre-existing (migration 074) and is why the project-allocation route
--   shape-checks the id before writing there.
-- * `(tenant_id, user_id, area)` is the PRIMARY KEY, so a member may hold
--   SEVERAL areas and re-recording an area is an upsert, not a duplicate. The
--   write path is a full-set replacement and gets its idempotency from this.
-- * ⛔ NO FOREIGN KEY on `tenant_id`. The obvious target is `workspaces(id)`,
--   and it is wrong. MEASURED on the prod primary (worker4, direct, 2026-09-27):
--   `user_roles` holds 13 grants across 13 distinct tenants; `workspaces` holds
--   10 rows; and 8 of those 13 tenants have NO `workspaces` row at all. A FK
--   would therefore refuse a legitimate write for 8 of 13 LIVE tenants. (The
--   10 non-zero `workspaces` rows are the control: the join works, those 8 are
--   genuinely absent.) The row is worthless without a matching `user_roles`
--   grant anyway, and THAT is checked on the write path, where it can return a
--   diagnosis instead of a constraint violation.
-- * `assigned_by` is text and nullable: the same shape as
--   `user_roles.granted_by`, for the same reason (system/bootstrap writers).
--
-- Additive, forward-only, pure DDL, idempotent on re-run. No DML, so
-- scripts/check-migration-dml-probed.ts needs nothing here; a
-- `tableExists('member_knowledge_areas')` probe is registered in
-- src/db/migration-runner.ts the same way migration 074's is, so a database
-- whose `_migrations` ledger is empty self-heals instead of stamping this file
-- applied over a missing table.

CREATE TABLE IF NOT EXISTS member_knowledge_areas (
  tenant_id   uuid        NOT NULL,
  user_id     text        NOT NULL,
  area        text        NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  assigned_by text,
  -- ⚠️ THE CONSTRAINT IS NAMED EXPLICITLY, matching what `drizzle-kit` emits for
  -- the same `primaryKey({...})` in db/schema.ts
  -- (`member_knowledge_areas_tenant_id_user_id_area_pk`). Left unnamed, postgres
  -- would call it `member_knowledge_areas_pkey` here and drizzle would call it
  -- the longer name in CI — the SAME key under two names, in two databases, which
  -- is exactly the kind of gratuitous divergence that makes a future probe or
  -- `\d` comparison read as drift. MEASURED: `drizzle-kit generate` from
  -- schema.ts emits the long name (2026-09-27).
  CONSTRAINT member_knowledge_areas_tenant_id_user_id_area_pk
    PRIMARY KEY (tenant_id, user_id, area),
  CONSTRAINT member_knowledge_areas_area_check CHECK (area IN (
    'analysis', 'architecture', 'bddtdd', 'change_management', 'design',
    'development', 'kaizen', 'meta_asset', 'meta_procedure', 'meta_prompt',
    'program_management', 'project_management', 'refactoring', 'research',
    'testing'
  ))
);

-- The directory read: "every area held by every member of this tenant", which
-- is one query per GET /api/tenant/members. The PK's leading column already
-- serves it, so this index exists for the REVERSE lookup the routing consumer
-- will need — "who in this tenant knows about `architecture`" — which the PK
-- cannot answer without a full scan.
CREATE INDEX IF NOT EXISTS member_knowledge_areas_tenant_area_idx
  ON member_knowledge_areas (tenant_id, area);
