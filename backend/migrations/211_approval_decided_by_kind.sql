-- Migration: 211_approval_decided_by_kind
-- Date: 2026-10-25
--
-- Cockpit A5 / R-CK1 (program/20-designs/FR-COCKPIT-IMPL-PLAN-2026-10-25.md §1 F7): WHAT made an
-- approval decision. The Claude approval-triage service accounts decide as ordinary approver
-- uuids, so until now a triage-agent decision read exactly like a person's, and the cockpit could
-- not tell machine time from waiting-on-people time.
--
--   approval_decisions.decided_by_kind  text NOT NULL DEFAULT 'human'
--     'human'         a person decided (every chat seat and the API, unless the decider is below)
--     'triage_agent'  a Claude approval-triage service account decided
--     'rule'          fr policy code decided with no person (no such insert site exists today;
--                     the value is reserved so a future policy writer never reads as 'human')
--
-- BACKFILL. Rows whose approver_id is one of the known triage service-account user ids become
-- 'triage_agent'. Those ids are NOT compiled in any more: they are supplied at runtime from
-- FR_TRIAGE_AGENT_USER_IDS (src/lib/decided-by-kind.ts), so a fresh database has no built-in set
-- for this historical backfill to match and the write is a recorded no-op. The accounts it once
-- covered, recorded here by name only — a user id is an identifier fr does not publish
-- (measured 2026-10-25):
--   claude-approval-triage-conveyor (a platform conveyor tenant)
--   claude-approval-triage
--   claude-approval-triage-workflow-improvement
--   claude-approval-triage-nonagentic-exec
--   claude-approval-triage-prompt-improvement
--   claude-approval-triage-procedure-improvement
-- No row is backfilled to 'rule': every historical approval_decisions insert site (API PUT,
-- Telegram, Teams, Signal) is a seat for an identified approver, so there is no rule-written row
-- to find. Writing 'rule' onto a guess would be a guess recorded as a fact.
--
-- RUNNER CONTRACT: contains DML (the backfill), so it is PROBED by its own receipt in
-- `_migration_effects` (written in the same statement as the UPDATE) — the one witness
-- `drizzle-kit push` cannot create. The column and CHECK are mirrored in src/db/schema.ts.
-- Idempotent: ADD COLUMN IF NOT EXISTS, a name-guarded CHECK, an UPDATE that only moves
-- 'human' rows of the listed ids, and ON CONFLICT DO NOTHING on the receipt.
-- No BEGIN/COMMIT (the runner's SAVEPOINT).

SET LOCAL lock_timeout = '10s';

ALTER TABLE approval_decisions
  ADD COLUMN IF NOT EXISTS decided_by_kind text NOT NULL DEFAULT 'human';

DO $decided_by_kind$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approval_decisions_decided_by_kind_check'
       AND conrelid = 'approval_decisions'::regclass
  ) THEN
    ALTER TABLE approval_decisions
      ADD CONSTRAINT approval_decisions_decided_by_kind_check
      CHECK (decided_by_kind IN ('human', 'triage_agent', 'rule'));
  END IF;
END
$decided_by_kind$;

CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The backfill and its receipt in ONE statement, so the receipt cannot exist without the write.
--
-- The triage-agent user ids are no longer compiled in. They are supplied at runtime from
-- FR_TRIAGE_AGENT_USER_IDS (src/lib/decided-by-kind.ts), so a fresh database has no built-in
-- set for this historical backfill to match and the write is a recorded no-op.
WITH moved AS (
  UPDATE approval_decisions
     SET decided_by_kind = 'triage_agent'
   WHERE FALSE
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '211_approval_decided_by_kind.sql',
       jsonb_build_object('triage_agent_backfilled', (SELECT count(*) FROM moved))
ON CONFLICT (migration) DO NOTHING;
