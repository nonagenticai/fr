-- backend/migrations/130_finding_suppressions.sql
--
-- FINDING SUPPRESSION LEDGER.
--
-- The n8n conveyor's analysis cards (code_quality_analysis, security_analysis,
-- bug_analysis, …) emit findings with a stable fingerprint and spawn small fix
-- cards through POST /api/cards/project, passing that fingerprint as
-- `asset_id`. When a human or QA decides a finding is a FALSE POSITIVE, the
-- next analysis run must not re-create it. This table records that decision.
--
-- One row per (project, fingerprint). Written by
-- PUT /api/findings/suppressions (idempotent: ON CONFLICT DO NOTHING, the
-- existing row wins and is returned), read by POST /api/cards/project BEFORE
-- the dedupe lookup / create lease, which answers `{suppressed:true}` and
-- creates nothing.
--
-- ⛔ NOT a dedupe table. Open-card dedupe stays OPEN-scoped in Planka
-- (services/improvement-cards/dedup.ts :: findOpenCardForAsset): a card that
-- reaches DONE stops suppressing. A row HERE suppresses permanently until it is
-- deleted — that is the difference between "already being worked" and
-- "decided not to be a defect".
--
-- ⛔ KEYED ON THE PROJECT, NOT ON THE CALLER'S TENANT. A project can be
-- visible under TWO active tenants at once: its EXEC owner's home view
-- (dept_id NULL) and the aa-orchestrator acting for the customer tenant named
-- in project_data.keycloak_tenant_id. A (tenant, project, fingerprint) key let
-- the owner suppress under EXEC while the orchestrator, acting for the
-- customer tenant, still minted the card. A suppression is a fact about the
-- project's finding, so it follows the project; WHO may read/write it is
-- decided by the routes (project visibility + EXEC pin), never by the key.
--
-- recorded_tenant_id is the active tenant of the caller that RECORDED the
-- decision — audit only, never a lookup key. No FK, like every other tenant
-- column in fr.
--
-- Idempotent: CI bootstraps with `drizzle-kit push` (which creates the same
-- table from schema.ts :: findingSuppressions) and then stamps this file, so
-- every statement is IF NOT EXISTS. CREATE TABLE / COMMENT only — no DML, so
-- scripts/check-migration-dml-probed.ts needs no probe for it.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS finding_suppressions (
  project_id         uuid        NOT NULL,
  fingerprint        text        NOT NULL,
  recorded_tenant_id uuid        NOT NULL,
  reason             text        NOT NULL,
  card_id            text,
  decided_by         text        NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  -- Named explicitly so schema.ts (drizzle-kit push, CI) and this file (prod)
  -- emit the SAME constraint name. The PK's leading column serves every
  -- project_id lookup (list, isFindingSuppressed, the ON DELETE CASCADE).
  CONSTRAINT finding_suppressions_pkey PRIMARY KEY (project_id, fingerprint),
  -- drizzle-kit's default FK name, spelled out so both emitters agree.
  CONSTRAINT finding_suppressions_project_id_projects_id_fk
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
);

COMMENT ON TABLE finding_suppressions IS
  'Findings (by stable fingerprint = the asset_id passed to POST /api/cards/project) '
  'that a human/QA marked false-positive for a project. A suppressed fingerprint is '
  'never turned into a card again. Keyed on (project_id, fingerprint), never on the '
  'caller tenant; recorded_tenant_id is audit only. Not an open-card dedupe: that '
  'stays OPEN-scoped in Planka.';
