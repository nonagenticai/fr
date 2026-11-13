-- 201 — G8 / R313: at most ONE pending `asset.promotion` per (tenant, project copy).
--
-- src/services/approvals/asset-promotion.ts `requestAssetPromotion` reads "is one pending?"
-- and then inserts. Two concurrent requests for the same copy both read "none" and both
-- insert, so the read alone cannot keep the one-open-per-copy rule. THE DATABASE IS THE
-- ARBITER (the same pattern as migration 153's bug-fix index): the loser's INSERT raises
-- 23505 on this index and the minter answers with the winner's row (deduplicated).
--
-- Only `pending` is inside the index: an approved (promoted OR failed), rejected, expired or
-- voided promotion must not block a fresh request for the same copy.
--
-- ⚠️ ENUM SAFETY. The predicate does NOT name `kind = 'asset.promotion'`: migration 200 adds
-- that label to the PRE-EXISTING approval_kind type, and the runner applies a whole run in
-- ONE transaction, so naming the label here fails "unsafe use of new value" on any database
-- that runs 200 and 201 together (prod). `kind::text` is no way out either: enum_out is
-- STABLE, not IMMUTABLE, so it is illegal in an index predicate (measured on postgres:18).
-- The predicate keys instead on the metadata shape only an `asset.promotion` row carries
-- ({asset_type in the three promotable kinds, copy_id, original_id}); no other minter writes
-- `copy_id` / `original_id` into approvals.metadata.
--
-- Prod has 0 `asset.promotion` rows (the kind is new in 200), so the build cannot fail on
-- pre-existing duplicates. Probe: src/db/migration-runner.ts (index by name). Pure DDL.
CREATE UNIQUE INDEX IF NOT EXISTS approvals_one_pending_asset_promotion_per_copy_idx
  ON approvals (tenant_id, ((metadata ->> 'copy_id')))
  WHERE status = 'pending'
    AND metadata ? 'copy_id'
    AND metadata ? 'original_id'
    AND (metadata ->> 'asset_type') IN ('requirement', 'principle', 'decision');
