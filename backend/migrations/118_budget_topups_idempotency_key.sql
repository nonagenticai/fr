-- 118: budget_topups.idempotency_key — make a token top-up un-double-creditable.
--
-- THE DEFECT
-- ----------
-- `budget_topups` (migration 092) carried NO uniqueness of any kind: a
-- gen_random_uuid() PK and one non-unique (tenant_id, created_at DESC) index.
-- `POST /api/me/budget/topup` accepted `{package_id}` only — no client key, no
-- header, no in-flight dedupe — and `runTopUp` opens a fresh audit row and then
-- calls billing's `POST /api/budget/topup/{tenant}` unconditionally.
--
-- So a double-clicked button, a proxy retry or a client-side retry allocated the
-- package TWICE: two budget_topups rows and two STACKING billing token budgets.
-- Packages run 1M-100M tokens, so each extra submit is a free grant of that size
-- and the platform under-bills by it.
--
-- The contrast that makes this a defect rather than an omission: the sibling
-- table added one migration later, `budget_alert_receipts` (093), DOES carry
-- `UNIQUE (budget_id, threshold_pct, period_start)` precisely so a re-delivered
-- webhook fans out at most once. The notification path was made idempotent and
-- the MONEY path was not.
--
-- THE FIX
-- -------
-- A caller-supplied `idempotency_key`, unique per tenant. The route INSERTs with
-- ON CONFLICT DO NOTHING and, on a conflict, returns the ORIGINAL row's outcome
-- instead of allocating again. Scoped per tenant (not globally) so two tenants
-- cannot collide on a guessable key, and so the key need only be unique to the
-- client that minted it.
--
-- Legacy rows are backfilled with a 'legacy-<id>' sentinel rather than a
-- constant: every historical row is a genuinely distinct top-up that really did
-- happen, so collapsing them under one key would be a lie about the past, and a
-- NULL would leave the column nullable and the guarantee optional.
--
-- PROBED: src/db/migration-runner.ts COLUMN_PROBES asserts
-- budget_topups.idempotency_key exists. Required — this file contains DML (the
-- backfill UPDATE) and `drizzle-kit push` cannot reproduce a data effect, so
-- without the probe the runner would stamp this APPLIED WITHOUT RUNNING IT
-- whenever `_migrations` is empty but the schema is populated, which is exactly
-- what CI's bootstrap produces.

ALTER TABLE budget_topups ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE budget_topups
   SET idempotency_key = 'legacy-' || id::text
 WHERE idempotency_key IS NULL;

ALTER TABLE budget_topups ALTER COLUMN idempotency_key SET NOT NULL;

-- A unique INDEX, not a named CONSTRAINT: `CREATE UNIQUE INDEX IF NOT EXISTS` is
-- re-runnable where `ADD CONSTRAINT` is not, and ON CONFLICT (tenant_id,
-- idempotency_key) infers from the index either way.
CREATE UNIQUE INDEX IF NOT EXISTS budget_topups_tenant_idempotency_key
    ON budget_topups (tenant_id, idempotency_key);
