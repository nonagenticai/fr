-- Migration: 191_approval_callback_url
-- Date: 2026-10-13
--
-- D17 (George-approved): an approval minted by n8n through the LICENCE door may
-- carry the n8n Wait node's `$execution.resumeUrl` as `callback_url`. On a
-- decision fr POSTs the decision payload to that URL EXACTLY as given, and to
-- nothing else — such an approval stores `callback_path` NULL, so no worker that
-- keys on `callback_path` ever posts it to `${N8N_WEBHOOK_URL}/<path>`.
--
-- ONE APPROVAL, SEVERAL CALLBACKS (1:N). A licence create that DEDUPES onto an
-- already-pending gate for the same card (one-open-gate) ATTACHES its
-- callback_url to that gate instead of dropping it — otherwise the second n8n
-- execution's Wait node never resumes. So a row is (approval, URL), unique on
-- (approval_id, md5(callback_url)) — md5 because a btree entry on the raw TEXT can
-- exceed the index row limit — and re-attaching the same URL is a no-op
-- (ON CONFLICT DO NOTHING). Each row carries its OWN delivery state
-- (`attempts`, `next_attempt_at`, `delivered_at`, `last_error`): one dead
-- receiver must neither block nor re-fire the others.
--
-- ⛔ WHY A SIDE TABLE AND NOT A COLUMN ON `approvals`. The value is a
-- CAPABILITY: n8n's resume URL carries a `signature` query parameter, and whoever
-- holds it can resume the waiting execution with any body — i.e. forge a
-- decision without fr. `approvals` rows leave fr whole: ~25 `select()` /
-- `returning()` full-row reads feed the REST API, the websocket broadcast and the
-- notification fan-out. A column there would ship the secret to every tenant user
-- who can read an approval. A side table is never read by any of those paths;
-- only services/n8n-callback.ts and workers/approval-redelivery.ts join it.
-- Never log it in full — origin + path prefix only (lib/approval-callback-url.ts).
--
-- DELIVERY: on ANY terminal status — approved / rejected (the decision), and
-- expired (workers/approval-expiry.ts) / voided (lib/void-approvals.ts), so a
-- lapsed or withdrawn gate also resumes its Wait node with decision
-- `expired` / `voided` — every undelivered row is POSTed. A send first CLAIMS its
-- row (`next_attempt_at` leased ahead, `attempts` + 1) so two senders never race;
-- a failure schedules `now() + min(15min * 2^(attempts-1), 24h)`; the
-- workers/approval-redelivery.ts callback lane re-sends due rows. Nothing here
-- touches migration 186's `approvals.redelivery_attempts` (the pending-row
-- notification lane's counter).
--
-- DESTRUCTIVE-STATEMENT GUARD (migration 142 regime, fr#1283): PROTECTED, like
-- `approvals` it hangs off (no regeneration path — a lost row strands a waiting
-- n8n execution). Listed in 142's `protected_tables` AND attached at the bottom of
-- THIS file, for the reason 160 gives: in production 142 never re-runs, so this
-- attach is what guards the table; on a push-built CI database 142 is re-applied
-- and its loop attaches to it as well. The cascade from a single-approval DELETE
-- removes that approval's few callback rows here, far under the guard's threshold.
--
-- RUNNER CONTRACT: DDL only (CREATE TABLE / ALTER TABLE / CREATE INDEX + CREATE OR
-- REPLACE TRIGGER reusing 142's functions), no DML; mirrored in src/db/schema.ts (so a push-built
-- database satisfies the probe). Idempotent (IF NOT EXISTS / CREATE OR REPLACE / the guarded DO block)
-- — safe under `reapplyIfProbeFails`. No BEGIN/COMMIT — the runner wraps each
-- file in a SAVEPOINT.

SET LOCAL lock_timeout = '10s';

CREATE TABLE IF NOT EXISTS approval_callback_urls (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  approval_id     UUID        NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  tenant_id       UUID        NOT NULL,
  callback_url    TEXT        NOT NULL,
  attempts        INTEGER     NOT NULL DEFAULT 0,
  next_attempt_at TIMESTAMPTZ,
  delivered_at    TIMESTAMPTZ,
  last_error      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- A database that applied this file's first (unmerged) 1:1 draft — PRIMARY KEY on
-- approval_id, no delivery columns — is reshaped in place. Pure DDL, idempotent:
-- each step is a no-op on the table created above.
ALTER TABLE approval_callback_urls ADD COLUMN IF NOT EXISTS id UUID NOT NULL DEFAULT gen_random_uuid();
ALTER TABLE approval_callback_urls ADD COLUMN IF NOT EXISTS attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE approval_callback_urls ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ;
ALTER TABLE approval_callback_urls ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ;
ALTER TABLE approval_callback_urls ADD COLUMN IF NOT EXISTS last_error TEXT;
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM pg_constraint c
      JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY (c.conkey)
     WHERE c.conrelid = 'public.approval_callback_urls'::regclass
       AND c.contype = 'p'
       AND a.attname = 'approval_id'
  ) THEN
    ALTER TABLE approval_callback_urls DROP CONSTRAINT approval_callback_urls_pkey;
    ALTER TABLE approval_callback_urls ADD PRIMARY KEY (id);
  END IF;
END
$$;

-- One row per (approval, URL): re-attaching the same Wait-node URL is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS approval_callback_urls_approval_url_key
  ON approval_callback_urls (approval_id, md5(callback_url));
-- The redelivery lane's population: undelivered rows, by due time.
CREATE INDEX IF NOT EXISTS approval_callback_urls_undelivered_idx
  ON approval_callback_urls (next_attempt_at)
  WHERE delivered_at IS NULL;

-- Attach migration 142's guard (functions fr_refuse_truncate /
-- fr_refuse_bulk_delete). Same shape and ENABLE ALWAYS state as 142's loop.
CREATE OR REPLACE TRIGGER fr_guard_truncate_approval_callback_urls
  BEFORE TRUNCATE ON public.approval_callback_urls
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_truncate();
ALTER TABLE public.approval_callback_urls
  ENABLE ALWAYS TRIGGER fr_guard_truncate_approval_callback_urls;

CREATE OR REPLACE TRIGGER fr_guard_bulk_delete_approval_callback_urls
  AFTER DELETE ON public.approval_callback_urls
  REFERENCING OLD TABLE AS fr_deleted_rows
  FOR EACH STATEMENT EXECUTE FUNCTION fr_refuse_bulk_delete();
ALTER TABLE public.approval_callback_urls
  ENABLE ALWAYS TRIGGER fr_guard_bulk_delete_approval_callback_urls;
