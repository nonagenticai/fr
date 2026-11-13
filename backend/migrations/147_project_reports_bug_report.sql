-- Migration: 147_project_reports_bug_report
-- Date: 2026-10-01
--
-- U2 — THE BUG REPORT AS A DURABLE, CONTENT-ADDRESSED ARTIFACT.
--
-- Before this, analyze-bug's report travelled only as an approval request body
-- (folded into the card description, Planka copy capped at 460 chars) and
-- nothing persisted it. POST /api/webhooks/n8n/report now accepts
-- `report_type = 'bug_report'` (src/routes/reports.ts →
-- src/services/reports/bug-report.ts), whose row carries `content_hash` = H_r,
-- the sha256 of the RFC 8785 canonical JSON of the bug_report/v1 hash body
-- (src/lib/bug-report-hash.ts). The SERVER recomputes H_r; a client-sent hash
-- that disagrees is a 400.
--
-- ── WHAT THIS FILE ADDS ───────────────────────────────────────────────────
-- * `content_hash text` — H_r. NULL for every pre-existing and every non
--   bug_report row; the CHECK pins the shape when present.
-- * `card_id` already exists (migration 005); the IF NOT EXISTS below is a
--   no-op kept so this file states every column the bug_report contract reads.
-- * `project_reports_bug_report_required` — a `bug_report` row MUST carry a
--   non-NULL tenant_id, content_hash and card_id. NULL tenant would make the
--   row fail-closed-INVISIBLE (every read is tenant-predicated, migration 080),
--   which for an artifact a human must read before approving is a silent loss,
--   not a safe default. The route refuses it first; this is the backstop.
-- * `project_reports_tenant_content_hash_uniq` — partial UNIQUE
--   (tenant_id, content_hash) WHERE content_hash IS NOT NULL: the insert-once
--   arbiter. The route inserts ON CONFLICT DO NOTHING against exactly this
--   predicate and returns the existing row on a duplicate.
--
-- `report_type` has NO database enum or CHECK (005 declared it plain text);
-- the closed set lives in the zod schema in src/routes/reports.ts. Adding a
-- CHECK here would have to enumerate every value prod rows already carry,
-- which this migration does not know, so it deliberately does not.
--
-- ── WHY NOT IN schema.ts (the index + constraints) ─────────────────────────
-- `content_hash` IS declared in schema.ts (drizzle reads/writes it). The index
-- and the two CHECKs are NOT: the same choice as 141 — `drizzle-kit push` would
-- build the column without the partial index, CI would then exercise an
-- insert-once proof against a table that can exclude nothing, and it would
-- pass while prod diverged. The COLUMN_PROBES entry for this file checks the
-- index AND both constraints, so a push-built database keeps 147 PENDING and the
-- runner creates them from THIS file — one emitter.
--
-- Pure DDL, additive, idempotent (IF NOT EXISTS / pg_constraint-guarded DO
-- block). No DML. No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS card_id text;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_reports_content_hash_hex'
       AND conrelid = 'project_reports'::regclass
  ) THEN
    ALTER TABLE project_reports
      ADD CONSTRAINT project_reports_content_hash_hex
      CHECK (content_hash IS NULL OR content_hash ~ '^[0-9a-f]{64}$');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_reports_bug_report_required'
       AND conrelid = 'project_reports'::regclass
  ) THEN
    ALTER TABLE project_reports
      ADD CONSTRAINT project_reports_bug_report_required
      CHECK (
        report_type <> 'bug_report'
        OR (tenant_id IS NOT NULL AND content_hash IS NOT NULL AND card_id IS NOT NULL AND card_id <> '')
      );
  END IF;
END
$$;

CREATE UNIQUE INDEX IF NOT EXISTS project_reports_tenant_content_hash_uniq
  ON project_reports (tenant_id, content_hash)
  WHERE content_hash IS NOT NULL;

COMMENT ON COLUMN project_reports.content_hash IS
  'H_r: sha256 (lowercase hex) of the RFC 8785 canonical JSON of the bug_report/v1 hash body, '
  'recomputed by the server (src/lib/bug-report-hash.ts). Insert-once per (tenant_id, content_hash).';
