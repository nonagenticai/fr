-- 099: documents.kag_degraded (+ reason / stage / chunk counts) — HONESTY flags
-- for a KAG ingestion that COMPLETED while losing most of the document.
--
-- Same failure mode as 091 (coding scan_degraded), one pipeline over. karma
-- PR #127 gave the extractor "partial credit": a chunk that only half-extracted
-- is returned ok=True with result.degraded=true. kag_orchestrator #123 OR-s two
-- independent signals into the stage metrics it callbacks with — its own
-- lost-chunk tolerance AND karma's per-chunk degraded bit
-- (src/adapters/karma/__init__.py: "the chunk is ok=True here, so failed_pct is
-- 0.0 and signal 1 alone can never see it"). hirag mirrors its own degraded bit
-- into metrics.degraded + metrics.partial for the same reason.
--
-- fr received all of that inside kag_ingest.stage_history[].metrics and threw it
-- away: mapJobStatusToRow flattened every terminal KAG outcome to a clean
-- 'completed', deriveIngestionProgress dropped every non-number metric (so the
-- degraded/partial BOOLEANS never survived the fold), and the status route never
-- returned a degraded field at all. A REAL prod row today:
--
--     total_chunks 137 · succeeded_chunks 18 · failed_chunks 119 · entities 239
--
-- 86% of that document is missing from the graph and fr renders a green
-- "completed". 20 such rows exist in prod. A researcher must never be shown a
-- silently-incomplete graph.
--
-- NULLABLE, and the NULL is load-bearing: NULL means UNKNOWN — never "clean",
-- never "degraded". Pre-099 rows, parse-only rows (KAG never ran), rows settled
-- from a LOST terminal callback whose stage_history carried no degraded/partial
-- key, and rows orphaned by a 404 job record all stay NULL. Only a poll that
-- actually READ a degradation signal off the upstream job writes true/false.
-- Anything that renders `kag_degraded = false` as a positive all-clear must
-- first check the column is not NULL.
--
-- chunks_indexed / chunks_failed / chunks_total are the karma stage's own
-- headline counts, persisted verbatim — never derived from one another, so a
-- missing count stays visibly missing instead of being invented by subtraction.
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kag_degraded        BOOLEAN;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kag_degraded_reason TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS kag_degraded_stage  TEXT;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunks_indexed      INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunks_failed       INTEGER;
ALTER TABLE documents ADD COLUMN IF NOT EXISTS chunks_total        INTEGER;

-- Partial index: the operator question is "which documents are lying to their
-- readers", so only the TRUE rows are worth indexing. NULL and FALSE rows are
-- excluded from the index entirely.
CREATE INDEX IF NOT EXISTS ix_documents_kag_degraded ON documents (kag_degraded) WHERE kag_degraded;
