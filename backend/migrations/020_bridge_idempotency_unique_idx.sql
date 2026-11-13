-- Migration: bridge — partial unique index for idempotency-key replay safety
-- Date: 2026-04-25
-- Reason: `card_drafts` carries the supplied idempotency_key inside
--         `metadata->>'idempotency_key'`. The application currently does a
--         SELECT-then-INSERT to honor idempotency: if the SELECT misses, it
--         INSERTs a fresh draft. Two concurrent identical POSTs both miss
--         the SELECT and both INSERT, producing duplicate drafts under load.
--
--         A partial unique index on
--         `(project_id, producer, metadata->>'idempotency_key')`, scoped to
--         rows that actually carry the key, lets one concurrent INSERT win
--         and the other fail — the route / action layer can then re-SELECT
--         and return the winning row to the duplicate caller. Race-safe
--         idempotency replay.
--
--         The WHERE clause keeps the index sparse: rows without an
--         idempotency_key (the bulk-create-from-UI path before the migration
--         landed, plus any tests that do not stamp one) do not contribute
--         to the index and cannot collide.

CREATE UNIQUE INDEX IF NOT EXISTS card_drafts_idempotency_unique_idx
    ON card_drafts (project_id, producer, (metadata->>'idempotency_key'))
    WHERE metadata ? 'idempotency_key';
