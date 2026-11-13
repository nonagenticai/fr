-- Migration: 079_project_requests
-- Date: 2026-06-13
-- Plan ref: ~/.claude/plans/spec3-written-and-cosmic-cloud.md
--           (commonpractice PLAN-PHASE5.D.md § "fr-side work")
--
-- The CP→fr bridge RECEIVING half. Common Practice forwards a winning solution
-- to fr as a DRAFT `project_request` (POST /api/project-requests) that a human
-- reviews/edits/approves in fr before fr/n8n/kanban act. This is NOT a project:
-- it carries the canonical, fr-mapped ProjectCreate payload + CP provenance and
-- stays inert (no Planka board, no n8n) until a human approves it — at which
-- point `createProjectCore` runs and a real `projects` row is born, identical to
-- POST /api/projects (the approval moves the intake card TODO→READY, firing n8n).
--
-- Distinct from `card_drafts` (tool-output → kanban-card staging): this is
-- project INTAKE, keyed by the upstream system's id for idempotency.
--
-- Idempotency: UNIQUE(tenant_id, external_ref). A re-POST of the same
-- (tenant, external_ref) updates a `draft`/`failed` row or reopens a `rejected`
-- one; a `promoted` row is immutable (the intake route returns 409 + project_id).
-- Pre-prod, forward-only.

BEGIN;

CREATE TABLE IF NOT EXISTS project_requests (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Resolved tenant uuid (fr edge license-authz rewrites the inbound
  -- X-Tenant-Id: Bearer <license token> to the tenant before the route sees it).
  tenant_id        uuid        NOT NULL,
  -- Upstream system label, e.g. 'commonpractice' (from external_origin.source).
  source           text        NOT NULL,
  -- Upstream record id used for idempotency (CP sends provenance.cp_solution_id).
  external_ref     text        NOT NULL,
  -- First-class provenance fr indexes/links on (CP ids + initiator + votes).
  external_origin  jsonb,
  -- The canonical, fr-mapped ProjectCreate envelope a human edits before approve.
  payload          jsonb       NOT NULL,
  status           text        NOT NULL DEFAULT 'draft',
  rejection_reason text,
  -- Last createProjectCore failure (set when an approve attempt throws).
  error            text,
  -- The bridge call's X-Subject-Id (who triggered the forward upstream); nullable.
  created_by       uuid,
  -- The human who approved/rejected in fr.
  reviewed_by      uuid,
  -- The promoted project (set on approve); ON DELETE SET NULL so deleting the
  -- project doesn't orphan-delete the request audit trail.
  project_id       uuid        REFERENCES projects(id) ON DELETE SET NULL,
  -- Append-only audit of intake re-posts + edits + decisions.
  history          jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT project_requests_status_check
    CHECK (status IN ('draft', 'approved', 'rejected', 'promoted', 'failed')),
  CONSTRAINT project_requests_tenant_external_ref_unique
    UNIQUE (tenant_id, external_ref)
);

CREATE INDEX IF NOT EXISTS project_requests_tenant_status_idx
  ON project_requests (tenant_id, status);

COMMIT;
