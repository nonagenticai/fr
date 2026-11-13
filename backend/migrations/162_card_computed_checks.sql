-- Migration: 162_card_computed_checks
-- Date: 2026-10-05
--
-- LIVENESS NEVER COUNTS TOWARD DONE (George ruling 2026-10-01), applied to the PROOF SUBSET
-- (bug_analysis, code_quality_analysis, security_analysis, development_bug_fix,
-- bug_hunt_sweep). Design: ~/.claude/plans/program/20-designs/
-- liveness-done-paths-proof-subset-2026-10-05.md; measured table: ncn#2087.
--
-- Two APPEND-ONLY tables, keyed by Planka card id:
--
-- 1. card_computed_checks — one row per COMPUTED evaluator verdict for a card (n8n
--    verify-coding with computed_ops_passed >= 1; the R10 PROOF-CORE grader). Written ONLY by
--    POST /api/internal/cards/:cardId/computed-checks, which authenticates a per-caller
--    X-Internal-Token and DERIVES `written_by` from WHICH token matched — never from the body
--    and never from a human JWT. Every fr DONE-move guard reads this table
--    (services/kanban/done-guard.ts hasComputedPass), never a liveness, judge or human field.
--
--    ⛔ NOT ac_coverage. That store is the ILS AA-TRACE sink (improvement-loop-service), per
--    acceptance criterion, and it already holds HUMAN `coverage_source='approval'` rows; a
--    computed pass must never be satisfiable by a human sign-off, so it cannot share a table
--    whose rows a human decision writes. NOT card_scenario_evidence either: that is repro
--    INPUT (the test file), not a verdict.
--
-- 2. card_done_overrides — the BREAK-GLASS audit row. A super-admin may move a proof-subset
--    card to DONE without a computed pass only through POST /api/kanban/cards/:cardId/
--    break-glass-done, with a mandatory reason. The row IS the mark: done_by is always
--    'human_override', and every fr DONE consumer treats a card with a row here as NON-DONE.
--
-- Append-only is enforced by the DATABASE (a BEFORE UPDATE OR DELETE trigger that raises),
-- not by convention: a verdict or an override that can be rewritten is not evidence.
-- TRUNCATE is not covered (it is an operator act, not a row write).
--
-- Pure DDL, additive, idempotent. No DML. NOT in src/db/schema.ts (same choice as 140/154):
-- the runner probes keep this file PENDING on a push-built database, so ONE emitter builds
-- the tables in CI and prod.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_computed_checks (
  id            bigserial   PRIMARY KEY,
  card_id       text        NOT NULL,
  check_kind    text        NOT NULL,
  verdict       text        NOT NULL,
  evidence_sha  text        NOT NULL,
  written_by    text        NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_computed_checks_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_computed_checks_check_kind_shape CHECK (check_kind ~ '^[a-z][a-z0-9_.:-]{0,63}$'),
  CONSTRAINT card_computed_checks_verdict_enum CHECK (verdict IN ('pass', 'fail')),
  CONSTRAINT card_computed_checks_evidence_sha_shape CHECK (evidence_sha ~ '^[0-9a-f]{40}([0-9a-f]{24})?$'),
  CONSTRAINT card_computed_checks_written_by_nonempty CHECK (written_by <> '')
);

CREATE INDEX IF NOT EXISTS card_computed_checks_card_latest_idx
  ON card_computed_checks (card_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS card_done_overrides (
  id          bigserial   PRIMARY KEY,
  card_id     text        NOT NULL,
  board_id    text        NOT NULL,
  card_type   text        NOT NULL,
  actor_id    text        NOT NULL,
  reason      text        NOT NULL,
  done_by     text        NOT NULL DEFAULT 'human_override',
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT card_done_overrides_card_id_nonempty CHECK (card_id <> ''),
  CONSTRAINT card_done_overrides_actor_nonempty CHECK (actor_id <> ''),
  CONSTRAINT card_done_overrides_reason_nonblank CHECK (length(btrim(reason)) > 0 AND length(reason) <= 2000),
  CONSTRAINT card_done_overrides_done_by_enum CHECK (done_by = 'human_override')
);

CREATE INDEX IF NOT EXISTS card_done_overrides_card_idx
  ON card_done_overrides (card_id);

CREATE OR REPLACE FUNCTION fr_refuse_append_only_mutation() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: % refused', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

DROP TRIGGER IF EXISTS card_computed_checks_append_only ON card_computed_checks;
CREATE TRIGGER card_computed_checks_append_only
  BEFORE UPDATE OR DELETE ON card_computed_checks
  FOR EACH ROW EXECUTE FUNCTION fr_refuse_append_only_mutation();

DROP TRIGGER IF EXISTS card_done_overrides_append_only ON card_done_overrides;
CREATE TRIGGER card_done_overrides_append_only
  BEFORE UPDATE OR DELETE ON card_done_overrides
  FOR EACH ROW EXECUTE FUNCTION fr_refuse_append_only_mutation();

COMMENT ON TABLE card_computed_checks IS
  'Append-only COMPUTED evaluator verdicts per Planka card (n8n verify-coding, R10 grader). Written only via '
  'POST /api/internal/cards/:cardId/computed-checks (per-caller X-Internal-Token; written_by derived from the token). '
  'Read by the fr DONE-move guard (services/kanban/done-guard.ts). Liveness/judge/human never write here.';
COMMENT ON TABLE card_done_overrides IS
  'Append-only break-glass audit: a super-admin moved a proof-subset card to DONE without a computed pass. '
  'done_by is always human_override; every fr DONE consumer treats the card as NON-DONE.';
