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
-- 'triage_agent'. The list MUST equal TRIAGE_AGENT_USER_IDS in src/lib/decided-by-kind.ts
-- (tests/unit/lib/decided-by-kind.test.ts compares the two). Ids measured 2026-10-25:
--   72084c2b-d87a-44fe-bcf0-9baddde3be78  claude-approval-triage-conveyor (tenant 5f868d42)
--   d16aa38b-30b7-46af-b47a-ae24d87527f4  claude-approval-triage
--   f66d2f56-784e-471b-9fb2-4afcb4851270  claude-approval-triage-workflow-improvement
--   44b9d331-8392-4af4-93fd-f0610379091a  claude-approval-triage-nonagentic-exec
--   1351ff57-3c88-4ea4-a3f2-0c77cc993982  claude-approval-triage-prompt-improvement
--   0df838ad-8122-4716-a86b-c080330ffec9  claude-approval-triage-procedure-improvement
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
WITH moved AS (
  UPDATE approval_decisions
     SET decided_by_kind = 'triage_agent'
   WHERE decided_by_kind = 'human'
     AND approver_id IN (
       '72084c2b-d87a-44fe-bcf0-9baddde3be78',
       'd16aa38b-30b7-46af-b47a-ae24d87527f4',
       'f66d2f56-784e-471b-9fb2-4afcb4851270',
       '44b9d331-8392-4af4-93fd-f0610379091a',
       '1351ff57-3c88-4ea4-a3f2-0c77cc993982',
       '0df838ad-8122-4716-a86b-c080330ffec9'
     )
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '211_approval_decided_by_kind.sql',
       jsonb_build_object('triage_agent_backfilled', (SELECT count(*) FROM moved))
ON CONFLICT (migration) DO NOTHING;
