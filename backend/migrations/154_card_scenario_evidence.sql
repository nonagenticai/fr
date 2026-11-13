-- Migration: 154_card_scenario_evidence
-- Date: 2026-10-02
--
-- THE BUG-PATH REPRO EVIDENCE OF A CARD'S gherkin_scenarios, KEYED BY PLANKA
-- CARD ID + scenario_id (fr#1338, R3 "repro contract v2").
--
-- A bug-path `gherkin_scenarios[]` entry carries the whole pytest file inline
-- (`test_file_content`, ≤ 32 KiB UTF-8). Coordinator ruling movies-13
-- (2026-10-02): that content lives ONLY in fr's own Postgres and NEVER in
-- Planka. POST /api/cards/project (src/routes/cards/project.ts) strips
-- `test_file_content` from the description it sends to Planka and writes the
-- FULL entry here instead; the card keeps `test_file_sha256` (and the small
-- evidence fields) as the pointer. GET /api/cards/:id returns the rows as
-- `scenario_evidence`.
--
-- Same lifecycle as 140 `card_version_stamps`: written only for a NEW card
-- (never on a dedupe / lease loser / suppression, which all return before the
-- create), inside the route's create-rollback try, deleted again with a
-- rolled-back card.
--
-- ── THE CHECKS ARE THE CONTRACT, ENFORCED BY THE DATABASE ─────────────────
-- * content ≤ 32768 UTF-8 BYTES (octet_length, not char_length).
-- * test_file_sha256 = sha256 of exactly those bytes — so a stored row can
--   never disagree with the pointer on the card. A mismatch is refused at
--   the door (400, qa_needs_info repro_malformed) before it gets here.
-- * `entry` is the entry AS SENT (jsonb string values are exact; jsonb only
--   drops insignificant whitespace and key order).
--
-- Pure DDL, additive, idempotent (IF NOT EXISTS). No DML. NOT in
-- src/db/schema.ts, the same choice as 140: the COLUMN_PROBES row
-- `tableExists('card_scenario_evidence')` keeps this file PENDING on a
-- push-built database, so the runner creates the table from THIS file — one
-- emitter, CI and prod cannot diverge.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_scenario_evidence (
  card_id          text        NOT NULL,
  scenario_id      text        NOT NULL,
  project_id       uuid        NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_file_sha256 text        NOT NULL,
  entry            jsonb       NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (card_id, scenario_id),
  CONSTRAINT card_scenario_evidence_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_scenario_evidence_scenario_id_shape CHECK (scenario_id ~ '^scn_[0-9a-f]{8}$'),
  CONSTRAINT card_scenario_evidence_entry_ids CHECK (
    entry->>'scenario_id' = scenario_id AND entry->>'test_file_sha256' = test_file_sha256
  ),
  CONSTRAINT card_scenario_evidence_content_cap CHECK (
    jsonb_typeof(entry->'test_file_content') = 'string'
    AND octet_length(entry->>'test_file_content') <= 32768
  ),
  CONSTRAINT card_scenario_evidence_sha256_of_content CHECK (
    test_file_sha256 ~ '^[0-9a-f]{64}$'
    AND test_file_sha256 = encode(sha256(convert_to(entry->>'test_file_content', 'UTF8')), 'hex')
  )
);

CREATE INDEX IF NOT EXISTS card_scenario_evidence_project_idx
  ON card_scenario_evidence (project_id);

COMMENT ON TABLE card_scenario_evidence IS
  'Bug-path repro evidence per (Planka card, scenario_id), written by POST /api/cards/project on a NEW card only. '
  'The full gherkin_scenarios entry incl. test_file_content (≤32768 UTF-8 bytes, sha256-checked); the Planka '
  'description carries the entry WITHOUT test_file_content. Read by GET /api/cards/:id as scenario_evidence (fr#1338).';
