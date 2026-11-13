-- Migration: 139_repoint_tip_to_stream_project
-- Date: 2026-09-28
--
-- REPOINT `tenant_improvement_projects` AT THE PLANKA PROJECT ITS STREAM USES.
--
-- ── WHY ────────────────────────────────────────────────────────────────────
-- The prompt-improvement TIP row (tenant 0195f48b-…0004, kind 'prompt') points
-- at Planka project 1764108882289886208 — the id migration 041 seeded in April
-- for an "empty umbrella" that 062 later re-keyed onto the new tenant. That
-- project is now an EMPTY duplicate "Continuous Prompt Improvement" board. The
-- live prompt board lives under 1768129775626355922 (73 cards), and the
-- `streams` row for the same (tenant, kind) (`__system_prompt__`) already
-- points there. The workflow TIP row agrees with its stream.
--
-- The STREAM is the source of truth: it is what the detector, the card routes
-- and the board UI actually read. The TIP row matters only to the
-- provisioner (src/services/streams/provisioner.ts ensureUmbrellaProject/-s),
-- which REUSES an existing TIP row without consulting `streams`. So a stale
-- TIP row silently routes every NEW stream board created for that
-- (tenant, kind) — via POST /api/assets/streams or the agui create-stream
-- action — into the dead project.
--
-- ── WHAT ───────────────────────────────────────────────────────────────────
-- DATA-DERIVED, no hard-coded Planka ids. For every TIP row whose
-- (tenant_id, kind) has EXACTLY ONE `streams` row with a non-null
-- planka_project_id, and that id differs from the TIP's, copy the stream's id
-- onto the TIP row. Zero streams → nothing to derive from; two or more → the
-- choice is ambiguous and is left for a human. Measured live 2026-09-28
-- (read-only): 14 TIP rows, exactly 1 matches (the prompt row above); the
-- three 0195f48b-…0002 asset kinds with 2 streams each already agree with TIP
-- and are untouched either way.
--
-- ⚠️ NOT PROBED, DELIBERATELY. `COLUMN_PROBES` in src/db/migration-runner.ts
-- covers SCHEMA migrations. On a push-bootstrapped DB (CI) the runner stamps
-- this file applied without running it; that loses nothing, because nothing
-- in backend/migrations inserts `streams` rows (they are created lazily by
-- application code), so a fresh database has no drift to repair. Same
-- reasoning as migration 121.
--
-- IDEMPOTENT: the `IS DISTINCT FROM` guard means a second run matches zero
-- rows. Covered by tests/integration/migrations/139-repoint-tip-to-stream.
-- integration.test.ts.

DO $$
DECLARE
    repointed integer;
BEGIN
    WITH single_stream AS (
        SELECT s.tenant_id,
               s.kind,
               min(s.planka_project_id) AS planka_project_id
          FROM streams s
         WHERE s.planka_project_id IS NOT NULL
         GROUP BY s.tenant_id, s.kind
        HAVING count(*) = 1
    )
    UPDATE tenant_improvement_projects t
       SET planka_project_id = ss.planka_project_id
      FROM single_stream ss
     WHERE t.tenant_id = ss.tenant_id
       AND t.kind = ss.kind
       AND t.planka_project_id IS DISTINCT FROM ss.planka_project_id;

    GET DIAGNOSTICS repointed = ROW_COUNT;
    RAISE NOTICE '139_repoint_tip_to_stream_project: repointed % tenant_improvement_projects row(s)', repointed;
END$$;
