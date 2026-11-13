-- Migration: Plan 3 — kaizen_candidates table
-- Date: 2026-04-28
-- Reason: When the agent encounters a request that has no matching n8n
--         workflow / procedure, it logs a Kaizen candidate so the work can
--         later be codified into a real workflow. Foundation spec §7.3
--         tool 9 (`log-kaizen-candidate`). Promotion to a real artifact is
--         improvement Plan 5 territory; this table is the seed.

CREATE TABLE IF NOT EXISTS kaizen_candidates (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT NOT NULL,
    user_id         UUID NOT NULL,
    thread_id       TEXT,
    ad_hoc_summary  TEXT NOT NULL,
    payload         JSONB NOT NULL DEFAULT '{}'::jsonb,
    status          TEXT NOT NULL DEFAULT 'new',
    created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Tenant-scoped queue listings.
CREATE INDEX IF NOT EXISTS idx_kaizen_candidates_tenant_status
    ON kaizen_candidates(tenant_id, status, created_at DESC);

-- Per-user "my candidates" filter.
CREATE INDEX IF NOT EXISTS idx_kaizen_candidates_user
    ON kaizen_candidates(user_id, created_at DESC);
