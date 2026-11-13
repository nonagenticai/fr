-- backend/migrations/128_card_contract_substrate.sql
--
-- THE CARD-CONTRACT SUBSTRATE FOR SPLIT FAMILIES (roadmap B1).
--
-- Specified by, and only by:
--   · n8n_custom_nodes AA_IMPLEMENTATION/RECURSIVE_DECOMPOSITION_SPEC.md (Track B)
--     "Four new substrate objects" + PR order row 1: `card_contracts`,
--     `decompositions`, `contract_dependencies`.
--   · n8n_custom_nodes docs/redesign/design/split-coherence-design.md §5 (the
--     "where each field lives" table) + §8 PR 4: `family_bundles`,
--     `family_decisions`, `interface_validations`; §3.2 for the decision-index
--     claim semantics (`UNIQUE(family_id, topic_slug)`, 409 + winning decision_id).
--
-- ── WHAT IT IS ───────────────────────────────────────────────────────────────
--
-- fr is the AUTHORITY for split-family state because it is the only place with
-- transactions and the only place that can answer tree-global questions (depth,
-- ancestry, repeated scope). Planka holds pointers only (its custom-field values
-- are capped at 512 chars, see n8n_custom_nodes CLAUDE.md). This file creates the
-- tables those pointers resolve against:
--
--   decompositions        one row per split = one FAMILY. `id` is the
--                         caller-generated decomposition_id (Track B "Atomic +
--                         idempotent creation") and IS the family_id every other
--                         table keys on.
--   card_contracts        one contract per card (or per child_key before its
--                         Planka card exists — Track B: "the stable identity is
--                         (decomposition_id, child_key), not the Planka card id").
--   contract_dependencies `requires` edges between siblings, by child_key.
--   family_bundles        the frozen READY context bundle, versioned.
--   family_decisions      the ORDERING + UNIQUENESS INDEX of sibling decisions.
--                         The decision CONTENT lives in requirements_management
--                         (`decisions`); fr holds only which child claimed which
--                         topic, in what order.
--   interface_validations one row per run of the family interface check.
--
-- ── WHAT IT IS NOT ───────────────────────────────────────────────────────────
--
-- ⛔ NOT project_deliverables / project_milestones (migration 127). Those are the
-- APPROVED SCOPE of a PROJECT, copied from a signed-off outline. A card contract
-- is the machine contract of ONE CARD inside a split tree; its `criteria` are
-- `crit_<sha1(text)[0:8]>` ids a split child must cover, not customer-agreed
-- deliverables. Do not join them, do not deduplicate one into the other.
--
-- ⛔ NOT acceptance_criteria storage for ordinary cards, and not a copy of Planka's
-- Acceptance Criteria group. `card_contracts.criteria` exists for split families
-- only; a card that was never split has no row here, and "no row" means exactly
-- that — `AA Activity - Integration` self-gates on it (`not_a_split_parent`).
--
-- ⛔ NOT the requirements service. `requirement_ids` / `principle_ids` /
-- `decision_ids` / `architecture_element_ids` are ids INTO requirements_management
-- with NO foreign key (it is another service's database). A dangling id is
-- representable here by design; resolving it is the bundle builder's job.
--
-- ⛔ NOT integration_runs / output_manifests. Those are Track B PR 5 / PR 6 and are
-- deliberately absent from this file.
--
-- ── THE ONE CONSTRAINT THIS FILE EXISTS FOR ──────────────────────────────────
--
-- family_decisions_one_active_topic_idx: at most ONE non-superseded decision per
-- (family_id, topic_slug). Two children that decide the same topic concurrently
-- must produce exactly one winner; the loser gets the winner's decision_id and
-- must conform or supersede (design §3.2). The claim is
--   INSERT … ON CONFLICT (family_id, topic_slug) WHERE superseded_by IS NULL
--   DO NOTHING RETURNING seq
-- (src/services/decomposition/family-decisions.ts) — the same atomic-claim idiom
-- as router_dedupe (migration 082), and the index IS the atomicity. Dropping it
-- turns every claim into 42P10 (no arbiter index), which is loud, and
-- tests/integration/decomposition/family-decisions-claim.integration.test.ts
-- (8 concurrent claims → exactly 1 winner) goes red.
--
-- ⚠️ SPEC CONTRADICTION, RESOLVED HERE: design §5 lists the columns as
-- `(family_id, seq, topic_slug, decision_id, child_key, supersedes)` and then
-- writes the predicate `WHERE superseded_by IS NULL` — a column the list does not
-- contain. The predicate cannot be expressed on `supersedes` (that marks the NEW
-- row, not the OLD one), so `superseded_by` is added: a supersession inserts the
-- new row with `supersedes = <old decision_id>` and stamps the old row's
-- `superseded_by = <new decision_id>`, which releases the topic for the new row.
--
-- ── SHAPE: DDL ONLY ──────────────────────────────────────────────────────────
--
-- CREATE TABLE / CREATE INDEX / COMMENT only. No INSERT, UPDATE, DELETE,
-- TRUNCATE, trigger or function — so per scripts/check-migration-dml-probed.ts
-- this needs no COLUMN_PROBES entry. And as with 127, a probe would be VACUOUS:
-- src/db/schema.ts expresses every part of this file (tables, CHECKs, named
-- UNIQUEs, the partial unique index, FK ON DELETE actions), so `drizzle-kit push`
-- reproduces the whole shape and a tableExists() probe would pass on a push-built
-- database whether or not this file ever executed.
--
-- ⛔ src/db/schema.ts AND THIS FILE ARE TWO EMITTERS OF ONE SHAPE. CI builds its
-- database with `drizzle-kit push` from schema.ts and the runner stamps this file
-- applied WITHOUT executing it; production takes the shape from here and never
-- sees schema.ts. In particular the partial unique index the concurrency test
-- depends on is declared in BOTH, with the same name and the same predicate. A
-- constraint landed in only one of them passes CI and fails production (or the
-- reverse) — the failure 113 shipped and 119/122/123/127 record.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next
-- file.

-- ── 1. decompositions — the family root ──────────────────────────────────────

CREATE TABLE IF NOT EXISTS decompositions (
  id             UUID        PRIMARY KEY,
  tenant_id      UUID        NOT NULL,
  parent_card_id TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The only lookup besides the PK: "which families did this card split into".
CREATE INDEX IF NOT EXISTS decompositions_parent_card_idx
  ON decompositions (parent_card_id);

COMMENT ON TABLE decompositions IS
  'One row per split = one FAMILY (Track B). id is the CALLER-GENERATED '
  'decomposition_id, so a retried commit with the same id resolves the same '
  'family; every family_* table and card_contracts.family_id key on it. '
  'tenant_id scopes every read and write of the family -- a family is never '
  'visible across tenants.';

-- ── 2. card_contracts — the per-card contract ───────────────────────────────

CREATE TABLE IF NOT EXISTS card_contracts (
  id                       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID        NOT NULL,
  card_id                  TEXT,
  family_id                UUID        REFERENCES decompositions(id) ON DELETE CASCADE,
  child_key                TEXT,
  depth                    INTEGER     NOT NULL DEFAULT 0,
  phase                    TEXT,
  leaf_class               TEXT,
  scope_hash               TEXT,
  criteria                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  covers                   TEXT[]      NOT NULL DEFAULT '{}'::text[],
  inputs                   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  output_schema            JSONB,
  proof_obligation         JSONB,
  dependency_bindings      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  scope_level              TEXT,
  requirement_ids          UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  context_requirement_ids  UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  principle_ids            UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  decision_ids             UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  architecture_element_ids UUID[]      NOT NULL DEFAULT '{}'::uuid[],
  toc_tree_id              TEXT,
  toc_goal_node_id         TEXT,
  toc_node_id              TEXT,
  bundle_ref               JSONB,
  interface_contract       JSONB,
  context_packs            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  procedure_pins           JSONB,
  prompt_pins              JSONB,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT card_contracts_card_id_unique UNIQUE (card_id),
  CONSTRAINT card_contracts_family_id_child_key_unique UNIQUE (family_id, child_key),
  CONSTRAINT card_contracts_family_child_key_pair_check
    CHECK ((family_id IS NULL) = (child_key IS NULL)),
  CONSTRAINT card_contracts_depth_check CHECK (depth >= 0),
  CONSTRAINT card_contracts_phase_check
    CHECK (phase IS NULL OR phase IN ('todo', 'ready', 'doing', 'qa', 'blocked', 'done')),
  CONSTRAINT card_contracts_leaf_class_check
    CHECK (leaf_class IS NULL OR leaf_class IN ('decision', 'answer', 'action'))
);

COMMENT ON TABLE card_contracts IS
  'The machine contract of ONE card in a split tree (Track B + split-coherence '
  '§5). fr is the authority; the card''s ```json fence and Planka custom fields '
  'are projections. card_id is NULLABLE because the stable identity is '
  '(family_id, child_key): a commit resolves the child contracts BEFORE their '
  'Planka cards exist (saga, not 2PC). A root card (never itself a child) has '
  'family_id = child_key = NULL. ⛔ NOT project_deliverables (migration 127).';

COMMENT ON COLUMN card_contracts.criteria IS
  '[{id, text}] with id = crit_<sha1(text)[0:8]> (Track B "Criterion identity"). '
  'Compared across the tree by exact string match.';

COMMENT ON COLUMN card_contracts.covers IS
  'Parent criterion ids this child claims to cover. Pre-mint validation requires '
  'union(children.covers) = parent.criteria[].id exactly, both directions.';

COMMENT ON COLUMN card_contracts.phase IS
  'The card''s current phase as fr last recorded it (split-coherence §3.3 step 1: '
  'integration refuses to start while any child is in DOING, "checked through fr '
  'card_contracts.phase"). NULL = never recorded -- NOT the same as todo. CLOSED '
  'vocabulary (lower-cased Planka list names) because integration branches on it. '
  '⚠️ Nothing writes it yet; a reader must treat NULL as unknown, never as "not doing".';

COMMENT ON COLUMN card_contracts.leaf_class IS
  'Typed terminal class (Track B): decision | answer | action; NULL = not a leaf '
  '(split). CLOSED vocabulary because the verifier is chosen by it.';

COMMENT ON COLUMN card_contracts.requirement_ids IS
  'Ids INTO requirements_management -- no FK (another service). Authority for the '
  'full list; Planka Requirements.requirement_1..5 is a 5-item projection.';

COMMENT ON COLUMN card_contracts.scope_level IS
  'The ladder level the split used (split-coherence §1.2: multi_repo > repo > app > '
  'module > component > file > class > function for it projects). OPEN vocabulary: '
  'non-it project types split on a different axis.';

COMMENT ON COLUMN card_contracts.context_requirement_ids IS
  'The parent''s OTHER requirement ids -- read-only context for this child '
  '(split-coherence §1.4), as opposed to requirement_ids, which it owns.';

COMMENT ON COLUMN card_contracts.bundle_ref IS
  '{family_id, bundle_version, bundle_hash} -- which family_bundles version this '
  'contract was derived from (split-coherence §1.4).';

COMMENT ON COLUMN card_contracts.context_packs IS
  '{"<spec>@<version>": {context_hash, item_ids, artifact_id}} compiled at READY '
  '(split-coherence §2.4); the pack text lives in artifacts. DOING reads by hash.';

COMMENT ON COLUMN card_contracts.interface_contract IS
  'The child''s declared interface (split-coherence §3.1): write_set, provides, '
  'consumes, http, schemas, declared_at_watermark. NULL until declare-interface runs.';

-- ── 3. contract_dependencies — sibling `requires` edges ─────────────────────

CREATE TABLE IF NOT EXISTS contract_dependencies (
  family_id          UUID        NOT NULL REFERENCES decompositions(id) ON DELETE CASCADE,
  child_key          TEXT        NOT NULL,
  requires_child_key TEXT        NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_id, child_key, requires_child_key),
  CONSTRAINT contract_dependencies_no_self_edge_check
    CHECK (child_key <> requires_child_key)
);

COMMENT ON TABLE contract_dependencies IS
  'child_key REQUIRES requires_child_key, both siblings in family_id (Track B '
  '"Dependencies as data edges"). Replaces resolve-by-exact-sibling-title. '
  'Cycle detection (Kahn) is the validator''s job, not a constraint.';

-- ── 4. family_bundles — the frozen READY context bundle ─────────────────────

CREATE TABLE IF NOT EXISTS family_bundles (
  family_id       UUID        NOT NULL REFERENCES decompositions(id) ON DELETE CASCADE,
  version         INTEGER     NOT NULL,
  bundle_hash     TEXT        NOT NULL,
  items           JSONB       NOT NULL,
  retrieval_trace JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (family_id, version),
  CONSTRAINT family_bundles_version_check CHECK (version >= 1)
);

COMMENT ON TABLE family_bundles IS
  'The family context bundle (split-coherence §2.1), FROZEN per version: a '
  'version is written once and never updated (the service refuses a second '
  'write of the same version with a different bundle_hash). Only '
  '"v<version>:<bundle_hash[0:16]>" goes onto the card.';

-- ── 5. family_decisions — the decision ordering + uniqueness index ──────────

CREATE TABLE IF NOT EXISTS family_decisions (
  seq           BIGSERIAL   PRIMARY KEY,
  family_id     UUID        NOT NULL REFERENCES decompositions(id) ON DELETE CASCADE,
  topic_slug    TEXT        NOT NULL,
  decision_id   UUID        NOT NULL,
  child_key     TEXT        NOT NULL,
  supersedes    UUID,
  superseded_by UUID,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT family_decisions_topic_slug_check
    CHECK (topic_slug ~ '^[a-z0-9_]{3,40}$')
);

-- ⭐ THE ATOMICITY. See the header. Declared identically in src/db/schema.ts.
CREATE UNIQUE INDEX IF NOT EXISTS family_decisions_one_active_topic_idx
  ON family_decisions (family_id, topic_slug)
  WHERE superseded_by IS NULL;

-- Serves `GET …/decisions?after_seq=` (WHERE family_id = $1 AND seq > $2 ORDER BY seq).
CREATE INDEX IF NOT EXISTS family_decisions_family_seq_idx
  ON family_decisions (family_id, seq);

COMMENT ON TABLE family_decisions IS
  'Append-only ordering + uniqueness index of sibling decisions (split-coherence '
  '§3.2/§4.2). Content lives in requirements_management (stable_key '
  'fam:<family_id>:<topic_slug>); fr holds who claimed which topic and in what '
  'order. seq is a GLOBAL bigserial: monotonic within a family, NOT dense '
  '(gaps are normal, a lost claim consumes a value). Readers compare it against '
  'a decision_watermark, which needs order, not density.';

COMMENT ON COLUMN family_decisions.superseded_by IS
  'decision_id of the row that superseded this one; NULL = the active decision '
  'for its topic. Not in the design''s column list, which nevertheless writes '
  'the predicate WHERE superseded_by IS NULL -- added so that predicate exists.';

-- ── 6. interface_validations — one row per interface-check run ──────────────

CREATE TABLE IF NOT EXISTS interface_validations (
  family_id  UUID        NOT NULL REFERENCES decompositions(id) ON DELETE CASCADE,
  run_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  violations JSONB       NOT NULL DEFAULT '[]'::jsonb,
  PRIMARY KEY (family_id, run_at)
);

COMMENT ON TABLE interface_validations IS
  'Result of each POST /api/decompositions/{family_id}/interfaces/validate run '
  '(split-coherence §3.1). violations = [] means the family''s interfaces are '
  'valid AS OF run_at; the latest row per family is the current verdict.';
