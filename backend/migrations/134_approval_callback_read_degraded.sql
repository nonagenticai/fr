-- 134 — #1104. `callback_resolution = 'read_degraded'`: the SIXTH terminal value,
-- plus the two columns that bound it.
--
-- ── WHY THIS EXISTS ────────────────────────────────────────────────────────
-- A card whose read NEVER answers re-enters workers/deblock-callback-redelivery.ts
-- on every tick and can never retire. The reason is deliberate and CORRECT, and
-- nothing here weakens it: a read that fails without answering is classified
-- 'degraded', a degraded read charges NO strike (it is evidence about Planka, not
-- about the card), and the row is never sent for either — the worker fails CLOSED
-- on a card whose list it cannot establish. So `callback_send_attempts` never
-- moves, `send_exhausted` can never trip, `callback_unreadable_reads` never moves,
-- `card_unreadable` can never trip, and there is no third exit. The row loops.
--
-- MEASURED on prod, 12 consecutive ticks 2026-09-21T15:10:42Z → 17:55:41Z, every
-- field byte-identical (fr#1104, comment):
--
--   offset=0 candidates=18 shadowed=506 ... eligible=0 acked=0 moved=0
--   not_blocked=0 unreadable=18 send_exhausted=0 breaker_tripped=false
--   strikes_withheld=0 successful_reads=0 failed=0 more=false
--
-- `unreadable == candidates` with zero churn — the whole visible queue, stuck. All
-- 18 fail at `lists.get`, on two lists that are `type='archive'` with an empty
-- name; the CARD read returns 200 for every one of them, and a positive control on
-- an ACTIVE list of the SAME board returns 200, so path and auth are proven good.
-- At 2 Planka reads per row per 15 minutes that is ~3,456 reads/day, forever.
--
-- ── WHY A SIXTH VALUE, AND NOT ONE OF THE FIVE ─────────────────────────────
-- ⛔ NONE OF THE EXISTING FIVE IS HONEST ABOUT THIS ROW, which is the same test
-- migration 119 applied to `hold_acknowledged`:
--
--   * `card_unreadable` claims Planka answered 404 ON THE CARD'S OWN READ PATH,
--     repeatedly — evidence ABOUT THE CARD. Measured false in the dominant
--     population: the card read returned 200. Writing it here would resurrect the
--     exact conflation classifyReadFailure's `definitivePath` test exists to end,
--     and would make `WHERE callback_resolution='card_unreadable'` stop meaning
--     what its own column comment says.
--   * `moved` claims the card left BLOCKED. We never established which list it is
--     in — that IS the failure — and `moved` is the only value that also stamps
--     `callback_delivered_at` (migration 113), which is the ack/effect conflation
--     113 exists to have ended.
--   * `not_blocked` claims the card was affirmatively observed off the board.
--   * `send_exhausted` claims MAX_SEND_ATTEMPTS acked sends. Measured false: ZERO
--     sends, because the worker fails closed. This is the same falsehood #1029
--     refunded an attempt to avoid telling.
--   * `hold_acknowledged` claims the receiver answered 200 and said it is holding
--     the card on purpose. Nothing answered anything.
--
-- `read_degraded` claims exactly what happened and no more: fr could not establish
-- which list this card is in, for long enough, while Planka was demonstrably
-- serving other cards. `WHERE callback_resolution = 'read_degraded'` is the
-- operator's queue of cards fr can no longer see.
--
-- ── WHAT STOPS A TRANSIENT OUTAGE RETIRING A RECOVERABLE CARD ──────────────
-- Three terms, and the third is a DIFFERENT KIND of term from the first two —
-- the same lesson migration 113's header records about BREAKER_MIN_READS, applied
-- one failure class over:
--
--   1. DEGRADED_STRIKES consecutive answerless reads, any resolved read clearing
--      the run (`callback_degraded_reads`, below);
--   2. that run spanning DEGRADED_MIN_SPAN_MS of wall clock
--      (`callback_degraded_first_at`) — the term an outage cannot compress,
--      because a strike COUNT counts ticks and ticks are not time;
--   3. ⭐ EACH of those strikes charged only on a tick that READ SOME OTHER CARD
--      SUCCESSFULLY. Terms 1 and 2 are PER-ROW and therefore both blind to a
--      Planka that answers nothing at all; term 3 is the cross-row one. Under an
--      outage every read degrades, no read succeeds, and NOT ONE STRIKE IS
--      CHARGED — so the bound is not merely slow during an outage, it is inert,
--      and the clock does not even start.
--
-- ⛔ NOTE THE ASYMMETRY WITH `card_unreadable`'s BREAKER, WHICH IS DELIBERATE. That
-- guard WITHHOLDS on the ABSENCE of successful reads and therefore needs a sample
-- floor (BREAKER_MIN_READS) before an absence means anything. This one ARMS on the
-- PRESENCE of one, and a single successful read is positive proof — of the base
-- URL, the token, the route and the card path all at once — so it needs no floor.
--
-- ── SHAPE: DDL ONLY, NO DML, SO NO RECEIPT ─────────────────────────────────
-- ⚠️ DELIBERATELY UNLIKE 113/114/117, WHICH ALL CARRY A `_migration_effects`
-- RECEIPT. Those files perform DML that `drizzle-kit push` cannot reproduce, so
-- their probe has to ask "did the statement RUN". This file adds two columns and
-- widens a CONSTRAINT DEFINITION and touches not one row.
--
-- ⛔ AND IT REPAIRS NO EXISTING ROW, ON PURPOSE. The rows stuck today are stuck
-- because of a code path, and the code path is what is being fixed: the next tick
-- starts their run legitimately, and they retire on the same evidence any future
-- row will. A backfill would write a terminal state on evidence never gathered —
-- which is the defect class this whole worker exists to have ended.
--
-- ⛔ SO schema.ts AND THIS FILE MUST LIST THE SAME VALUES. They are two independent
-- emitters of one constraint: a push-built CI database takes it from the `check()`
-- in src/db/schema.ts, a migrated database takes it from here. A value added to
-- only one passes the suite in one environment and rejects every write in the
-- other — at runtime, with `tsc` green. 113 shipped exactly that once.
--
-- Idempotent, statement by statement, as `reapplyIfProbeFails` requires:
--   * both ALTERs are `ADD COLUMN IF NOT EXISTS`;
--   * the `DO $$` block re-reads `pg_get_constraintdef` and drops ONLY a definition
--     that does not already admit `read_degraded` — it COMPARES THE DEFINITION,
--     NOT THE NAME, for the reason 119's header records: an `IF NOT EXISTS
--     (conname)` guard leaves a stale five-value constraint in place under the same
--     name, which then rejects every write while this migration reports success;
--   * there is no INSERT, no UPDATE, no DELETE and no destructive ALTER anywhere.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS callback_degraded_reads INTEGER NOT NULL DEFAULT 0;

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS callback_degraded_first_at TIMESTAMPTZ;

DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'approvals_callback_resolution_check'
     AND c.conrelid = 'approvals'::regclass;

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%read_degraded%' THEN
    ALTER TABLE approvals DROP CONSTRAINT approvals_callback_resolution_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_callback_resolution_check
      CHECK (callback_resolution IS NULL
             OR callback_resolution IN ('moved', 'not_blocked', 'card_unreadable',
                                        'send_exhausted', 'hold_acknowledged',
                                        'read_degraded'));
  END IF;
END
$$;

COMMENT ON COLUMN approvals.callback_degraded_reads IS
  'CONSECUTIVE reads that answered NOTHING about this card - a 5xx/timeout on the '
  'card read, a failure on the LIST read (which is NOT evidence about the card: the '
  'card read returned 200 first), or a 200 with no listId/name. Any read that does '
  'resolve the card list resets it to 0. Deliberately NOT callback_unreadable_reads, '
  'which counts DEFINITIVE misses (404 on /api/cards/:id) and must never absorb an '
  'answerless read. A strike here is charged ONLY on a tick that read some OTHER card '
  'successfully, which is what makes a Planka outage unable to increment it at all.';

COMMENT ON COLUMN approvals.callback_degraded_first_at IS
  'When the current run of answerless reads began; NULL when there is no run. Reset '
  'with the count. Retirement as read_degraded needs the run to span '
  'DEGRADED_MIN_SPAN_MS of wall clock as well as reaching DEGRADED_STRIKES, because '
  'the strike count counts TICKS and ticks are not time.';

COMMENT ON COLUMN approvals.callback_resolution IS
  'Terminal classification written ONLY by workers/deblock-callback-redelivery.ts. '
  'moved = we sent and the card was then observed out of BLOCKED (the only value that '
  'also stamps callback_delivered_at). not_blocked = the card was already off the board '
  'and we never sent. card_unreadable = Planka 404d the card ON ITS OWN READ PATH '
  'repeatedly over hours. send_exhausted = MAX_SEND_ATTEMPTS acked sends and the card '
  'never moved. hold_acknowledged = the receiver 200d and its own body reported it is '
  'holding the card ON PURPOSE (deliberate_hold / APPROVED WITH NO ANSWER), so fr '
  'stopped after one send; the card stays in BLOCKED by design and only a real answer '
  'releases it. read_degraded = fr could never establish which list the card is in - '
  'DEGRADED_STRIKES consecutive answerless reads spanning DEGRADED_MIN_SPAN_MS, each '
  'charged only on a tick that read OTHER cards successfully, so it is not an outage; '
  'nothing was ever sent for such a row and no delivery is claimed.';
