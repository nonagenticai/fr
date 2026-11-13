-- 205 — R318 §2 step 1: at most ONE pending `board.move_confirmation` per project.
--
-- The andon compare-and-set (migration 206 columns) already admits one waiting move per
-- project; this index is the database's own backstop behind it, the 201 pattern: a second
-- pending confirmation for the same project raises 23505 on this index and
-- src/services/approvals/board-move.ts answers with the winner instead.
--
-- Only `pending` is inside the index: a confirmed, cancelled or voided move must not block
-- the next drag on the same project.
--
-- ⚠️ ENUM SAFETY (the 201 rule). The predicate does NOT name `kind =
-- 'board.move_confirmation'`: migration 204 adds that label to the PRE-EXISTING
-- approval_kind type and the runner applies a whole run in ONE transaction, so naming the
-- label here fails "unsafe use of new value" on a database that runs 204 and 205 together
-- (prod). `kind::text` is not a way out either (enum_out is STABLE, illegal in an index
-- predicate). The predicate keys on the metadata shape only a board-move confirmation
-- carries ({request_id, from_list_id, to_list_id}); no other minter writes `from_list_id`
-- or `to_list_id` into approvals.metadata (grep of backend/src, 2026-10-20).
--
-- Prod has 0 such rows (the kind is new in 204), so the build cannot fail on pre-existing
-- duplicates. Probe: src/db/migration-runner.ts (index by name). Pure DDL.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_board_move_per_project_idx
  ON approvals (project_id)
  WHERE status = 'pending'
    AND project_id IS NOT NULL
    AND metadata ? 'request_id'
    AND metadata ? 'from_list_id'
    AND metadata ? 'to_list_id';
