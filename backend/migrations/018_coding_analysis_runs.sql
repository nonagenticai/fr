-- 018_coding_analysis_runs.sql
--
-- Slice: 2026-04-24-coding-analysis-ui (Wave 1 Slice 2).
-- Plan:  2026-04-25-coding-analysis-implementation.md.
--
-- Persists FR-side `coding.*` analysis-job state. The upstream coding-gateway
-- has heterogeneous job models per service (security/dependencies/bug_hunt key
-- on container_name; quality returns a task_id; tests are synchronous), so FR
-- mints its own ULID job id and stores the upstream identifier (when one
-- exists) in `upstream_id`. Findings live on the row's `findings_json` blob —
-- normalized to the FR Finding envelope at the adapter layer (slice §
-- "Normalized envelopes"). The untouched upstream payload lives in `raw_json`
-- for forward-compat and deep-dive tooling.
--
-- Idempotency:
--   The (project_id, repo_id, type, client_idempotency_key) tuple is the
--   10-minute dedup window the spec §"Error mapping" 409 rule names. The
--   adapter checks for a row inserted within `now() - interval '10 minutes'`
--   and returns it instead of triggering a new run. The registry's own
--   idempotency layer (E-2 / E-4) covers the simultaneous-double-call case;
--   this column covers the cross-process / replay case.
--
-- Repositories add a nullable `container_name text` column so the adapter can
-- resolve an FR repo_id to the upstream container identifier. NULL means
-- "not onboarded to coding service" — the adapter raises
-- REPO_NOT_ONBOARDED before any gateway call.

ALTER TABLE repositories
  ADD COLUMN IF NOT EXISTS container_name TEXT;

CREATE TABLE IF NOT EXISTS coding_analysis_runs (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                  UUID NOT NULL,
  project_id               UUID,
  repo_id                  UUID NOT NULL,
  container_name           TEXT NOT NULL,
  type                     TEXT NOT NULL CHECK (
    type IN ('security', 'bug_hunt', 'quality', 'dependencies', 'tests')
  ),
  status                   TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')
  ),
  upstream_id              TEXT,
  correlation_id           TEXT NOT NULL,
  client_idempotency_key   TEXT NOT NULL,
  options_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
  findings_json            JSONB,
  findings_count           INTEGER,
  raw_json                 JSONB,
  error_code               TEXT,
  error_message            TEXT,
  started_at               TIMESTAMPTZ,
  finished_at              TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_coding_runs_user_created
  ON coding_analysis_runs (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_coding_runs_repo_created
  ON coding_analysis_runs (repo_id, created_at DESC);

-- Idempotency lookup: the 10-min dedup window is computed at query time
-- against created_at; a partial index on (project_id, repo_id, type, key)
-- ordered by created_at DESC keeps the lookup cheap regardless of table size.
CREATE INDEX IF NOT EXISTS idx_coding_runs_idem
  ON coding_analysis_runs (
    project_id,
    repo_id,
    type,
    client_idempotency_key,
    created_at DESC
  );
