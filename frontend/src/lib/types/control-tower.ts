// control-tower.ts (types)
// =========================
// Frontend mirror of the super-admin CONTROL TOWER read model
// (backend/src/services/control-tower/index.ts `ControlTower`). ONE flat
// endpoint — GET /api/admin/control-tower — returns all 9
// blocks; there is NO drilldown / ?param selection (the inspector hydrates from
// the already-fetched blocks). Keep every interface in lock-step with the
// backend. Data-gaps are honest-by-construction: `kag_lag_available:false`,
//, `available:false` meters, `confidence:'derived'`.

import type { Block } from './read-model';

// --- fleet -----------------------------------------------------------------
export interface FleetKpis {
  tenants: number;
  active_executions: number;
  /** true ⇒ the n8n running count hit the single-page cap (report "N+"). */
  active_executions_capped: boolean;
  gate_waiting: number;
  open_approvals: number;
  overdue_callbacks: number;
  /**
   * KAG worst-case backlog age in SECONDS (max oldest-pending age across
   * pipeline stages), from kag_orchestrator /health/lag. Backlog-age PROXY, NOT
   * a true p95. Null when unset/unreachable or the pipeline is idle.
   */
  kag_lag_p95: number | null;
  kag_lag_available: boolean;
  /**
   * True DONE→searchable completion-latency p95 in SECONDS from kag_orchestrator
   * GET /health/kag-latency. Null when unreachable/unset OR sample_count===0
   * (no completed items in window — never fabricated). Rendered as a seconds
   * tile in the Fleet band, NOT in a 0..1 telemetry meter.
   */
  kag_completion_p95_seconds: number | null;
  kag_completion_p95_available: boolean;
}

// --- tenants ---------------------------------------------------------------
export type TenantKind =
  | 'system'
  | 'execution'
  | 'other';

export interface TenantHealthRow {
  tenant_id: string;
  name: string;
  kind: TenantKind;
  is_system: boolean;
  board_id: string | null;
  /** false ⇒ the tenant's board was unreachable (wip/blocked fall back to 0). */
  board_available: boolean;
  wip: number;
  blocked: number;
  andon_engaged: boolean;
  archived: boolean;
}

// --- active_executions -----------------------------------------------------
/**
 * Why a row's `correlation_id` is what it is. Mirrors `CorrelationState` in
 * `backend/src/services/control-tower/index.ts`.
 *  - 'present'          — an id was resolved
 *  - 'not_fr_initiated' — an n8n schedule/webhook started the run, so no fr
 *                         correlation id EXISTS. A fact, not a gap.
 *  - 'unavailable'      — the mapping lookup failed; unknown, not absent.
 */
export type CorrelationState = 'present' | 'not_fr_initiated' | 'unavailable';

export interface ActiveExecutionRow {
  execution_id: string;
  source: 'n8n' | 'worker-management';
  mode: string | null;
  status: string;
  correlation_id: string | null;
  /**
   * OPTIONAL here while the backend half of this fix lands, so the two can ship
   * independently; the backend types it as REQUIRED and always sends it, which
   * an optional field accepts. Tighten to required once both are on main.
   * Rendering tolerance lives in `correlationLabel()` in the control-tower
   * `logic.ts`, not in each call site.
   */
  correlation_state?: CorrelationState;
  started_at: string | null;
}

export interface ActiveExecutions {
  rows: ActiveExecutionRow[];
  gate_waiting: number;
  n8n_available: boolean;
  worker_management_available: boolean;
}

// --- observability meters -------------------------------------------------
export type MeterStatus = 'ok' | 'warn' | 'danger' | 'unknown';

export interface Meter {
  key: string;
  label: string;
  /** 0..1 ratio, or null when the source was unavailable / has no denominator. */
  value: number | null;
  status: MeterStatus;
  detail: string;
  available: boolean;
}

// --- n8n_workflows: the live n8n workflow list (mirror backend) ------------
export interface LiveWorkflowRow {
  id: string;
  name: string;
  active: boolean;
  /** n8n `updatedAt` (ISO); null when n8n did not report one. */
  updated_at: string | null;
  tags: string[];
}

export interface LiveWorkflows {
  total: number;
  active: number;
  inactive: number;
  /** Sorted active first, then by name. */
  rows: LiveWorkflowRow[];
  fetched_at: string;
  /** true ⇒ the catalogue is past its freshness window (still served). */
  degraded: boolean;
}

// --- approvals -------------------------------------------------------------
export interface ApprovalsRollup {
  open: number;
  overdue: number;
  by_tenant: { tenant_id: string; name: string; open: number; overdue: number }[];
  by_kind: { kind: string; open: number }[];
}

// --- andon -----------------------------------------------------------------
export interface AndonSnapshot {
  global_engaged: boolean;
  engaged_at: string | null;
  engaged_by: string | null;
  /**
   * `andon_state.worker_replicas` — the cord's actuator reading. `0` = every
   * automatic n8n execution is stopped, `1` = the worker is running, `null` =
   * NOT MEASURED. ⛔ Never render `null` as 0 or as "running": those are the two
   * measurements it is not.
   */
  worker_replicas: number | null;
  project_stops: number;
  stream_stops: number;
}

// --- alerts ----------------------------------------------------------------
export type ControlAlertSeverity = 'ok' | 'warn' | 'danger';

export interface ControlAlert {
  key: string;
  severity: ControlAlertSeverity;
  title: string;
  detail: string;
  /** Deep-link hint: `block:<name>` / `card:<id>` / null (same convention as the lenses). */
  link: string | null;
}

// --- the envelope ----------------------------------------------------------
export interface ControlTower {
  fleet: Block<FleetKpis>;
  tenants: Block<TenantHealthRow[]>;
  active_executions: Block<ActiveExecutions>;
  n8n_workflows: Block<LiveWorkflows>;
  observability: Block<Meter[]>;
  approvals: Block<ApprovalsRollup>;
  andon: Block<AndonSnapshot>;
  alerts: Block<ControlAlert[]>;
}

/** The two inspector selection kinds this surface opens. */
export type InspectKind = 'tenant' | 'alert';
