// Types for the analysis-to-kanban bridge.
// Mirrors fr/backend/src/domain/bridge/types.ts (see spec
// 2026-04-24-analysis-to-kanban-bridge.md §Architecture key types).

export type ProducerId = 'coding' | 'kag' | 'artifacts';

export type Severity = 'low' | 'moderate' | 'high' | 'critical';

export type DraftStatus =
  | 'editing'
  | 'submitted'
  | 'committed'
  | 'rejected'
  | 'deduped';

export type DraftInitiator = 'user' | 'agent' | 'cron';

export interface ToolOutputSourceRef {
  file_path?: string;
  line_number?: number;
  url?: string;
  artifact_id?: string;
}

export interface ToolOutput {
  producer: ProducerId;
  run_id: string;
  output_id: string;
  stable_id: string;
  title: string;
  body_md: string;
  severity?: Severity;
  source_ref?: ToolOutputSourceRef;
  suggested_labels?: string[];
  suggested_project_id?: string;
}

export interface KanbanCardDraft {
  id: string;
  project_id: string;
  drafter_id: string;
  initiator: DraftInitiator;
  producer: ProducerId;
  run_id: string;
  output_id: string;
  stable_id: string;
  content_digest: string;
  title: string;
  body_md: string;
  target_project_id?: string | null;
  target_board_id?: string | null;
  target_list_id?: string | null;
  assignee_user_id?: string | null;
  labels: string[];
  status: DraftStatus;
  approval_id?: string | null;
  committed_card_id?: string | null;
  dedup_of_card_id?: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface BridgeSourceDescriptor {
  id: ProducerId;
  label: string;
  filters_schema?: Record<string, unknown>;
}

export interface BridgeLink {
  id: string;
  project_id: string;
  producer: ProducerId;
  stable_id: string;
  card_id: string;
  run_id: string;
  content_digest: string;
  created_at: string;
  last_seen_at: string;
}

/** Single-output ref accepted by POST /api/tools/bridge/drafts. */
export interface CreateDraftSingle {
  producer: ProducerId;
  output_id: string;
  overrides?: Partial<KanbanCardDraft>;
  idempotency_key?: string;
  /**
   * For producer='coding': the originating coding-gateway run id whose
   * findings encoded `output_id`. Lets the backend resolve the output on
   * a cache miss without re-listing every job. Sent as both a body field
   * and the X-Coding-Job-Id request header.
   */
  coding_job_id?: string;
}

/** Multi-output ref accepted by POST /api/tools/bridge/drafts. */
export interface CreateDraftBulk {
  producer: ProducerId;
  output_ids: string[];
  overrides?: Partial<KanbanCardDraft>;
  idempotency_key?: string;
  /** See CreateDraftSingle.coding_job_id. */
  coding_job_id?: string;
}

export type CreateDraftBody = CreateDraftSingle | CreateDraftBulk;

export interface PatchDraftBody {
  title?: string;
  body_md?: string;
  target_project_id?: string;
  target_board_id?: string;
  target_list_id?: string;
  assignee_user_id?: string | null;
  labels?: string[];
  idempotency_key?: string;
}

export interface RejectDraftBody {
  reason?: string;
  idempotency_key?: string;
}

export interface CreateDraftsResponse {
  drafts: KanbanCardDraft[];
}

export interface SubmitDraftResponse {
  approval_id: string;
  broadcasted_to: string[];
  draft: KanbanCardDraft;
}
