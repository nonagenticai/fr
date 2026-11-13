// Shared types for the Wave A /cards/[id] view. Mirrors the
// `GET /api/cards/:id` response shape produced by
// fr/backend/src/routes/cards/get.ts. Kept in lib/cards/ rather than
// lib/types/api.ts so the AA-card vocabulary stays scoped to the cards
// view and doesn't bleed into the generic API client.

export type GroupName =
  | 'Metadata'
  | 'Relations'
  | 'Acceptance Criteria'
  | 'Validation'
  | 'Requirements'
  | 'Principles'
  | 'Decisions'
  | 'Procedures'
  // Execution-time group the conveyor's n8n handlers fill (pr_url, block_reason,
  // …). Blank until a handler writes it; read via lib/cards/runtime-state.ts.
  | 'Runtime State';

export interface CardTask {
  id: string;
  name: string;
  is_completed: boolean;
  task_list_id: string;
  task_list_name: string | null;
  position: number | null;
}

export type DecisionRow =
  | {
      source: 'planka';
      id: string;
      text: string;
    }
  | {
      source: 'approval';
      id: string;
      approval_id: string;
      approval_status: string;
      approval_description: string;
      approver_id: string;
      outcome: string;
      comment: string | null;
      decided_at: string;
    };

// A card's open (pending) approval. The merged `decisions[]` feed only
// carries *decided* approvals, so the BLOCKED gate reads open approvals
// from here. Card approvals raised by n8n are resolved out-of-band via an
// n8n callback (callback_path/recipient) — this surface is read-only.
export interface OpenApproval {
  approval_id: string;
  description: string;
  status: string;
  source: string | null;
  callback_path: string | null;
  recipient: string | null;
  created_at: string;
  /** NULL = "no deadline, ever" (backend migration 105). See ApprovalResponse. */
  expires_at: string | null;
}

// One list transition from the Planka card-action log, annotated with the
// AA phase each list maps to. The decoupled phase journey — reconstructed
// from Planka's own list-move actions, never from n8n.
export interface PhaseTransition {
  action_id: string;
  type: string; // 'createCard' | 'moveCard'
  from_list: string | null;
  to_list: string | null;
  from_phase: Phase | null;
  to_phase: Phase | null;
  at: string | null;
  /** BLOCKED steps only: the `block_reason` Planka recorded for THIS step.
   *  Absent ⇒ none recorded (never the card's current reason copied back). */
  block_reason?: string;
  block_reason_at?: string;
}

export interface CardDetail {
  id: string;
  name: string;
  description: string | null;
  list_id: string;
  list_name: string | null;
  board_id: string;
  /**
   * The fr project whose board holds this card (card → board →
   * `projects.planka_board_id`, resolved SERVER-side by GET /api/cards/:id).
   * `null` = the board is not a project board (a stream / ad-hoc board);
   * absent = an older backend that does not resolve it (treated as unknown,
   * never as "no project"). Drives the §7.5 /cards/[id] → project redirect.
   */
  fr_project_id?: string | null;
  type: string | null;
  position: number | null;
  due_date: string | null;
  is_closed: boolean;
  created_at: string | null;
  updated_at: string | null;
  tenant: string | null;
  is_system: boolean;
  /** The card's owning tenant is in fr's PLATFORM_TENANT_IDS. `false` when the
   *  tenant could not be resolved — never `true` by default. */
  tenant_is_platform: boolean;
  /** A group can be absent at runtime (blank board, older payload) — read with `?.`. */
  groups: Record<GroupName, Record<string, string>>;
  tasks: CardTask[];
  decisions: DecisionRow[];
  /** false ⇒ the approvals half of the feed could not be read; it is short, not complete. */
  decisions_available: boolean;
  /** null ⇒ the read FAILED. `[]` would claim "no seeker pulls", which is an answer. */
  kag_seeker: unknown[] | null;
  /** null ⇒ the read FAILED. `[]` would claim "no open approvals" on a BLOCKED card. */
  open_approvals: OpenApproval[] | null;
  /** `null` when fr could not read the card's Planka action log at all. An
   *  empty array would claim the card has no history, which no real card has. */
  phase_journey: PhaseTransition[] | null;
  /** true ONLY when fr read the card's WHOLE Planka action history (up to 5
   *  pages). false ⇒ older moves may be missing from `phase_journey`. */
  phase_journey_complete: boolean;
  /** ISO time of the oldest action `phase_journey` was built from; null when none
   *  was read. The journey covers nothing older than this unless complete. */
  phase_journey_oldest_at: string | null;
  /** id → title for related/parent/child cards (≤10, tenant-gated, best-effort).
   *  An id missing here means "title unknown", not "no such card". Optional:
   *  older payloads do not carry it. */
  related_titles?: Record<string, string>;
}

/** GET /api/card-types/:card_type — the tenant's RM card type (no per-phase protocol). */
export interface CardTypeDescription {
  card_type: string;
  title: string;
  card_type_description: string;
  /** The card type's RM capability name. */
  card_group: string | null;
  capability: { name: string; title: string } | null;
  inputs: string[];
  outputs: string[];
  acceptance: string[];
  rules: string[];
  human_task: boolean | null;
  definition_of_done: unknown;
}

// The four canonical phases per PHILOSOPHY.md. Driven by Planka list
// name, not a schema column — the mapping lives in PhaseStrip.svelte.
export type Phase = 'READYING' | 'DOING' | 'INSPECTING' | 'PUBLISHING';

export const PHASES: readonly Phase[] = [
  'READYING',
  'DOING',
  'INSPECTING',
  'PUBLISHING',
] as const;
