-- backend/migrations/100_card_phase_lease.sql
--
-- ⚠️ NUMBERING DEVIATION FROM THE SPEC, STATED EXPLICITLY.
-- `n8n_custom_nodes/AA_IMPLEMENTATION/PRODUCTION_READINESS.md` §3.1 names this file
-- `099_card_phase_lease.sql`. Slot 099 was already taken by
-- `099_documents_kag_degraded.sql` when this landed, and
-- `bun run check-migration-numbers` (a CI step) fails outright on a duplicate NNN_
-- prefix. So this takes the next genuinely free slot, 100. Nothing else about the
-- spec's shape changes.
--
-- THE ATOMIC CARD CLAIM (PRODUCTION_READINESS.md Part 3).
--
-- §3.0 — why no read-based guard can work. `ready-prefetch.json`'s `Advance Guard`
-- says so itself: "⚠️ NOT ATOMIC … Planka exposes no compare-and-swap on a card
-- update (no If-Match / expected-listId), so this is a read-then-guard: it NARROWS
-- the race … It does not close it."
--
-- The live 2026-08-10 incident proves the stronger claim — that even the obvious
-- cheaper fix fails. Card 1834885028425762010: the watchdog moved READY→BLOCKED at
-- 04:32:30 on its `ready_20min` SLA; an orphaned in-flight prefetch (exec 504665,
-- started 04:28:30) moved BLOCKED→DOING at 04:35:32, undoing the fail-safe. That
-- prefetch's `Get Card State` ran at 04:34:34 and ALREADY READ BLOCKED — so an
-- "unchanged since we looked" guard would have compared BLOCKED to BLOCKED, passed,
-- and advanced anyway. Only a claim taken at the START of the pass and validated at
-- WRITE time closes it.
--
-- §3.1 — shape. Mirrors `082_router_dedupe.sql`: THE ATOMICITY IS THE PRIMARY KEY
-- PLUS ONE CONDITIONAL UPDATE; NO ADVISORY LOCK. A claim is a single
--   INSERT … ON CONFLICT (tenant_id, card_id) DO UPDATE … WHERE <free|expired|preempt>
--     RETURNING …
-- Postgres serialises concurrent writers on the conflicting row, so under N
-- simultaneous claims exactly one statement returns a row (= granted) and the rest
-- return none (= held by someone else). See src/routes/webhooks/card-phase-lease.ts.
--
-- Key is (tenant_id, card_id) — ONE LEASE PER CARD, not per phase-writer, because
-- the whole point is exclusion ACROSS DIFFERENT phase writers (ready-prefetch vs
-- watchdog vs doing-orchestrate vs qa-evaluate vs done-finalize vs approval-callback).
--
-- `fence` is a monotonic BIGINT that is NEVER RESET. The row is RETAINED (not
-- deleted) on release precisely so the counter cannot restart at 1 and re-open an
-- ABA window: a holder that slept past its TTL must be able to discover that the
-- card moved on beneath it.
--
-- ⚠️ DELIBERATE DIVERGENCE FROM `router_dedupe`, PART 1 — THERE IS NO REAPER.
-- `082_router_dedupe.sql` carries a `created_at` index specifically so the handler
-- can opportunistically DELETE rows past the ~60s cascade window. This table has no
-- such index and its handler issues no DELETE, because deleting a lease row is
-- exactly the ABA window the `fence` exists to close. The table grows by at most one
-- row per card, forever; at the measured conveyor throughput (§"The throughput
-- context": four READY prefetches in the 7 days to 2026-08-10) that is nothing.
--
-- ⚠️ DELIBERATE DIVERGENCE FROM `router_dedupe`, PART 2 — DEGRADATION IS CLOSED.
-- Quoting §3.4 verbatim: "`router-dedupe` degrades OPEN for a specific reason:
-- Planka's webhook is fire-and-forget and the event is lost forever if the router
-- does not answer. Failing closed there converts an fr outage into permanent data
-- loss. A card phase transition has none of those properties. … CLOSED. A lease that
-- grants itself when the arbiter is down is not a lease."
-- The SQL half of "closed" is that a claim is granted ONLY by a row this statement
-- actually returned — there is no fallback path, no default-true, and the handler
-- never catches a DB error into a `granted:true`.
--
-- No BEGIN/COMMIT — the migration runner wraps every file in a SAVEPOINT inside an
-- outer transaction (see src/db/migration-runner.ts); an explicit COMMIT here would
-- break the next file's SAVEPOINT.

CREATE TABLE IF NOT EXISTS card_phase_lease (
  tenant_id   TEXT        NOT NULL,
  card_id     TEXT        NOT NULL,
  -- The current holder's opaque claim token. `verify` compares against THIS, which
  -- is what makes stale-holder detection a fence question and not a clock question
  -- (§3.1: "A holder that slept past its TTL cannot tell time reliably; it CAN ask
  -- whether its lease_id is still current").
  lease_id    TEXT        NOT NULL,
  -- Which phase writer holds it: 'ready-prefetch' | 'watchdog' | 'doing-orchestrate'
  -- | 'qa-evaluate' | 'done-finalize' | 'approval-callback'. Not constrained by a
  -- CHECK: the allowlist that MATTERS (who may preempt) is enforced server-side in
  -- the handler, and a CHECK here would turn adding a sixth writer into a migration.
  holder      TEXT        NOT NULL,
  -- Monotonic, NEVER reset. Incremented on every successful (re)claim.
  fence       BIGINT      NOT NULL DEFAULT 1,
  granted_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TTL horizon. A claim may take a lease whose expires_at has passed; that is the
  -- no-preempt half of the 2026-08-10 replay.
  expires_at  TIMESTAMPTZ NOT NULL,
  -- Set on an explicit release. The ROW SURVIVES — see the fence note above.
  released_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, card_id)
);
