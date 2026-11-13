-- backend/migrations/124_outline_approval_roster_backfill.sql
--
-- OUTLINE APPROVALS WERE MINTED WITH AN EMPTY ROSTER, SO NOBODY COULD DECIDE THEM.
--
-- #1153 (migration 123) added `project_outline.approval`, raised by
-- routes/project-request-lifecycle.ts :: handleProjectRequestOutline. It wrote
-- `approvals.approver_user_id` (a column with no readers) and never inserted a
-- `required_approvers` row. handleUpdateApproval authorizes a decider ONLY through
-- `required_approvers` (by user_id, or by role), so every outline approval 422'd
-- "not authorized" for everyone, the requester included, and super_admin got
-- "no required approvers recorded ... void it". Approve-outline -> promote was
-- impossible. The route now writes the roster in the approval's transaction; this
-- file repairs the rows minted before that fix (2 pending on prod when written:
-- eda0f57c-2912-4ce5-8176-a662e8171269, 902086be-...).
--
-- ── THE RULE (identical to the route) ───────────────────────────────────────
--
-- `resolveSignoffStakeholderIds(payload.approvers, created_by)`
-- (src/lib/execution-signoff.ts): the deduped UUID-shaped subset of the
-- request's `payload.approvers`; if that is empty, the request's `created_by`.
-- UUID shape mirrors src/utils/tenant.ts :: isValidUuid (RFC v1-v8, or the
-- all-zero bootstrap prefix). Role 'outline_approver' (OUTLINE_APPROVER_ROLE),
-- deliberately not a realm role, so the role arm of approverIdentityFilter admits
-- nobody extra. tenant_id is the approval's tenant.
--
-- ── SCOPE ───────────────────────────────────────────────────────────────────
--
-- ONLY status = 'pending' AND kind = 'project_outline.approval' AND no roster row
-- at all. A decided/voided/expired row is history and is not touched; a row that
-- already has ANY roster row is not added to (its quorum is whatever it is).
--
-- IDEMPOTENT: the NOT EXISTS term means a second run matches zero rows.
--
-- ⚠️ `a.kind::text`, NOT `a.kind = 'project_outline.approval'`. 123 adds that enum
-- value, and the runner wraps one run's pending files in ONE outer transaction; on
-- any database that takes 123 and 124 in the same run, using the freshly-added
-- enum value as an enum literal raises 55P04 ("unsafe use of new value") and
-- aborts the boot. Comparing as text never parses the literal as the enum.
--
-- ⚠️ NOT PROBED, DELIBERATELY. The effect is a data repair of rows that exist only
-- on a database where outline approvals have already been minted. On a push-built
-- CI database the runner may stamp this applied without running it, and that loses
-- nothing: there are no outline approvals there to repair, and every approval
-- minted after this change carries its roster from the route itself. On prod the
-- ledger is populated, so the file runs normally.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

DO $$
DECLARE
  inserted integer;
BEGIN
  WITH targets AS (
    SELECT a.id AS approval_id, a.tenant_id, pr.payload, pr.created_by
      FROM approvals a
      JOIN project_requests pr ON pr.id = a.project_request_id
     WHERE a.status = 'pending'
       AND a.kind::text = 'project_outline.approval'
       AND NOT EXISTS (
             SELECT 1 FROM required_approvers ra WHERE ra.approval_id = a.id
           )
  ),
  named AS (
    SELECT DISTINCT t.approval_id, t.tenant_id, lower(e.v)::uuid AS user_id
      FROM targets t
      CROSS JOIN LATERAL jsonb_array_elements_text(
             CASE WHEN jsonb_typeof(t.payload->'approvers') = 'array'
                  THEN t.payload->'approvers' ELSE '[]'::jsonb END
           ) AS e(v)
     WHERE e.v ~* '^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-[0-9a-f]{12})$'
  ),
  fallback AS (
    SELECT t.approval_id, t.tenant_id, t.created_by AS user_id
      FROM targets t
     WHERE t.created_by IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM named n WHERE n.approval_id = t.approval_id)
  ),
  ins AS (
    INSERT INTO required_approvers (tenant_id, approval_id, user_id, role)
    SELECT tenant_id, approval_id, user_id, 'outline_approver'
      FROM (SELECT * FROM named UNION ALL SELECT * FROM fallback) r
    RETURNING 1
  )
  SELECT count(*) INTO inserted FROM ins;

  RAISE NOTICE '124_outline_approval_roster_backfill: inserted % required_approvers row(s)', inserted;
END $$;
