-- backend/migrations/114_approvals_one_open_gate_per_card.sql
--
-- ONE CARD, ONE OPEN GATE — ENFORCED BY THE DATABASE, NOT BY A READ.
--
-- ── THE DEFECT (fr#1000) ──────────────────────────────────────────────────────
--
-- `domain/approvals/one-open-gate.ts` answered "does this card already have a
-- gate holding it?" with a bare SELECT, and every caller then INSERTed
-- unconditionally. Two n8n executions for the same card both read null and both
-- minted. Read-then-write with nothing atomic between, and nothing at the DB
-- level to catch it.
--
-- MEASURED on prod 2026-09-06/07:
--
--     39 consecutive mints on one (tenant_id, card_id) inside 60s
--     tightest pair 57ms apart (card 1854924746060203221)
--     352 duplicate gates, which carried:
--         352 extra notification_log rows
--         341 extra engagement_deliveries
--         339 extra required_approvers
--     60 cards holding >=2 simultaneously-pending gates, 67 excess rows
--
-- So this is not cosmetic bookkeeping: a human was PAGED TWICE and asked to
-- decide twice about one stuck card. Growth of non-self-closing duplicates per
-- week: 1 (Jun-15) -> 5 (Jul-06) -> 30 (Aug-24).
--
-- ── WHY THE INDEX ALONE WOULD HAVE BEEN A REGRESSION ──────────────────────────
--
-- A partial unique index on its own turns the losing INSERT into a 23505 that no
-- caller handles -- trading duplicate gates for 500s on the gate-minting path.
-- The index therefore lands together with `mintOneOpenGate`, which makes the
-- INSERT itself the arbiter via `ON CONFLICT ... DO NOTHING` and returns the row
-- that won. Index and conflict-handling are one change; neither is correct alone.
--
-- ⚠️ THE PREDICATE HERE AND THE ONE IN `mintOneOpenGate` MUST STAY IDENTICAL.
-- Postgres matches an ON CONFLICT arbiter to a partial index by its predicate;
-- if they diverge it finds no arbiter and raises 42P10 on EVERY mint, not only
-- the racing ones.
--
-- ── THE 67 ROWS THIS CHANGES, AND WHY THE OLDEST SURVIVES ─────────────────────
--
-- A unique index cannot be created while rows violate it, so the duplicates must
-- be resolved first -- in this file, before the CREATE, or the migration fails on
-- any database carrying real data.
--
-- The survivor is the OLDEST row per (tenant_id, card_id). That is not a
-- preference: `findOpenGateForCard` orders `created_at ASC, id ASC` and returns
-- the first row, so the oldest IS the gate the application already treats as the
-- one holding the card. Keeping any other row would make the migration disagree
-- with the reader. (`id` breaks an exact `created_at` tie so the rule is total.)
--
-- ⛔ NO DELETE. The losers are VOIDED, using the vocabulary migration 110 created,
-- so the change is reversible: `voided_by = 'migration:114_one_open_gate_per_card'`
-- names the exact row set. To undo, DROP the index first, then set those rows back
-- to `pending`. Child rows (required_approvers, engagement_deliveries,
-- notification_log) are deliberately untouched -- the humans were already paged;
-- deleting the record of that would not un-page them.
--
-- ⚠️ `CREATE INDEX CONCURRENTLY` IS IMPOSSIBLE HERE. The runner wraps the whole
-- run in one `sql.begin(...)` with a SAVEPOINT per file, and CONCURRENTLY cannot
-- run inside a transaction block. A plain create is correct at this size: the
-- table holds ~2,855 rows, so the SHARE lock is milliseconds (precedent: 112).

-- Runner-owned receipt table. Repeated here with IF NOT EXISTS so this file is
-- independently runnable rather than depending on 113 having gone first.
CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The void and its receipt in ONE statement.
--
-- ⭐ THE CTE IS LOAD-BEARING, for the same reason it is in 113: Postgres runs a
-- data-modifying WITH clause exactly once and to completion, so the receipt
-- cannot land unless the UPDATE ran. Two statements would let a later edit drop
-- the UPDATE while leaving a receipt asserting it happened.
--
-- Idempotent: after the first run no row satisfies the EXISTS (only one pending
-- row per card remains), so a re-run voids zero and DO NOTHING preserves the
-- ORIGINAL receipt and its row count rather than overwriting it with a zero.
WITH voided AS (
  UPDATE approvals a
     SET status        = 'voided',
         voided_at     = now(),
         voided_by     = 'migration:114_one_open_gate_per_card',
         voided_reason = 'Duplicate pending gate on the same card (fr#1000). '
                      || 'An older pending gate already holds this card; this row '
                      || 'was a second page for one stuck card.'
   WHERE a.status = 'pending'
     AND a.card_id IS NOT NULL
     AND EXISTS (
       SELECT 1 FROM approvals w
        WHERE w.status = 'pending'
          AND w.card_id IS NOT NULL
          AND w.tenant_id = a.tenant_id
          AND w.card_id  = a.card_id
          AND (w.created_at, w.id) < (a.created_at, a.id)
     )
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '114_approvals_one_open_gate_per_card.sql',
       jsonb_build_object('voided_duplicate_gates', (SELECT count(*) FROM voided))
ON CONFLICT (migration) DO NOTHING;

-- The arbiter. Predicate must match `mintOneOpenGate`'s `where` exactly.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_open_gate_per_card_idx
  ON approvals (tenant_id, card_id)
  WHERE status = 'pending' AND card_id IS NOT NULL;
