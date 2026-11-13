-- backend/migrations/049_backfill_channel_owns_assignments.sql
-- Foundation Plan 2 — Task 6 §4 (followup, channels table now exists).
--
-- Migration 029 deferred the channel-rows seed because the `channels`
-- table didn't exist yet. Migration 030 created it. This backfill closes
-- the loop: every channel gets the workspace-scope `owns` edge in
-- asset_assignments so the Library effective-set queries (Spec 1 §6.2)
-- pick it up. Idempotent via the `(asset_type, asset_id, scope_level)`
-- partial unique index from migration 028.
--
-- asset_id is text since migration 031, so the channel UUID is cast.

INSERT INTO asset_assignments (
  workspace_id, asset_type, asset_id, scope_level, link_kind, assigned_by
)
SELECT
  c.workspace_id,
  'channel'::asset_type,
  c.id::text,
  'workspace'::scope_level,
  'owns'::link_kind,
  'system-backfill'
FROM channels c
WHERE c.archived_at IS NULL
ON CONFLICT DO NOTHING;
