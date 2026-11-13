// cockpit.ts
// =========
// Frontend mirror of the project-cockpit read model
// (backend/src/services/cockpit/project-cockpit.ts). One block per section of
// GET /api/projects/:id/cockpit; keep these types verbatim-aligned with the
// backend's exported payload types. Faithful to the backend: fields the backend
// types as `T | null` stay nullable here (do NOT collapse to `?`) so the UI
// handles the real payload.

import type { Panel, PanelHealth } from './panel';
import type { ConversationEntry, DeliveredPr, HistoryCard } from './conveyor-history';

/** Canonical mantra phase (board-list derived) — NOT the project lifecycle phase. */
export type Phase = 'READYING' | 'DOING' | 'INSPECTING' | 'PUBLISHING' | 'BLOCKED' | 'OTHER';

export interface PhaseColumn {
  phase: Phase;
  list_name: string | null;
  count: number;
  /** true when this is the phase with the most in-flight (DOING/INSPECTING) cards. */
  active: boolean;
  /** ms since the oldest card entered this list (null when empty). */
  oldest_card_age_ms: number | null;
}

export interface CockpitCard {
  id: string;
  name: string;
  phase: Phase;
  list_name: string | null;
  labels: string[];
  age_in_phase_ms: number | null;
  updated_at: string | null;
  blocked: boolean;
  blocked_reason: string | null;
}

export interface CockpitApproval {
  id: string;
  kind: string;
  status: string;
  description: string;
  card_id: string | null;
  created_at: string | null;
  expires_at: string | null;
  /** The approval's `metadata` jsonb, verbatim (null = no gate recorded). */
  metadata?: Record<string, unknown> | null;
  required_approvers: { user_id: string; role: string | null }[];
  decisions: {
    approver_id: string;
    decision: string;
    comment: string | null;
    decided_at: string | null;
    /** A5 / R-CK1: a person, the approval-triage agent, or fr policy code. */
    decided_by_kind?: 'human' | 'triage_agent' | 'rule' | 'agent';
  }[];
  // The fields the "needs you" widget used to hydrate with a second approvals.list call.
  tenant_id?: string;
  source?: string | null;
  requester_id?: string | null;
  action_id?: string | null;
  change_summary?: string | null;
  impact_analysis?: string | null;
}

export interface CurrentExecution {
  execution_id: string;
  workflow_id: string;
  correlation_id: string;
  status: string;
  started_at: string | null;
  triggered_at: string | null;
}

export type TimelineEventType =
  | 'phase_transition'
  | 'asset_fetch'
  | 'worker_inference'
  | 'typed_action'
  | 'qa_verdict'
  | 'decision_write'
  | 'kag_write';

export type TimelinePillTone = 'success' | 'warn' | 'danger' | 'neutral';

export interface TimelinePill {
  label: string;
  tone: TimelinePillTone;
}

export interface TimelineEvent {
  id: string;
  type: TimelineEventType;
  at: string;
  title: string;
  card_id: string | null;
  execution_id: string | null;
  correlation_id: string | null;
  status: string | null;
  pills: TimelinePill[];
}

export interface AssetUsage {
  /** distinct KAG entities linked to this project's cards (cardSeekerLinks). */
  kag_memory_links: number;
  cards_with_links: number;
  per_card: { card_id: string; link_count: number }[];
  /** Governance assets bound to this project, per kind (asset_bindings). 0 = none bound. */
  bound_by_kind: {
    principle: number;
    requirement: number;
    decision: number;
  };
}

export interface CockpitGoal {
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  cards_total: number | null;
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  cards_published: number | null;
  /** null ⇒ the phase rail could not be read. NEVER 0-as-unknown. */
  coverage_pct: number | null;
  open_gates: number;
}

// ── MACRO project lifecycle rail ─────────────────────────────────────────────
//
// Mirrors backend `LifecycleRail` / `RailNode` (backend/src/lib/project-phase.ts).
// ⚠️ Distinct from `PhaseColumn` above, which is the MICRO board-mantra axis.
// The SERVER projects this rail from the project's RM project-type phases (or its
// plan's), with RM's titles as `label` — the frontend holds no phase list.

/** A phase NAME of the project's RM project type (requirements_management). */
export type ProjectPhaseName = string;

export type LifecycleRailNodeState = 'done' | 'active' | 'gate' | 'upcoming';

export interface LifecycleRailNode {
  phase: ProjectPhaseName;
  label: string;
  state: LifecycleRailNodeState;
  isGate: boolean;
  /** PLAN projects only (fr#1482): the approval kinds gating this phase's EXIT. */
  gate_kinds?: string[];
}

export interface LifecycleRail {
  /** RM's current phase (RM owns it; n8n writes it). null = NOT STARTED: every node pending. */
  phase: ProjectPhaseName | null;
  /** Nullable even when the block is AVAILABLE — see the backend's note. */
  phase_updated_at: string | null;
  next_gate: ProjectPhaseName | null;
  nodes: LifecycleRailNode[];
  /**
   * fr#1482: present (non-null) for a PLAN project — its nodes are then the
   * plan's phases only, projected by the server. null/absent = legacy spine.
   */
  plan?: { template_id: string; template_hash: string } | null;
}

// ── The APPROVED SCOPE (migration 127) ───────────────────────────────────────
//
// ⚠️ `acceptance_criteria` IS APPROVED INTENT, NOT EVIDENCE OF COMPLETION.
// Nothing validates a criterion against an artefact (measured 2026-09-23:
// `artifacts.card_id` NULL on all 58,573 rows). A component rendering these must
// not add a checkmark, "done" styling, or a completed count.

export interface ProjectDeliverable {
  id: string;
  position: number;
  kind: 'deliverable' | 'intermediate';
  title: string;
  description: string | null;
  /** `[]` is a real "none recorded", never a missing read. */
  acceptance_criteria: string[];
}

export interface ProjectMilestone {
  position: number;
  name: string;
  /** NULLABLE by design: an agreed ordering need not commit to dates. */
  target_date: string | null;
}

/** ⚠️ APPROVED, not tracked — nothing in fr measures effort spent. */
export interface ApprovedEffortEstimate {
  value: number;
  unit: string;
  note?: string;
}

export interface ApprovedScope {
  deliverables: ProjectDeliverable[];
  milestones: ProjectMilestone[];
  approved_effort_estimate: ApprovedEffortEstimate | null;
}

// ── Per-project LLM cost to date ─────────────────────────────────────────────
//
// ⛔ THIS TYPE REPLACES `ProjectCost` IN `$lib/api/cockpit`, WHOSE AMOUNT FIELD
// WAS NAMED AS A TOTAL AND WAS NOT ONE. Billing only ever knew the spend that
// arrived carrying this project's id, and the backend emits that id only for a
// project whose `keycloak_tenant_id` tag matches the caller's tenant. For any
// other project the id was never emitted, so billing's zero means UNKNOWN — and
// `$0.00` rendered identically for "spent nothing" and "nothing was ever
// attributed". The old `coverage_note` warned in prose and could not move the
// render.
//
// An unattributable project now arrives as an UNAVAILABLE block (`data:null`,
// `unavailable_kind:'data_gap'`), so there is no number to format. The project's Cost page (and the
// shell header's one-line spend) is the reader.

export type ProjectCostCoverage = 'attributed' | 'unattributable';

export interface ProjectCost {
  /** Dollars billing ATTRIBUTED over [from, to] — a floor on spend, not a total. */
  attributed_usd: number | null;
  /**
   * What `attributed_usd` is: `'billed'` (incurred × the tenant's markup) for
   * everyone but a super-admin, who gets `'incurred'`. `'unavailable'` (with a
   * null amount) when the markup cannot be established — the backend never
   * substitutes the incurred figure.
   */
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  /** LLM calls billing attributed over the same window. */
  attributed_request_count: number;
  /** Input / output tokens billing attributed over the same window (absent on an older backend). */
  input_tokens?: number;
  output_tokens?: number;
  /**
   * ⚠️ The last day the figures cover (billing rolls up per COMPLETED UTC day, so
   * today's spend is not in them). null = no completed day yet (project started
   * today): the figures are then NOT a zero. Absent on an older backend.
   */
  rolled_up_through?: string | null;
  /** A single funding (e.g. `local_gpu`), `mixed`, or null — drives the cost-basis line. */
  funding_kind?: string | null;
  /** Inclusive first day (YYYY-MM-DD, UTC) — the project's creation day. */
  from: string;
  /** Inclusive last day (YYYY-MM-DD, UTC). */
  to: string;
  /** When billing was asked. */
  as_of: string;
  /**
   * ⚠️ Always 'attributed' on a block today's backend publishes: an
   * unattributable project resolves unavailable, so it carries no data. The panel
   * branches on it FIRST anyway — it is a REFUSAL, not a metric, and it is what
   * would still stop a `$0.00` if a future backend made that path available with
   * zeros. ⛔ Do not delete it as single-valued.
   */
  coverage: ProjectCostCoverage;
  /**
   * Who paid — local GPU / platform-paid / tenant BYO — over `funding.from..to`
   * (≤ 92 days, complete UTC days, so it need not sum to `attributed_usd`).
   * `null` = billing's breakdown could not be read; absent = an older backend.
   */
  funding?: ProjectFundingSplit | null;
}

export interface ProjectFundingSplit {
  from: string;
  to: string;
  by_funding: { funding: string; events: number; cost_usd: number | null }[];
}

/**
 * One repository attached to a project, as the cockpit publishes it. Mirrors
 * `ProjectRepositoryRow` in `backend/src/services/project-repositories.ts`.
 */
export interface CockpitProjectRepository {
  repo_id: string;
  url: string;
  branch: string | null;
  name: string;
  path: string | null;
  is_primary: boolean;
  position: number;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  /** RM's current phase; null = not started, or unreadable (the `project` panel is then degraded). */
  project_phase: string | null;
  /** RM's project type name, or null. */
  project_type?: string | null;
  /** RM's lifecycle status (`closed` once the PM closes the project); null when unreadable. */
  rm_status?: string | null;
  shape: string;
  planka_board_id: string | null;
  n8n_project_id: string | null;
  /**
   * The DENORMALISED primary repo url. ⛔ Kept deliberately — every existing
   * consumer destructures it and it stays meaningful as the primary. What was
   * wrong before was that it was the ONLY repo field, so a 3-repo project and a
   * 1-repo project rendered identically.
   */
  repository_url: string | null;
  /** The project carries an RM link (run by the conveyor); the conveyor-history panel mounts only then. */
  conveyor_linked?: boolean;
  /**
   * 'coordinated' (one unit of work across every repo) or 'independent' (each
   * repo moves on its own). Ships beside `repositories` because the list alone
   * does not say how the repos are worked, and a consumer rendering N repos
   * without the mode has to guess.
   */
  coordination_mode: string;
  /**
   * R6 / R-CK3: RM's budget — reporting only (nothing enforces it). A null budget means NO budget
   * is set and must never render as $0. Optional: absent on an older backend ⇒ no budget line.
   */
  budget?: number | null;
  /**
   * R6: whether the RM state behind `budget` was read. `false` ⇒ RM could not be read, so a null
   * budget is UNKNOWN, not "no budget set" — the UI words it that way. Absent on an older backend
   * (⇒ treat a null budget as "not set", the pre-R6 behaviour).
   */
  budget_known?: boolean;
  /** ISO 4217 code alongside `budget`; null when RM holds none. */
  currency?: string | null;
  // The FULL repository set is its own panel (`ProjectCockpit.repositories`).
  /**
   * Migration 173 — set when `status === 'delivered'`. OPTIONAL: the cockpit
   * backend does not emit these yet; absent ⇒ the badge renders without a PR link.
   */
  delivered_at?: string | null;
  delivery_evidence?: import('./api').ProjectDeliveryEvidence | null;
}

/** Review-actionable artifact (pending / needs_revision) for the "Needs you" queue. */
export interface CockpitArtifact {
  id: string;
  filename: string;
  kind: string;
  project_id: string;
  created_at: string;
  status: 'pending' | 'needs_revision';
}

/** A report the conveyor stored in the artifacts service (`report.json`) for this project. */
export interface CockpitReport {
  id: string;
  filename: string;
  card_id: string | null;
  card_name: string | null;
  step: string | null;
  /** REVIEW status (`pending` = not reviewed yet) — not readiness. */
  status: string | null;
  /** `published` / `draft` (artifact_service); null = not served. Absent on an older backend. */
  publish_status?: 'draft' | 'published' | null;
  /** The newest published report — the project's final report. */
  is_final?: boolean;
  created_at: string;
}

// ── C1 status header ─────────────────────────────────────────────────────────

/** FR-PROJECT-HOME-REDESIGN §4: Running · Waiting on you · Blocked · Paused (andon) · Completed · Cancelled. */
export type CockpitState = 'running' | 'waiting_on_you' | 'blocked' | 'paused' | 'completed' | 'cancelled';

export type CockpitStateReason =
  | 'rm_closed'
  | 'project_archived'
  | 'project_delivered'
  | 'andon_engaged'
  | 'card_blocked'
  | 'flow_failed'
  | 'open_approvals';

export interface CockpitStatus {
  state: CockpitState;
  reasons: CockpitStateReason[];
  project_type: string | null;
  phase: string | null;
  next_gate: string | null;
  started_at: string | null;
  ended_at: string | null;
  open_approvals: number;
  /** "Phase N of M: X" — the chain is the type's phases + Closure (absent on an older backend). */
  current_phase?: string | null;
  current_phase_label?: string | null;
  phase_position?: number | null;
  phase_count?: number | null;
  /** Spend to date; null = billing not read / not attributable. */
  cost?: { total: number | null; calls: number; currency: string; basis: 'incurred' | 'billed' | 'unavailable' } | null;
  health: { flows: PanelHealth; upstream: PanelHealth; cost: PanelHealth };
}

// ── C2 action strip ──────────────────────────────────────────────────────────

export type CockpitActionType = 'ask' | 'signoff' | 'review';

export interface CockpitActionItem {
  key: string;
  type: CockpitActionType;
  title: string;
  created_at: string | null;
  card_id: string | null;
  card_name: string | null;
  approval_id: string | null;
  artifact_id: string | null;
  /** The phase of the item's card (exact); null/absent = not tied to a phase. */
  phase?: string | null;
}

// ── A5 flow runs ─────────────────────────────────────────────────────────────

export interface CockpitFlowRun {
  execution_id: string;
  workflow_id: string | null;
  workflow_name: string | null;
  card_id: string | null;
  /** The conveyor's verdict: a run that took the flow's `Flow error` / `Agent failed` path is 'error'. */
  status: string;
  /** n8n's own final status (migration 214); absent on an older backend. */
  n8n_status?: string | null;
  started_at: string | null;
  stopped_at: string | null;
  failed_node: string | null;
  error_class: string | null;
}

export interface CockpitFlowFailure extends CockpitFlowRun {
  /** Raw detail — only ever behind "Details". */
  error_message: string | null;
  /** n8n finished normally but the flow took its own failure path (flow_error / agent_failed). */
  failed_inside_flow: boolean;
}

export interface CockpitFlows {
  connected: boolean;
  runs: CockpitFlowRun[];
  unresolved_failures: CockpitFlowFailure[];
  /** Every failed run in the window read, newest first (capped); absent on an older backend. */
  failures?: CockpitFlowFailure[];
  failure_count?: number;
  last_received_at: string | null;
}

// ── billing #290 per-project costs (Slice 2 renders them) ───────────────────

/** R6 (C7 / R-CK6): one card's spend plus the phase and capability DERIVED from the card. */
export interface CostCardRow {
  card_id: string | null;
  cost: number | null;
  calls: number;
  /** The card's EXACT phase (its own `phase` field, Closure for a closure card); null = no card / not tied. */
  phase?: string | null;
  /** The card's `card_type` custom field. */
  card_type?: string | null;
  /** The RM capability NAME of `card_type`; null when the type or the catalogue could not say. */
  capability?: string | null;
}

/** R6 (C7): the BOARD's state behind the cost rows' annotation. 'no_board' is a fact about the
 * project (it has no board), never a read failure — the two are worded differently. */
export type CostBoardState = 'ok' | 'unavailable' | 'no_board';

export interface CockpitProjectCosts {
  cost_basis: 'incurred' | 'billed' | 'unavailable';
  settled: { day: string; cost: number | null; calls: number; tokens_in: number; tokens_out: number }[];
  provisional: { since: string | null; cost: number | null; calls: number; tokens_in: number; tokens_out: number };
  by_card: CostCardRow[];
  by_card_since: string | null;
  /**
   * R6: whether the project's board was read when these rows were annotated. `false` ⇒ no row can
   * be tied to a card, so every `phase` / `capability` is null because the board was unavailable —
   * NOT because the cards record nothing. Absent on an older backend/answer (⇒ say nothing extra).
   */
  board_available?: boolean;
  /**
   * R6: the board's state behind the annotation, tri-state. `no_board` = the project has no board
   * at all (a fact — the archive purges `planka_board_id`), NOT a failed read; `unavailable` = the
   * board could not be read. OPTIONAL like `board_available`: absent on an older backend, where
   * `board_available === false` still means "unavailable" (the pre-R6 behaviour).
   */
  board_state?: CostBoardState;
  /**
   * Whether the card→capability names could be read: 'unavailable' = the tenant catalogue was
   * needed and failed, so every `capability` is null and the page says so. Absent on an older backend.
   */
  capability_source?: 'catalogue' | 'unavailable';
  totals: {
    cost: number | null;
    settled_cost: number | null;
    provisional_cost: number | null;
    calls: number;
    tokens_in: number;
    tokens_out: number;
  };
  currency: string;
  basis: string;
  as_of: string;
}

export interface CockpitRepositorySet {
  repositories: CockpitProjectRepository[];
  count: number;
}

export interface CockpitConveyorHistory {
  conversation: Panel<{ entries: ConversationEntry[] }>;
  cards: Panel<{ cards: HistoryCard[] }>;
  delivered: Panel<{ pull_requests: DeliveredPr[] }>;
}

/** `GET /api/projects/:id/cockpit?scope=header`. */
export interface ProjectCockpitHeader {
  scope: 'header';
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  /**
   * R4: how many items the project's Needs you page lists — the length of the SAME server list
   * the full read serves as `actions`. Absent from an older backend (⇒ no badge, never 0).
   */
  needs_you?: Panel<number>;
}

/** `GET /api/projects/:id/cockpit` — read model v2 (R-CK8): every key a Panel. */
export interface ProjectCockpit {
  scope: 'full';
  project: Panel<ProjectSummary>;
  status: Panel<CockpitStatus>;
  actions: Panel<CockpitActionItem[]>;
  lifecycle_rail: Panel<LifecycleRail>;
  phase_rail: Panel<PhaseColumn[]>;
  active_cards: Panel<CockpitCard[]>;
  blocked_cards: Panel<CockpitCard[]>;
  approvals: Panel<CockpitApproval[]>;
  current_execution: Panel<CurrentExecution | null>;
  timeline_events: Panel<TimelineEvent[]>;
  flows: Panel<CockpitFlows>;
  asset_usage: Panel<AssetUsage>;
  goal: Panel<CockpitGoal>;
  artifacts: Panel<CockpitArtifact[]>;
  reports: Panel<CockpitReport[]>;
  /** fr's own stored reports (`project_reports`), newest first. */
  stored_reports: Panel<import('$lib/api/reports').ProjectReport[]>;
  cost: Panel<ProjectCost>;
  project_costs: Panel<CockpitProjectCosts>;
  deliverables: Panel<ApprovedScope>;
  repositories: Panel<CockpitRepositorySet>;
  capabilities: Panel<import('$lib/api/project-capabilities').ProjectCapabilities>;
  conveyor_history: Panel<CockpitConveyorHistory>;
  /** C3 phase spine (absent on an older backend). */
  spine?: Panel<CockpitSpine>;
  /** C8 decision log (absent on an older backend). */
  decisions?: Panel<CockpitDecision[]>;
  /** R2 overview: the project as a chain of phases (absent on an older backend). */
  overview?: Panel<ProjectOverview>;
  /** R5 board (C4): columns, time in column, blocked reasons, exact phase (absent on an older backend). */
  board?: Panel<ProjectBoard>;
}

// ── R5 board (backend services/cockpit/board.ts) ────────────────────────────

export type BoardBlockKind = 'lane' | 'label' | 'flow_failed';

export interface BoardColumn {
  id: string;
  name: string;
  kind: Phase;
}

export interface BoardCard {
  id: string;
  name: string;
  list_id: string;
  list_name: string | null;
  kind: Phase;
  in_column_since: string | null;
  in_column_basis: 'moved' | 'created' | null;
  /** Exact phase: the card's `phase` field, or Closure for a `project_closure` card; null = not tied to a phase. */
  phase: string | null;
  placed_by: 'card_phase' | 'card_type' | null;
  card_type: string | null;
  blocked: boolean;
  block_kind: BoardBlockKind | null;
  block_reason: string | null;
  waiting_on: { approval_id: string; description: string; created_at: string | null } | null;
  comment_count: number | null;
  done: boolean;
  position: number | null;
}

export interface ProjectBoard {
  board_id: string | null;
  columns: BoardColumn[];
  cards: BoardCard[];
  unplaced: number;
}

// ── R2 overview (backend services/cockpit/overview.ts) ──────────────────────

export type OverviewOutputStatus = 'published' | 'draft' | 'in_review' | 'open' | 'merged' | 'closed' | null;

export interface OverviewOutput {
  id: string;
  kind: 'document' | 'pull_request';
  title: string;
  type_label: string | null;
  status: OverviewOutputStatus;
  summary: string | null;
  at: string | null;
  card_id: string | null;
  card_name: string | null;
  phase: string | null;
  is_final: boolean;
  url: string | null;
}

export interface OverviewCost {
  cost: number | null;
  calls: number;
}

export interface OverviewPhase {
  name: string;
  label: string;
  position: number;
  state: SpinePhaseState;
  entered_at: string | null;
  left_at: string | null;
  duration_ms: number | null;
  cards: {
    total: number;
    by_state: Record<SpineCardState, number>;
    items: { id: string; name: string; state: SpineCardState }[];
  };
  outputs: OverviewOutput[];
  delivered: OverviewOutput[];
  decisions: number;
  open_asks: number;
  cost: OverviewCost | null;
  signoff: { at: string | null; by_kind: DecidedByKind | null; by_name: string | null; subject: string | null } | null;
}

export interface OverviewProblem {
  code: 'flow_failures' | 'blocked_card';
  message: string;
  href: string;
}

export interface ProjectOverview {
  phases: OverviewPhase[];
  current_phase: string | null;
  current_position: number | null;
  phase_count: number;
  unassigned: { cards: number; outputs: OverviewOutput[]; decisions: number; cost: OverviewCost | null };
  outputs: OverviewOutput[];
  outcome: {
    state: 'completed' | 'cancelled';
    final_report: OverviewOutput | null;
    summary: string | null;
    pull_requests: OverviewOutput[];
  } | null;
  problems: OverviewProblem[];
  cost_by_card_since: string | null;
  currency: string | null;
}

// ── GET /api/projects/:id/registers (RM #240 proxy) ─────────────────────────

export interface RegisterRisk {
  id: string;
  title: string;
  score: number;
  status: string;
  owner: string | null;
  response_plan: string | null;
  phase: string | null;
  // REG-1 fields the Registers page reads (RM `RegisterRisk`); optional so a partial row still renders.
  category?: string | null;
  probability?: number | null;
  impact?: number | null;
  card_id?: string | null;
  raised_at?: string | null;
}
export interface RegisterDecision {
  id: string;
  title: string;
  decision: string;
  decided_by_kind: string | null;
  decided_at: string | null;
  phase: string | null;
  context?: string | null;
  alternatives_count?: number | null;
  card_id?: string | null;
  raised_at?: string | null;
}
/** One piece of evidence for a criterion's check (RM `CriterionEvidence`). */
export interface RegisterCriterionEvidence {
  kind?: string | null;
  ref?: string | null;
}
export interface RegisterCriterion {
  kind: 'success' | 'acceptance';
  id: string | null;
  text: string;
  /** met | not_met | unchecked; null for a success criterion (no check). */
  status: string | null;
  evidence?: RegisterCriterionEvidence[] | null;
  checked_at?: string | null;
}
export type ProjectRegisters =
  | { available: false; project_id: string; reason: string }
  | {
      available: true;
      project_id: string;
      rm_project_id: string;
      phase: string | null;
      risks: RegisterRisk[];
      decisions: RegisterDecision[];
      requirements: { id: string; title: string }[];
      criteria: RegisterCriterion[];
      counts: { risks_open: number; risks_total: number; decisions: number; requirements: number; criteria_met: number; criteria_total: number };
    };

// ── C3 phase spine / C8 decision log (backend services/cockpit/spine.ts) ────

export type DecidedByKind = 'human' | 'triage_agent' | 'rule' | 'agent';
export type SpinePhaseState = 'done' | 'active' | 'upcoming' | 'not_run';
export type SpineCardState = 'todo' | 'doing' | 'qa' | 'done' | 'blocked';

export interface SpinePhase {
  name: string;
  label: string;
  state: SpinePhaseState;
  entered_at: string | null;
  left_at: string | null;
  duration_ms: number | null;
  human_wait_ms: number;
  machine_ms: number;
  card_ids: string[];
  has_gate: boolean;
}

export interface SpineGate {
  phase: string;
  state: 'passed' | 'waiting' | 'ahead';
  at: string | null;
  approval_id: string | null;
  signed_at: string | null;
  signed_by_kind: DecidedByKind | null;
  signed_by_name: string | null;
  subject: string | null;
}

export interface SpineCard {
  id: string;
  name: string;
  state: SpineCardState;
  phase: string | null;
  /** Exact only: the card's own `phase` field, or card type `project_closure` (Closure). */
  placed_by: 'card_phase' | 'card_type' | null;
}

export interface CockpitSpine {
  phases: SpinePhase[];
  gates: SpineGate[];
  cards: SpineCard[];
  totals: { duration_ms: number; human_wait_ms: number; machine_ms: number };
  closed: boolean;
  measured_at: string;
}

export interface CockpitDecision {
  approval_id: string;
  kind: 'question' | 'signoff' | 'request';
  /** One plain sentence naming the gate or card and the kind of ask. */
  subject: string;
  question: string;
  question_full: string;
  answer: string | null;
  answer_full: string | null;
  decision: string | null;
  actor_kind: DecidedByKind | null;
  actor_name: string | null;
  asked_at: string | null;
  decided_at: string | null;
  card_id: string | null;
  card_name: string | null;
  phase: string | null;
  open: boolean;
}
