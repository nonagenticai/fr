-- Migration: 026_streams — improvement-stream registry
-- Date: 2026-04-28
-- Slice: 2026-04-27-continuous-improvement-design (Plan 3)
--
-- A "stream" is a tenant-owned bundle of similar assets (workflows OR
-- prompts) that share a Planka improvement board, threshold rules, an
-- optional eval set, and an optional owning department. The continuous-
-- improvement detector materializes a card on the stream's board when an
-- asset within the stream breaches its rules; the manual-trigger endpoint
-- lets operators force the same flow without waiting for the detector.
--
-- Forward-only / additive. Re-runnable via the idempotent migration
-- runner (see src/db/migration-runner.ts) — every CREATE here uses
-- IF NOT EXISTS / DO $$ guards.
--
-- Notes
--   * `stream_kind` is the categorical split between workflow and prompt
--     improvement streams. New kinds (e.g. 'principle') will land as a
--     follow-up ALTER TYPE … ADD VALUE in a future migration.
--   * `asset_kind` is the union over every type of asset that can be a
--     stream member OR can be the subject of a continuous-improvement
--     card. Listed exhaustively here even though only a subset participate
--     in stream membership today, so the FK target is stable.
--   * `streams.threshold_rules` defaults to the empty JSON object at the
--     DB level; the create-stream HANDLER fills in the standard rule set
--     (p95_latency / failure_rate / fallback_rate / cost_per_exec /
--     bounce_rate) — keeping the default in code rather than in DDL means
--     tweaking the rule set doesn't require a migration churn.

-- Per the migration-runner contract (sequential, transactional, advisory-
-- locked), idempotency comes from the runner's _migrations bookkeeping
-- table — but DO NOT rely on `CREATE TYPE IF NOT EXISTS` because Postgres
-- 18 still doesn't support it (only the table form). Wrap the type
-- creation in a DO block that swallows duplicate_object so a manual
-- re-run never breaks.

DO $$
BEGIN
    CREATE TYPE stream_kind AS ENUM ('workflow', 'prompt');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END$$;

DO $$
BEGIN
    CREATE TYPE asset_kind AS ENUM (
        'workflow',
        'prompt',
        'kag_source',
        'coding_repository',
        'requirement',
        'principle',
        'decision',
        'procedure',
        'artifact'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END$$;

CREATE TABLE IF NOT EXISTS streams (
    id                  UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id           UUID         NOT NULL,
    kind                stream_kind  NOT NULL,
    name                TEXT         NOT NULL,
    -- planka_project_id / planka_board_id are TEXT (not UUID) to mirror
    -- the existing `projects` table convention — Planka returns string ids
    -- for both, and the kanban integration here pumps them around as
    -- strings end-to-end.
    planka_project_id   TEXT         NOT NULL,
    planka_board_id     TEXT         NOT NULL,
    threshold_rules     JSONB        NOT NULL DEFAULT '{}'::jsonb,
    eval_set_id         UUID         NULL,
    owner_dept_id       UUID         NULL,
    min_significance_n  INTEGER      NOT NULL DEFAULT 30,
    is_active           BOOLEAN      NOT NULL DEFAULT TRUE,
    created_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at          TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Hot-path query: "list active streams for tenant T, optionally filtered
-- by kind". Partial index on is_active keeps the index small (soft-deleted
-- streams stay in the table forever for audit but never need to be scanned).
CREATE INDEX IF NOT EXISTS streams_tenant_active
    ON streams (tenant_id, kind)
    WHERE is_active;

CREATE TABLE IF NOT EXISTS asset_stream_membership (
    asset_kind  asset_kind   NOT NULL,
    asset_id    UUID         NOT NULL,
    stream_id   UUID         NOT NULL REFERENCES streams(id) ON DELETE CASCADE,
    added_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (asset_kind, asset_id, stream_id)
);

-- Reverse-lookup index: "list members of stream S" path used by the GET
-- /api/assets/streams/:id/members handler.
CREATE INDEX IF NOT EXISTS asset_stream_membership_stream
    ON asset_stream_membership (stream_id);

CREATE TABLE IF NOT EXISTS tenant_improvement_projects (
    tenant_id          UUID         NOT NULL,
    kind               stream_kind  NOT NULL,
    -- TEXT to match streams.planka_project_id (Planka returns string ids).
    planka_project_id  TEXT         NOT NULL,
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    PRIMARY KEY (tenant_id, kind)
);
