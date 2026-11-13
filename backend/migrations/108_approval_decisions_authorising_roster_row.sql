-- 108_approval_decisions_authorising_roster_row.sql
--
-- Record WHICH roster row authorised a decision.
--
-- THE DEFECT (issue #923). `handleUpdateApproval` completed an approval with:
--
--     allDecisions.length === allRequiredApprovers.length
--       && allDecisions.every(d => d.decision === 'approved')
--
-- a COUNT compared to a COUNT. It never asked whether the people who decided are
-- the people the roster required. `approverIdentityFilter` admits a caller either
-- by `required_approvers.user_id` OR by a matching `required_approvers.role`, and
-- the role arm is deliberate — but once a role-authorised caller had decided,
-- nothing recorded which roster obligation that discharged, so one decision
-- satisfied a quorum of one regardless of whose obligation it was.
--
-- MEASURED against the live fr database: of 343 decisions by
-- 32969c16-6ecd-49fe-a106-ba13e6640dc8, **338 were on approvals whose rostered
-- required approver was a DIFFERENT uuid** (e148e8af-3751-49bf-a0fa-56ab46d31ddc).
-- Those approvals completed. The named approver never decided.
--
-- NULLABLE and NOT backfilled, deliberately. Existing rows genuinely do not carry
-- this information and it cannot be reconstructed: the caller's roles at decision
-- time are not recorded anywhere, so any backfill would be a guess written as a
-- fact. The reading code treats NULL as "pre-108, unknown" and falls back to the
-- old count comparison for that approval, so no pending row becomes uncompletable.
--
-- ON DELETE SET NULL rather than CASCADE: removing someone from a roster must not
-- delete the historical record that they decided.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'approval_decisions'
      AND column_name = 'required_approver_id'
  ) THEN
    RAISE NOTICE '108_approval_decisions_authorising_roster_row: already applied, nothing to do';
    RETURN;
  END IF;

  ALTER TABLE approval_decisions
    ADD COLUMN required_approver_id UUID NULL
      REFERENCES required_approvers(id) ON DELETE SET NULL;

  CREATE INDEX IF NOT EXISTS idx_approval_decisions_required_approver
    ON approval_decisions (required_approver_id);

  RAISE NOTICE '108_approval_decisions_authorising_roster_row: column added (nullable, not backfilled — pre-108 rows keep NULL and read as "unknown")';
END $$;
