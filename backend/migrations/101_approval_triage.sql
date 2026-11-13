-- backend/migrations/101_approval_triage.sql
--
-- AN APPROVAL THAT CANNOT NAME A HUMAN IS A TIMER, NOT A GATE.
--
-- PHILOSOPHY.md §1 makes BLOCKED "the human-input gate"; P-SYS-07 says "an approval
-- whose callback is not wired is a defect, not a deferred feature". The card-approval
-- path satisfied the letter of P-SYS-07 — its callback IS wired — while failing the
-- point of it, because it had no field in which to put a person. Its own comment said
-- so: "This card-approval path has no user_id (only an optional raw phone number), so
-- per-user preference resolution is not applicable."
--
-- MEASURED ON PROD 2026-08-18, which is why these columns exist:
--
--   approvals ever raised .................. 362
--   ... that name any approver .............  46   (316 name NOBODY)
--   ... that EXPIRED unanswered ............ 335   (92%)
--   ... ever answered by a human ...........  16
--   delivery attempts logged since 2026-05-01  52 rows
--   ... that reached telegram ...............  1
--
-- The channel was never broken. `engagement_deliveries` shows tenant …0003's
-- workspace-admin receiving an approval on telegram at 2026-06-13T15:33:59Z — the path
-- works end to end. It was exercised once, on the day the pref was set, and has been
-- unaddressable ever since. Downstream: 547 cards sat in BLOCKED and 722 principles sat
-- DRAFT, because the thing that would release them expired at the 24h mark unread.
--
-- ── `approver_user_id` — WHO WAS ASKED ────────────────────────────────────────────
-- Nullable ONLY so the column can land on 362 historical rows that genuinely asked
-- nobody. New rows are resolved at the boundary and a row that cannot name a reachable
-- human FAILS LOUD instead of being written. Do not "relax" this to a default: a
-- default approver that nobody reads is the exact defect being closed.
--
-- ⚠️ DO NOT default this to `projects.owner_id`. MEASURED: 292 of the projects are
-- owned by `22560966-…`, the system exec-operator — a robot with `inapp` as its only
-- enabled channel. Routing to the owner would keep paging it and would look correct in
-- every test that only asserts "an approver was named".
--
-- ── `notified_at` — WAS ANYONE ACTUALLY TOLD ─────────────────────────────────────
-- Distinct from created_at on purpose. Without it, "expired" is indistinguishable from
-- "asked and ignored", and 335 rows of never-delivered silence read as human decisions.
-- A NULL here at expiry means the system failed, not the person.
--
-- ── THE TRIAGE SEAM (`triage_*`) ─────────────────────────────────────────────────
-- George 2026-08-18: a worker should be able to filter / pre-approve human approval
-- requests once the GPUs and model quality are there. That seam is built NOW rather
-- than retrofitted, because retrofitting it later means changing the write path of a
-- gate while it is load-bearing.
--
-- It stays inside P-SYS-12 ("iteration lives in the n8n graph, not inside the model"):
-- the future triager is a SINGLE-INFERENCE n8n worker with a schema-enforced verdict,
-- never a tool-use loop. fr only stores the verdict and obeys it.
--
--   triage_verdict  escalate | auto_approve | auto_reject | defer
--   triage_actor    'policy' today; 'worker:<name>' when a worker decides
--
-- ⚠️ FAIL-CLOSED IS THE WHOLE DESIGN. A NULL verdict, an unreachable triager, or any
-- value outside the CHECK means ESCALATE TO THE HUMAN. Absence must never read as
-- approval — that is the same discipline the qa-verify-* oracles use when they abstain
-- rather than fabricate a pass, and it is the difference between a gate that degrades
-- into asking a person and one that degrades into saying yes.
--
-- Today every row is written `('escalate','policy')`: a pure pass-through, so this
-- migration cannot change a single approval outcome. The seam ships INERT and the
-- first version is structurally incapable of deciding anything on George's behalf.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS approver_user_id UUID,
  ADD COLUMN IF NOT EXISTS notified_at      TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS triage_verdict   TEXT,
  ADD COLUMN IF NOT EXISTS triage_actor     TEXT,
  ADD COLUMN IF NOT EXISTS triage_rationale TEXT,
  ADD COLUMN IF NOT EXISTS triage_at        TIMESTAMPTZ;

-- The CHECK is the fail-closed guarantee in the schema rather than in a code path a
-- future caller can forget. NULL is permitted (historical rows + rows written before
-- triage runs) and is read as `escalate` by resolveTriageVerdict(); a typo'd verdict
-- is rejected by the database instead of silently becoming an auto-approval.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'approvals_triage_verdict_check'
  ) THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_triage_verdict_check
      CHECK (triage_verdict IS NULL
             OR triage_verdict IN ('escalate', 'auto_approve', 'auto_reject', 'defer'));
  END IF;
END $$;

-- Finding the approvals a given human still owes an answer on is the query the digest
-- and the escalation sweep both run; without this it is a seq scan over every approval
-- ever raised.
CREATE INDEX IF NOT EXISTS approvals_approver_pending_idx
  ON approvals (approver_user_id, status)
  WHERE status = 'pending';

-- The escalation sweep's actual predicate: raised, still pending, and NOBODY WAS EVER
-- TOLD. That set is the 335-row silence this migration exists to make visible.
CREATE INDEX IF NOT EXISTS approvals_undelivered_idx
  ON approvals (expires_at)
  WHERE status = 'pending' AND notified_at IS NULL;
