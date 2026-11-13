-- Migration: 161_priority_set_by_conveyor
-- Date: 2026-10-04
--
-- WHY. Migration 160 created `priority_change_events` with
-- `priority_set_by ~ '^(human|operator):.+$'` because no conveyor identity
-- existed yet. The dedicated conveyor priority identity is now live (Keycloak
-- client `conveyor-priority`, realm role `conveyor-priority-writer`), and fr's
-- priority routes stamp its writes `conveyor:<rule>` (lib/priority-change.ts
-- isConveyorActor / conveyorSetBy; rule ∈ A1 | A2 | B1 | B2, design
-- 20-designs/backlog-reprioritization.md). This widens the CHECK to admit that
-- class and nothing else.
--
-- ⛔ 160 is applied in production — it is NOT edited; this file replaces the
-- constraint in place.
-- ⛔ TWO EMITTERS OF ONE SHAPE with src/db/schema.ts priorityChangeEvents
-- (setByCheck) — CI builds from schema.ts (drizzle-kit push) and stamps this
-- file applied without running it; production gets the shape from here. Keep
-- the expression identical in both.
--
-- Idempotent: the DO block drops the constraint only when its definition does
-- not already admit `conveyor`, then adds it only when absent. Widening only —
-- every existing row (human:/operator:) satisfies the new expression, so the
-- re-validation on ADD cannot fail. No DML, no trigger, no function.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts).

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'priority_change_events_set_by_check'
     AND c.conrelid = 'priority_change_events'::regclass;

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%conveyor%' THEN
    ALTER TABLE priority_change_events DROP CONSTRAINT priority_change_events_set_by_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE priority_change_events
      ADD CONSTRAINT priority_change_events_set_by_check
      CHECK (priority_set_by ~ '^(human|operator|conveyor):.+$');
  END IF;
END
$$;
