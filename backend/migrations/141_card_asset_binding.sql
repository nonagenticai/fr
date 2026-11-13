-- Migration: 141_card_asset_binding
-- Date: 2026-09-30
--
-- ONE IN-FLIGHT IMPROVEMENT-CARD CREATE PER (board, asset) — as a SCHEMA FACT.
--
-- ⚠️ THE TITLE OF THIS FILE USED TO READ "ONE OPEN IMPROVEMENT CARD PER
-- (board, asset)". THAT WAS AN OVER-CLAIM, and it is the one this header must
-- not make again. The table is a CRITICAL SECTION, released when the create
-- ends (see "RELEASED ROWS" below), so by itself it excludes only creates that
-- OVERLAP — two callers one second apart both claim, both create. It says
-- nothing about how many cards are open.
--
-- ⭐ WHAT IS ACTUALLY GUARANTEED, and by what:
--   * THIS INDEX gives MUTUAL EXCLUSION: at most one caller at a time inside
--     the create for a (board, asset).
--   * THE CALL SITE gives the rest: holding the binding, the winner READS
--     metering for an already-open card and declines to create
--     (`routes/assets/streams.ts` step 1b, "PRE-CREATE READ"). Mutual exclusion
--     is the only reason that read is not itself a TOCTOU; the read is the only
--     reason the mutual exclusion prevents a duplicate rather than merely
--     ordering two of them. NEITHER HALF IS SUFFICIENT ALONE.
--   * Nothing here binds a writer that does not claim the binding. See the ⚠️
--     at `agui/actions/streams.ts`'s `openDetectorCard` call.
--
-- Issue #996. `services/improvement-cards/create-lease.ts` closes the TOCTOU on
-- POST /api/cards/improvement and POST /api/cards/project with a TTL lease, and
-- records its own honest caveat verbatim:
--
--     "This is a race-window REDUCER, not a hard exactly-once. Planka has no
--      unique constraint on asset_id. A hard guarantee needs a
--      `card_asset_binding(board_id, asset_id)` table with a partial unique
--      index in fr's own DB."
--
-- This is that table. It is introduced for the ONE writer that had no guard of
-- any kind: `handleManualImprovementCard` in src/routes/assets/streams.ts,
-- which created the Planka card FIRST and only then claimed the metering slot,
-- compensating with a DELETE when it lost. Its own comment admitted the race,
-- and the compensation is best-effort: a failed DELETE leaves the duplicate on
-- the board PERMANENTLY, with nothing that can ever collapse it.
--
-- ── WHERE THE ATOMICITY LIVES ─────────────────────────────────────────────
-- ONE piece, and it is deliberately NOT the shape migration 138 needed:
--   * `card_asset_binding_open_uidx` makes "one open binding per (board, asset)"
--     a schema fact and is the arbiter of the claim's
--     `ON CONFLICT (board_id, asset_id) WHERE released_at IS NULL DO NOTHING`.
--     Note the wording: one open BINDING, not one open CARD. The card-level
--     property is the call site's, per the ⭐ block at the top of this file.
--   * ⛔ NO ADVISORY LOCK, and 138's is NOT the precedent to copy here. 138
--     needs `pg_advisory_xact_lock` because it serialises a COUNT across
--     DIFFERENT `card_id`s — N concurrent claims for N different cards all read
--     the same `held` and all insert, and no row index can see that. Our
--     predicate is ONE ROW per (board, asset), which a unique row index
--     arbitrates by itself. Read 138's "WHERE THE ATOMICITY LIVES" header for
--     the distinction before adding a lock here.
--   * The claim is ONE AUTOCOMMIT STATEMENT. No transaction is held across the
--     Planka create (measured 54-104s, 10/10 samples), so nothing pins a
--     pgbouncer server backend for a minute — the same pgbouncer-safety
--     argument as `domain/engagement/dedup-claim.ts` and create-lease.ts.
--
-- ── RELEASED ROWS, AND WHY THERE IS NO TTL ────────────────────────────────
-- The binding is a CRITICAL SECTION over the create, NOT a registry of open
-- cards. The winner releases it in a `finally` on EVERY outcome — success
-- ('created'), throw ('create_failed'), or losing the metering slot
-- ('lost_metering_race'). Released rows are retained for audit and do not
-- conflict, so the same (board, asset) can be claimed again afterwards.
--
-- ⛔ DO NOT "improve" this by keeping the row open for the card's lifetime.
-- That was considered and rejected: NOTHING in fr releases such a row when the
-- card reaches DONE, so a card that closed would suppress the route for its
-- (board, asset) FOREVER, with no clock to expire it. The durable
-- "is a card open right now?" answer stays where it already has a closer —
-- metering's `detector_open_cards` (`closeDetectorCard`). This table answers
-- only "is another request creating one RIGHT NOW?".
--
-- ⚠️ RESIDUAL, NAMED NOT HIDDEN: there is no TTL and no takeover, so a pod
-- killed between the claim and the `finally` leaves an OPEN row that nothing
-- expires, and the route then answers `create_in_progress` for that
-- (board, asset) until the row is released by hand. It degrades to a REFUSAL TO
-- CREATE, never to a duplicate, which is the direction this issue is about.
-- `claimed_at` is the column a `reconcile` sweep (138's shape) would key on;
-- that sweep is a follow-up, not shipped here.
--
-- ── COLUMN CHOICES ────────────────────────────────────────────────────────
-- * `tenant_id` uuid, NO foreign key — same measured reason as migrations 135
--   and 138: 8 of 13 live tenants have no `workspaces` row.
-- * `board_id` / `asset_id` TEXT, matching 138's `project_id`/`card_id`: Planka
--   ids are 19-digit snowflakes, not uuids, and Planka is not in this database
--   so there is nothing to reference.
-- * ⭐ `tenant_id` is deliberately NOT part of the unique index. ⚠️ THE
--   JUSTIFICATION THAT USED TO STAND HERE WAS A MISCITATION and is replaced.
--   It cited create-lease.ts `projectCreateLeaseNamespace` — "one board is
--   legitimately reachable under TWO active tenants at once". That comment is
--   about one PROJECT under `POST /api/cards/project`, and it governs a
--   DIFFERENT route's lease NAMESPACE (`action_idempotency.user_id`), not a
--   board's ownership. It is not evidence about boards: measured on prod `fr`,
--   `projects` has NO `tenant_id` column at all, and the improvement-card lease
--   in the same file points the other way — `routes/cards/improvement.ts:521`
--   passes the caller's `tenantId` as the lease namespace, i.e. tenant-KEYED.
--   The honest reason, MEASURED on prod `fr` 2026-09-30:
--     - Boards ARE tenant-owned, and `board_id` therefore already determines
--       the tenant: `streams` 18 rows / 18 distinct `planka_board_id` /
--       `tenant_id` `is_nullable=NO` / **0** boards carrying more than one
--       `tenant_id` (6 distinct tenants across the 18). Adding `tenant_id` to
--       the index cannot change which rows conflict — it is REDUNDANT.
--     - It is also redundant-but-DANGEROUS, which is the reason it stays out
--       rather than merely the reason it need not go in: the callers do not
--       agree on what tenant they pass. `routes/assets/streams.ts` claims with
--       `requireInternalTenant()` (a constant), while anything acting for a
--       user's own tenant would pass that. A tenant-keyed index hands those two
--       DIFFERENT rows for the SAME board, so both win and the board gets the
--       duplicate. The card the index protects is board-scoped, so the index is
--       board-scoped, and `tenant_id` is an audit payload column only.
-- * `release_reason` is set iff `released_at` is (CHECK below).
--
-- ── NEW TABLE ⇒ NO DEDUP STEP ─────────────────────────────────────────────
-- The table is created empty, so no pre-existing row can violate the unique
-- index and the build cannot fail. There is deliberately NO dedup DML and NO
-- row deletion in this file.
--
-- Pure DDL, additive, idempotent on re-run. No DML, so
-- scripts/check-migration-dml-probed.ts needs nothing. Deliberately NOT in
-- src/db/schema.ts (the same choice as 100's `card_phase_lease`, 138's
-- `wip_slot` and 140's `card_version_stamps`): CI's `drizzle-kit push` must not
-- create it, or the PARTIAL index would exist in prod and not in CI and the
-- concurrency test would pass against a table that cannot enforce anything.
-- The COLUMN_PROBES row `tableExists('card_asset_binding')` in
-- src/db/migration-runner.ts keeps this file PENDING on a push-built database.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_asset_binding (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  board_id       text        NOT NULL,
  asset_id       text        NOT NULL,
  claimed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at    timestamptz,
  release_reason text,
  CONSTRAINT card_asset_binding_release_reason_iff_released
    CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

-- One OPEN binding per (board, asset). The claim's ON CONFLICT arbiter, and the
-- whole of this migration's guarantee.
CREATE UNIQUE INDEX IF NOT EXISTS card_asset_binding_open_uidx
  ON card_asset_binding (board_id, asset_id)
  WHERE released_at IS NULL;
