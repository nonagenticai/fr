-- Migration: 229_katas
-- Date: 2026-11-03
--
-- The kata record (docs/design/kata-super-admin.md §3b, amended by the kata build contract):
-- one row per kata, tying symptom, source project, kata project, signature, target flow,
-- versions, cord hold and state together. fr becomes the one place a kata can be read.
--
--   * id = the kata project's fr id (one kata, one project, in the `kata` tenant — 228).
--   * state ∈ running | qa | published | closed | failed | rolled_back. The kata's id is in
--     andon_state.kata_holders EXACTLY while state ∈ (running, qa); services/katas enforces
--     that in one transaction per transition, and accrues cord_held_seconds from
--     cord_engaged_at on every release.
--   * card_ready_at = when the first card reached READY (the open's last step). A running kata
--     whose card never got there (past a grace) or whose project is archived is a dead open: the
--     next open of its signature fails it and opens afresh (services/katas/core.ts).
--   * The partial UNIQUE index allows one open kata per signature (K1): running, qa or
--     published. failed / closed / rolled_back free it.
--
-- Attaches migration 142's destructive-statement guard (protected_tables lists it).
--
-- RUNNER CONTRACT: pure DDL plus TRIGGERs (no DML); mirrored in src/db/schema.ts. Probed for
-- the partial index and both guard triggers — push creates the table but never the triggers,
-- so a push-built database keeps this file pending until it runs. Idempotent — safe under
-- `reapplyIfProbeFails`. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS katas (
  id                    uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  source_project_id     uuid NOT NULL,
  source_tenant_id      uuid NOT NULL,
  source_card_id        text,
  source_execution_id   text,
  source_board_id       text,
  source_phase          text,
  symptom               text NOT NULL,
  opened_by             text NOT NULL,
  signature             text,
  root_cause_class      text,
  target_flow           text,
  target_flow_id        text,
  base_version_id       text,
  published_version_id  text,
  state                 text NOT NULL
                          CONSTRAINT katas_state_check
                          CHECK (state IN ('running', 'qa', 'published', 'closed', 'failed', 'rolled_back')),
  state_detail          text,
  replay_passed         integer,
  replay_total          integer,
  evidence              jsonb NOT NULL DEFAULT '{}'::jsonb,
  ops                   jsonb,
  replays               jsonb,
  linked_cards          jsonb NOT NULL DEFAULT '[]'::jsonb,
  kata_board_id         text,
  kata_card_id          text,
  card_ready_at         timestamptz,
  opened_at             timestamptz NOT NULL DEFAULT now(),
  qa_at                 timestamptz,
  published_at          timestamptz,
  closed_at             timestamptz,
  failed_at             timestamptz,
  rollback_requested_at timestamptz,
  rollback_delivered_at timestamptz,
  rolled_back_at        timestamptz,
  cord_engaged_at       timestamptz,
  cord_held_seconds     integer NOT NULL DEFAULT 0,
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS katas_open_signature_unique
  ON katas (signature)
  WHERE state IN ('running', 'qa', 'published');
CREATE INDEX IF NOT EXISTS katas_opened_at_idx ON katas (opened_at DESC);
CREATE INDEX IF NOT EXISTS katas_source_project_idx ON katas (source_project_id);

-- Attach migration 142's guard (functions fr_refuse_truncate / fr_refuse_bulk_delete).
-- Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_katas
  BEFORE TRUNCATE ON public.katas
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.katas
  ENABLE ALWAYS TRIGGER fr_guard_truncate_katas;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_katas
  AFTER DELETE ON public.katas
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.katas
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_katas;
