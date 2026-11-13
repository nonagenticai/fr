-- 098: execution_signoff_blocks — the durable ledger of cards the AA
-- ready-prefetch sign-off gate parked but could NOT create an approval for.
--
-- WHY THIS TABLE EXISTS
--
-- n8n moves a policy-gated card READY -> BLOCKED and POSTs
-- /api/execution/approvals. fr answers 404 (no project for that board), 400
-- (project has no resolvable tenant) or 422 (project has no
-- 'execution_signoff' approvers). The n8n HTTP node runs with
-- onError:continueRegularOutput, so EVERY one of those answers is discarded
-- by the caller and the card sits in BLOCKED with nothing, anywhere, that
-- knows it is unreleasable. src/lib/execution-signoff.ts has named this
-- consequence in a comment since it was written — "that 422 is swallowed and
-- the card is stranded in BLOCKED forever" — but naming it in a comment does
-- not make it queryable.
--
-- Measured on prod (worker4, db `fr`, 2026-08-08): of the 292 cards currently
-- in a READY/BLOCKED list that carry AA metadata, 137 sit on a Planka board
-- with NO row in fr.projects (-> 404) and 102 sit on a board whose project has
-- ZERO execution_signoff stakeholders (-> 422). 53 could actually get an
-- approval. Answering that question required a hand-written join across two
-- databases, because fr retains nothing when the gate fails. This table is
-- what makes it a one-line SELECT.
--
-- A RESPONSE STATUS IS NOT A RECORD. The status code is advice to a caller
-- that has already decided to ignore it; the row is the system's own memory.
-- The two are complementary and this migration only adds the second.
--
-- tenant_id IS NULLABLE — deliberately, and against the house rule that every
-- tenant-scoped table carries a NOT NULL tenant_id (migration 043). The whole
-- point of a `project_not_found` block is that fr could not resolve a project,
-- and therefore could not resolve a tenant either. Forcing a tenant here would
-- mean either inventing one or dropping the very rows the table exists to
-- keep. Reads are consequently super-admin-only (operator diagnostics), never
-- tenant-scoped customer data.
CREATE TABLE IF NOT EXISTS execution_signoff_blocks (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),

    -- Planka card id, as the caller sent it. TEXT, matching approvals.card_id:
    -- Planka ids are 64-bit snowflakes that do not fit a bigint round-trip
    -- through JSON cleanly, and fr treats them as opaque everywhere else.
    card_id             TEXT NOT NULL,

    -- The board the card sits on (approvals resolve project via
    -- projects.planka_board_id). Kept even when nothing resolved: it is the
    -- only handle an operator has for "which board do I have to fix".
    board_id            TEXT,

    -- The project key the caller supplied VERBATIM, un-validated. TEXT and not
    -- UUID on purpose: a caller sending a non-UUID (a Planka numeric project
    -- id, a sentinel like `__system_workflow__`) is exactly the case we must
    -- be able to record, and a uuid column would reject the evidence.
    requested_project_id TEXT,

    -- Set only when the project row actually resolved (the no-approvers and
    -- untenanted cases). NULL for project_not_found. No FK: a project deleted
    -- after the block was recorded must not erase the block.
    resolved_project_id UUID,

    -- NULL when unresolvable — see the header note.
    tenant_id           UUID,

    -- Machine-readable cause. Values are the SignoffBlockReason union in
    -- src/lib/execution-signoff.ts. TEXT, no CHECK/enum: this is an
    -- operator-facing diagnostic and a new cause must never need a migration
    -- to be recordable (same reasoning as 094's disabled_reason).
    reason_code         TEXT NOT NULL,

    -- Human-readable detail: the message the API also returned.
    detail              TEXT NOT NULL,

    -- The gate re-fires every time the card is touched, so a block is a
    -- COUNTER, not an event stream. One row per (card_id, reason_code);
    -- repeats bump attempts + last_seen_at. Keeps the operator view a list of
    -- distinct problems instead of a firehose.
    attempts            INTEGER NOT NULL DEFAULT 1,
    first_seen_at       TIMESTAMP NOT NULL DEFAULT now(),
    last_seen_at        TIMESTAMP NOT NULL DEFAULT now(),

    -- Set when the same card later succeeds in creating an approval (the
    -- config was fixed). Retained rather than deleted so "how long was this
    -- card unreleasable" stays answerable.
    resolved_at         TIMESTAMP
);

-- The upsert key. Partial-free (plain UNIQUE): resolved rows keep the slot so a
-- recurrence re-opens the SAME row rather than accumulating duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS execution_signoff_blocks_card_reason_key
    ON execution_signoff_blocks (card_id, reason_code);

-- The operator query: open blocks, newest first.
CREATE INDEX IF NOT EXISTS execution_signoff_blocks_open_idx
    ON execution_signoff_blocks (last_seen_at DESC)
    WHERE resolved_at IS NULL;
