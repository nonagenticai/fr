-- Migration: 149_project_reports_trace_id
-- Date: 2026-10-01
--
-- U2 × AA-TRACE — STAMP THE RUN THAT WROTE A REPORT.
--
-- AA-TRACE-join-key-SPEC.md §1:
--   | `trace_id` | UUIDv7 | Minted ONCE, by the first n8n execution triggered by
--   a Planka card event (Router), or by fr for fr-originated actions … It never
--   changes downstream. |
-- U2 ruling (10-01, condition 4): "The report row stamps the `trace_id` from
-- AA-TRACE-join-key-SPEC.md."
--
-- (148 is taken by the parallel U11 branch, 148_card_plan_pinning.sql; 149 is
-- the next free number on origin/main at build time.)
--
-- ── WHAT THIS FILE ADDS ───────────────────────────────────────────────────
-- * `trace_id uuid` — NULLABLE. Spec §2: a write with no X-AA-Trace-Id is
--   recorded with trace_id NULL (an orphan), not refused; §4 makes a missing
--   trace UNPROVEN in a proof run, which requires the row to exist.
-- * `project_reports_trace_id_v7` — CHECK: version nibble 7 and RFC 9562
--   variant. The route checks the same shape (src/lib/aa-trace.ts) first; this
--   is the backstop for a writer that bypasses it.
-- * `project_reports_trace_id_idx` — partial index for the join (trace → report).
--
-- trace_id is NOT part of H_r (content_hash): it names the run, not the
-- content. Insert-once on (tenant_id, content_hash) keeps the FIRST run's trace.
--
-- ── WHY THE CHECK + INDEX ARE NOT IN schema.ts ─────────────────────────────
-- Same as 141/147: `trace_id` IS in schema.ts, so `drizzle-kit push` builds the
-- column without the CHECK and the index; the COLUMN_PROBES entry checks both
-- so a push-built database keeps 149 PENDING and the runner creates them here.
--
-- Pure DDL, additive, idempotent. No DML. No BEGIN/COMMIT (runner SAVEPOINT).

ALTER TABLE project_reports ADD COLUMN IF NOT EXISTS trace_id uuid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'project_reports_trace_id_v7'
       AND conrelid = 'project_reports'::regclass
  ) THEN
    ALTER TABLE project_reports
      ADD CONSTRAINT project_reports_trace_id_v7
      CHECK (trace_id IS NULL OR trace_id::text ~ '^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$');
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS project_reports_trace_id_idx
  ON project_reports (trace_id)
  WHERE trace_id IS NOT NULL;

COMMENT ON COLUMN project_reports.trace_id IS
  'AA-TRACE §1 join key (UUIDv7) of the run that wrote this row; NULL = orphan write (§2). '
  'Not part of content_hash (H_r).';
