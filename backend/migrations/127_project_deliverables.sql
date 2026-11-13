-- backend/migrations/127_project_deliverables.sql
--
-- THE APPROVED SCOPE DIED AT THE MOMENT OF PROMOTION.
--
-- ── SCOPE: THIS TABLE IS DELIBERATELY fr-LOCAL ───────────────────────────────
--
-- ⛔ READ THIS BEFORE "CONNECTING" IT TO ANYTHING. A table called
-- `project_deliverables`, in a fleet that runs a project-management service,
-- reads like that service's missing half. It is not. The next session to touch
-- it will otherwise either wire it into `requirements_management` or delete it
-- as a duplicate, and both are wrong.
--
-- WHAT IT IS: the durable record of the scope a human APPROVED on an outline.
-- That is fr's own domain — fr owns `project_requests` and `project_outlines`
-- and owns the approval that decided them (migration 123). Today that answer to
-- "what did we agree to deliver" is LOST at promote, which is the entire defect
-- this file closes.
--
-- WHAT IT IS NOT: a work breakdown, and not a PM activity hierarchy. It holds no
-- FK to `requirements_management` because there is nothing there to point at.
-- MEASURED BY ANOTHER LANE, 2026-09-23 (their figures, not this lane's):
--   · `requirements_management` — the service that owns activities and WBS — has
--     NO deliverable concept at all: the word appears ZERO times across
--     `models/pm.py`, `schemas/pm.py` and all nine `routers/pm_*.py`, and NO PM
--     entity carries an acceptance field of any kind.
--   · its `is_milestone` (`models/pm.py:190`) is a bare boolean meaning "zero
--     duration" to cpm / evm / monte_carlo. No criteria, no evidence, no artefact
--     link — it is not the same concept as `project_milestones` below.
--   · the work breakdown this would hang off is FLAT: 3,235 activities, 0 with a
--     parent, and 3,234 of 3,235 `wbs_code` values are two-segment. Neither
--     `project_phase` nor `epic` has an entity at all.
-- So a join would not be under-specified, it would be unrepresentable. ⛔ A
-- future session must not manufacture the PM half in order to create one.
--
-- WHAT WOULD HAVE TO EXIST FIRST for a cross-service link to mean anything:
-- (1) a PM deliverable/acceptance ENTITY in `requirements_management` — not a
-- boolean, an entity with criteria; and (2) a PARENT link on activities, so a
-- deliverable has something hierarchical to own. Until both exist, this table
-- stands alone on purpose and that is not an omission.
--
-- ⚠️ AND `acceptance_criteria` IS NOT EVIDENCE OF COMPLETION. It is fr-local
-- free text, validated against nothing. AS OF 2026-09-23, `artifacts.card_id` is
-- NULL on all 58,573 rows and 0 of 15 upload sites set it (same lane, same date),
-- so there is no path at all from a criterion to an artefact that would satisfy
-- it.
--
-- ⚠️ THAT SECOND SENTENCE IS DATED ON PURPOSE — it is a measurement, not a
-- property. A peer lane has a PR open on the artifacts service to start writing
-- `card_id` plus four currently-dead provenance columns AT THE WRITE END ONLY,
-- with NO BACKFILL. So the direction of travel is: new artefacts become linkable,
-- the 58,573 existing rows stay NULL forever. When that lands, narrow this
-- caveat; do not delete it and do not "correct" it the other way.
--
-- ⭐ WHAT DOES NOT CHANGE WHEN IT LANDS: `acceptance_criteria` is still fr-local
-- and still not evidence of completion. A populated `card_id` only makes a link
-- CHEAPER TO BUILD LATER; it does not build it, and nothing in this table is
-- validated against an artefact either way. Anything presenting this column as
-- "done" is presenting an intention as a result.
--
-- ── WHAT MIGRATION 123 BUILT, AND WHERE IT STOPS ─────────────────────────────
--
-- 123 gave the request a Stage B: `project_outlines` holds what is AGREED after
-- analysis — deliverables, intermediate deliverables, milestones, effort — in
-- NAMED columns, decided by a human through `approvals`. That half works.
--
-- The half that does not is what happens next. Promotion re-parses the ORIGINAL
-- Stage-A request payload (`project_requests.payload`) and calls
-- `createProjectCore`, so the project row is built from what the customer typed
-- BEFORE the analysis, and every deliverable, acceptance criterion, milestone
-- and effort figure a human actually signed off is dropped on the floor. The
-- outline survives as a record of a decision whose content nothing downstream
-- can read.
--
-- ⭐ SO THE PROJECT NEEDS ITS OWN COPY OF THE APPROVED SCOPE, not a pointer to
-- the outline it came from. The outline is a VERSIONED PROPOSAL and 123 made it
-- deliberately mutable-by-supersession; the project's scope is the thing that
-- was agreed and must not change when a later amendment round supersedes or
-- prunes the row it was agreed in. Hence `source_outline_id` is provenance and
-- is ON DELETE SET NULL — see below.
--
-- ── WHY TYPED COLUMNS AND NOT A JSONB BLOB ───────────────────────────────────
--
-- ⛔ Same reason 123 states for `project_outlines`, and the reason is not style.
-- The cheap move is `projects.project_data.deliverables = [...]`. That is the
-- exact write-only shape this unit exists to delete: 21 fields arrived in
-- `projects.project_data` that way, read by nothing, missed by no test, because
-- a jsonb column accepts anything and asserts nothing. A deliverable has a
-- position, a kind, a title and acceptance criteria; those get columns, a CHECK
-- and a UNIQUE, so the database refuses a malformed one instead of storing it.
--
-- `acceptance_criteria` stays JSONB because it is an ORDERED LIST OF FREE TEXT
-- with no internal structure to name — the one shape a blob is honest about.
-- It is NOT NULL DEFAULT '[]' so "no criteria recorded" is an empty list rather
-- than a NULL every reader has to remember to coalesce.
--
-- ── WHY `kind` IS A CHECK AND NOT A SECOND TABLE ──────────────────────────────
--
-- 123 carries deliverables and intermediate deliverables as two separate JSONB
-- columns on the outline. Promoted, they are ONE ordered list of scope items
-- that differ only in whether the customer receives them, and `position` has to
-- be unique across the whole list for an ordering to exist at all. Two tables
-- would make that ordering unrepresentable and every reader UNION them back.
--
-- ⚠️ THE VOCABULARY IS CLOSED ON PURPOSE. `deliverable` | `intermediate` and
-- nothing else. This is the opposite call from `projects.project_phase`, whose
-- comment states its vocabulary is deliberately open — the difference is that a
-- phase is a label a human reads and a kind is a predicate code branches on.
-- An unrecognised kind does not degrade a branch, it silently drops the row from
-- whichever side of the branch was supposed to handle it. 'epic' is the concrete
-- near-miss and is REJECTED (tests/integration/migrations/
-- 127-project-deliverables.integration.test.ts pins it).
--
-- ── THE DELETE SEMANTICS, WHICH ARE THE POINT OF THE WHOLE FILE ───────────────
--
--   project_id        ON DELETE CASCADE  — scope has no meaning without its
--                     project; an orphan row is unreachable by every route
--                     (they all scope by project) and would defeat the
--                     right-to-delete purge by outliving its subject.
--   source_outline_id ON DELETE SET NULL — PROVENANCE, NOT OWNERSHIP. An outline
--                     is versioned and prunable; the approved scope must SURVIVE
--                     the disappearance of the document it was approved in. A
--                     CASCADE here would let an outline cleanup silently delete
--                     a live project's agreed deliverables, and nothing in the
--                     system would be able to tell that it had happened.
--                     NULLABLE for the same reason: unknown provenance is a
--                     representable state, a vanished deliverable is not.
--
-- ── SHAPE: DDL ONLY ───────────────────────────────────────────────────────────
--
-- CREATE TABLE / ADD COLUMN / COMMENT only. No INSERT, UPDATE, DELETE, TRUNCATE,
-- trigger or function — so per scripts/check-migration-dml-probed.ts this needs
-- neither a COLUMN_PROBES entry in src/db/migration-runner.ts nor the
-- `NOT PROBED, DELIBERATELY` annotation. Verified by running that checker:
-- "OK — 16 migration(s) at or above 112 scanned, 0 unprobed data-changing", with
-- its own detector control still flagging the 24 grandfathered ones, so the green
-- is not vacuous.
--
-- ⛔ AND DO NOT "FIX" THAT BY ADDING ONE — A PROBE HERE WOULD BE VACUOUS, WHICH IS
-- WORSE THAN ABSENT. schema.ts expresses EVERY part of this file: both FK
-- ON DELETE actions, the named UNIQUE (same name in both emitters, deliberately —
-- 123's bare UNIQUE would give prod `_key` and drizzle `_unique`), the named CHECK
-- and the composite PK. So `drizzle-kit push` reproduces the whole shape, and a
-- `tableExists(project_deliverables)` probe would pass on a push-built database
-- whether or not this file ever executed — stamping it applied and reporting
-- success. That is not hypothetical: migration 101's probe on `approver_user_id`
-- was vacuous for exactly this reason (drizzle modelled the column), which the
-- runner's own entry for it records under "CORRECTED 2026-08-29". An honest probe
-- must target what drizzle CANNOT express; here that set is empty.
--
-- ⛔ src/db/schema.ts AND THIS FILE ARE TWO EMITTERS OF ONE SHAPE. CI builds its
-- database with `drizzle-kit push` from schema.ts and the runner then stamps this
-- file applied WITHOUT executing it; a real database takes the shape from here
-- and never sees schema.ts. So a CHECK landed in only one of them passes the
-- suite in one environment and 23514s every write in the other — the failure
-- migration 113 shipped once, and 119's, 122's and 123's headers all record. The
-- `kind` CHECK below is therefore declared in BOTH and the two declarations are
-- compared against each other, on a real Postgres, by the drift test named above.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next
-- file.

-- ── 1. the approved scope items ──────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_deliverables (
  id                  UUID    PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id          UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_outline_id   UUID    REFERENCES project_outlines(id) ON DELETE SET NULL,
  position            INTEGER NOT NULL,
  kind                TEXT    NOT NULL,
  title               TEXT    NOT NULL,
  description         TEXT,
  acceptance_criteria JSONB   NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT project_deliverables_project_id_position_unique
    UNIQUE (project_id, position),
  CONSTRAINT project_deliverables_kind_check
    CHECK (kind IN ('deliverable', 'intermediate'))
);

-- ⚠️ NO SEPARATE INDEX ON (project_id), DELIBERATELY. The unique constraint
-- above is backed by a btree on (project_id, position) whose LEADING column is
-- project_id, so `WHERE project_id = $1` — the only access pattern any route
-- has, always with an ORDER BY position — is already served by it. A second
-- index on (project_id) would be a pure write-amplification and VACUUM cost
-- that never gets chosen. (123 does add `project_outlines_request_idx` beside
-- `UNIQUE (request_id, version)`; that is the same redundancy and is not a
-- precedent worth copying.) Add one only if a query appears that filters on a
-- non-leading column.

COMMENT ON TABLE project_deliverables IS
  'The APPROVED scope of a project: one ordered list of deliverables and '
  'intermediate deliverables, copied out of the outline a human signed off '
  '(migration 123) at promotion. Exists because promotion re-parsed the Stage-A '
  'request payload and dropped the approved scope entirely. The project owns '
  'this copy -- the outline it came from is a versioned proposal that may be '
  'superseded or pruned, and the agreed scope must not change when it is. '
  '⛔ NOT a work breakdown and NOT a PM activity hierarchy: it holds no link to '
  'requirements_management because that service has no deliverable or acceptance '
  'entity to link to and its activity tree is flat (measured 2026-09-23). Do not '
  'invent the PM half to create a join.';

COMMENT ON COLUMN project_deliverables.source_outline_id IS
  'PROVENANCE only -- which outline version this item was approved in. '
  'ON DELETE SET NULL and nullable BY DESIGN: the approved scope must survive '
  'the pruning of the outline document. A CASCADE here would let an outline '
  'cleanup silently delete a live project''s agreed deliverables with nothing '
  'able to detect it; NULL provenance is a representable state, a vanished '
  'deliverable is not.';

COMMENT ON COLUMN project_deliverables.kind IS
  'deliverable = the customer receives it; intermediate = needed to get there. '
  'CLOSED vocabulary, enforced by project_deliverables_kind_check, because code '
  'BRANCHES on this value -- an unrecognised kind does not degrade a label, it '
  'drops the row out of whichever branch was meant to handle it. Widening it is '
  'a two-emitter change: this CHECK and the check() in src/db/schema.ts.';

COMMENT ON COLUMN project_deliverables.acceptance_criteria IS
  'Ordered list of free-text criteria. JSONB because the content genuinely has '
  'no internal structure to name -- the one shape a blob is honest about. '
  'NOT NULL DEFAULT ''[]'' so "none recorded" is an empty list, not a NULL every '
  'reader must remember to coalesce. ⚠️ NOT EVIDENCE OF COMPLETION: fr-local text '
  'validated against nothing. AS OF 2026-09-23 artifacts.card_id was NULL on all '
  '58,573 rows with 0 of 15 upload sites setting it, so no criterion here could be '
  'tied to an artefact at all; a peer lane has a PR open to populate card_id at the '
  'WRITE END ONLY, no backfill, so newer artefacts become linkable and those 58,573 '
  'stay NULL. Either way this column is still not evidence -- a populated card_id '
  'only makes a future link cheaper to build.';

-- ── 2. the approved milestones ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS project_milestones (
  project_id  UUID    NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  position    INTEGER NOT NULL,
  name        TEXT    NOT NULL,
  target_date DATE,
  PRIMARY KEY (project_id, position)
);

-- Same reasoning as project_deliverables: the primary key's btree leads on
-- project_id, so no separate (project_id) index. Composite-PK shape mirrors
-- project_request_repositories (migration 123) -- a milestone has no identity
-- apart from its project and its place in the order, so it needs no surrogate id.

COMMENT ON TABLE project_milestones IS
  'The APPROVED milestones of a project, copied from the signed-off outline at '
  'promotion. `target_date` is NULLABLE: an outline may agree an ordering '
  'without committing to dates, and a fabricated date is worse than none. '
  '⚠️ NOT requirements_management''s `is_milestone`, which is a bare zero-duration '
  'boolean for cpm/evm/monte_carlo with no criteria and no artefact link. Different '
  'concept, different service, deliberately unjoined.';

-- ── 3. the approved effort estimate ──────────────────────────────────────────

ALTER TABLE projects
  ADD COLUMN IF NOT EXISTS approved_effort_estimate JSONB;

COMMENT ON COLUMN projects.approved_effort_estimate IS
  'The effort estimate a human APPROVED, copied from project_outlines.effort_estimate '
  'at promotion. ⚠️ NOT the same field as the free-text ProjectCreate.effort_estimate '
  'that lands in projects.project_data -- that one is a customer''s guess typed '
  'before any analysis, is read by nothing, and is DELETED in this same PR. This '
  'column is the output of a decision, so it is stored where a decision''s output '
  'belongs: on the project, structured, and distinct in name so no reader can '
  'confuse the two. Nullable: every project created before the outline flow, and '
  'any project promoted from an outline that agreed scope without an effort figure.';
