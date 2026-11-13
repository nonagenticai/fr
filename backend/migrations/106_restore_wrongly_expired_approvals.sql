-- backend/migrations/106_restore_wrongly_expired_approvals.sql
--
-- RESTORE THE BACKLOG THAT 105 DELIBERATELY LEFT ALONE.
--
-- 105 made `expires_at` nullable and said, in its own header: "Restoring the wrongly-expired
-- backlog is a separate, reviewable step -- a schema change must not quietly rewrite 435 rows of
-- history." This is that step, reviewed on its own, authorised explicitly rather than folded into
-- the schema change.
--
-- WHY THESE ROWS ARE OWED A RESTORE. There was never an approval-expiry requirement: `grep -ci
-- expir` returns 0 across all nine AA specification documents, and the entire provenance of the
-- deadline was one `z.number().default(24)` on the card-approval webhook schema. So every row
-- below was expired by a defect, not by a policy. routes/approvals.ts refuses any decision past
-- `expires_at`, which means each one's card is currently unreachable through the only designed
-- drain (approve -> deblock_action -> move).
--
-- ============================================================================================
-- ⛔ SCOPE: `status = 'expired'` ONLY. THIS PREDICATE IS THE SAFETY PROPERTY, NOT A CONVENIENCE.
-- ============================================================================================
-- On 2026-08-31 at 10:46:50-51Z, 175 approvals were decided in TWO SECONDS by a single approver
-- identity with a null comment on all 175, at ages ranging 2.1h to 21.5h. Whatever that was, those
-- rows now carry `status = 'approved'` and a provenance nobody in this estate has yet established.
--
-- Filtering on 'expired' excludes every one of them STRUCTURALLY -- not by an id list that could
-- drift, not by a timestamp window that could be off by a second, but because an approved row is
-- not an expired row. This migration therefore CANNOT overwrite a decision, correct or otherwise.
-- Re-examining that burst is a separate question and it is deliberately not answered here.
--
-- WHAT IS RESTORED, and what is emphatically NOT:
--   * status      -> 'pending'  : the row becomes answerable again. That is the whole fix.
--   * expires_at  -> NULL       : per 105, no deadline ever. Without this the reaper would
--                                 re-expire every restored row on its very next tick and the
--                                 migration would silently undo itself while reporting success.
--   * completed_at-> NULL       : workers/approval-expiry.ts sets `completed_at = now()` when it
--                                 expires a row. A pending row with a completion time is a lie,
--                                 and `completed_at IS NOT NULL` is exactly how decision bursts
--                                 are counted -- leaving it set would inflate that census.
--   * error_message-> NULL      : it says "expired: ..."; untrue once the row is pending again.
--
--   ⛔ NOT the card. No card is moved, no list is touched, nothing goes BLOCKED -> DOING. 105's
--      sibling reasoning ("expiry must never manufacture a decision nobody made") runs in reverse
--      too: a restore returns the question to the board, it does not answer it.
--   ⛔ NOT `notified_at`. Its NULL-ness is the only evidence a push channel ever accepted the
--      request, and approval-expiry.ts branches its message on it precisely because "nobody
--      answered" and "nobody was ever told" are different failures. Clearing it would erase that
--      distinction across the whole population; re-notification is a separate decision.
--   ⛔ NOT `approver_user_id` or any triage_* column.
--
-- NOTHING IS ERASED. Both fields this migration clears are copied into `metadata` first, under a
-- namespaced key, so the evidence of the defect survives the fix. A restoration that destroys the
-- record of what it restored is worse than the defect.
--
-- ⛔ CHECKED BEFORE SHIPPING: THIS CANNOT DOUBLE-GATE A CARD.
-- The obvious way this migration could do harm is by restoring a row whose card was ALREADY
-- returned to the board by the expiry re-queue notice (fr #897 + n8n_custom_nodes #1187). That
-- card would then carry two live gates for one question. Measured rather than assumed:
--
--   callback_path                      expired  expired AFTER the re-queue sender went live
--   kanban/approval-callback               280                                            0
--   execution-ready-signoff-callback       152                                            0
--   (null)                                   3                                            0
--
-- The sender went live ~09:35Z on 2026-08-31; the LATEST expiry in the whole table is
-- 2026-08-30 14:00:08. So not one of these 435 rows ever fired a notice, and not one of their
-- cards was ever re-queued. Every restore below returns a question that has been unanswerable
-- since it expired, to a card that has been sitting on it. Re-check this if the migration is
-- applied long after it was written — the property is a fact about a WINDOW, not an invariant.
--
-- ⚠️ OPERATOR NOTE — WHAT THIS LOOKS LIKE THE MORNING AFTER, so nobody reads it as a fault.
-- This migration moves the ENTIRE expired count into pending in one step. The expired side has been
-- stable (435 on 2026-08-31 17:5xZ and still 435 on 2026-09-01 -- nothing expired overnight, because
-- the earliest pending deadline was 2026-09-01 11:01), but the PENDING side is climbing: 168 on
-- 08-31, 256 on 09-01. So the absolute jump is ~435 rows and the RATIO depends on when this lands
-- (3.6x on 08-31, 2.7x on 09-01). Do not quote a multiplier from this comment -- count both sides at
-- apply time, exactly as the DO block below does for its own assertion.
--
-- And it lands in a queue that is NOT draining: the last decision anywhere in `approval_decisions`
-- was 2026-08-31 10:46:51Z, i.e. SEVEN HOURS earlier, and 96% of all decisions ever recorded come
-- from one identity acting in bursts rather than a steady human process. So the honest description
-- is: this makes 435 stranded cards ANSWERABLE again. It does not make them ANSWERED, and on
-- current drain it will not look like it did anything for a while.
--
-- That is still the right trade -- an unreachable card is strictly worse than a visible backlog,
-- and these rows get `expires_at = NULL` so they never churn through expiry again -- but the queue
-- jump is the expected consequence, not a symptom. Do not "fix" it by re-expiring them.
--
-- IDEMPOTENT. The metadata guard means a re-run restores nothing it has already restored, so this
-- is safe to re-apply and safe to run after a partial failure.

DO $$
DECLARE
  candidates bigint;
  restored   bigint;
BEGIN
  SELECT count(*) INTO candidates
    FROM approvals
   WHERE status = 'expired'
     AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'restored_by_migration_106');

  WITH moved AS (
    UPDATE approvals
       SET status        = 'pending',
           expires_at    = NULL,
           completed_at  = NULL,
           error_message = NULL,
           updated_at    = now(),
           metadata      = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                             'restored_by_migration_106', jsonb_build_object(
                               'restored_at',            now(),
                               'previous_status',        status,
                               'previous_expires_at',    expires_at,
                               'previous_completed_at',  completed_at,
                               'previous_error_message', error_message
                             )
                           )
     WHERE status = 'expired'
       AND NOT (COALESCE(metadata, '{}'::jsonb) ? 'restored_by_migration_106')
    RETURNING 1
  )
  SELECT count(*) INTO restored FROM moved;

  -- The count is measured HERE, at apply time, and never taken from a number written in a
  -- document. The population was still growing while 105 was merged-but-undeployed, so any
  -- figure quoted from a plan would already be stale by the time this ran.
  RAISE NOTICE 'migration 106: restored % of % candidate expired approval(s) to pending with no deadline', restored, candidates;

  IF restored <> candidates THEN
    RAISE EXCEPTION 'migration 106: restored % but there were % candidates -- refusing to report success on a partial restore', restored, candidates;
  END IF;
END $$;
