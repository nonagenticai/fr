-- backend/migrations/105_approval_expiry_optional.sql
--
-- A CARD-BLOCKING APPROVAL MUST NOT EXPIRE. NOBODY EVER ASKED FOR ONE THAT DOES.
--
-- Measured 2026-08-31: `grep -ci expir` returns 0 across all NINE AA specification documents
-- (PHILOSOPHY, GOVERNANCE, SPEC, BACKLOG, PRODUCTION_READINESS, RECURSIVE_DECOMPOSITION_SPEC,
-- READYING_REDESIGN, IT_MVP_SUBSPEC, ACTIVITY_PATTERNS). PHILOSOPHY defines the BLOCKED list as
-- the "Human-input gate: requests for input, decisions, approvals" — BLOCKED *is* the wait
-- state. The entire provenance of the deadline was one `z.number().default(24)` on the
-- card-approval webhook schema; `blocked-escalate.json :: Call FR` never sent the field at all.
--
-- WHAT IT COST, measured on prod the same day:
--   435 approvals expired  ·  178 pending  ·  170 approved  ·  1 rejected
--   430 of them on callback_path 'kanban/approval-callback' (the card-blocking path)
--   routes/approvals.ts refuses any decision past expires_at, so every expired row's card became
--   PERMANENTLY unreachable via the only designed drain (approve -> deblock_action -> move).
--   workers/approval-expiry.ts writes "the row needs re-raising" into error_message; nothing
--   re-raises, and the only reader of status='expired' in the whole backend is a read-only list.
--
-- NULL now means "no deadline, ever". Existing rows are NOT touched: this migration changes the
-- constraint only, so every historical deadline and every expired row is preserved exactly as it
-- was. Restoring the wrongly-expired backlog is a separate, reviewable step — a schema change
-- must not quietly rewrite 435 rows of history.
--
-- ⛔ READ THE COLUMN THROUGH lib/approval-deadline.ts::hasPassedDeadline, NEVER A BARE COMPARE.
-- Postgres does the right thing by itself (`expires_at <= now()` is NULL, not TRUE, so the reaper
-- skips these rows with no change). JavaScript does the exact opposite: `new Date(null)` is
-- EPOCH 0, so `new Date() > new Date(null)` is TRUE and a bare compare reads a deadline-less
-- approval as expired since 1970 — turning "never expires" into "dead on arrival", which is
-- strictly worse than the 24h TTL this replaces. That asymmetry is why the predicate is a named,
-- unit-tested function and why this comment is here.

ALTER TABLE approvals ALTER COLUMN expires_at DROP NOT NULL;

COMMENT ON COLUMN approvals.expires_at IS
  'Deadline for a decision. NULL = no deadline, ever (card-blocking approvals: BLOCKED is the human-input gate). Read via lib/approval-deadline.ts::hasPassedDeadline — a bare JS date compare coerces NULL to epoch 0 and reads it as expired.';
