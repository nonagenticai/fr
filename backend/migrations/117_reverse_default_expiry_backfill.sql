-- 117_reverse_default_expiry_backfill.sql
--
-- ⛔ THIS REVERSES MIGRATION 107's DATA EFFECT, ON PURPOSE, ON A CLOCK.
--    Read 107's header first — this file is the rollback 107 itself published,
--    WITH ONE CORRECTION. The correction is the whole reason this is a new
--    migration and not a copy-paste of the SQL in 107's comment.
--
-- ── WHY NOW ────────────────────────────────────────────────────────────────
--
-- 107 manufactured a deadline for 794 pending approvals that had NONE. 191 of
-- those are STILL PENDING and every one of them matures on 2026-09-10, the
-- earliest at 03:04:27 UTC.
--
-- Expiry is IRREVERSIBLE in the only sense that matters to a human waiting on
-- one of these rows:
--   * workers/approval-expiry.ts sets `status='expired'` + `completed_at`;
--   * routes/approvals.ts::handleUpdateApproval then 422s any non-pending row.
-- So once the reaper fires, the approval can never be decided BY ANYONE, EVER.
-- Not by the requester, not by an operator, not by a later migration — the
-- decision route is closed and there is no un-expire path.
--
-- The deadline being enforced is MANUFACTURED. `previous_expires_at` is NULL on
-- 191 of 191 (measured, below): before 107 these rows carried no deadline at
-- all. src/lib/approval-deadline.ts argues, with measurements, that a deadline
-- on a card-BLOCKING approval is itself the defect — BLOCKED *is* the wait
-- state. 107 overrode that knowingly; this file restores the pre-107 state for
-- the rows that are still undecided, before the override becomes permanent.
--
-- ── ⛔ THE CORRECTION: 107's PUBLISHED ROLLBACK IS MISSING A STATUS GUARD ───
--
-- 107's header (lines 34-38) prints this as the way to reverse it:
--
--     UPDATE approvals
--        SET expires_at = NULL
--      WHERE metadata ? 'default_expiry_backfill_107'
--        AND (metadata->'default_expiry_backfill_107'->>'previous_expires_at') IS NULL;
--
-- ⚠️ DO NOT RUN THAT. It has no `status` term, so it does not stop at the rows
-- 107 is still harming — it reaches every row 107 ever touched, including the
-- ones that have since been DECIDED.
--
-- MEASURED ON THE PRODUCTION STANDBY 2026-09-09 (master:5432,
-- pg_is_in_recovery()=t, so the reads below could not have written anything):
--
--     191  rows match WITH    `AND status = 'pending'`   <- this file's target
--     925  rows match WITHOUT it                          <- 107's published text
--     ---
--     734  already-decided rows the published rollback would ALSO have cleared
--          = 327 status='approved'  +  407 status='voided'
--
-- Clearing `expires_at` on a decided row does not un-decide it — `completed_at`
-- and the decision row are what make it terminal — but it DESTROYS THE ONLY
-- RECORD of the deadline that row was under while it was open, and it does so
-- silently, on 734 rows, in the same statement that fixes 191. `approvals` has
-- no history table, no audit trigger and no `updated_at` trigger (107's own
-- header says so), and this file writes no pre-image of its own for those rows
-- because it must not touch them at all. That damage would be unrecoverable.
--
-- ⭐ THE GUARD IS ALSO WHAT MAKES THIS FILE'S SCOPE EQUAL TO ITS JUSTIFICATION.
-- The argument above is "an undecided row must stay decidable". A decided row
-- is not covered by that argument, so it is not covered by this UPDATE.
--
-- ── WHAT IS *NOT* TOUCHED, AND THE CONTROL THAT PROVES IT ──────────────────
--
--     797  pending approvals carry a deadline that 107 did NOT set
--          (no `default_expiry_backfill_107` key). These are caller-set
--          `source='n8n'` ~14-day deadlines — a real request from the caller,
--          not something fr invented. They are CORRECTLY EXCLUDED.
--
-- 468 of them fall on 2026-09-22, a far larger cliff than the one this file
-- clears. ⛔ THAT CLIFF IS DELIBERATELY LEFT STANDING. Whether a caller-set
-- deadline should expire a card-blocking approval is the same open question
-- 107 answered by fiat, and it needs deciding on its own evidence — not
-- silently, as a side effect of a rollback aimed at 191 different rows.
--
-- ── WHY `expires_at = NULL` IS SAFE, VERIFIED ON origin/main ───────────────
--
--   * workers/approval-expiry.ts:251 — the reaper's predicate is
--     `status = 'pending' AND expires_at <= now()`. SQL three-valued logic makes
--     `NULL <= now()` UNKNOWN, so a NULL row is never selected. It is not
--     "expired later"; it is out of the population.
--   * lib/approval-deadline.ts::hasPassedDeadline returns false on NULL, by an
--     explicit `== null` test, and its header says it mirrors the reaper's
--     predicate deliberately so the two can never disagree.
-- So a NULL deadline restores exactly the pre-107 behaviour: the approval waits
-- for a human, indefinitely, which is what BLOCKED means.
--
-- ── NOTHING IS LOST, AND 107 STAYS RE-APPLIABLE ────────────────────────────
--
-- This does NOT strip the `default_expiry_backfill_107` metadata stamp. The
-- stamp is the only evidence these rows were ever backfilled, and it is what
-- lets this file be surgical at all. Because `previous_expires_at` is NULL on
-- all 191, there is no pre-image to restore and none is discarded: NULL is the
-- pre-image. If the deadline policy is genuinely wanted later, 107's own
-- SELECT (`status='pending' AND expires_at IS NULL AND NOT (metadata ? ...)`)
-- will not re-match these rows — by design, since they keep the stamp — so a
-- future policy must be a NEW migration that says so out loud, which is the
-- correct place for that decision to be visible.
--
-- ── RE-RUN SAFETY, STATEMENT BY STATEMENT ──────────────────────────────────
--
-- Required because this file is registered with `reapplyIfProbeFails` in
-- src/db/migration-runner.ts, and that flag must never be set by analogy:
--   * the UPDATE carries `AND expires_at IS NOT NULL`, so a second run matches
--     ZERO rows. It has no way to widen: `status='pending'` only ever shrinks
--     as rows get decided, and a decided row is not re-openable.
--   * the receipt INSERT is `ON CONFLICT DO NOTHING`, so a re-run preserves the
--     ORIGINAL row count instead of overwriting it with a second run's zero.
--   * there is no unconditional INSERT, DELETE, or destructive ALTER, and no
--     schema change of any kind. This file is DATA ONLY.
--
-- ⭐ AND THE RECEIPT IS WHAT MAKES THE REVERSAL ONE-SHOT, WHICH IS THE POINT.
-- `reapplyIfProbeFails` can only fire when the receipt is ABSENT — i.e. when the
-- UPDATE has never run — so re-running is always the correct action in exactly
-- the case the flag triggers. It can never re-fire after a legitimate apply and
-- wipe deadlines that a deliberate future re-application of 107 had restored.
--
-- ── WHY IT IS PROBED, WHERE 107 REFUSED TO BE ──────────────────────────────
--
-- 107 declined a probe because the obvious one ("no stamped pending row has a
-- deadline") is re-evaluated on EVERY boot and would hard-error the backend the
-- day a single such row reappeared. That reasoning is correct and this file does
-- not repeat the mistake: the probe here is 113's `_migration_effects` RECEIPT,
-- which asks only whether the statement RAN. It is true forever once true, and
-- `drizzle-kit push` cannot fake it because push cannot INSERT A ROW.
--
-- That matters more here than it did for 113. The runner stamps an UNPROBED
-- migration APPLIED WITHOUT RUNNING IT when `_migrations` is empty and
-- `projects` exists. On a fresh database that is harmless — nothing to reverse.
-- But this file exists to beat a deadline on a real population, and "stamped
-- applied, never ran" is precisely the failure mode that would let 191 rows
-- expire while CI was green and `_migrations` said 117 had been applied.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next
-- file.

-- Runner-owned infrastructure, created by 113. Migrations run in numeric order
-- so it exists by the time this file runs — but it is guarded anyway, exactly as
-- 113 guards it. An unguarded reference to a missing relation would ERROR, and
-- because the runner wraps every file in one outer transaction that error does
-- not just skip 117, it ABORTS THE BOOT. Three lines to remove that failure mode
-- from a file whose entire purpose is to run before a deadline.
CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- ⭐ ONE STATEMENT, NOT TWO. Postgres executes a data-modifying WITH clause
-- exactly once and always to completion, so the receipt below cannot land unless
-- the UPDATE ran. Two separate statements would let a future edit reorder or
-- drop the reversal while leaving a receipt claiming it happened — the same
-- class of defect 113 introduced this pattern to close.
WITH reversed AS (
  UPDATE approvals
     SET expires_at = NULL,
         updated_at = now()
   WHERE metadata ? 'default_expiry_backfill_107'
     -- Only rows 107 created a deadline for out of nothing. A non-NULL
     -- `previous_expires_at` would mean 107 OVERWROTE a real deadline, and NULL
     -- would not be the correct restoration for it. Measured 0 such rows on
     -- prod 2026-09-09, but the term is the guarantee, not the measurement.
     AND (metadata->'default_expiry_backfill_107'->>'previous_expires_at') IS NULL
     -- ⛔ THE TERM 107's PUBLISHED ROLLBACK OMITS. Without it this statement
     -- also clears 734 already-decided rows (327 approved, 407 voided) whose
     -- deadline is now historical record. See the header.
     AND status = 'pending'
     -- Idempotence, and the reason a re-run is a provable no-op.
     AND expires_at IS NOT NULL
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '117_reverse_default_expiry_backfill.sql',
       jsonb_build_object(
         'reversed_rows', (SELECT count(*) FROM reversed),
         'expected_on_prod_2026_09_09', 191,
         'note', 'pending rows whose 107-manufactured deadline was cleared; '
                 || 'decided rows deliberately untouched'
       )
ON CONFLICT (migration) DO NOTHING;
