-- One-shot _migrations tracker rename. Run inline by the migration runner's
-- bootstrap-rename guard on next startup (src/db/migration-runner.ts) so live
-- DBs self-heal without operator intervention. Idempotent: re-running is a
-- no-op because every WHERE clause matches the OLD name; once renamed, no
-- row has the old name anymore.
--
-- Order does not matter (no FK / no cross-row dependency); we still wrap
-- in a single transaction so a partial rename can never leave _migrations
-- with a mix of old and new names.

BEGIN;

-- 026 dupes → 017 (streams uses the original gap) + 026 (workspaces kept).
UPDATE _migrations SET filename = '017_streams.sql'                              WHERE filename = '026_streams.sql';

-- 027 dupes → 027 (dept_member_roles kept) + 028 (streams_canary_enabled).
UPDATE _migrations SET filename = '028_streams_canary_enabled.sql'               WHERE filename = '027_streams_canary_enabled.sql';

-- 028 trio → 029 / 030 / 031.
UPDATE _migrations SET filename = '029_agent_runtime_sessions_messages.sql'      WHERE filename = '028_agent_runtime_sessions_messages.sql';
UPDATE _migrations SET filename = '030_asset_assignments.sql'                    WHERE filename = '028_asset_assignments.sql';
UPDATE _migrations SET filename = '031_canary_rollback_events.sql'               WHERE filename = '028_canary_rollback_events.sql';

-- 029 dupes → 032 + 033.
UPDATE _migrations SET filename = '032_backfill_workspaces_default_dept.sql'     WHERE filename = '029_backfill_workspaces_default_dept.sql';
UPDATE _migrations SET filename = '033_kaizen_candidates.sql'                    WHERE filename = '029_kaizen_candidates.sql';

-- +4 shift for everything from 030 onward.
UPDATE _migrations SET filename = '034_channels_registry.sql'                    WHERE filename = '030_channels_registry.sql';
UPDATE _migrations SET filename = '035_relax_asset_assignments_asset_id_to_text.sql' WHERE filename = '031_relax_asset_assignments_asset_id_to_text.sql';
UPDATE _migrations SET filename = '036_backfill_projects_dept_id.sql'            WHERE filename = '032_backfill_projects_dept_id.sql';
UPDATE _migrations SET filename = '037_relax_projects_dept_id_fk.sql'            WHERE filename = '033_relax_projects_dept_id_fk.sql';
UPDATE _migrations SET filename = '038_internal_improvement_workspaces.sql'      WHERE filename = '034_internal_improvement_workspaces.sql';
UPDATE _migrations SET filename = '039_drop_improvements_table.sql'              WHERE filename = '035_drop_improvements_table.sql';
UPDATE _migrations SET filename = '040_seed_internal_tenant_operator_roles.sql'  WHERE filename = '036_seed_internal_tenant_operator_roles.sql';
UPDATE _migrations SET filename = '041_seed_tenant_improvement_projects.sql'     WHERE filename = '037_seed_tenant_improvement_projects.sql';
UPDATE _migrations SET filename = '042_approvals_kind.sql'                       WHERE filename = '038_approvals_kind.sql';
UPDATE _migrations SET filename = '043_kaizen_log.sql'                           WHERE filename = '039_kaizen_log.sql';
UPDATE _migrations SET filename = '044_streams_notification_channels.sql'        WHERE filename = '040_streams_notification_channels.sql';
UPDATE _migrations SET filename = '045_spec_2_continuous_flow.sql'               WHERE filename = '041_spec_2_continuous_flow.sql';
UPDATE _migrations SET filename = '046_extend_trigger_run_status.sql'            WHERE filename = '042_extend_trigger_run_status.sql';
UPDATE _migrations SET filename = '047_approvals_tenant_id.sql'                  WHERE filename = '043_approvals_tenant_id.sql';
UPDATE _migrations SET filename = '048_credentials_encryption_marker.sql'        WHERE filename = '044_credentials_encryption_marker.sql';
UPDATE _migrations SET filename = '049_suggested_schedules.sql'                  WHERE filename = '045_suggested_schedules.sql';
UPDATE _migrations SET filename = '050_scheduled_reports_partial_failure_status.sql' WHERE filename = '046_scheduled_reports_partial_failure_status.sql';
UPDATE _migrations SET filename = '051_scheduled_triggers_from_suggestion.sql'   WHERE filename = '047_scheduled_triggers_from_suggestion.sql';
UPDATE _migrations SET filename = '052_suggested_schedules_heuristic_dedupe.sql' WHERE filename = '048_suggested_schedules_heuristic_dedupe.sql';
UPDATE _migrations SET filename = '053_backfill_channel_owns_assignments.sql'    WHERE filename = '049_backfill_channel_owns_assignments.sql';
UPDATE _migrations SET filename = '054_streams_slug.sql'                         WHERE filename = '050_streams_slug.sql';
UPDATE _migrations SET filename = '055_agent_runtime_sessions_project_id.sql'    WHERE filename = '051_agent_runtime_sessions_project_id.sql';
UPDATE _migrations SET filename = '056_provisioning_audit.sql'                   WHERE filename = '052_provisioning_audit.sql';
UPDATE _migrations SET filename = '057_andon_engaged.sql'                        WHERE filename = '053_andon_engaged.sql';
UPDATE _migrations SET filename = '058_andon_function_owner.sql'                 WHERE filename = '054_andon_function_owner.sql';
UPDATE _migrations SET filename = '059_streams_kind_tenant_aware.sql'            WHERE filename = '055_streams_kind_tenant_aware.sql';
UPDATE _migrations SET filename = '060_streams_kind_tenant_check_rewrite.sql'    WHERE filename = '056_streams_kind_tenant_check_rewrite.sql';

COMMIT;
