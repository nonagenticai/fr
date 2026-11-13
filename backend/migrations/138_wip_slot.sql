-- Migration: 138_wip_slot
-- Date: 2026-09-28
--
-- THE CONVEYOR'S WIP SLOTS — one row per card the READY→DOING pull admitted.
--
-- Read/written ONLY by POST /api/webhooks/n8n/wip-slot
-- (src/routes/webhooks/wip-slot.ts). The n8n pattern `p.wip.pull` asks for a
-- slot before it moves a card into DOING; the route grants one only if the
-- system, tenant and project WIP levels (env AA_WIP_LIMITS) all have room.
--
-- ── THERE ARE NO CLOCKS ───────────────────────────────────────────────────
-- A slot has no TTL and no expiry. It is freed by an explicit `release` (the
-- card left DOING) or by `reconcile` (the caller hands over the live DOING
-- card set and every unreleased slot whose card is not in it is released with
-- reason 'reconciled'). `claimed_at` / `released_at` are audit columns; no
-- decision reads them.
--
-- ── WHERE THE ATOMICITY LIVES ─────────────────────────────────────────────
-- Two independent pieces, and they guard DIFFERENT things:
--   * `pg_advisory_xact_lock(LOCK_KEYS.wipSlotClaim)` in the claim transaction
--     serialises count-then-insert. Without it, N concurrent claims for N
--     DIFFERENT cards all count the same `held` and all insert — the unique
--     index below cannot see that, because the cards differ.
--   * `wip_slot_open_card_uidx` makes "one open slot per card" a schema fact,
--     and is the arbiter of the claim's `ON CONFLICT (card_id) WHERE released_at
--     IS NULL DO NOTHING`. Released rows are retained (audit) and do not
--     conflict, so a card may be claimed again after it is released.
--
-- ── COLUMN CHOICES ────────────────────────────────────────────────────────
-- * `tenant_id` uuid, NO foreign key — same measured reason as migration 135:
--   8 of 13 live tenants have no `workspaces` row.
-- * `project_id` / `card_id` TEXT — they are whatever the conveyor keys on
--   (Planka ids are 19-digit snowflakes, not uuids). No FK: Planka is not in
--   this database.
-- * `release_reason` is set iff `released_at` is (CHECK below), so an open
--   slot can never carry a reason and a released one can never lack one.
--
-- Pure DDL, additive, idempotent on re-run. No DML, so
-- scripts/check-migration-dml-probed.ts needs nothing. Deliberately NOT in
-- src/db/schema.ts (the same choice as migration 100's `card_phase_lease`):
-- CI's `drizzle-kit push` therefore does not create it, the COLUMN_PROBES row
-- `tableExists('wip_slot')` in src/db/migration-runner.ts keeps this file
-- PENDING on a push-built database, and the runner creates the table from
-- THIS file — one emitter, so the partial index cannot diverge between CI and
-- prod.
--
-- No BEGIN/COMMIT — the runner wraps each file in a SAVEPOINT.

CREATE TABLE IF NOT EXISTS wip_slot (
  id             uuid        NOT NULL DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      uuid        NOT NULL,
  project_id     text        NOT NULL,
  card_id        text        NOT NULL,
  claimed_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  released_at    timestamptz,
  release_reason text,
  CONSTRAINT wip_slot_release_reason_iff_released
    CHECK ((released_at IS NULL) = (release_reason IS NULL))
);

-- One OPEN slot per card. The claim route's ON CONFLICT arbiter.
CREATE UNIQUE INDEX IF NOT EXISTS wip_slot_open_card_uidx
  ON wip_slot (card_id)
  WHERE released_at IS NULL;

-- The per-level counts. Tenant counts use the leading column of the composite
-- index below; this one serves the tenant-scoped `reconcile` sweep and the
-- tenant count without dragging project_id along.
CREATE INDEX IF NOT EXISTS wip_slot_open_tenant_idx
  ON wip_slot (tenant_id)
  WHERE released_at IS NULL;

CREATE INDEX IF NOT EXISTS wip_slot_open_tenant_project_idx
  ON wip_slot (tenant_id, project_id)
  WHERE released_at IS NULL;
