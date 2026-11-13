-- Migration: 160_priority_change_events
-- Date: 2026-10-03
--
-- WHY. Project priority (`projects.project_data.priority`) and card priority
-- (Planka `Metadata.priority`) are set through fr by people AND by the conveyor
-- (ruling 2026-10-03: setting priority and backlog reprioritisation are part of
-- the conveyor system). Every effective change is recorded here: who (actor id,
-- username, display name, kind), when, what (project, or project + card), and
-- the from/to values, and the provenance stamp (`priority_set_by`).
--
-- Written by lib/priority-change.ts recordPriorityChange in the SAME transaction
-- as the change, so a failed audit write rolls the change back (the card route
-- writes Planka inside that transaction and compensates if the commit fails).
-- A no-op (from = to) is never recorded — priority_change_events_changed_check.
--
-- ⛔ No FK on project_id: the trail outlives the project.
-- ⛔ TWO EMITTERS OF ONE SHAPE with src/db/schema.ts priorityChangeEvents — CI
-- builds its DB from schema.ts (drizzle-kit push) and stamps this file applied;
-- production gets the shape from here. Keep names identical in both.
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283). This is an
-- append-only audit trail with no regeneration path, so it is PROTECTED, like
-- approval_decisions and finding_suppression_events: listed in 142's
-- `protected_tables` (the classification check-destructive-guard-coverage.ts
-- reads) AND attached at the bottom of THIS file. Both are required:
--   * production: 142's COLUMN_PROBES entry probes only `projects`, which
--     already passes there, so 142 never re-runs and the attach below is what
--     guards the table;
--   * CI (push-built DB, empty ledger): this file is stamped applied without
--     running, but 142 IS re-applied (its triggers are absent) and its loop
--     attaches to every listed table that exists, this one included.
-- No UPDATE trigger: no audit table under 142 carries one; the convention is
-- TRUNCATE + bulk-DELETE refusal with the `SET LOCAL fr.allow_destructive` hatch.
--
-- NOT PROBED, DELIBERATELY: the only non-DDL here is CREATE OR REPLACE TRIGGER
-- reusing 142's functions; CI gets the same triggers from 142's reapply (above),
-- so a COLUMN_PROBES entry would only duplicate it.
--
-- IF NOT EXISTS / CREATE OR REPLACE; no DML. Safe to re-run.

CREATE TABLE IF NOT EXISTS priority_change_events (
  id             bigserial PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  project_id     uuid        NOT NULL,
  card_id        text,
  from_priority  text,
  to_priority    text,
  actor_id       text        NOT NULL,
  actor_username text,
  actor_name     text,
  actor_kind     text        NOT NULL,
  -- The provenance stamped with this change (lib/priority-change.ts
  -- prioritySetBy): `human:<sub>` | `operator:<sub>`. No `conveyor:` class
  -- exists yet (dedicated conveyor identity: movies-09) — the CHECK refuses one.
  priority_set_by text       NOT NULL,
  changed_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT priority_change_events_to_check
    CHECK (to_priority IS NULL OR to_priority IN ('P0', 'P1', 'P2', 'P3')),
  CONSTRAINT priority_change_events_changed_check
    CHECK (from_priority IS DISTINCT FROM to_priority),
  CONSTRAINT priority_change_events_actor_kind_check
    CHECK (actor_kind IN ('user', 'service_account', 'unknown')),
  CONSTRAINT priority_change_events_set_by_check
    CHECK (priority_set_by ~ '^(human|operator):.+$')
);

CREATE INDEX IF NOT EXISTS priority_change_events_project_idx
  ON priority_change_events (project_id, changed_at);

-- Attach migration 142's guard (functions fr_refuse_truncate /
-- fr_refuse_bulk_delete). Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_priority_change_events
  BEFORE TRUNCATE ON public.priority_change_events
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.priority_change_events
  ENABLE ALWAYS TRIGGER fr_guard_truncate_priority_change_events;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_priority_change_events
  AFTER DELETE ON public.priority_change_events
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.priority_change_events
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_priority_change_events;
