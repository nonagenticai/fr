-- 153 — U3: the derived coverage kind + the structured G-12 decision column + the
-- ac_coverage redelivery sweep's partial index.
--
--   qa.coverage_signoff  G-12 A4 / AA-TRACE §6.17; DERIVED at mint, never sent.
--   + the one-bug-fix-authorization-per-bug-card partial UNIQUE index.
--
-- ⚠️ The SENT U3 kind `execution.feature_design_approval` (G-12 A3) is NOT added here:
-- fr#1333's `152_web_only_approval_kinds.sql` adds it (IF NOT EXISTS). This file was 150;
-- renumbered to 153 when #1336 took 150 and #1333 took 152, and the duplicate ADD VALUE
-- was dropped so there is ONE definition of each label. `execution.bug_fix_approval` is
-- DROPPED everywhere (RULING 10-01, movies-13): the bug-fix gate (G-12 A1) is the
-- `metadata.approval_kind = 'bug_fix_authorization'` marker on generic /
-- execution.ready_signoff rows, which needs no label.
--
-- ALTER TYPE ... ADD VALUE follows migration 086: committed here and only referenced by
-- later runtime transactions (an approval INSERT), never in this one — safe inside the
-- runner's savepoint (PG >= 12). The index below deliberately does NOT name the label
-- (see its comment).
--
-- `approval_decisions.item_decisions` holds the structured G-12 decision for marked
-- bug-fix rows and the design kind: {rule_row, rule_version, inputs_hash, items:[{item_id,
-- decision, reason_code}]} (src/services/approvals/u3-gates.ts). NULL for every other
-- decision. Tenant is inherited through approval_decisions.approval_id → approvals
-- (tenant_id NOT NULL, migration 043); approval_decisions has no tenant_id of its own
-- and every reader reaches it through the tenant-scoped approval, so no direct column.
--
-- `approvals_one_bug_fix_authorization_per_bug_card_idx` (end of file) makes the DATABASE the
-- arbiter of "one fix-authorising approval per bug card" (U3, RULING 10-01 item 3).
--
-- The CHECK and the partial indexes are deliberately NOT in schema.ts: `drizzle-kit push`
-- would build the column but neither of those, so the runner probe keys on them and keeps
-- 153 PENDING on a push-built database. Pure DDL, idempotent; no DML.
ALTER TYPE approval_kind ADD VALUE IF NOT EXISTS 'qa.coverage_signoff';

ALTER TABLE approval_decisions ADD COLUMN IF NOT EXISTS item_decisions jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'approval_decisions_item_decisions_shape'
       AND conrelid = 'approval_decisions'::regclass
  ) THEN
    ALTER TABLE approval_decisions
      ADD CONSTRAINT approval_decisions_item_decisions_shape CHECK (
        item_decisions IS NULL OR (
          jsonb_typeof(item_decisions) = 'object'
          AND jsonb_typeof(item_decisions -> 'items') = 'array'
          AND item_decisions ? 'rule_row'
          AND item_decisions ? 'rule_version'
        )
      );
  END IF;
END $$;

-- The ac_coverage redelivery sweep's partial index (workers/ac-coverage-redelivery.ts →
-- claimAcCoverageBatch) AND of the stuck-row sampler (services/approvals/ac-coverage-stuck.ts
-- → fr_ac_coverage_stuck_approvals). It covers decided rows with no completed delivery
-- marker — a set that drains to ~0 in steady state, so the index stays tiny however large
-- `approvals` grows. `metadata ? 'coverage_decision'` is deliberately NOT in the predicate:
-- the sampler must also count decided rows that LACK it (reason coverage_decision_absent),
-- and a predicate it does not imply would leave it a sequential scan of `approvals`. The
-- sweep keeps that clause in its own WHERE (a filter on this tiny set). Keys: kind
-- (equality), then the two marker instants the claim filters on (next_attempt_at backoff,
-- lease_until). They are ISO-8601 UTC TEXT in jsonb; a ::timestamptz cast is not IMMUTABLE
-- and so cannot be an index expression, and the fixed-width 'Z' form sorts as text.
--
-- ⛔ WHY `kind` IS A KEY COLUMN AND NOT IN THE PREDICATE. The obvious predicate
-- `WHERE kind = 'qa.coverage_signoff' AND ...` CANNOT be built here: the runner applies a
-- whole run in ONE transaction, and the label is ADDED above in that same transaction.
-- Measured on postgres:18: `ALTER TYPE k ADD VALUE 'b'; CREATE INDEX ... WHERE kind='b'`
-- fails "unsafe use of new value ... New enum values must be committed before they can be
-- used", and `kind::text = 'b'` fails "functions in index predicate must be marked
-- IMMUTABLE" (enum_out is STABLE). A later migration file would not help — it runs in the
-- same transaction on any database that applies both. So the predicate holds the
-- enum-free clauses and kind leads the key; the claim's `kind = $1` is an index condition.
--
-- ⚠️ The predicate clauses are spelled EXACTLY as claimAcCoverageBatch and the stuck sampler
-- spell them, so the planner can prove the index applies (tests/unit/services/approvals/
-- ac-coverage-stuck.test.ts EXPLAINs the sampler). Change all three together.
CREATE INDEX IF NOT EXISTS approvals_ac_coverage_sweep_idx
  ON approvals (
    kind,
    ((metadata -> 'ac_coverage_delivery' ->> 'next_attempt_at')),
    ((metadata -> 'ac_coverage_delivery' ->> 'lease_until'))
  )
  WHERE status IN ('approved', 'rejected')
    AND COALESCE((metadata -> 'ac_coverage_delivery') ? 'completed_at', false) = false;

-- ONE FIX-AUTHORISING APPROVAL PER BUG CARD (U3, RULING 10-01 item 3). The DB is the arbiter,
-- not a read-check-write in the route: two concurrent marked mints for the same bug card race
-- on THIS index and the loser gets 23505, which services/approvals/bug-fix-uniqueness.ts maps
-- to 409 `bug_card_already_has_approval` — or, when the winner is the SAME request (equal
-- report_hash, bug_card_id and bug_ids as a set), returns the winner (an idempotent retry).
-- fr writes nothing onto the bug card: GET /api/approvals/bug-fix-for-card/:bugCardId reads
-- the row through the same predicate, which is how a caller finds the authorization.
--
-- Scope = exactly the rows that authorise fixes: kind execution.ready_signoff (RULING a —
-- BUG_FIX_AUTHORISING_KIND) carrying the bug-fix marker. `tenant_id` leads the key so a
-- conflict can only ever be against a row in the minting tenant (a cross-tenant 409 would leak
-- that another tenant holds an approval for the card).
--
-- `status NOT IN ('voided','expired')`: voiding is a real path (lib/void-approvals.ts sets
-- status='voided'; migration 114 voids duplicate gates), and a voided row was withdrawn, not
-- decided, so it must not block a fresh authorization. An EXPIRED row was not decided either:
-- the expiry worker (src/workers/approval-expiry.ts) puts the card back in TODO to be
-- re-raised, and a row that still held this index would answer the re-raise with 409 (or a
-- dedupe onto the expired row) and strand the card. approved / rejected DO block: they are
-- the one decision on record for the card (a rejected bug card is terminal), and the read
-- endpoint returns that row, so a second authorization could never be the answer anyway.
--
-- ⚠️ ENUM SAFETY. This predicate names an enum label, which the ac_coverage index above
-- cannot do for 'qa.coverage_signoff' ("unsafe use of new value" — the label is ADDED in this
-- same transaction). 'execution.ready_signoff' is NOT new: migration 073 added it, and
--   * on prod and on any DB past 073 it is committed long before this runs;
--   * on a drizzle-kit-push-built DB (CI) the type is CREATEd with every label, committed,
--     and 073's ADD VALUE IF NOT EXISTS is a no-op;
--   * on a from-scratch runner DB, 042 CREATEs the type in the SAME transaction, and labels
--     of a type created in the current transaction are safe to use.
-- The literal is folded to an enum constant at CREATE INDEX time and enum equality is
-- IMMUTABLE, so the predicate is legal. Measured on postgres:18: type created + label added in
-- one transaction → index builds; label added to a PRE-EXISTING type in the same transaction →
-- "unsafe use of new value"; ADD VALUE IF NOT EXISTS of an existing label → index builds. And
-- `bun run migrate` on a push-built DB applies this file.
--
-- Prod had 0 marked rows when this was written (BEGIN READ ONLY count on worker4, 2026-10-01),
-- so the build cannot fail on pre-existing duplicates.
--
-- DROP first: an earlier revision of this unmerged file built the index with
-- `status <> 'voided'`, and CREATE ... IF NOT EXISTS would keep that predicate on any DB that
-- applied it. The runner probe keys on the predicate naming 'expired', so such a DB re-applies
-- this file and converges. No DML.
DROP INDEX IF EXISTS approvals_one_bug_fix_authorization_per_bug_card_idx;
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_bug_fix_authorization_per_bug_card_idx
  ON approvals (tenant_id, ((metadata ->> 'bug_card_id')))
  WHERE kind = 'execution.ready_signoff'
    AND metadata ->> 'approval_kind' = 'bug_fix_authorization'
    AND status NOT IN ('voided', 'expired');
