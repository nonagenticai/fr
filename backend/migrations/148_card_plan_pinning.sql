-- Migration: 148_card_plan_pinning
-- Date: 2026-10-01
--
-- U11 — A CARD'S PLAN IS PINNED AT MINT, AND WHAT ACTUALLY RAN IS LOGGED.
--
-- Three tables, all keyed by Planka card id, all carrying tenant_id NOT NULL:
--
--   * card_plan_pins            — the plan the minter computed for the card, ONE
--                                 row per card, written by POST /api/cards/project
--                                 or POST /api/cards/improvement when the caller
--                                 sends `plan_pin` on a create that mints a NEW
--                                 card. The card carries only the pointer
--                                 `Metadata.plan_pin = {"store":"fr","sha256":…}`
--                                 (same shape as B13's Metadata.version_stamp,
--                                 migration 140). INSERT-ONCE.
--   * card_plan_events          — split / reclassify decisions that legitimately
--                                 change what a card may run, with WHO computed
--                                 them (`rule` or `llm`) and the LIST they were
--                                 emitted from (NOT NULL: RULING 10-01 movies-ab
--                                 makes the list part of whether the event can
--                                 excuse a deviation — a split from `doing` never
--                                 does). APPEND-ONLY.
--   * card_executed_activities  — one row per activity the conveyor actually ran
--                                 (list, pattern, activity, execution id).
--                                 APPEND-ONLY.
--
-- GET /api/cards/:id/plan-conformance is a pure computation over the three
-- (src/services/improvement-cards/plan-conformance.ts).
--
-- WHY: the plan used to be read at DISPATCH from a ConfigMap that can change
-- mid-run, so a conformance check derived at check time compared the run with
-- whatever the plan said THEN — a tautology. n8n executions are kept 72h and
-- Runtime State is last-writer-wins, so nothing durable said what ran.
--
-- ── IMMUTABILITY IS ENFORCED IN THE DATABASE ─────────────────────────────
-- A row-level BEFORE UPDATE OR DELETE trigger on all three tables:
--   * UPDATE is ALWAYS refused. There is no hatch: a pin or a ledger row that
--     can be edited is not evidence of anything.
--   * DELETE is refused unless the transaction armed fr's ONE destructive hatch,
--     `SET LOCAL fr.allow_destructive = 'on'` (migration 142's convention, so a
--     right-to-delete / restore operator has exactly one switch to learn).
--     ⛔ NEVER a session-level SET: fr reaches postgres through PgBouncer in
--     transaction pooling, where a session GUC leaks to the next client.
--   * TRUNCATE reuses migration 142's fr_refuse_truncate() (same hatch).
-- All triggers are ENABLE ALWAYS, so they also fire on a replica / logical
-- apply. No REVOKE: fr's app role OWNS these tables, and an owner can re-grant
-- itself anything — a REVOKE against the owner would be a guard in name only.
-- The trigger binds every client holding the role, psql at a prompt included.
--
-- ⚠️ Consequence the route accepts on purpose: B13 deletes its stamp row when a
-- create is rolled back. A plan pin CANNOT be deleted, so a rolled-back create
-- leaves its pin row behind, keyed by a Planka card id that no longer exists.
-- Planka ids are never reused, so that row can never be read as another card's
-- plan; the route reports it as `plan_pin_kept_for_rolled_back_card: true`.
--
-- ── COLUMN CHOICES ────────────────────────────────────────────────────────
-- * NO project FK (unlike 140). A cascade from `projects` would be a DELETE on
--   an append-only table, i.e. the trigger above would refuse every project
--   delete. The ledger must outlive the project anyway (same reasoning as
--   migration 132's finding_suppression_events).
-- * tenant_id uuid NOT NULL, no FK — the tenant the card was minted / the event
--   was recorded under. Every read is predicated on it.
-- * sha256 columns carry the same 64-hex CHECK as 140.
-- * `trace_id uuid` (both ledgers), NULLABLE, UUIDv7 CHECK as 149: the AA-TRACE
--   join key only, never used by conformance.
-- * `recorded_at` (both ledgers) is server-stamped and is the ONLY clock
--   conformance uses; the caller-supplied `at` is kept as information. A
--   backdated `at` must not be able to place a re-plan before an activity.
--
-- Pure DDL + functions/triggers, idempotent on re-run (IF NOT EXISTS, CREATE OR
-- REPLACE). Deliberately NOT in src/db/schema.ts (the 138/140/141 choice): CI's
-- `drizzle-kit push` does not create these tables, and the COLUMN_PROBES row in
-- src/db/migration-runner.ts — which probes the TRIGGERS, not just the tables —
-- keeps this file pending on a push-built database so the runner creates
-- everything from THIS file. One emitter.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_plan_pins (
  card_id      text        NOT NULL PRIMARY KEY,
  tenant_id    uuid        NOT NULL,
  plan         jsonb       NOT NULL,
  plan_sha256  text        NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_plan_pins_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_plan_pins_sha256_hex CHECK (plan_sha256 ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS card_plan_pins_tenant_idx
  ON card_plan_pins (tenant_id);

CREATE TABLE IF NOT EXISTS card_plan_events (
  id                 bigserial   PRIMARY KEY,
  card_id            text        NOT NULL,
  tenant_id          uuid        NOT NULL,
  kind               text        NOT NULL,
  computed_by        text        NOT NULL,
  list               text        NOT NULL,
  actor_execution_id text,
  prev_plan_sha      text,
  new_plan_sha       text,
  detail             jsonb       NOT NULL DEFAULT '{}'::jsonb,
  -- `at` is the CALLER's claim (informational only). `recorded_at` is the
  -- server's: DEFAULT now(), never written by any fr writer, so no caller can
  -- backdate it. Conformance orders and governs ONLY by recorded_at (then id).
  at                 timestamptz NOT NULL DEFAULT now(),
  recorded_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_plan_events_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_plan_events_kind_check CHECK (kind IN ('split', 'reclassify')),
  CONSTRAINT card_plan_events_computed_by_check CHECK (computed_by IN ('rule', 'llm')),
  -- The plan's per-list keys (ncn AA_IMPLEMENTATION/card_type_descriptions.json
  -- "plan: per list (todo/ready/doing/qa/blocked/done)"; ncn workflows/cells/*.json).
  CONSTRAINT card_plan_events_list_check
    CHECK (list IN ('todo', 'ready', 'doing', 'qa', 'blocked', 'done')),
  CONSTRAINT card_plan_events_prev_sha_hex
    CHECK (prev_plan_sha IS NULL OR prev_plan_sha ~ '^[0-9a-f]{64}$'),
  CONSTRAINT card_plan_events_new_sha_hex
    CHECK (new_plan_sha IS NULL OR new_plan_sha ~ '^[0-9a-f]{64}$')
);

-- A database that applied an earlier draft of this file has the table without
-- recorded_at; ADD COLUMN with a stable DEFAULT is a catalog-only change (no
-- row UPDATE, so the immutability trigger below is not involved).
ALTER TABLE card_plan_events ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();
-- AA-TRACE §1 join key of the run that wrote the row (X-AA-Trace-Id or body
-- trace_id, lib/aa-trace.ts). NULL = orphan write (§2), stored, not refused.
-- A JOIN KEY ONLY: conformance never reads it.
ALTER TABLE card_plan_events ADD COLUMN IF NOT EXISTS trace_id uuid
  CONSTRAINT card_plan_events_trace_id_v7
  CHECK (trace_id IS NULL OR trace_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE INDEX IF NOT EXISTS card_plan_events_trace_id_idx
  ON card_plan_events (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS card_plan_events_card_rec_idx
  ON card_plan_events (tenant_id, card_id, recorded_at, id);

CREATE TABLE IF NOT EXISTS card_executed_activities (
  id            bigserial   PRIMARY KEY,
  card_id       text        NOT NULL,
  tenant_id     uuid        NOT NULL,
  list          text        NOT NULL,
  pattern       text        NOT NULL,
  activity      text        NOT NULL,
  execution_id  text,
  at            timestamptz NOT NULL DEFAULT now(),
  recorded_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_executed_activities_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_executed_activities_list_nonempty CHECK (list <> ''),
  CONSTRAINT card_executed_activities_activity_nonempty CHECK (activity <> '')
);

ALTER TABLE card_executed_activities ADD COLUMN IF NOT EXISTS recorded_at timestamptz NOT NULL DEFAULT now();
-- AA-TRACE §1 join key of the run that wrote the row (X-AA-Trace-Id or body
-- trace_id, lib/aa-trace.ts). NULL = orphan write (§2), stored, not refused.
-- A JOIN KEY ONLY: conformance never reads it.
ALTER TABLE card_executed_activities ADD COLUMN IF NOT EXISTS trace_id uuid
  CONSTRAINT card_executed_activities_trace_id_v7
  CHECK (trace_id IS NULL OR trace_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
CREATE INDEX IF NOT EXISTS card_executed_activities_trace_id_idx
  ON card_executed_activities (trace_id) WHERE trace_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS card_executed_activities_card_rec_idx
  ON card_executed_activities (tenant_id, card_id, recorded_at, id);

-- ---------------------------------------------------------------------------
-- The refusal. Row-level, so it fires on a single-row statement too (142's
-- statement-level bulk guard deliberately lets 1-row deletes through).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION fr_refuse_plan_ledger_mutation() RETURNS trigger
LANGUAGE plpgsql AS $fr_plan_ledger$
BEGIN
  IF TG_OP = 'DELETE'
     AND coalesce(current_setting('fr.allow_destructive', true), 'off') = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION
    '% on %.% is refused: U11 plan pins are insert-once and plan events / executed '
    'activities are append-only (migration 148)',
    TG_OP, TG_TABLE_SCHEMA, TG_TABLE_NAME
    USING
      ERRCODE = 'raise_exception',
      HINT = CASE WHEN TG_OP = 'DELETE'
        THEN 'If this is deliberate (right-to-delete, restore), arm the hatch INSIDE one '
             'transaction: BEGIN; SET LOCAL fr.allow_destructive = ''on''; <statement>; COMMIT;  '
             'NEVER a session-level SET (PgBouncer transaction pooling leaks it).'
        ELSE 'UPDATE has no hatch. Record a new card_plan_events row instead.'
      END;
END
$fr_plan_ledger$;

COMMENT ON FUNCTION fr_refuse_plan_ledger_mutation() IS
  'U11 (migration 148): refuses UPDATE always, and DELETE unless the transaction has '
  'SET LOCAL fr.allow_destructive = ''on'', on card_plan_pins / card_plan_events / '
  'card_executed_activities.';

DO $fr_plan_attach$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['card_plan_pins', 'card_plan_events', 'card_executed_activities'] LOOP
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER fr_immutable_%s BEFORE UPDATE OR DELETE ON public.%I '
      'FOR EACH ROW EXECUTE FUNCTION fr_refuse_plan_ledger_mutation()', t, t);
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER fr_immutable_%s', t, t);
    -- fr_refuse_truncate() is migration 142's; 148 > 142, so it exists.
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER fr_guard_truncate_%s BEFORE TRUNCATE ON public.%I '
      'FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate()', t, t);
    EXECUTE format(
      'ALTER TABLE public.%I ENABLE ALWAYS TRIGGER fr_guard_truncate_%s', t, t);
  END LOOP;
END
$fr_plan_attach$;

COMMENT ON TABLE card_plan_pins IS
  'U11: the plan computed at mint, one row per Planka card, INSERT-ONCE (trigger). '
  'The card carries Metadata.plan_pin = {"store":"fr","sha256":…} where sha256 = plan_sha256 '
  '(sha256 of the canonical JSON of plan). Read by GET /api/cards/:id/plan-pin.';
COMMENT ON TABLE card_plan_events IS
  'U11: append-only split/reclassify decisions with computed_by rule|llm and the list '
  'they were emitted from. Only a rule split at ready/qa/blocked or a rule reclassify at '
  'qa/blocked can excuse a plan deviation (plan-conformance.ts EXCUSING_PLAN_EVENTS).';
COMMENT ON TABLE card_executed_activities IS
  'U11: append-only log of activities the conveyor actually ran, per card and list.';
