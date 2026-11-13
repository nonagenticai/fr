// Mirrors backend `GET /api/projects/:id/plan` (backend/src/routes/project-plan.ts,
// facts from backend/src/lib/plan-phase-exit.ts `evaluatePlanPhases`) and the
// outline list's server-built `plan_view` (proposed mode, fr#1484).
//
// ⛔ THESE ARE SERVER FACTS. Nothing in the frontend derives a phase list, a gate,
// a completion or a card count from the spine or from card types — a client-side
// projection is banned (CONVEYOR-TAXONOMY D8).
// A component renders these values or says it has none.

import type { ProjectPhaseName } from './cockpit';

export interface PlanGateFact {
  kinds: string[];
  satisfied: boolean;
  approval_ids: string[];
  unknown_kinds: string[];
}

export interface PlanDeliverableFact {
  plan_deliverable_id: string;
  phase: ProjectPhaseName;
  card_types: string[];
  cardinality: string;
  minter: string;
  deliverable_id: string | null;
  title: string | null;
  deferred: boolean | null;
  minted_at: string | null;
  minted_count: number | null;
  cards: { total: number; done: number; by_list: Record<string, number> };
  complete: boolean;
  incomplete_reason: string | null;
}

export interface PlanPhaseFact {
  phase: ProjectPhaseName;
  label: string;
  index: number;
  state: 'done' | 'active' | 'upcoming';
  gate: PlanGateFact | null;
  deliverables: PlanDeliverableFact[];
  exit_ready: boolean;
  blockers: string[];
  next_phase: ProjectPhaseName | null;
}

export interface PlanFacts {
  size_class: unknown;
  repo_count: unknown;
  risk_flags: unknown;
  optional_phases: unknown;
}

export interface ProjectPlanLive {
  project_id: string;
  legacy: false;
  kind?: undefined;
  template: { id: string; hash: string };
  outline_id: string;
  phase_plan_hash: string;
  current_phase: string;
  phase_updated_at: string | null;
  phases: PlanPhaseFact[];
  facts: PlanFacts;
}

export interface ProjectPlanLegacy {
  project_id: string;
  legacy: true;
  kind?: undefined;
  reason: string;
}

export type ProjectPlanResponse = ProjectPlanLive | ProjectPlanLegacy | ConveyorPlan;

/** One proposed phase (server-built from the outline's stored phase_plan). */
export interface ProposedPlanPhase {
  phase: ProjectPhaseName;
  label: string;
  gate_kinds: string[];
  deliverables: Array<{
    plan_deliverable_id: string;
    card_types: string[];
    cardinality: string;
    minter: string;
    /** Cards THIS deliverable mints at approval (PSD AT6): n for fixed:n in phases[0], else 0. */
    cards_at_commit: number;
  }>;
}

/** `plan_view` on an outline list item that carries a phase_plan (fr#1484). */
export interface ProposedPlanView {
  template: { id: string; hash: string };
  phase_plan_hash: string;
  phases: ProposedPlanPhase[];
  /** PSD AT6: cards minted at commit = Σ n over phases[0]'s fixed:n deliverables. null = the plan lists no deliverables (not zero). */
  card_count_at_commit: number | null;
  /** Number of template deliverables (= project_deliverables rows at approval); null as above. */
  deliverable_count: number | null;
  /** S4 computed plan-check results. null = no check has run yet ("checks pending"). */
  checks: null | Array<{ code: string; passed: boolean }>;
}

// ── the CONVEYOR (v4) plan — GET /api/projects/:id/plan for an RM-linked project
// with no template (backend/src/services/conveyor-plan.ts). Server facts from
// RM + the Planka board; a source that could not be read is
// `{available:false, reason}`, never an empty list.

export type ConveyorSection<T> = ({ available: true } & T) | { available: false; reason: string };

export type ConveyorPhaseState = 'done' | 'active' | 'upcoming' | 'not_run';

export interface ConveyorPlanCard {
  id: string;
  name: string;
  card_type: string | null;
  card_type_title: string | null;
  list: string | null;
  last_moved_at: string | null;
  placed_by: 'card_phase' | 'card_type' | null;
}

export interface ConveyorPlanPhase {
  name: string;
  title: string;
  position: number;
  has_gate: boolean;
  entered_at: string | null;
  left_at: string | null;
  state: ConveyorPhaseState;
  cards: ConveyorPlanCard[];
}

export interface ConveyorPlanCapability {
  name: string;
  title: string | null;
  involvement: string | null;
  rigor: string | null;
  complexity: string | null;
  purpose: string | null;
  reason: string | null;
  order_after: string[];
  selected_at: string | null;
}

export interface ConveyorPlanRisk {
  id: string;
  title: string;
  description: string | null;
  status: string | null;
  category: string | null;
  probability: number | null;
  impact_score: number | null;
  risk_score: number | null;
  response_strategy: string | null;
  response_plan: string | null;
}

export interface ConveyorPlanAvailable {
  project_id: string;
  legacy: false;
  kind: 'conveyor';
  available: true;
  project_type: { id: string | null; name: string | null };
  status: string | null;
  closed: boolean;
  current_phase: string | null;
  phase_updated_at: string | null;
  phases: ConveyorSection<{ items: ConveyorPlanPhase[] }>;
  phase_history: ConveyorSection<Record<never, never>>;
  cards: ConveyorSection<{ unplaced: ConveyorPlanCard[] }>;
  capabilities: ConveyorSection<{ selected: ConveyorPlanCapability[] }>;
  risks: ConveyorSection<{ items: ConveyorPlanRisk[] }>;
}

export interface ConveyorPlanUnavailable {
  project_id: string;
  legacy: false;
  kind: 'conveyor';
  available: false;
  reason: string;
}

export type ConveyorPlan = ConveyorPlanAvailable | ConveyorPlanUnavailable;
