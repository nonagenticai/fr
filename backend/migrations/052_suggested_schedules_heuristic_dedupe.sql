-- Spec ref: docs/archive/2026-04-27-continuous-project-model-design.md §13.2
-- Closes:   §15 #1 (suggestion-detection heuristic) — idempotency
--
-- Partial unique index so the in-tick heuristic can ON CONFLICT DO NOTHING
-- without producing duplicate `new` candidates per (tenant, project, user,
-- hour). Once the user accepts or dismisses a candidate (status flips off
-- 'new'), the partial-index predicate stops covering it and the heuristic
-- can re-emit it later if the pattern persists.

BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_suggested_schedules_heuristic_dedupe
  ON suggested_schedules (tenant_id, project_id, user_id, ((payload->>'hour_utc')::int))
  WHERE source = 'heuristic' AND status = 'new';

COMMIT;
