-- Migration: 208_project_conveyor_notice_resumed
-- Date: 2026-10-20
--
-- R318 F2: a member's "Resume the project" after a `project.andon_unreadable` notice (207).
-- fr asks the conveyor (E-move `resume` without an approval id); once the conveyor accepts it,
-- fr records that THIS notice was resumed, so GET /api/projects/:id/andon stops reporting
-- `held_unreadable` and the paused banner clears. If the conveyor holds the work again it sends
-- a NEW andon_unreadable notice (a new row, resumed_at NULL), which shows the banner again.
--
--   resumed_at  when the member's resume was claimed for this notice (compare-and-set on NULL,
--               so a concurrent second press claims nothing and sends nothing); reset to NULL
--               when the conveyor did not accept the resume.
--   resumed_by  the member who pressed it (email or id).
--
-- RUNNER CONTRACT: pure DDL, no DML (every existing row reads "not resumed"); mirrored in
-- src/db/schema.ts, so a push-built database satisfies the probe. Idempotent (IF NOT EXISTS) —
-- safe under `reapplyIfProbeFails`. No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE project_conveyor_failures ADD COLUMN IF NOT EXISTS resumed_at timestamptz NULL;
ALTER TABLE project_conveyor_failures ADD COLUMN IF NOT EXISTS resumed_by text NULL;
