-- backend/migrations/123_project_request_lifecycle.sql
--
-- THE PROJECT REQUEST HAD NO STATE BETWEEN "SOMEONE TYPED IT" AND "IT IS A PROJECT".
--
-- ── WHAT EXISTS TODAY ─────────────────────────────────────────────────────────
--
-- `project_requests` (migration 079) is built end to end: 7 routes, a list page,
-- a detail page, and a free-text intake. Its status CHECK permits
--   ('draft', 'approved', 'rejected', 'promoted', 'failed')
-- but MEASURED on this tree, `approved` IS NEVER WRITTEN. It appears only as a
-- `history` action label (routes/project-requests.ts:599). The live machine is
--   draft -> (patch, draft) -> promoted | failed | rejected
-- i.e. a request is a project the instant a human clicks approve, and the
-- analysis that decides WHAT the project should be has nowhere to happen.
--
-- ⭐ SO `approved` IS A DEAD ENUM SLOT THE CONSTRAINT ALREADY BLESSES, and it is
-- exactly the state the two-stage model needs: OUTLINE AGREED, PROJECT NOT YET
-- CREATED. This migration does not invent it; it gives it its meaning and adds
-- the four states around it.
--
-- ── THE TWO STAGES, AND WHY THE SPLIT IS THE POINT ────────────────────────────
--
-- One schema (`ProjectCreateSchema`) and one form conflate two different moments:
--
--   Stage A — the REQUEST. What a customer can actually know when they ask: the
--     problem, the outcome, which repos, constraints, dependencies, risks.
--   Stage B — the OUTLINE. What is AGREED after analysis: deliverables,
--     intermediate deliverables, milestones, effort. The agent proposes it; the
--     user approves or amends it. A user cannot author this up front, and asking
--     them to is why the form grew ~50 fields of which 21 are read by nothing.
--
-- ── WHY `project_outlines` IS A TYPED TABLE AND NOT `approvals.metadata` ──────
--
-- ⛔ THE CHEAP MOVE IS THE ONE THIS WHOLE UNIT EXISTS TO DELETE. The outline
-- could ride as a jsonb blob inside the approval row that decides it. That is
-- precisely the write-only shape — a value the schema accepts, nothing reads by
-- name, and no test can miss. 21 fields arrived in `projects.project_data` that
-- way. The content gets named columns; only the DECISION lives in `approvals`.
--
-- ── WHY THE DECISION *DOES* REUSE `approvals` ─────────────────────────────────
--
-- ⭐ `approvals` already fits, and building a second decision mechanism beside it
-- would be the actual mistake. MEASURED: `approvals.project_id` is NULLABLE
-- (schema.ts:450), `kind` is an extensible enum (:455), and `callback_path`
-- (:462) already gives the deciding agent a resume hook — the whole
-- PUT /api/approvals/:id path (routes/approvals.ts:1898) writes
-- `approval_decisions`, flips status under an optimistic lock, broadcasts over
-- WS, and fires the n8n decision callback.
--
-- The ONE thing it cannot do is hang off a request instead of a project: all
-- three raise sites require an existing project row. Hence `project_request_id`
-- below — one nullable column, not a parallel mechanism.
--
-- ⚠️ IT IS NULLABLE AND MUST STAY SO. Every approval raised today has no request,
-- and an outline approval has no project YET. A NOT NULL on either side would
-- make one of the two populations unrepresentable.
--
-- ── WHY REPOSITORIES GET THEIR OWN TABLE ──────────────────────────────────────
--
-- The form offers a `multi_repo` scope level and then gives the user ONE repo
-- field — the literal defect reported. `project_repositories` (migration 072)
-- already stores N repos per PROJECT, but a request has no project yet, so
-- Stage A has nowhere to put the second repo. `project_request_repositories` is
-- that place, and it carries the access verdict too.
--
-- ⚠️ `access_state` IS ADVISORY AND MUST NOT BECOME A GATE. It records whether we
-- could actually read the repo when we looked. A red verdict warns; it never
-- blocks submit. A verification that blocks is a verification that gets disabled
-- the first time GitHub rate-limits us, and then it protects nothing at all.
-- `unknown` is the honest default: not checked is not the same as not readable.
--
-- ── SHAPE: DDL ONLY ───────────────────────────────────────────────────────────
--
-- CREATE TABLE / ADD COLUMN / DROP+ADD CONSTRAINT. No INSERT, no UPDATE, no
-- DELETE, no TRUNCATE, no trigger, no function — so per
-- scripts/check-migration-dml-probed.ts this needs neither a COLUMN_PROBES entry
-- in src/db/migration-runner.ts nor the `NOT PROBED, DELIBERATELY` annotation.
--
-- ⛔ src/db/schema.ts AND THIS FILE ARE TWO EMITTERS OF ONE SHAPE. CI builds its
-- database with `drizzle-kit push` from schema.ts; a real database takes it from
-- here. Landing the widened CHECK in only one of them passes the suite in one
-- environment and 23514s every lifecycle write in the other — the failure
-- migration 113 shipped once and 119's and 122's headers both record.
--
-- ⚠️ THE CHECK IS DROPPED AND RE-ADDED, WHICH IS NOT A NO-OP ON A LIVE TABLE.
-- It is additive in effect (every currently-permitted value stays permitted), so
-- no existing row can violate the new constraint and the re-add cannot fail on
-- data. It takes a brief ACCESS EXCLUSIVE lock; `project_requests` is a
-- low-traffic human-driven table, so this is milliseconds, not an outage.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

-- ── 1. the lifecycle states ──────────────────────────────────────────────────

ALTER TABLE project_requests DROP CONSTRAINT IF EXISTS project_requests_status_check;

ALTER TABLE project_requests ADD CONSTRAINT project_requests_status_check
  CHECK (status IN (
    'draft',            -- being written; the only editable state
    'submitted',        -- the user is done; analysis not yet dispatched
    'analysing',        -- dispatched to the agent, awaiting an outline
    'outline_proposed', -- an outline exists and is awaiting a human decision
    'approved',         -- outline agreed; the project has NOT been created yet
    'promoted',         -- the project row exists (terminal, success)
    'rejected',         -- a human said no (terminal)
    'withdrawn',        -- the requester took it back (terminal)
    'failed'            -- creation or analysis errored; retryable
  ));

ALTER TABLE project_requests
  ADD COLUMN IF NOT EXISTS submitted_at TIMESTAMPTZ;

COMMENT ON COLUMN project_requests.submitted_at IS
  'WHEN the requester declared the request finished (draft -> submitted). '
  'NULL for a request still being drafted. Distinct from created_at, which is '
  'when the row appeared -- a CommonPractice-bridged or free-text-intake request '
  'is created already populated but is not submitted until a human says so.';

-- ── 2. N repositories per REQUEST ────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_request_repositories (
  request_id        UUID        NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
  position          INTEGER     NOT NULL,
  url               TEXT        NOT NULL,
  branch            TEXT,
  path              TEXT,
  name              TEXT,
  is_primary        BOOLEAN     NOT NULL DEFAULT FALSE,
  access_state      TEXT        NOT NULL DEFAULT 'unknown',
  access_detail     TEXT,
  access_checked_at TIMESTAMPTZ,
  PRIMARY KEY (request_id, position),
  CONSTRAINT project_request_repositories_access_state_check
    CHECK (access_state IN ('unknown', 'public', 'private_granted', 'private_ungranted', 'error'))
);

-- Exactly one primary per request. Mirrors the partial unique index
-- `project_repositories` uses (migration 072) so the two tables cannot disagree
-- about what "primary" means.
CREATE UNIQUE INDEX IF NOT EXISTS project_request_repositories_one_primary_idx
  ON project_request_repositories (request_id) WHERE is_primary;

COMMENT ON TABLE project_request_repositories IS
  'The repositories a Stage-A request names, BEFORE any project exists. '
  'Promoted into project_repositories (migration 072) at approval. Exists '
  'because the form offers a multi_repo scope level and the request row had '
  'nowhere to put the second repo.';

COMMENT ON COLUMN project_request_repositories.access_state IS
  'ADVISORY verdict from actually attempting to read the repo -- never a gate. '
  '`unknown` means NOT YET CHECKED, which is not the same as not readable; that '
  'distinction is why the default is unknown and not error. A red verdict warns '
  'the user and lets them submit anyway (product decision, 2026-09-21): a check '
  'that blocks submit is a check that gets switched off the first time GitHub '
  'rate-limits us, after which it protects nothing.';

-- ── 3. the outline (Stage B), versioned ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_outlines (
  id                        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  request_id                UUID        NOT NULL REFERENCES project_requests(id) ON DELETE CASCADE,
  version                   INTEGER     NOT NULL,
  status                    TEXT        NOT NULL DEFAULT 'proposed',
  summary                   TEXT,
  deliverables              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  intermediate_deliverables JSONB       NOT NULL DEFAULT '[]'::jsonb,
  milestones                JSONB       NOT NULL DEFAULT '[]'::jsonb,
  effort_estimate           JSONB,
  cost_estimate             JSONB,
  approval_id               UUID        REFERENCES approvals(id) ON DELETE SET NULL,
  proposed_by               TEXT,
  proposed_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_by                UUID,
  decided_at                TIMESTAMPTZ,
  decision_note             TEXT,
  UNIQUE (request_id, version),
  CONSTRAINT project_outlines_status_check
    CHECK (status IN ('proposed', 'superseded', 'approved', 'rejected'))
);

-- At most one outline may be awaiting a decision at a time. Without this, an
-- agent re-delivering an outline (a retry, a duplicate webhook) silently raises
-- a SECOND approval for the same request and the user decides a version that is
-- no longer current.
CREATE UNIQUE INDEX IF NOT EXISTS project_outlines_one_live_idx
  ON project_outlines (request_id) WHERE status = 'proposed';

CREATE INDEX IF NOT EXISTS project_outlines_request_idx
  ON project_outlines (request_id);

COMMENT ON TABLE project_outlines IS
  'Stage B: what is AGREED after analysis -- deliverables, intermediate '
  'deliverables, milestones, effort. Proposed by the agent, decided by a human. '
  'VERSIONED so an amendment round-trip is auditable rather than destructive. '
  'The content lives here in named columns; the DECISION lives in approvals '
  '(approval_id). Deliberately NOT stuffed into approvals.metadata -- an untyped '
  'blob nothing reads by name is the exact write-only defect this unit removes.';

COMMENT ON COLUMN project_outlines.cost_estimate IS
  'The agent''s PROPOSED cost, clearly an estimate. ⚠️ NOT a tracked budget: '
  'billing_service carries no project_id on any event or rollup table, and fr '
  'stamps project_id onto the request stream (billing_metering_events), which '
  'has no token or cost columns at all. Per-project SPEND is a separate '
  'multi-repo unit; nothing here should be presented to a user as money spent.';

-- ── 4. let an approval hang off a REQUEST, not only a project ────────────────

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS project_request_id UUID REFERENCES project_requests(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS approvals_project_request_idx
  ON approvals (project_request_id) WHERE project_request_id IS NOT NULL;

COMMENT ON COLUMN approvals.project_request_id IS
  'The project REQUEST this approval decides, for kind = project_outline.approval. '
  'NULL for every other approval, which is the overwhelming majority -- all three '
  'pre-existing raise sites require an existing project. NULLABLE ON BOTH SIDES BY '
  'DESIGN: an ordinary approval has no request, and an outline approval has no '
  'project yet, so a NOT NULL on either column would make one population '
  'unrepresentable. This column exists so the outline decision can reuse the '
  'approvals machinery (decisions, optimistic locking, WS broadcast, n8n callback) '
  'instead of growing a second decision mechanism beside it.';

-- ── 5. the approval kind that decides an outline ─────────────────────────────
--
-- ALTER TYPE ... ADD VALUE is committed here and only referenced by later
-- runtime transactions (an approval INSERT), never in the same txn — the same
-- constraint migrations 059, 066, 073 and 086 each record. IF NOT EXISTS makes
-- the file re-runnable.
ALTER TYPE approval_kind ADD VALUE IF NOT EXISTS 'project_outline.approval';
