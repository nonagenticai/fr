-- 119 — `callback_resolution = 'hold_acknowledged'`: the FIFTH terminal value.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- MEASURED on prod 2026-09-10: every tick of workers/deblock-callback-redelivery.ts
-- in a 2h window read `acked=10 moved=0`, and rows carrying
-- `metadata->>'deblock_action' = 'QUESTION'` retired as
-- `callback_resolution='send_exhausted'`, cause `receiver_unresponsive`, AFTER FIVE
-- SUCCESSFUL ACKS.
--
-- The receiver was not unresponsive. Verified byte-equal live-vs-repo, `AA Pattern -
-- Approval Callback :: Resolve Target List` (n8n id yG1N9K2hTswEZNTq) computes
-- `questionAnswered = action === 'QUESTION' && decision === 'approved' &&
-- String(ctx.comment ?? '').trim().length > 0`; with no answer text it sets
-- `shouldMoveCard = false`, holds the card DELIBERATELY, and answers 200 with
-- `deliberate_hold: true` and a `resolve_diagnostic` ending `APPROVED WITH NO
-- ANSWER: the ask is still open`. fr counted the transport ack and threw the body
-- away. Those approvals are also SPENT — fr accepts no second decision on an
-- already-decided approval — so no answer can ever ride on them, and the five
-- retries were five sends of a payload that could not succeed.
--
-- The worker now reads that body and retires the row on the FIRST send. It needs a
-- value for it, and NONE OF THE EXISTING FOUR IS HONEST ABOUT THIS ROW:
--
--   * `send_exhausted` claims MAX_SEND_ATTEMPTS acked sends and an unresponsive
--     receiver. Measured false in both halves: one send, and a receiver that
--     answered and explained itself.
--   * `moved` claims the card left BLOCKED. Measured false: the hold IS that it
--     did not, and `moved` is the only value that also stamps
--     `callback_delivered_at` (migration 113), which would resurrect precisely the
--     ack/effect conflation 113 exists to have ended.
--   * `not_blocked` claims the card was already off the board and nothing was sent.
--   * `card_unreadable` claims Planka cannot see the card.
--
-- ⛔ THIS DOES NOT RELEASE THE HOLD, AND NOTHING BUILT ON IT MAY. The card stays in
-- BLOCKED on purpose; n8n's `blocked-sweep.json :: Classify + Plan:76` says it in
-- capitals ("DO NOT 'FIX' approval_hold BY MAKING A DECIDED HOLD MOVABLE"). The
-- defect being closed is fr's RECORD of the hold, not the card's position. Release
-- comes from a real answer, elsewhere.
-- `WHERE callback_resolution = 'hold_acknowledged'` is therefore the operator's
-- queue of cards waiting on a human answer that no re-send can supply — which is
-- the query that could not be written while these rows were laundered into
-- `send_exhausted` alongside genuinely dead receivers.
--
-- ── SHAPE: DDL ONLY, NO DML, SO NO RECEIPT ─────────────────────────────────
-- ⚠️ DELIBERATELY UNLIKE 113/114/117, WHICH ALL CARRY A `_migration_effects`
-- RECEIPT. Those files perform DML (a backfill, a void, a reversal) that
-- `drizzle-kit push` cannot reproduce, so their probe has to ask "did the statement
-- RUN". This file changes a CONSTRAINT DEFINITION and touches not one row: there is
-- no effect to receipt, and the property that must hold is simply "the live
-- constraint admits the new value". That is exactly what the probe registered in
-- src/db/migration-runner.ts reads (`pg_get_constraintdef ... LIKE
-- '%hold_acknowledged%'`), and it is true in BOTH environments for the right
-- reason: a push-built CI database gets it from the `check()` declared in
-- src/db/schema.ts, a migrated database gets it from here.
--
-- ⛔ SO schema.ts AND THIS FILE MUST LIST THE SAME VALUES. They are two independent
-- emitters of one constraint, and a value added to only one passes the suite in one
-- environment while rejecting every write in the other — at runtime, with `tsc`
-- green. 113 already shipped this exact failure once (a three-value draft), which is
-- why the guard below compares the DEFINITION and not the NAME.
--
-- Idempotent, statement by statement, as `reapplyIfProbeFails` requires:
--   * the `DO $$` block re-reads `pg_get_constraintdef` and drops ONLY a definition
--     that does not already admit `hold_acknowledged`;
--   * `ADD CONSTRAINT` runs only when no constraint of that name remains;
--   * there is no INSERT, no UPDATE, no DELETE and no destructive ALTER anywhere in
--     the file, so a second run is a no-op rather than a second effect.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'approvals_callback_resolution_check'
     AND c.conrelid = 'approvals'::regclass;

  -- ⛔ COMPARES THE DEFINITION, NOT THE NAME, FOR THE REASON 113'S HEADER RECORDS:
  -- a database carrying the four-value constraint under this same name would be
  -- left untouched by an `IF NOT EXISTS (conname)` guard and would then reject
  -- every `hold_acknowledged` write at runtime -- while this migration reported
  -- success.
  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%hold_acknowledged%' THEN
    ALTER TABLE approvals DROP CONSTRAINT approvals_callback_resolution_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_callback_resolution_check
      CHECK (callback_resolution IS NULL
             OR callback_resolution IN ('moved', 'not_blocked', 'card_unreadable',
                                        'send_exhausted', 'hold_acknowledged'));
  END IF;
END
$$;

COMMENT ON COLUMN approvals.callback_resolution IS
  'Terminal classification written ONLY by workers/deblock-callback-redelivery.ts. '
  'moved = we sent and the card was then observed out of BLOCKED (the only value that '
  'also stamps callback_delivered_at). not_blocked = the card was already off the board '
  'and we never sent. card_unreadable = Planka 404d the card repeatedly over hours. '
  'send_exhausted = MAX_SEND_ATTEMPTS acked sends and the card never moved. '
  'hold_acknowledged = the receiver 200d and its own body reported it is holding the '
  'card ON PURPOSE (deliberate_hold / APPROVED WITH NO ANSWER), so fr stopped after one '
  'send; the card stays in BLOCKED by design and only a real answer releases it.';
