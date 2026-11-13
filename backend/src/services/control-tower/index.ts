// src/services/control-tower/index.ts
//
// Super-admin control-tower read-model aggregator.
// Endpoint: GET /api/admin/control-tower (AA cockpit B5 — the LAST cockpit).
// Design contract: docs/cockpit-super-admin-control-tower-proposal.html (10
// response blocks named in the proposal's data-seam comment, lines 53-59):
//   fleet, tenants, active_executions, n8n_workflows, observability,
//   approvals, andon, alerts. (The improvement_lanes block went
//   with the v3 improvement loop; the kata replaced it.)
//
// This is the fleet lens: it composes fleet-wide fr-DB reads (approvals,
// andon, tenant/workspace health) and read-only upstream probes (n8n, worker-
// management, kag). Every block is wrapped so one dead upstream degrades
// to available:false instead of 500ing the whole tower — "everything down" is
// still a 200 with each block honestly marked unavailable.
//
// Honest-by-construction (read-model kit Block envelope): joined/inferred data
// is confidence:'derived'; and the genuine data-gaps (KAG compression lag p95 — not exposed)
// ship available:false with an
// explicit reason instead of a fabricated number.

import { block, availableBlock, unavailableBlock, type Block } from '../read-models/_lib';
import { isIntegrationError, reportSwallowedFailure } from '../../integrations/_lib/errors';
import { db } from '../../db/client';
import {
  approvals,
  andonState,
  n8nExecutionMapping,
  projects,
  streams,
  workspaces,
} from '../../db/schema';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
  PLATFORM_TENANT_IDS,
} from '../../middleware/internal-tenant-only';
import { CANONICAL_TENANTS } from '../../routes/tenants';
import { plankaClient } from '../../services/planka';
import type { BoardDetail } from '../../services/planka/types';
import { listExecutions, N8N_MAX_PAGE_SIZE } from '../../integrations/n8n';
import type { Execution, ExecutionList, GetExecutionsParams } from '../../integrations/n8n';
import { listGraphExecutionSessions } from '../../integrations/workers';
import type { GraphExecutionSession } from '../../integrations/workers';
import { getKagLag, getKagLatency } from '../../integrations/kag-orchestrator';
import type { KagLagStatus, KagLatencyStatus } from '../../integrations/kag-orchestrator';
import { readWorkflowsCatalogue } from '../../routes/workflows';

// ---------------------------------------------------------------------------
// Dependencies (DB reads go through `db` directly).
// ---------------------------------------------------------------------------

interface ControlTowerDeps {
  getBoardDetail: (boardId: string) => Promise<BoardDetail>;
  /**
   * ⚠️ Must be called WITH a `status` — the control tower's definition of
   * "active" is `status ∈ {running, waiting}` and n8n filters server-side. A
   * status-less call returns the newest N executions of ANY status, which is how
   * the panel used to render 25 `success` rows under the heading "Active
   * executions" (and why the band, fed from a SECOND running-only fetch,
   * disagreed with it). n8n's `status` param is a SCALAR enum
   * (`GetExecutionsStatus`, @fr/service-client-n8n) — one status per call — so
   * the loader issues TWO filtered calls, never one mixed page filtered
   * client-side.
   *
   * Returns the full `ExecutionList` (incl. `nextCursor`) so the caller can tell
   * a full page from a full page WITH MORE BEHIND IT and report "250+" rather
   * than a precise-looking lie.
   */
  listExecutions: (params?: GetExecutionsParams) => Promise<ExecutionList>;
  /**
   * The live n8n workflow catalogue (`routes/workflows.ts`
   * `readWorkflowsCatalogue`): the background crawl that follows n8n's cursor
   * to the END. A cold/too-stale catalogue THROWS, so the block degrades to
   * unavailable instead of rendering an empty list.
   */
  readWorkflowsCatalogue: () => {
    rows: { id: string; name: string; active: boolean; tags: string[]; updatedAt: string }[];
    degraded: boolean;
    fetchedAt: number;
  };
  listGraphExecutionSessions: (
    filters: { limit?: number },
  ) => Promise<{ sessions: GraphExecutionSession[]; appliedLimit: number; truncated: boolean }>;
  getKagLag: () => Promise<KagLagStatus>;
  getKagLatency: () => Promise<KagLatencyStatus>;
}

function defaultDeps(): ControlTowerDeps {
  return {
    getBoardDetail: (boardId) => plankaClient.asAgent().boards.get(boardId),
    listExecutions: (params) => listExecutions(params),
    readWorkflowsCatalogue: () => readWorkflowsCatalogue(),
    listGraphExecutionSessions: (filters) => listGraphExecutionSessions(filters),
    getKagLag: () => getKagLag(),
    getKagLatency: () => getKagLatency(),
  };
}

const deps: ControlTowerDeps = defaultDeps();

// ---------------------------------------------------------------------------
// Payload types (mirrored block-by-block on the frontend in Session 11)
// ---------------------------------------------------------------------------

export interface FleetKpis {
  tenants: number;
  /**
   * In-flight executions across BOTH sources — n8n `status ∈ {running,waiting}`
   * plus worker-management sessions with `completed_at == null`.
   *
   * ⚠️ This is `active_executions.rows.length` BY CONSTRUCTION: band and panel
   * are folded from the SAME fetch. They used to be two fetches with two
   * different definitions of "active" (the panel took the newest 25 of ANY
   * status, the band a running-only count), so the page routinely showed
   * "0 active" above a list of 25 rows. Never reintroduce a second fetch here.
   */
  active_executions: number;
  /** true ⇒ a source hit its page ceiling with more behind it (report "N+"). */
  active_executions_capped: boolean;
  gate_waiting: number;
  open_approvals: number;
  overdue_callbacks: number;
  /**
   * KAG worst-case backlog age in SECONDS (max oldest-pending age across
   * pipeline stages), from kag_orchestrator GET /health/lag. This is a
   * backlog-age PROXY, NOT a true DONE→searchable p95 (the orchestrator retains
   * no completed-item durations). Null when the orchestrator is unset/unreachable
   * or the pipeline is idle.
   */
  kag_lag_p95: number | null;
  kag_lag_available: boolean;
  /** True DONE->searchable completion-latency p95 in SECONDS from kag_orchestrator
   *  GET /health/kag-latency. Null when unreachable/unset OR sample_count===0
   *  (no completed items in window => p95 undefined, never fabricated). */
  kag_completion_p95_seconds: number | null;
  kag_completion_p95_available: boolean;
}

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

/**
 * Why a row's `correlation_id` is null. "We could not look it up" and "this run
 * was never fr-initiated, so no correlation id exists" are DIFFERENT facts, and
 * collapsing both into a blank cell is what made the column read as
 * structurally, permanently broken:
 *  - 'present'          — a correlation id was resolved (`correlation_id` set)
 *  - 'not_fr_initiated' — no fr mapping row (an n8n schedule or webhook started
 *                         it); the run genuinely has no correlation id
 *  - 'unavailable'      — the mapping lookup itself failed; unknown, not absent
 */
export type CorrelationState = 'present' | 'not_fr_initiated' | 'unavailable';

export interface ActiveExecutionRow {
  execution_id: string;
  source: 'n8n' | 'worker-management';
  mode: string | null;
  status: string;
  correlation_id: string | null;
  correlation_state: CorrelationState;
  started_at: string | null;
}

export interface ActiveExecutions {
  rows: ActiveExecutionRow[];
  gate_waiting: number;
  n8n_available: boolean;
  worker_management_available: boolean;
  /**
   * true ⇒ at least one source hit its page ceiling with more behind it, so
   * `rows` (and therefore the fleet band's `active_executions`) is a FLOOR.
   * Render "N+".
   */
  capped: boolean;
}

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

// --- n8n_workflows: the live n8n workflow list ------------------------------
//
// Straight from the live n8n catalogue — no registry, no cells, no drift.

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
  /** When the crawl that produced these rows finished (ISO). */
  fetched_at: string;
  /** true ⇒ the catalogue is past its freshness window (still served). */
  degraded: boolean;
}

export interface ApprovalsRollup {
  open: number;
  overdue: number;
  by_tenant: { tenant_id: string; name: string; open: number; overdue: number }[];
  by_kind: { kind: string; open: number }[];
}

export interface AndonSnapshot {
  global_engaged: boolean;
  engaged_at: string | null;
  engaged_by: string | null;
  /**
   * `andon_state.worker_replicas` — the cord's actuator reading. `0` = every
   * automatic n8n execution is stopped, `1` = the line is running, `null` = fr
   * could not measure (never render that as either number).
   */
  worker_replicas: number | null;
  project_stops: number;
  stream_stops: number;
}

export interface ControlAlert {
  key: string;
  severity: 'ok' | 'warn' | 'danger';
  title: string;
  detail: string;
  link: string | null;
}

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

// ---------------------------------------------------------------------------
// Pure helpers + folds (unit-tested directly)
// ---------------------------------------------------------------------------

function toIso(v: Date | string | null | undefined): string | null {
  if (v == null) return null;
  return v instanceof Date ? v.toISOString() : v;
}

function tenantKind(id: string): TenantKind {
  if (id === INTERNAL_SYSTEM_TENANT_ID) return 'system';
  if (id === EXECUTION_TENANT_ID) return 'execution';
  return 'other';
}

function meter(key: string, label: string, value: number | null, detail: string): Meter {
  return { key, label, value, status: thresholdStatus(value, 0.95, 0.85), detail, available: true };
}

/** A meter with an explicit ok/warn threshold pair. */
function meterAt(key: string, label: string, value: number | null, okAt: number, warnAt: number, detail: string): Meter {
  return { key, label, value, status: thresholdStatus(value, okAt, warnAt), detail, available: true };
}

function unavailableMeter(key: string, label: string, reason: string): Meter {
  return { key, label, value: null, status: 'unknown', detail: reason, available: false };
}

function thresholdStatus(value: number | null, okAt: number, warnAt: number): MeterStatus {
  if (value == null) return 'unknown';
  if (value >= okAt) return 'ok';
  if (value >= warnAt) return 'warn';
  return 'danger';
}

/** Project the live n8n catalogue into the `n8n_workflows` block. Pure. */
export function composeLiveWorkflows(input: {
  rows: readonly { id: string; name: string; active: boolean; tags: readonly string[]; updatedAt: string }[];
  fetchedAt: number;
  degraded: boolean;
}): LiveWorkflows {
  const rows: LiveWorkflowRow[] = input.rows
    .map((w) => ({
      id: w.id,
      name: w.name,
      active: w.active,
      updated_at: w.updatedAt || null,
      tags: [...w.tags],
    }))
    .sort((a, b) => Number(b.active) - Number(a.active) || a.name.localeCompare(b.name));
  const active = rows.filter((r) => r.active).length;
  return {
    total: rows.length,
    active,
    inactive: rows.length - active,
    rows,
    fetched_at: new Date(input.fetchedAt).toISOString(),
    degraded: input.degraded,
  };
}

/** Fold the fleet KPI band. Pure over already-resolved block data. */
export function deriveFleetKpis(input: {
  tenantCount: number;
  /**
   * In-flight count + cap flag. ⚠️ MUST be folded from the SAME
   * `active_executions` block the panel renders (`{count: rows.length, capped}`)
   * — never from a separate upstream count, which is how the band and the panel
   * came to disagree. null ⇒ that block was unavailable.
   */
  running: { count: number; capped: boolean } | null;
  gateWaiting: number;
  openApprovals: number;
  overdueApprovals: number;
  kagLag: KagLagStatus | null;
  kagLatency: KagLatencyStatus | null;
}): FleetKpis {
  return {
    tenants: input.tenantCount,
    active_executions: input.running?.count ?? 0,
    active_executions_capped: input.running?.capped ?? false,
    gate_waiting: input.gateWaiting,
    open_approvals: input.openApprovals,
    overdue_callbacks: input.overdueApprovals,
    // Worst-case backlog age across stages; null-when-idle stays null (not 0).
    kag_lag_p95: input.kagLag?.max_oldest_age_seconds ?? null,
    // available reflects reachability, not backlog presence — an idle-but-reachable
    // orchestrator is available with a null age.
    kag_lag_available: input.kagLag !== null,
    // True DONE→searchable p95 (seconds). Null when unreachable OR the window had
    // no completed items (sample_count===0) — never fabricate a p95 from 0 samples.
    kag_completion_p95_seconds:
      input.kagLatency && input.kagLatency.sample_count > 0 ? input.kagLatency.p95_seconds : null,
    kag_completion_p95_available: input.kagLatency !== null && input.kagLatency.sample_count > 0,
  };
}

/** Fold the fleet alert strip from the composed blocks — never hand-written. Pure. */
export function deriveAlerts(input: {
  callbackMeter: Meter | undefined;
  andon: AndonSnapshot | null;
}): ControlAlert[] {
  const alerts: ControlAlert[] = [];

  const cb = input.callbackMeter;
  if (cb && cb.available && cb.value != null && cb.value < 0.9) {
    alerts.push({
      key: 'callback_health',
      severity: 'danger',
      title: `approval callback health ${(cb.value * 100).toFixed(0)}%`,
      detail: cb.detail,
      link: 'block:observability',
    });
  }

  if (input.andon?.global_engaged) {
    alerts.push({
      key: 'andon',
      severity: 'danger',
      title: 'Global andon engaged',
      // `null` is NOT a replica count. Rendering it as "null replica(s)" was the
      // same class of defect the view's own doc warns about.
      detail:
        input.andon.worker_replicas === null
          ? 'n8n-worker state not measured'
          : `n8n-worker at ${input.andon.worker_replicas} replica(s)`,
      link: 'block:andon',
    });
  }

  if (alerts.length === 0) {
    alerts.push({ key: 'ok', severity: 'ok', title: 'No fleet alerts', detail: 'all checks nominal', link: null });
  }
  return alerts;
}

// ---------------------------------------------------------------------------
// Board card counting (WIP / blocked) — shared heuristic (mirrors the lens
// *CardStatus mappers, kept local so this module owns no lens internals).
// ---------------------------------------------------------------------------

function countBoard(board: BoardDetail): { wip: number; blocked: number } {
  const lists = board.included.lists ?? [];
  const listNameById = new Map(lists.map((l) => [l.id, (l.name ?? '').toUpperCase()]));
  const labelsById = new Map((board.included.labels ?? []).map((l) => [l.id, l.name ?? '']));
  const labelsByCard = new Map<string, string[]>();
  for (const cl of board.included.cardLabels ?? []) {
    const arr = labelsByCard.get(cl.cardId) ?? [];
    arr.push(labelsById.get(cl.labelId) ?? '');
    labelsByCard.set(cl.cardId, arr);
  }
  let wip = 0;
  let blocked = 0;
  for (const c of board.included.cards ?? []) {
    const listName = listNameById.get(c.listId) ?? '';
    const labels = labelsByCard.get(c.id) ?? [];
    const isBlocked = labels.some((l) => /block|hold|gate/i.test(l)) || listName.includes('BLOCK');
    if (isBlocked) {
      blocked += 1;
    } else if (listName.includes('DOING') || listName.includes('PROGRESS') || listName.includes('WIP')) {
      wip += 1;
    }
  }
  return { wip, blocked };
}

// ---------------------------------------------------------------------------
// DB loaders + upstream probes (direct; covered by the integration test)
// ---------------------------------------------------------------------------

async function loadTenantHealth(): Promise<TenantHealthRow[]> {
  const ids = CANONICAL_TENANTS.map((t) => t.id);
  const [wsRows, streamRows] = await Promise.all([
    db
      .select({ id: workspaces.id, name: workspaces.name, archived_at: workspaces.archived_at })
      .from(workspaces)
      .where(inArray(workspaces.id, ids)),
    db
      .select({ tenant_id: streams.tenant_id, board: streams.planka_board_id, andon: streams.andon_engaged })
      .from(streams)
      .where(inArray(streams.tenant_id, ids)),
  ]);
  const wsById = new Map(wsRows.map((w) => [w.id, w]));
  const boardByTenant = new Map<string, string>();
  const streamAndonByTenant = new Map<string, boolean>();
  for (const s of streamRows) {
    if (s.board && !boardByTenant.has(s.tenant_id)) boardByTenant.set(s.tenant_id, s.board);
    if (s.andon) streamAndonByTenant.set(s.tenant_id, true);
  }

  // Fetch each canonical tenant's board in parallel; a board failure degrades
  // that ONE row (board_available:false), never the whole block.
  const boardStats = await Promise.all(
    CANONICAL_TENANTS.map(async (t) => {
      const boardId = boardByTenant.get(t.id);
      if (!boardId) return { tenant: t.id, wip: 0, blocked: 0, available: false };
      try {
        const { wip, blocked } = countBoard(await deps.getBoardDetail(boardId));
        return { tenant: t.id, wip, blocked, available: true };
      } catch {
        return { tenant: t.id, wip: 0, blocked: 0, available: false };
      }
    }),
  );
  const statsByTenant = new Map(boardStats.map((b) => [b.tenant, b]));

  return CANONICAL_TENANTS.map((t) => {
    const ws = wsById.get(t.id);
    const stats = statsByTenant.get(t.id);
    return {
      tenant_id: t.id,
      name: ws?.name ?? t.name,
      kind: tenantKind(t.id),
      is_system: t.is_system,
      board_id: boardByTenant.get(t.id) ?? null,
      board_available: stats?.available ?? false,
      wip: stats?.wip ?? 0,
      blocked: stats?.blocked ?? 0,
      andon_engaged: streamAndonByTenant.get(t.id) ?? false,
      archived: !!ws?.archived_at,
    };
  });
}

/**
 * THE definition of "an execution is active", in one place.
 *
 * n8n's `ExecutionStatus` enum also carries `new`, `canceled`, `crashed`,
 * `error`, `success` and `unknown`. Only these two are in flight:
 *  - 'running' — executing now
 *  - 'waiting' — parked at a human/timer gate; still in flight, not finished.
 *    The band surfaces this subset separately as `gate_waiting`, so counting it
 *    here does not double-report it — it makes the two numbers consistent.
 *
 * ⚠️ `GetExecutionsStatus` (@fr/service-client-n8n, generated from n8n Public
 * API 1.1.1) is a SCALAR enum, and `getGetExecutionsUrl` serialises each param
 * with `value.toString()` — so passing an array would emit
 * `status=running,waiting`: ONE bogus value, not two filters. Hence one call per
 * status.
 */
const ACTIVE_N8N_STATUSES = ['running', 'waiting'] as const;

/**
 * ⚠️ Applied INSIDE {@link composeActiveExecutions} as well as in the fetch
 * params — deliberately belt-and-braces. If the predicate lived only in the
 * request, the pure fold would faithfully render whatever it was handed: a
 * future caller reintroducing an unfiltered fetch would reproduce the original
 * defect AND the unit test asserting "a page of successes yields zero active
 * rows" would still pass, because that test can only ever hand the composer
 * pre-filtered input. The definition has to be enforced where it is asserted.
 *
 * ⚠️ This used to say "n8n's `status` FILTER has no `new`/`crashed` values at all,
 * so a queued-but-unstarted execution is unreachable through this API either way".
 * FALSE on 2.46.1 (MEASURED 2026-11-01: `?status=new` → 200; the accepted enum is
 * canceled | crashed | error | new | running | success | unknown | waiting), so
 * `new` IS fetchable. Leaving it out here is therefore a DEFINITION, not a
 * limitation: a queued execution has not started, and this block reports work in
 * flight. Widen BOTH {@link ACTIVE_N8N_STATUSES} and the fetch params if that
 * definition ever changes.
 */
function isActiveN8nStatus(status: string | undefined): boolean {
  return (ACTIVE_N8N_STATUSES as readonly string[]).includes(status ?? '');
}

/**
 * Pure fold: raw upstream reads → the `active_executions` block. No I/O, so the
 * band-equals-panel invariant is unit-testable without a live n8n.
 *
 * `n8n` / `workerManagement` are null when that source was unreachable.
 * `correlationById` is null when the fr-DB mapping lookup itself failed (⇒ every
 * n8n row reports 'unavailable', NOT 'not_fr_initiated').
 */
export function composeActiveExecutions(input: {
  n8n: { executions: Execution[]; capped: boolean } | null;
  workerManagement: { sessions: GraphExecutionSession[]; truncated: boolean } | null;
  correlationById: Map<string, string> | null;
}): ActiveExecutions {
  const n8nRows: ActiveExecutionRow[] = (input.n8n?.executions ?? [])
    .filter((e) => isActiveN8nStatus(e.status))
    .map((e) => {
      const id = String(e.id ?? '');
      const corr = input.correlationById?.get(id) ?? null;
      return {
        execution_id: id,
        source: 'n8n' as const,
        mode: e.mode ?? null,
        status: e.status ?? 'unknown',
        correlation_id: corr,
        correlation_state: (input.correlationById === null
          ? 'unavailable'
          : corr !== null
            ? 'present'
            : 'not_fr_initiated') as CorrelationState,
        started_at: e.startedAt ?? null,
      };
    });

  // worker-management carries its correlation_id inline on the session — no join
  // to fail, so a WM row is never 'unavailable': the id either came back or the
  // session was not fr-initiated.
  const wmRows: ActiveExecutionRow[] = (input.workerManagement?.sessions ?? [])
    .filter((s) => s.completed_at == null)
    .map((s) => ({
      execution_id: s.session_id,
      source: 'worker-management' as const,
      mode: null,
      status: s.status,
      correlation_id: s.correlation_id,
      correlation_state: (s.correlation_id != null
        ? 'present'
        : 'not_fr_initiated') as CorrelationState,
      started_at: s.created_at,
    }));

  return {
    rows: [...n8nRows, ...wmRows],
    gate_waiting: n8nRows.filter((r) => r.status === 'waiting').length,
    n8n_available: input.n8n !== null,
    worker_management_available: input.workerManagement !== null,
    capped: (input.n8n?.capped ?? false) || (input.workerManagement?.truncated ?? false),
  };
}

/**
 * Resolve fr correlation ids for a batch of n8n execution ids from
 * `n8n_execution_mapping` (migration 015; `correlation_id` is NOT NULL, so a hit
 * always yields a real id). Returns null when the read FAILS — an absent row and
 * an unreadable table are different facts, and the row type keeps them apart.
 */
async function loadCorrelationIds(executionIds: string[]): Promise<Map<string, string> | null> {
  if (executionIds.length === 0) return new Map();
  try {
    const rows = await db
      .select({
        execution_id: n8nExecutionMapping.execution_id,
        correlation_id: n8nExecutionMapping.correlation_id,
      })
      .from(n8nExecutionMapping)
      .where(inArray(n8nExecutionMapping.execution_id, executionIds));
    return new Map(rows.map((r) => [r.execution_id, r.correlation_id]));
  } catch (err) {
    reportSwallowedFailure(err, {
      service: 'control-tower',
      degradedTo: "correlation_state='unavailable' (unknown, not absent)",
    });
    return null;
  }
}

/**
 * Why a worker-management read produced nothing. A `MISSING_TENANT` refusal
 * (WM#324, fr row 15: the WM client fails closed when no tenant resolves) is a
 * different state from an outage and is said so — "unreachable" would send an
 * operator to debug a healthy service.
 */
export function wmUnavailableReason(err: unknown): string {
  return isIntegrationError(err) && err.code === 'MISSING_TENANT'
    ? 'not called: no tenant resolved for this request'
    : 'unreachable';
}

async function loadActiveExecutions(): Promise<ActiveExecutions> {
  // ⛔ Do NOT collapse this to one unfiltered page plus a client-side filter. A
  // page of 25 `success` rows would hide every running execution behind it — the
  // same wrong-number defect in a different hat. n8n filters server-side; ask it
  // once per active status, at the API's max page size.
  let n8n: { executions: Execution[]; capped: boolean } | null = null;
  try {
    const pages = await Promise.all(
      ACTIVE_N8N_STATUSES.map((status) => deps.listExecutions({ status, limit: N8N_MAX_PAGE_SIZE })),
    );
    n8n = {
      executions: pages.flatMap((p) => p.data ?? []),
      // A page is a FLOOR only when it came back full *and* upstream still has a
      // cursor. A full page with a cleared cursor is an exact count.
      capped: pages.some((p) => (p.data ?? []).length >= N8N_MAX_PAGE_SIZE && !!p.nextCursor),
    };
  } catch {
    n8n = null;
  }

  let workerManagement: { sessions: GraphExecutionSession[]; truncated: boolean } | null = null;
  let wmReason = 'unreachable';
  try {
    const wm = await deps.listGraphExecutionSessions({ limit: 25 });
    workerManagement = { sessions: wm.sessions, truncated: wm.truncated };
  } catch (err) {
    workerManagement = null;
    wmReason = wmUnavailableReason(err);
  }

  if (n8n === null && workerManagement === null) {
    throw new Error(`n8n unreachable; worker-management ${wmReason}`);
  }

  const correlationById =
    n8n === null
      ? new Map<string, string>()
      : await loadCorrelationIds(
          n8n.executions.map((e) => String(e.id ?? '')).filter((id) => id.length > 0),
        );

  return composeActiveExecutions({ n8n, workerManagement, correlationById });
}

/**
 * fr row 14d: the control tower is a super-admin surface, and no super-admin
 * path reads a CUSTOMER tenant's approvals. Both approvals reads below are
 * confined to the PLATFORM tenants — the same set the approvals hint, void and
 * stranded lanes use. Customer approvals are read only from inside that
 * customer's own workspace.
 */
const PLATFORM_APPROVAL_TENANTS = [...PLATFORM_TENANT_IDS];

async function loadApprovalsRollup(): Promise<ApprovalsRollup> {
  const rows = await db
    .select({
      tenant_id: approvals.tenant_id,
      kind: approvals.kind,
      expires_at: approvals.expires_at,
    })
    .from(approvals)
    .where(and(eq(approvals.status, 'pending'), inArray(approvals.tenant_id, PLATFORM_APPROVAL_TENANTS)));

  const now = Date.now();
  let open = 0;
  let overdue = 0;
  const byTenant = new Map<string, { open: number; overdue: number }>();
  const byKind = new Map<string, number>();
  for (const r of rows) {
    open += 1;
    const isOverdue = r.expires_at != null && new Date(r.expires_at).getTime() < now;
    if (isOverdue) overdue += 1;
    const t = byTenant.get(r.tenant_id) ?? { open: 0, overdue: 0 };
    t.open += 1;
    if (isOverdue) t.overdue += 1;
    byTenant.set(r.tenant_id, t);
    byKind.set(r.kind, (byKind.get(r.kind) ?? 0) + 1);
  }
  const nameById = new Map(CANONICAL_TENANTS.map((t) => [t.id, t.name]));
  return {
    open,
    overdue,
    by_tenant: [...byTenant.entries()]
      .map(([tenant_id, v]) => ({ tenant_id, name: nameById.get(tenant_id) ?? tenant_id, open: v.open, overdue: v.overdue }))
      .sort((a, b) => b.open - a.open),
    by_kind: [...byKind.entries()].map(([kind, o]) => ({ kind, open: o })).sort((a, b) => b.open - a.open),
  };
}

/** Approval callback health: share of callback-bearing approvals that reached a terminal outcome. */
async function loadCallbackHealth(): Promise<number | null> {
  const rows = await db
    .select({ status: approvals.status, completed_at: approvals.completed_at })
    .from(approvals)
    .where(
      and(
        sql`${approvals.callback_path} IS NOT NULL AND ${approvals.callback_path} <> ''`,
        inArray(approvals.tenant_id, PLATFORM_APPROVAL_TENANTS),
      ),
    );
  const total = rows.length;
  if (total === 0) return null;
  const healthy = rows.filter((r) => r.status !== 'pending' || r.completed_at != null).length;
  return healthy / total;
}

async function loadAndon(): Promise<AndonSnapshot> {
  const [stateRows, projStops, streamStops] = await Promise.all([
    db.select().from(andonState).where(eq(andonState.id, 1)),
    db.select({ n: sql<number>`count(*)::int` }).from(projects).where(eq(projects.andon_engaged, true)),
    db.select({ n: sql<number>`count(*)::int` }).from(streams).where(eq(streams.andon_engaged, true)),
  ]);
  const s = stateRows[0];
  return {
    global_engaged: s?.engaged ?? false,
    engaged_at: toIso(s?.engaged_at ?? null),
    engaged_by: s?.engaged_by ?? null,
    worker_replicas: s?.worker_replicas ?? null,
    project_stops: projStops[0]?.n ?? 0,
    stream_stops: streamStops[0]?.n ?? 0,
  };
}

/** Page size the correlation-coverage meter reads; a full page means the ratio is a sample. */
const CORRELATION_SAMPLE_LIMIT = 200;

async function buildObservabilityMeters(): Promise<Meter[]> {
  const meters: Meter[] = [];

  // Meter 1: correlation coverage % (WM sessions carrying a correlation id).
  // worker-management's GET /execution/sessions/list is `response_model=list[dict]`
  // — a BARE ARRAY with no total (see integrations/workers.ts) — so a fleet-wide
  // denominator is NOT obtainable here. Do not "fix" this into a true ratio; the
  // only honest option is to disclose when the page came back full, i.e. when the
  // ratio is over a sample rather than the whole set.
  try {
    const wm = await deps.listGraphExecutionSessions({ limit: CORRELATION_SAMPLE_LIMIT });
    const total = wm.sessions.length;
    const withCorr = wm.sessions.filter((s) => s.correlation_id != null && s.correlation_id !== '').length;
    const sampled = total >= CORRELATION_SAMPLE_LIMIT;
    meters.push(
      meter(
        'correlation_coverage',
        'Correlation coverage',
        total > 0 ? withCorr / total : null,
        sampled
          ? `Worker sessions carrying a traceable correlation id. Sampled over the most recent ${CORRELATION_SAMPLE_LIMIT} sessions; more exist.`
          : 'Worker sessions carrying a traceable correlation id.',
      ),
    );
  } catch (err) {
    meters.push(
      unavailableMeter(
        'correlation_coverage',
        'Correlation coverage',
        `worker-management session list ${wmUnavailableReason(err)}`,
      ),
    );
  }

  // Meter 2: KAG compression lag p95 — narrowed data-gap. kag_orchestrator now
  // exposes backlog DEPTH + oldest-pending AGE via GET /health/lag, surfaced as
  // the Fleet band's backlog-age KPI. A true DONE→searchable p95 (this meter's
  // intent) still needs completed-item duration capture the orchestrator does
  // not retain — a separate follow-up — so this stays available:false here
  // rather than mislabel backlog age as a latency p95.
  meters.push(
    unavailableMeter(
      'kag_compression_lag',
      'KAG compression lag p95',
      'true DONE→searchable p95 is a duration, surfaced in the Fleet band (KAG completion p95); the telemetry panel renders 0..1 ratios only',
    ),
  );

  // Meter 3: approval callback health %.
  try {
    const value = await loadCallbackHealth();
    meters.push(
      meterAt(
        'approval_callback_health',
        'Approval callback health',
        value,
        0.9,
        0.75,
        'Approvals with a callback path that recorded a terminal decision outcome.',
      ),
    );
  } catch {
    meters.push(unavailableMeter('approval_callback_health', 'Approval callback health', 'approvals callback read failed'));
  }

  return meters;
}

// ---------------------------------------------------------------------------
// Control-tower aggregator — GET /api/admin/control-tower
// ---------------------------------------------------------------------------

export async function buildControlTower(): Promise<ControlTower> {
  // KAG backlog gauge (fed into BOTH the fleet band and the observability meter,
  // so it is fetched up-front rather than inside the Promise.all below). Dead /
  // unset orchestrator → data:null → both surfaces degrade to available:false.
  const kagLagBlock = await block('kag', () => deps.getKagLag());

  // KAG completion-latency p95 (TRUE DONE→searchable distribution, seconds).
  // Surfaced as a seconds tile in the fleet band — NOT the 0..1 telemetry meter.
  // Dead / unset orchestrator → data:null → the tile degrades to available:false.
  const kagLatencyBlock = await block('kag', () => deps.getKagLatency());

  // Independent blocks — each wrapped so one dead upstream degrades in place.
  const [
    tenantsBlock,
    activeBlock,
    workflowsBlock,
    observabilityBlock,
    approvalsBlock,
    andonBlock,
  ] = await Promise.all([
    block('composed', () => loadTenantHealth(), { confidence: 'derived' }),
    // ⚠️ ONE fetch feeds BOTH the fleet band's active_executions count and the
    // panel's rows. There used to be a second `block('n8n', () =>
    // deps.countRunningExecutions())` here whose count fed the band while this
    // block fed the rows — two fetches, two definitions of "active", one page
    // contradicting itself ("0 active" above 25 listed rows). The band is now
    // derived from these rows below, so they agree BY CONSTRUCTION rather than
    // by two definitions happening to coincide. Do not add a second fetch.
    block('composed', () => loadActiveExecutions()),
    block('n8n', async () => composeLiveWorkflows(deps.readWorkflowsCatalogue())),
    block('composed', () => buildObservabilityMeters(), {
      confidence: 'derived',
    }),
    block('fr-db', () => loadApprovalsRollup()),
    block('fr-db', () => loadAndon()),
  ]);

  // Derived folds over the resolved blocks (pure; never throw).
  const observabilityMeters = observabilityBlock.data ?? [];
  const fleet = deriveFleetKpis({
    tenantCount: CANONICAL_TENANTS.length,
    running: activeBlock.data
      ? { count: activeBlock.data.rows.length, capped: activeBlock.data.capped }
      : null,
    gateWaiting: activeBlock.data?.gate_waiting ?? 0,
    openApprovals: approvalsBlock.data?.open ?? 0,
    overdueApprovals: approvalsBlock.data?.overdue ?? 0,
    kagLag: kagLagBlock.data,
    kagLatency: kagLatencyBlock.data,
  });
  const alerts = deriveAlerts({
    callbackMeter: observabilityMeters.find((m) => m.key === 'approval_callback_health'),
    andon: andonBlock.data,
  });

  return {
    fleet: availableBlock('composed', fleet, { confidence: 'derived' }),
    tenants: tenantsBlock,
    active_executions: activeBlock,
    n8n_workflows: workflowsBlock,
    observability: observabilityBlock,
    approvals: approvalsBlock,
    andon: andonBlock,
    alerts: availableBlock('composed', alerts),
  };
}
