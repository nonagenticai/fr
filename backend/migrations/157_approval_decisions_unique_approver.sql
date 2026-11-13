-- Migration: 157_approval_decisions_unique_approver
-- Date: 2026-10-02
--
-- WHY. Every decision seat (routes/approvals.ts and the three chat seats: telegram /
-- teams / signal webhooks) guards "one decision per approver per approval" with a
-- CHECK-THEN-INSERT (SELECT the prior decision, then INSERT) — a race: two concurrent
-- deliveries (e.g. a Telegram webhook retry overlapping the original) both pass the
-- SELECT and both INSERT, double-recording one human's decision (and double-counting it
-- toward quorum).
--
-- `approval_decisions_approval_approver_unique` — UNIQUE (approval_id, approver_id) —
-- makes the losing side of that race a unique violation (23505) instead of a second row.
-- It is the intended invariant everywhere already: approvals.ts 422s "You have already
-- made a decision on this approval", teams answers {duplicate:true}, and
-- decision-guards.ts states "a caller may decide an approval once". Together with the
-- FOR UPDATE re-check in recordDecision it is what makes the DECISION exactly-once.
--
-- ⚠️ There is deliberately NO Telegram update_id dedup ledger. An earlier revision of
-- this migration added one (claim-before-process); review showed it LOSES messages — a
-- retryable 503 is retried by Telegram and found already "claimed", and a pod killed
-- mid-request on every deploy (SIGTERM -> process.exit) leaves a claim for an update that
-- was never processed. The thing that must be exactly-once is the decision, and this
-- index guarantees it. A Telegram retry is processed again (as before); it can repeat a
-- chat reply but can never decide twice.
--
-- MEASURED 2026-10-02 against prod: 0 duplicate (approval_id, approver_id) pairs across
-- 2452 approval_decisions rows, so the unique index builds without any DML. ⚠️ If a
-- database DOES carry duplicates the CREATE UNIQUE INDEX fails and the runner refuses to
-- boot — that is deliberate: deduplicating decision rows is a human call, never a
-- migration's.
--
-- Pure DDL, IF NOT EXISTS; no DML. Safe to re-run.

-- Bounded wait for the table lock (fr queue coordinator, 2026-10-02): the build takes a
-- SHARE lock on approval_decisions; if a long writer holds it, fail fast (the runner rolls
-- the whole run back and boot reports it) rather than queue every decision behind us.
-- SET LOCAL only — the runner wraps the run in ONE transaction (migration-runner.ts), so
-- this never outlives it, and it is reset below so later files in the same run are unaffected.
SET LOCAL lock_timeout = '10s';
CREATE UNIQUE INDEX IF NOT EXISTS approval_decisions_approval_approver_unique
  ON approval_decisions (approval_id, approver_id);
SET LOCAL lock_timeout TO DEFAULT;
