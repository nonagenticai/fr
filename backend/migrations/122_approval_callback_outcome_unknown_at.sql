-- backend/migrations/122_approval_callback_outcome_unknown_at.sql
--
-- THE DECISION-CALLBACK REQUEST DEADLINE DID NOT RECORD ITS OWN UNCERTAINTY.
--
-- ── THE DEFECT ────────────────────────────────────────────────────────────────
--
-- `routes/approvals.ts :: reportDecisionCallback` races the outbound decision
-- callback against `decisionRequestDeadlineMs()` (8s). Three things happen when
-- the deadline wins, and only the first two were ever observable:
--
--   1. the decider is answered `202 { callback: { outcome: 'pending', … } }` —
--      truthful, deliberate, and NOT changed by this migration;
--   2. the in-flight send is left running, so its own stamp may still land later;
--   3. fr writes NOTHING. No column, no row, no field on `approval_decisions`.
--
-- After the response has been read, (3) means the row is byte-for-byte identical
-- to a row whose callback was never owed at all: `callback_acked_at` NULL,
-- `callback_delivered_at` NULL, `callback_resolution` NULL,
-- `callback_send_attempts` 0. The only report was a 202 body that nobody stores.
--
-- ⛔ SO THE ZERO COUNT FOR THIS PATH WAS NEVER EVIDENCE OF RARITY. It was
-- evidence that nothing was counting. Measured 2026-09-15: 1,148 of 2,321
-- approved rows (49.5%) carry `callback_acked_at IS NULL` across several
-- resolutions — a large population that this branch can contribute to, with no
-- query able to isolate the slice it produced. "It is unobserved" and "it does
-- not happen" are different claims, and only one of them was ever measured.
--
-- ── WHY THIS IS A NEW COLUMN AND NOT A SIXTH `callback_resolution` VALUE ──────
--
-- ⛔ THE OBVIOUS MOVE IS THE WRONG ONE AND THE CODEBASE ALREADY REFUSES IT TWICE.
-- `callback_resolution` is the TERMINAL vocabulary of
-- workers/deblock-callback-redelivery.ts, and `AND a.callback_resolution IS NULL`
-- is a clause of that worker's candidate predicate (`candidateWhereBase`).
-- Writing ANY value there retires the row from the only repair path there is.
--
-- And it would retire exactly the wrong rows. At the instant this branch fires,
-- `callback_acked_at` is still NULL, `callback_delivered_at` is still NULL and
-- the send is STILL IN FLIGHT — the row is a prime re-delivery candidate. Adding
-- a terminal value here would write it off for the sole reason that fr did not
-- wait long enough, which is the migration-113 defect (373 of 373 rows retired by
-- a stamp written too eagerly, every card still in BLOCKED) reproduced against a
-- different column.
--
--   * `services/n8n-callback.ts :: recordDecisionCallbackProblem` refuses the same
--     move on the FAILED branch, in its own words: "Writing one here would retire
--     the row from the only repair path there is — on evidence that the repair had
--     FAILED, which is precisely backwards."
--   * `deblock-callback-redelivery.ts :: notARejectedHold` refuses it again, and
--     spells out that none of the existing values would be HONEST about the row.
--
-- Neither would be honest here either: `send_exhausted` claims MAX_SEND_ATTEMPTS
-- acked sends (there was one, unfinished); `moved` and `not_blocked` both make
-- claims about the card's position that this site cannot see; `card_unreadable`
-- claims Planka 404d; `hold_acknowledged` claims the receiver answered and
-- explained itself — the exact thing that did NOT happen.
--
-- ⇒ A column that means TERMINAL must only ever be written by something that
--   reached a terminal state. This site never does. So the fact gets its own
--   NON-terminal column, exactly as migration 116 gave "we LOOKED at this row"
--   its own column rather than overloading "we CHANGED this row".
--
-- ── WHY THE NAME CANNOT BE MISREAD AS A FAILURE ───────────────────────────────
--
-- ⭐ AN UNKNOWN IS NOT A FAILURE, AND THE TWO MAKE OPPOSITE CLAIMS ABOUT THE
-- RECEIVER. `failed` says the receiver did not take the work. This says only that
-- FR STOPPED LISTENING; on the measured evidence the work very likely COMPLETED.
-- The same distinction already forced `timeout-unknown` to be spelled separately
-- from `failed` in `DecisionCallbackOutcome` (measured 2026-09-13: 66 rows in 3
-- days recorded `abandoned after 5000ms` while n8n recorded ZERO errored
-- executions over the same window, against a receiver whose own latency is p50
-- 9,472 ms / mean 22,844 ms — fr was abandoning BELOW the receiver's median and
-- then accusing it).
--
-- So the column is named for the EPISTEMIC state and contains no failure word:
-- `callback_outcome_unknown_at` = "at this instant, fr did not know the outcome".
-- Not `*_failed_at`, not `*_timed_out_at`, not `*_abandoned_at` — each of those
-- would be read by the next person as a verdict on n8n, and fr has no such
-- verdict to give. A reader who wants failures reads `error_message`; a reader
-- who wants terminal states reads `callback_resolution`; this column answers
-- neither question.
--
-- ── NULLABLE, NOT BACKFILLED, NOT AN EXCLUSION ────────────────────────────────
--
-- NULL means "fr was never left not-knowing on the request path for this row",
-- which is every successful send and the overwhelming majority of rows. There is
-- NO backfill and NO DEFAULT: nothing in the database records which historical
-- rows took this branch, so any backfill would manufacture the measurement this
-- column exists to start taking honestly — the failure mode migration 116's
-- header names in the same words.
--
-- ⚠️ A STAMPED ROW IS NOT FINISHED WITH. The in-flight send may still ack it, and
-- workers/deblock-callback-redelivery.ts still selects it. ⛔ Nothing may ever add
-- this column to a candidate predicate as an exclusion — doing so would turn an
-- observation column into the terminal column this migration exists to avoid.
--
-- ── SHAPE: DDL ONLY, NO DML, SO NO PROBE AND NO RECEIPT ───────────────────────
--
-- One `ADD COLUMN IF NOT EXISTS` and one `COMMENT ON COLUMN`. No INSERT, no
-- UPDATE, no DELETE, no destructive ALTER — so this file needs neither a
-- `COLUMN_PROBES` entry in src/db/migration-runner.ts nor the `NOT PROBED,
-- DELIBERATELY` annotation that scripts/check-migration-dml-probed.ts requires of
-- a DML migration. `drizzle-kit push` reproduces a plain column from
-- src/db/schema.ts, so a stamped-but-unrun apply loses no effect. This is
-- migration 116's shape exactly, and 116's header states the rule.
--
-- ⛔ src/db/schema.ts AND THIS FILE ARE TWO EMITTERS OF ONE COLUMN. A push-built
-- CI database takes it from schema.ts; a migrated database takes it from here.
-- Adding it to only one passes the suite in one environment and 42703s every
-- write in the other, at runtime, with `tsc` green — the failure 113 shipped once
-- and 119's header records.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT inside an outer
-- transaction (src/db/migration-runner.ts); an explicit COMMIT breaks the next file.

ALTER TABLE approvals
  ADD COLUMN IF NOT EXISTS callback_outcome_unknown_at TIMESTAMPTZ;

COMMENT ON COLUMN approvals.callback_outcome_unknown_at IS
  'WHEN fr STOPPED WAITING WITHOUT LEARNING THE OUTCOME of the outbound decision '
  'callback. Written in exactly ONE place: routes/approvals.ts :: '
  'reportDecisionCallback, on the branch where decisionRequestDeadlineMs() wins '
  'the race and the decider is answered callback.outcome = pending. '
  'NOT A FAILURE AND NOT A VERDICT ON THE RECEIVER: it records only that fr '
  'stopped listening, and the receiver''s measured p50 is ~9.5s with zero errored '
  'executions logged, so the work may well have completed. Failures live in '
  'error_message; terminal states live in callback_resolution; this column is '
  'NON-TERMINAL and must never appear as an exclusion in any candidate predicate '
  '-- the row stays a workers/deblock-callback-redelivery.ts candidate and the '
  'in-flight send may still stamp callback_acked_at afterwards. '
  'NULL = fr was never left not-knowing on the request path for this row.';
