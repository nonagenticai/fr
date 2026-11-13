// The custom-field NAMES fr's card readers and writers use, by group —
// a constant map of the requirements_management DEFAULT BOARD TEMPLATE
// (RM src/data/pm_catalogue_defaults.json `board_templates[default]`, synced to
// tooling/openapi/specs/requirements.pm-catalogue-defaults.json).
//
// ⭐ THE RM BOARD TEMPLATE IS THE MASTER (George 2026-10-13, v4 ruling 12).
// A board's groups and fields are created ONCE, from the tenant's RM template,
// when the board is built (services/catalogue/board-template.ts →
// planka/custom-fields.ts provisionBoardFieldGroups). This file provisions
// NOTHING and feeds no board creation: it only names fields so card code can
// read/write their values. A name a board does not carry is skipped with a
// `board_custom_field_missing` warning (planka/custom-fields.ts boardField) —
// fr never creates it. To add a field: add it to the RM template first, then
// here (field-groups.test.ts pins this map == the vendored RM template, so the
// two cannot drift).
//
// `GROUP_POSITIONS` is the template's group order (65536 apart), used to order
// the groups of a card read (routes/cards/get.ts).

export const GROUP_POSITIONS = {
  Metadata: 65536,
  Relations: 131072,
  'Acceptance Criteria': 196608,
  Validation: 262144,
  Requirements: 327680,
  Principles: 393216,
  Decisions: 458752,
  Procedures: 524288,
  'Runtime State': 589824,
} as const;

export const GROUP_FIELDS: Record<keyof typeof GROUP_POSITIONS, readonly string[]> = {
  Metadata: [
    'work_type',
    'card_group',
    'priority',
    'scope_level',
    'requestor',
    'creator_role',
    'project_id',
    'constraints',
    'stream_id',
    'stream_slug',
    'card_type',
    'project_type',
    'phase',
    'capability',
    'asset_id',
    'asset_kind',
    'detector_severity',
    'manual_trigger',
    'worker_name',
    'keycloak_tenant_id',
    'user_id',
    'subtype',
    'authored_asset_id',
    'version_stamp',
    'plan_pin',
    'source_artifact_id',
    'source_item_id',
    'spec_hash',
  ],
  Relations: [
    'parent_card',
    'child_cards',
    'requires',
    'required_by',
    'criterion_ids',
  ],
  'Acceptance Criteria': [
    'criterion_1',
    'criterion_2',
    'criterion_3',
    'criterion_4',
    'criterion_5',
  ],
  Validation: [
    'scenario_titles',
    'gherkin_summary',
    'qa_exit_rule',
    'blocked_conditions',
  ],
  Requirements: [
    'requirement_1',
    'requirement_2',
    'requirement_3',
    'requirement_4',
    'requirement_5',
  ],
  Principles: [
    'principle_1',
    'principle_2',
    'principle_3',
    'principle_4',
    'principle_5',
  ],
  Decisions: [
    'decision_1',
    'decision_2',
    'decision_3',
    'decision_4',
    'decision_5',
  ],
  Procedures: [
    'readying_procedure',
    'doing_procedure',
    'qa_procedure',
    'done_procedure',
  ],
  'Runtime State': [
    'prefetch_results',
    'counts',
    'sparse_dimensions',
    'expansion',
    'keywords_used',
    'output_summary',
    'step_results',
    'container_name',
    'status',
    'artifact_id',
    'reasoning_verdict',
    'execution_tier',
    'procedure_used',
    'deliverables',
    'pr_url',
    'pr_number',
    'pr_repo_owner',
    'pr_repo_name',
    'pr_is_draft',
    'verdict',
    'recommendation',
    'issues',
    'qa_exit_rule_applied',
    'oracle_tier',
    'blocking_gate',
    'escalate',
    'escalation_reason',
    'decision_id',
    'principles_applied',
    'completion_summary',
    'kaizen_log_id',
    'finalized',
    'notification_status',
    'block_reason',
    'old_workflow_id',
    'new_workflow_id',
    'proposal',
    'is_analysis_only',
    'phase_run_id',
    'validation_ok',
    'validation_violations',
    'commit_sha',
    'qa_chain',
    'acs_count',
    'cause',
    'split_request',
    'wip_slot_id',
    'priority_set_by',
    'priority_base',
    'job_pending',
    'context_pack_ref',
    'context_pack_output_ref',
    'context_pack_qa_output_ref',
    'check_json_sha256',
    'analysis_report',
    'hunt_result_id',
    'grid_handover_ready',
    'grid_handover_doing',
    'released',
    'wait_for_phase',
  ],
} as const;

export type GroupName = keyof typeof GROUP_POSITIONS;
