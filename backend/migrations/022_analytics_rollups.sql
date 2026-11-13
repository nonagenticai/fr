-- 022_analytics_rollups.sql
--
-- Slice: 2026-04-24-analytics-page §8.1 "Rollup table schema"
--
-- Materialized rollup tables for the FR Analytics surface (Wave 3). The
-- rollup worker (`backend/src/workers/analytics-rollup.ts`) writes one row
-- per (tenant, project, user, bucket, metric, initiator, channel, dims)
-- tuple every 5 minutes; the routes under `/api/tools/analytics/*` read
-- only from this table — never from Prometheus directly.
--
-- The spec proposes file `011_analytics_rollups.sql`; the live tree has
-- already advanced to 021 so we land at 022 instead. Same schema.

CREATE TABLE IF NOT EXISTS analytics_rollups (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       TEXT        NOT NULL,
    project_id      UUID        NULL,
    user_id         UUID        NULL,
    bucket_ts       TIMESTAMPTZ NOT NULL,
    bucket_size     TEXT        NOT NULL,         -- '5m' | '1h' | '1d' | '1w'
    metric_name     TEXT        NOT NULL,
    initiator       TEXT        NOT NULL DEFAULT 'unknown',
    channel         TEXT        NOT NULL DEFAULT 'unknown',
    value           NUMERIC     NOT NULL,
    dimensions      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Per spec §8.1: idempotent upsert key. NULL semantics matter for project_id
-- and user_id (NULL = aggregate). Postgres distinct-with-nulls behavior is
-- handled with COALESCE on the unique index.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_analytics_rollups_bucket
    ON analytics_rollups (
        tenant_id,
        COALESCE(project_id, '00000000-0000-0000-0000-000000000000'::uuid),
        COALESCE(user_id,    '00000000-0000-0000-0000-000000000000'::uuid),
        bucket_ts,
        bucket_size,
        metric_name,
        initiator,
        channel,
        dimensions
    );

CREATE INDEX IF NOT EXISTS idx_analytics_rollups_tenant_project_bucket
    ON analytics_rollups (tenant_id, project_id, bucket_ts);

CREATE INDEX IF NOT EXISTS idx_analytics_rollups_metric_bucket
    ON analytics_rollups (metric_name, bucket_ts);

CREATE INDEX IF NOT EXISTS idx_analytics_rollups_bucket_ts
    ON analytics_rollups (bucket_ts);

-- Worker telemetry / staleness signal. Single row per tick name.
CREATE TABLE IF NOT EXISTS analytics_rollup_meta (
    tick_name        TEXT PRIMARY KEY,
    last_success     TIMESTAMPTZ,
    last_outcome     TEXT,                    -- 'ok' | 'partial' | 'failed'
    last_error       TEXT,
    metrics_written  INTEGER NOT NULL DEFAULT 0,
    prom_queries     INTEGER NOT NULL DEFAULT 0,
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
