-- 120 — `streams.project_id`: the column that makes a detector-minted card workable.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- MEASURED on prod 2026-09-13: 508 live cards carry a `project_id` that resolves
-- to no project at all, and every one of them was minted by the stream detector.
--
-- n8n_custom_nodes `workflows/detector-scan-streams.json`, node `Execute Card
-- Request Assembly Orchestrator`, passed
--     "project_id": "={{ $('Compose card payload').item.json.tenant_id }}"
-- — a TENANT id in the parameter every downstream hop reads as a PROJECT id. That
-- is not a cosmetic mislabel. `workflows/patterns/done-finalize.json` :: `Fetch
-- Project For Decomp` does `GET /api/projects/{project_id}` and reads
-- `repository_url` off the record; with a tenant id the fetch returns nothing, so
-- the card can never learn which repository to work on. `Emit Decomp Children` in
-- that same workflow then THROWS on the empty `repository_url` — so the card does
-- not fail at mint time, it fails a whole lifecycle later, blaming the project
-- fetch rather than the minter.
--
-- ⛔ THE BLOCKING SUB-PROBLEM WAS THAT THERE WAS NOWHERE ELSE FOR THE MINTER TO
-- READ IT FROM. Verified in the migration lineage (017 + 028/038/044/054/057/
-- 059/060/062/066) and against live `\d streams` on worker4: 19 columns, and NOT
-- ONE of them names an fr project. The minter was not choosing the wrong column —
-- it was choosing the only id it had.
--
-- ⚠️ `planka_project_id` IS NOT THIS COLUMN AND MUST NOT BE REUSED AS IT. It is
-- `text`, not `uuid`; it holds a PLANKA board-container id (017 and the schema.ts
-- comment both say so, mirroring `projects.planka_project_id`); and it has NO
-- foreign key to `projects`. Passing it to `GET /api/projects/{id}` 404s exactly
-- as the tenant id does. The `uuid REFERENCES projects(id)` below is what makes
-- the difference measurable rather than asserted: a wrong id can no longer be
-- stored at all.
--
-- ── WHY NULLABLE, AND WHAT NULLABLE DOES *NOT* LICENSE ─────────────────────
-- ⛔ NOT NULL IS IMPOSSIBLE HERE, AND NOT MERELY INCONVENIENT. All 18 live rows
-- have no answer to backfill from — there is no column, no join table and no
-- naming convention linking a stream to a project, so any backfill would be a
-- fabricated pairing, which is the same class of defect as the 508 cards. A NOT
-- NULL with no default would additionally fail every existing INSERT and break
-- stream creation outright.
--
-- ⛔ BUT NULLABLE IS NOT A LICENCE TO MINT A CARD ANYWAY, and this is the half
-- that is easy to get wrong. `services/improvement-cards/request-schema.ts:25`
-- validates `project_id: z.string().min(1)` — a plain non-empty string, NOT a
-- `.uuid()` and with no existence check — so an empty, fabricated or tenant-shaped
-- value is accepted with a 200 and then silently never resolves. That acceptance
-- is precisely the silence that produced the 508. The refusal therefore lives at
-- the MINT SITE: the detector's orchestrator expression now throws, naming the
-- stream and the remedy, when a stream has no project. A stream with a NULL
-- project_id is still EVALUATED (its lowUsage/noop findings are honest and cost
-- nothing); it just cannot mint.
--
-- ⚠️ CONSEQUENCE, STATED PLAINLY: until an operator points streams at projects,
-- the detector mints ZERO cards instead of unworkable ones. That is the intended
-- trade and it is reversible per stream:
--     UPDATE streams SET project_id = '<projects.id>' WHERE slug = '<stream slug>';
-- or `PATCH /api/assets/streams/{id}` with `{"project_id": "<uuid>"}`.
--
-- ── SHAPE: DDL ONLY, NO DML, SO NO RECEIPT ─────────────────────────────────
-- DELIBERATELY UNLIKE 113/114/117, which carry a `_migration_effects` receipt.
-- Those perform DML that `drizzle-kit push` cannot reproduce, so their probe has
-- to ask "did the statement RUN". This file adds a column and touches not one
-- row: there is no effect to receipt, and the property that must hold is simply
-- "the column is there". That is what the probe registered in
-- src/db/migration-runner.ts reads (`columnExists(sql, 'streams', 'project_id')`),
-- and it is true in BOTH environments for the right reason — a push-built CI
-- database gets the column from src/db/schema.ts, a migrated database from here.
--
-- ⛔ SO schema.ts AND THIS FILE MUST DECLARE THE SAME COLUMN. They are two
-- independent emitters, and a column added to only one passes the suite in one
-- environment while being absent in the other. ⚠️ AND `tsc` WILL NOT CATCH THE
-- MISS THAT MATTERS: `routes/assets/streams.ts :: shapeStream` is a hand-written
-- serializer that already silently drops `slug` and all three `andon_*` columns,
-- so a column present in Postgres, in drizzle and in `StreamRow` still does not
-- reach the API consumer unless it is named there too. The detector reads this
-- column through `GET /api/assets/streams` (the kaizen-discover node returns that
-- response verbatim — no field whitelist), so `shapeStream` is its last gate.
--
-- `ON DELETE SET NULL`, not CASCADE: deleting a project must not delete the
-- stream and its whole threshold/membership configuration. It returns the stream
-- to exactly the state every row is in today — evaluated, unable to mint — which
-- the mint site already refuses safely. Precedent: 055_agent_runtime_sessions_
-- project_id.sql:17, 068_scheduled_triggers_origin.sql:29, 069:33.
--
-- Idempotent, statement by statement:
--   * `ADD COLUMN IF NOT EXISTS` is a no-op on a second run;
--   * `CREATE INDEX IF NOT EXISTS` likewise;
--   * there is no INSERT, no UPDATE, no DELETE and no destructive ALTER anywhere
--     in the file, so a re-run is a no-op rather than a second effect.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

ALTER TABLE streams
  ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id) ON DELETE SET NULL;

-- Partial: the overwhelming majority of rows are NULL today, and the only queries
-- that use this column ask "which streams belong to project X" / join to projects.
CREATE INDEX IF NOT EXISTS idx_streams_project_id
  ON streams (project_id)
  WHERE project_id IS NOT NULL;

COMMENT ON COLUMN streams.project_id IS
  'The fr project (projects.id) whose repository this stream''s improvement work '
  'targets. Read by the stream detector and passed as the minted card''s project_id, '
  'from which done-finalize resolves repository_url via GET /api/projects/{id}. '
  'NULLable because no existing row has an answer to backfill from and a fabricated '
  'pairing would be worse than none — a stream with NULL here is still evaluated, it '
  'simply cannot mint a card (the detector refuses, naming the stream). '
  '⚠️ NOT the same as planka_project_id, which is a text Planka board-container id '
  'with no foreign key and 404s against /api/projects.';
