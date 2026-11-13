-- backend/migrations/031_relax_asset_assignments_asset_id_to_text.sql
-- Foundation Plan 2 deferred — Item 1.
--
-- Relax `asset_assignments.asset_id` from `uuid` to `text` so non-UUID
-- upstream ids (procedure_management's numeric ids, n8n workflow string
-- ids, channel slugs, future slug-style asset_ids) can join. Routes
-- string-coerce on the way in via `applyEffectiveFilter` (see
-- backend/src/routes/assets/_lib/effective-query.ts).
--
-- The cast `asset_id::text` is loss-free for the existing UUID rows; the
-- partial unique indexes that key on `asset_id` keep their semantics
-- because text equality on a UUID's canonical string form behaves the
-- same as uuid equality.
--
-- Deviation from spec: the planning brief used a literal `BEGIN; ...
-- COMMIT;` wrapper. The migration runner (src/db/migration-runner.ts)
-- already wraps each file in a SAVEPOINT inside an outer transaction;
-- adding inner BEGIN/COMMIT blows out the outer savepoint state when
-- this migration runs in the same batch as another BEGIN/COMMIT
-- migration (e.g. 032 below), failing the next savepoint with
-- "SAVEPOINT can only be used in transaction blocks". Reproduced
-- locally 2026-04-29 against postgres18.

ALTER TABLE asset_assignments
  ALTER COLUMN asset_id TYPE text USING asset_id::text;
