-- backend/migrations/113_approval_callback_effect_marker.sql
--
-- A TRANSPORT ACK IS NOT AN EFFECT.
--
-- THE DEFECT. Migration 109 added `callback_delivered_at` and its own header
-- called it "a MEASUREMENT, never an intention". It is — but of the WRONG
-- THING. `services/n8n-callback.ts::deliverDecisionCallback` stamps it the
-- instant `n8nClient.sendApprovalDecision` returns without throwing, i.e. on
-- n8n's 2xx TRANSPORT ACK. n8n's webhook acks on receipt; the Planka
-- `card.update{listId}` that actually moves the card BLOCKED -> DOING happens
-- afterwards, in a queue that has been measured giving up ("This execution
-- failed to be processed too many times and will no longer retry", 61 rows on
-- 2026-09-04) and behind a Planka that has been measured 504-ing (20 rows).
--
-- And `callback_delivered_at IS NULL` is half of the candidate predicate in
-- `workers/deblock-callback-redelivery.ts`. So a 2xx retires a row from the
-- ONLY repair path there is, whether or not it repaired anything.
--
-- MEASURED ON PROD 2026-09-06: of 373 callbacks delivered in the last 30h,
-- **373 of 373** (253 distinct cards) are STILL IN BLOCKED. 216 approved-but-
-- still-blocked cards are already stamped and therefore already unreachable.
-- The worker drained its own queue, not the board.
--
-- SECOND DEFECT, same worker. Its candidate SQL carries no notion of
-- blockedness at all — that is decided afterwards, live, by `isBlockedList`
-- against Planka. A row the live gate classifies `not_blocked` (~29/tick) or
-- `unreadable` (~11/tick) is never written to AT ALL, so it is re-selected
-- every scan cycle, forever, and the residue eats the 40-row scan window.
--
-- ── WHAT THIS MIGRATION ADDS ────────────────────────────────────────────────
--
-- `callback_acked_at`   — the 2xx transport ack. This is EXACTLY what
--                         `callback_delivered_at` has been recording since 109;
--                         the column is the honest name for that measurement.
--
-- `callback_resolution` — the TERMINAL classification, written only by the
--                         re-delivery worker after it has looked at the card:
--                           'moved'           we sent, and the card left BLOCKED
--                           'not_blocked'     the card was already off the board
--                                             and we never sent for it
--                           'card_unreadable' the card was DEFINITIVELY absent
--                                             (Planka 404 on the CARD's own read
--                                             path) on consecutive attempts
--                                             spanning hours, in ticks that did
--                                             not themselves look like a
--                                             Planka-wide outage
--                           'send_exhausted'  we sent MAX_SEND_ATTEMPTS times,
--                                             n8n acked every one, the card
--                                             never moved
--                         NULL = not terminal, still a candidate. These four
--                         are deliberately distinct values and not one boolean:
--                         a future reader must be able to tell "we moved it"
--                         from "it was already gone" from "we cannot see it"
--                         from "n8n keeps accepting and nothing happens".
--
-- `callback_resolved_at`          — when the terminal state was reached.
-- `callback_unreadable_reads`     — CONSECUTIVE unreadable reads, reset to 0 by
--                         any successful read.
-- `callback_unreadable_first_at`  — when the current run of them STARTED.
-- `callback_send_attempts`        — sends made for this row, ever.
--
-- ⛔ WHY A STRIKE COUNT AND NOT "RETIRE ON THE FIRST 404", AND WHY A COUNT IS
-- NOT ENOUGH EITHER.
--
-- The count first. A card reads as unreadable both when it is deleted and when
-- Planka is unreachable, so retiring on one failed read would let a single blip
-- write off the entire backlog — the same class of silent write-off this
-- migration exists to close, just faster.
--
-- ⚠️ CORRECTED 2026-09-06. THIS PARAGRAPH USED TO CLAIM three consecutive
-- misses "across a 15-minute tick with a rotating scan window spans hours,
-- which no blip does". THAT ARITHMETIC IS WRONG. `advanceScan` resets
-- `scanOffset` to 0 whenever a scan comes back short, which it does as soon as
-- the residue drains, so the SAME rows are re-read every DEFAULT_INTERVAL_MS —
-- 900_000 ms. Three ticks is 30 minutes of elapsed time and 45 minutes from
-- first miss to retirement. A Planka 504 window, or an expired agent token,
-- lasts longer than that routinely.
--
-- So retirement now needs FOUR things, not one:
--   1. the read failed DEFINITIVELY — Planka answered 404 ON THE CARD'S OWN READ
--      PATH, `/api/cards/:id`. A 5xx, a 429, a timeout, a network error or an
--      auth failure is NOT evidence the card is gone and does not strike at all;
--   2. UNREADABLE_STRIKES consecutive such reads;
--   3. the run of them spanning UNREADABLE_MIN_SPAN_MS of WALL CLOCK
--      (`callback_unreadable_first_at`), which no tick count can substitute for;
--   4. the TICK not looking like a Planka-wide failure — DEGRADED_TICK_MIN_READS
--      / DEGRADED_TICK_GONE_RATIO.
-- The exact constants and their arithmetic live next to the code that enforces
-- them, in workers/deblock-callback-redelivery.ts.
--
-- ⚠️ CORRECTED 2026-09-06 (SECOND AUDIT). TERM 1 WAS DOCUMENTED AND UNENFORCED,
-- AND TERMS 1-3 ARE NOT INDEPENDENT DEFENCES.
--
--   * The line above used to end at "an auth failure ... does not strike at
--     all". The code tested `err.status === 404` and NOTHING ELSE, and
--     `PlankaHttp` raises 404 from three places: the card read, the LIST read
--     (reached only after the card read returned 200, i.e. after Planka
--     confirmed the card EXISTS), and `loginAgent`'s POST /api/access-tokens —
--     an AUTH failure, exactly the one this paragraph exempted. A wrong
--     PLANKA_BASE_URL therefore struck every candidate on every tick.
--     `PlankaError.path` is now the discriminator; only the card's own read path
--     can strike.
--   * The worker's UNREADABLE_MIN_SPAN_MS block claimed the 404 rule and the 6h
--     span were "two independent terms, so either one alone still refuses". They
--     are not: BOTH are per-row, and against a Planka that 404s everything
--     neither refuses — term 1 because every read genuinely is a 404, term 3
--     because it only postpones the write-off six hours, after which the whole
--     population qualifies at once. Term 4 is the cross-row guard that was
--     missing; it is the only one of the four that can tell a deleted card from
--     a broken Planka.
--
-- ── `callback_delivered_at` NOW MEANS "THE CARD MOVED" ──────────────────────
--
-- It keeps its name and its column; it changes its stamping site and therefore
-- its meaning. From this migration on it is written ONLY by the re-delivery
-- worker, and only alongside `callback_resolution = 'moved'`, i.e. only once
-- Planka has been re-read and the card is observably out of BLOCKED.
-- `deliverDecisionCallback` no longer writes it at all — it writes the ack.
--
-- ── THE BACKFILL IS A RENAME, NOT A CLAIM ───────────────────────────────────
--
--     UPDATE approvals SET callback_acked_at = callback_delivered_at ...
--
-- Every existing non-NULL `callback_delivered_at` was written at exactly one
-- site, on a 2xx, and nowhere else — 109's header and schema.ts both pin that.
-- So copying it into `callback_acked_at` asserts nothing new: it moves a
-- measurement to the column that names it correctly. That is the opposite of
-- 109's refusal to backfill, which was refused precisely because there WAS no
-- evidence; here the evidence is the column being copied.
--
-- ⛔ AND IT DELIBERATELY DOES NOT CLEAR `callback_delivered_at`. Clearing it
-- would return all 373 rows to the worker's population in one tick — the exact
-- outbound burst at Planka that produced the 504s (727 decisions in ~7s was the
-- original trigger). The 216 stuck rows are an OPERATOR-APPROVED, separately
-- paced data repair; this migration makes the mechanism correct and leaves the
-- historical rows for that repair to reach. Until then those rows read as
-- "delivered" under the OLD meaning, which is why `callback_resolution` — not
-- `callback_delivered_at` — is the field a reader should trust going forward.
--
-- ── THE PROBE IS THE BACKFILL RECEIPT, NOT THE CHECK CONSTRAINT ────────────
--
-- ⚠️ CORRECTED 2026-09-06. THIS BLOCK USED TO SAY "drizzle has no CHECK
-- primitive and push emits none (measured for 104)". THAT IS FALSE, and the
-- probe it justified was one edit away from becoming vacuous.
--
--   * `check` is imported at src/db/schema.ts:18 and used 25 times.
--   * A scratch `drizzle-kit push` against an empty postgres:18 emitted four
--     CHECK constraints (andon_state_id_check, streams_kind_tenant_check,
--     streams_notification_channels_check, suggested_schedules_status_check).
--   * `constraintExists(approvals, approvals_callback_resolution_check)` was
--     FALSE on a push-built DB for exactly ONE reason: nobody had declared THIS
--     check in schema.ts yet. And schema.ts + tests/integration/services/
--     db-invariants.integration.test.ts actively INSTRUCT the next author to
--     declare every hand-written CHECK there for CI/prod parity. The first
--     author who obeyed that instruction would have turned this migration into
--     "stamped applied, never run" — silently, on a green CI.
--
-- So the constraint IS now declared in schema.ts (parity, as instructed) and it
-- is NO LONGER the probe. The probe reads the BACKFILL RECEIPT below:
--
--     _migration_effects: one row per migration whose DATA effect ran.
--
-- `drizzle-kit push` reproduces a SCHEMA. It creates tables and constraints; it
-- has no mechanism that can INSERT A ROW. So a receipt row is something push
-- can never produce, no matter what anybody later declares in schema.ts — and
-- the row is written by the SAME STATEMENT as the backfill (a data-modifying
-- CTE), so the receipt cannot exist unless the UPDATE ran to completion.
--
-- ⛔ AND THE ROW COUNT IS DELIBERATELY *NOT* THE PROBE. `count(*) > 0` would be
-- vacuous on a fresh DB, where `approvals` is empty and the backfill correctly
-- touches zero rows: it would read FALSE forever after a legitimate apply and
-- hard-fail every boot (probes are re-evaluated on EVERY startup and must stay
-- TRUE once true). The receipt records the count in `detail` for a human; the
-- probe asks only whether the statement RAN.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS callback_acked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callback_resolution TEXT,
  ADD COLUMN IF NOT EXISTS callback_resolved_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS callback_unreadable_reads INTEGER NOT NULL DEFAULT 0,
  -- WHEN the current run of consecutive unreadable reads started. The strike
  -- COUNT alone is a count of TICKS, and ticks are 15 minutes apart, so three
  -- of them is 45 minutes -- see the UNREADABLE_MIN_SPAN_MS note in
  -- workers/deblock-callback-redelivery.ts. Retirement now needs the run to
  -- span real wall-clock time as well, and this is the clock it is measured on.
  -- Reset to NULL by any successful read, exactly like the count.
  -- ⚠️ THIS CLOCK IS NOT AN INDEPENDENT DEFENCE AGAINST A PLANKA THAT 404s
  -- EVERYTHING, and the worker used to claim it was. It is per-row: under a
  -- fleet-wide 404 every row's clock runs simultaneously and they all mature
  -- together. The cross-row guard is DEGRADED_TICK_GONE_RATIO in the worker.
  ADD COLUMN IF NOT EXISTS callback_unreadable_first_at TIMESTAMPTZ,
  -- How many times we have SENT for this row. An acked-but-never-moved row
  -- became a candidate again every ACK_GRACE_MS and was re-sent forever; the
  -- receiver does not dedupe, so "forever" is also "moves the card every time
  -- it does work". Bounded by MAX_SEND_ATTEMPTS, terminating in the
  -- 'send_exhausted' resolution below.
  ADD COLUMN IF NOT EXISTS callback_send_attempts INTEGER NOT NULL DEFAULT 0;

-- The four terminal values, and nothing else. A typo'd resolution would
-- silently retire a row under a name no reader knows how to interpret.
--
-- ⚠️ 'send_exhausted' is the fourth and it is NOT a success: it means we sent
-- MAX_SEND_ATTEMPTS times, n8n acked every time, and the card never left
-- BLOCKED. It stamps no `callback_delivered_at`. It exists so those rows stop
-- re-sending AND stay findable -- `WHERE callback_resolution = 'send_exhausted'`
-- is the operator's queue of cards n8n accepts and does not move.
-- ⚠️ AND IT REPLACES A STALE ONE. A plain `IF NOT EXISTS (conname)` guard is
-- wrong here: this file shipped an earlier draft with a THREE-value list, and
-- any database that ran it (a reused CI database, a developer's scratch DB)
-- would keep the three-value constraint under the same name and reject every
-- 'send_exhausted' write at runtime -- while this migration reported success.
-- So the guard compares the DEFINITION, not the name.
DO $$
DECLARE
  existing_def text;
BEGIN
  SELECT pg_get_constraintdef(c.oid) INTO existing_def
    FROM pg_constraint c
   WHERE c.conname = 'approvals_callback_resolution_check'
     AND c.conrelid = 'approvals'::regclass;

  IF existing_def IS NOT NULL AND existing_def NOT LIKE '%send_exhausted%' THEN
    ALTER TABLE approvals DROP CONSTRAINT approvals_callback_resolution_check;
    existing_def := NULL;
  END IF;

  IF existing_def IS NULL THEN
    ALTER TABLE approvals
      ADD CONSTRAINT approvals_callback_resolution_check
      CHECK (callback_resolution IS NULL
             OR callback_resolution IN ('moved', 'not_blocked', 'card_unreadable',
                                        'send_exhausted'));
  END IF;
END
$$;

-- The receipt table. Runner-owned infrastructure, named like `_migrations` and
-- deliberately NOT in schema.ts: one row per migration whose DATA effect has
-- actually executed. `drizzle-kit push` can create a table; it cannot insert a
-- row into one, which is the whole point.
CREATE TABLE IF NOT EXISTS _migration_effects (
  migration   TEXT PRIMARY KEY,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb
);

-- The rename described above, and its receipt, in ONE statement.
--
-- ⭐ THE CTE IS LOAD-BEARING. Postgres executes a data-modifying WITH clause
-- exactly once and always to completion, so the INSERT below cannot land unless
-- the UPDATE ran. Two separate statements would let a future edit delete or
-- reorder the backfill while leaving a receipt that says it happened -- which is
-- the class of defect this whole migration exists to close.
--
-- Idempotent on both halves: the UPDATE never overwrites a value the new code
-- has already written, and the INSERT is ON CONFLICT DO NOTHING, so a re-run
-- keeps the ORIGINAL receipt (including its original row count) rather than
-- overwriting it with a second run's zero.
WITH backfilled AS (
  UPDATE approvals
     SET callback_acked_at = callback_delivered_at
   WHERE callback_delivered_at IS NOT NULL
     AND callback_acked_at IS NULL
  RETURNING 1
)
INSERT INTO _migration_effects (migration, detail)
SELECT '113_approval_callback_effect_marker.sql',
       jsonb_build_object('backfilled_rows', (SELECT count(*) FROM backfilled))
ON CONFLICT (migration) DO NOTHING;

-- The worker's predicate changed shape, so 109's partial index no longer covers
-- it. Same column, same purpose, one more term.
CREATE INDEX IF NOT EXISTS approvals_callback_unresolved_idx
  ON approvals (completed_at)
  WHERE callback_delivered_at IS NULL
    AND callback_resolution IS NULL
    AND callback_path IS NOT NULL;

DROP INDEX IF EXISTS approvals_callback_undelivered_idx;
