#!/usr/bin/env bash
# One-shot renumbering of backend/migrations/*.sql to enforce
# monotonic numeric prefixes (no duplicates). Run once at PR-review
# time so the diff is clean `git mv` operations; do NOT re-run on
# previously-renamed trees (the file basenames have changed).
#
# After renaming, the migration runner's bootstrap-rename guard
# (src/db/migration-runner.ts) maps the old names in the _migrations
# tracker table to the new names on the next startup, so live DBs
# self-heal without operator intervention.
#
# Mapping derived from ~/.claude/plans/user-is-authenticated-favicon-ico-1-rippling-harp.md Phase D1.

set -euo pipefail

cd "$(dirname "$0")/../migrations"

# 026 dupes: streams gets the 017 gap; workspaces stays at 026.
git mv 026_streams.sql                              017_streams.sql

# 027 dupes: dept_member_roles stays at 027 (FK to dept from 026);
# streams_canary_enabled shifts to 028.
git mv 027_streams_canary_enabled.sql               028_streams_canary_enabled.sql

# 028 trio: agent_runtime_sessions_messages → 029, asset_assignments → 030,
# canary_rollback_events → 031.
git mv 028_agent_runtime_sessions_messages.sql      029_agent_runtime_sessions_messages.sql
git mv 028_asset_assignments.sql                    030_asset_assignments.sql
git mv 028_canary_rollback_events.sql               031_canary_rollback_events.sql

# 029 dupes: backfill_workspaces_default_dept → 032, kaizen_candidates → 033.
git mv 029_backfill_workspaces_default_dept.sql     032_backfill_workspaces_default_dept.sql
git mv 029_kaizen_candidates.sql                    033_kaizen_candidates.sql

# Shift 030..056 by +4 to make room for the new monotonic 026..033 range.
# Done in reverse order so we never clobber an existing destination.
git mv 056_streams_kind_tenant_check_rewrite.sql    060_streams_kind_tenant_check_rewrite.sql
git mv 055_streams_kind_tenant_aware.sql            059_streams_kind_tenant_aware.sql
git mv 054_andon_function_owner.sql                 058_andon_function_owner.sql
git mv 053_andon_engaged.sql                        057_andon_engaged.sql
git mv 052_provisioning_audit.sql                   056_provisioning_audit.sql
git mv 051_agent_runtime_sessions_project_id.sql    055_agent_runtime_sessions_project_id.sql
git mv 050_streams_slug.sql                         054_streams_slug.sql
git mv 049_backfill_channel_owns_assignments.sql    053_backfill_channel_owns_assignments.sql
git mv 048_suggested_schedules_heuristic_dedupe.sql 052_suggested_schedules_heuristic_dedupe.sql
git mv 047_scheduled_triggers_from_suggestion.sql   051_scheduled_triggers_from_suggestion.sql
git mv 046_scheduled_reports_partial_failure_status.sql 050_scheduled_reports_partial_failure_status.sql
git mv 045_suggested_schedules.sql                  049_suggested_schedules.sql
git mv 044_credentials_encryption_marker.sql        048_credentials_encryption_marker.sql
git mv 043_approvals_tenant_id.sql                  047_approvals_tenant_id.sql
git mv 042_extend_trigger_run_status.sql            046_extend_trigger_run_status.sql
git mv 041_spec_2_continuous_flow.sql               045_spec_2_continuous_flow.sql
git mv 040_streams_notification_channels.sql        044_streams_notification_channels.sql
git mv 039_kaizen_log.sql                           043_kaizen_log.sql
git mv 038_approvals_kind.sql                       042_approvals_kind.sql
git mv 037_seed_tenant_improvement_projects.sql     041_seed_tenant_improvement_projects.sql
git mv 036_seed_internal_tenant_operator_roles.sql  040_seed_internal_tenant_operator_roles.sql
git mv 035_drop_improvements_table.sql              039_drop_improvements_table.sql
git mv 034_internal_improvement_workspaces.sql      038_internal_improvement_workspaces.sql
git mv 033_relax_projects_dept_id_fk.sql            037_relax_projects_dept_id_fk.sql
git mv 032_backfill_projects_dept_id.sql            036_backfill_projects_dept_id.sql
git mv 031_relax_asset_assignments_asset_id_to_text.sql 035_relax_asset_assignments_asset_id_to_text.sql
git mv 030_channels_registry.sql                    034_channels_registry.sql

echo "Migration renumbering complete. Verify with:"
echo "  ls backend/migrations/ | awk -F_ '{print \$1}' | sort | uniq -d   # should be empty"
echo "  bun run check-migration-numbers"
