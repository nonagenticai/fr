// tests/unit/services/control-tower/index.test.ts
//
// Unit coverage for the control-tower pure folds (AA cockpit B5): the live n8n
// workflow list, fleet KPI band, and
// the check-derived alert strip. The full
// buildControlTower() (DB + upstream probes) is covered by the integration
// test; these deps-free folds carry the bulk of the logic weight.

import { test, expect, describe } from 'bun:test';
import {
  composeLiveWorkflows,
  composeActiveExecutions,
  deriveFleetKpis,
  deriveAlerts,
  type Meter,
  wmUnavailableReason,
} from '../../../../src/services/control-tower/index';
import { IntegrationError } from '../../../../src/integrations/_lib/errors';

// ---------------------------------------------------------------------------

describe('composeLiveWorkflows', () => {
  test('counts active/inactive, sorts active first then by name, null for a missing updatedAt', () => {
    const w = composeLiveWorkflows({
      rows: [
        { id: 'b', name: 'sub.card_action', active: false, tags: ['v4'], updatedAt: '' },
        { id: 'c', name: 'sub.run_card_flow', active: true, tags: [], updatedAt: '2026-10-29T10:00:00.000Z' },
        { id: 'a', name: 'card.it', active: true, tags: ['v4', 'card-type'], updatedAt: '2026-10-28T10:00:00.000Z' },
      ],
      fetchedAt: Date.parse('2026-10-30T12:00:00.000Z'),
      degraded: true,
    });
    expect(w.total).toBe(3);
    expect(w.active).toBe(2);
    expect(w.inactive).toBe(1);
    expect(w.rows.map((r) => r.id)).toEqual(['a', 'c', 'b']);
    expect(w.rows[2]!.updated_at).toBeNull();
    expect(w.rows[0]!.tags).toEqual(['v4', 'card-type']);
    expect(w.fetched_at).toBe('2026-10-30T12:00:00.000Z');
    expect(w.degraded).toBe(true);
  });
});

describe('deriveFleetKpis', () => {
  test('maps counts + carries the n8n running cap; reachable KAG backlog age surfaces', () => {
    const f = deriveFleetKpis({
      tenantCount: 5,
      running: { count: 38, capped: true },
      gateWaiting: 6,
      openApprovals: 17,
      overdueApprovals: 3,
      kagLag: {
        stages: [{ stage: 'karma', pending: 5, oldest_age_seconds: 120 }],
        total_pending: 5,
        max_oldest_age_seconds: 120,
        backend: 'database',
      },
      kagLatency: null,
    });
    expect(f.tenants).toBe(5);
    expect(f.active_executions).toBe(38);
    expect(f.active_executions_capped).toBe(true);
    expect(f.gate_waiting).toBe(6);
    expect(f.open_approvals).toBe(17);
    expect(f.overdue_callbacks).toBe(3);
    expect(f.kag_lag_p95).toBe(120);
    expect(f.kag_lag_available).toBe(true);
  });

  test('reachable-but-idle orchestrator → available with null age (not a gap, not 0)', () => {
    const f = deriveFleetKpis({
      tenantCount: 1,
      running: null,
      gateWaiting: 0,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: { stages: [], total_pending: 0, max_oldest_age_seconds: null, backend: 'database' },
      kagLatency: null,
    });
    expect(f.kag_lag_p95).toBeNull();
    expect(f.kag_lag_available).toBe(true);
  });

  test('null kagLag (unset/unreachable) → data-gap: null age, available:false', () => {
    const f = deriveFleetKpis({
      tenantCount: 1,
      running: null,
      gateWaiting: 0,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: null,
      kagLatency: null,
    });
    expect(f.kag_lag_p95).toBeNull();
    expect(f.kag_lag_available).toBe(false);
  });

  test('null running block → zero active, not a crash', () => {
    const f = deriveFleetKpis({ tenantCount: 5, running: null, gateWaiting: 0, openApprovals: 0, overdueApprovals: 0, kagLag: null, kagLatency: null });
    expect(f.active_executions).toBe(0);
    expect(f.active_executions_capped).toBe(false);
  });

  test('kagLatency present + samples>0 → true completion p95 (seconds) surfaces, available', () => {
    const f = deriveFleetKpis({
      tenantCount: 1,
      running: null,
      gateWaiting: 0,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: null,
      kagLatency: { p95_seconds: 12.5, p50_seconds: 3, max_seconds: 40, sample_count: 128, window_hours: 24 },
    });
    expect(f.kag_completion_p95_seconds).toBe(12.5);
    expect(f.kag_completion_p95_available).toBe(true);
  });

  test('kagLatency reachable but zero samples → null p95, available:false (no fabricated number)', () => {
    const f = deriveFleetKpis({
      tenantCount: 1,
      running: null,
      gateWaiting: 0,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: null,
      kagLatency: { p95_seconds: null, p50_seconds: null, max_seconds: null, sample_count: 0, window_hours: 24 },
    });
    expect(f.kag_completion_p95_seconds).toBeNull();
    expect(f.kag_completion_p95_available).toBe(false);
  });

  test('null kagLatency (unset/unreachable) → null p95, available:false', () => {
    const f = deriveFleetKpis({
      tenantCount: 1,
      running: null,
      gateWaiting: 0,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: null,
      kagLatency: null,
    });
    expect(f.kag_completion_p95_seconds).toBeNull();
    expect(f.kag_completion_p95_available).toBe(false);
  });
});

// ---------------------------------------------------------------------------

describe('deriveAlerts', () => {
  const okMeter = (key: string, value: number): Meter => ({ key, label: key, value, status: 'ok', detail: 'd', available: true });
  test('callback danger fires on a low meter', () => {
    const alerts = deriveAlerts({
      callbackMeter: { key: 'approval_callback_health', label: 'x', value: 0.82, status: 'danger', detail: 'd', available: true },
      andon: null,
    });
    expect(alerts.find((a) => a.key === 'callback_health')?.severity).toBe('danger');
  });

  test('global andon engaged → danger', () => {
    const alerts = deriveAlerts({
      callbackMeter: undefined,
      andon: { global_engaged: true, engaged_at: null, engaged_by: null, worker_replicas: 0, project_stops: 1, stream_stops: 0 },
    });
    expect(alerts.find((a) => a.key === 'andon')?.severity).toBe('danger');
  });

  test('nothing wrong → a single ok alert', () => {
    const alerts = deriveAlerts({
      callbackMeter: okMeter('approval_callback_health', 0.99),
      andon: { global_engaged: false, engaged_at: null, engaged_by: null, worker_replicas: 1, project_stops: 0, stream_stops: 0 },
    });
    // the ok-fallback is the only entry; no danger/warn.
    expect(alerts.some((a) => a.severity === 'danger' || a.severity === 'warn')).toBe(false);
    expect(alerts.some((a) => a.severity === 'ok')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// composeActiveExecutions — the band-equals-panel invariant.
//
// The defect these pin: the panel was fed an UNFILTERED page of the newest 25
// executions (any status) while the fleet band was fed a separate running-only
// count. Two fetches, two definitions, one page saying "0 active" above 25 rows.
// ---------------------------------------------------------------------------

describe('composeActiveExecutions', () => {
  const exec = (id: number, status: string, mode = 'trigger') =>
    ({ id, mode, status, startedAt: `2026-07-08T00:0${id}:00.000Z` }) as never;

  const session = (
    session_id: string,
    status: string,
    completed_at: string | null,
    correlation_id: string | null = null,
  ) =>
    ({
      session_id,
      graph_id: 'g',
      status,
      validation_passed: null,
      correlation_id,
      request_payload: null,
      final_response: null,
      created_at: '2026-07-08T00:00:00.000Z',
      completed_at,
    }) as never;

  test('terminal n8n statuses yield ZERO n8n rows (a page of successes is not "active")', () => {
    const a = composeActiveExecutions({
      n8n: {
        executions: [
          exec(1, 'success'),
          exec(2, 'error'),
          exec(3, 'canceled'),
          exec(4, 'crashed'),
          exec(5, 'new'),
          exec(6, 'unknown'),
        ],
        capped: false,
      },
      workerManagement: { sessions: [], truncated: false },
      correlationById: new Map(),
    });
    expect(a.rows.filter((r) => r.source === 'n8n')).toHaveLength(0);
    expect(a.gate_waiting).toBe(0);
  });

  test('band ≡ panel: rows.length === deriveFleetKpis(...).active_executions', () => {
    const a = composeActiveExecutions({
      n8n: {
        executions: [
          exec(1, 'success'),
          exec(2, 'error'),
          exec(3, 'running'),
          exec(4, 'waiting'),
          exec(5, 'running'),
        ],
        capped: false,
      },
      workerManagement: {
        sessions: [
          session('s1', 'running', null),
          session('s2', 'success', '2026-07-08T00:05:00.000Z'),
        ],
        truncated: false,
      },
      correlationById: new Map(),
    });

    // 3 in-flight n8n (2 running + 1 waiting; success/error dropped) + 1 in-flight WM.
    expect(a.rows).toHaveLength(4);
    expect(a.gate_waiting).toBe(1);

    const fleet = deriveFleetKpis({
      tenantCount: 5,
      running: { count: a.rows.length, capped: a.capped },
      gateWaiting: a.gate_waiting,
      openApprovals: 0,
      overdueApprovals: 0,
      kagLag: null,
      kagLatency: null,
    });
    expect(fleet.active_executions).toBe(a.rows.length);
    expect(fleet.gate_waiting).toBe(a.gate_waiting);
    expect(fleet.active_executions_capped).toBe(false);
  });

  test('worker-management rows are in-flight only (completed_at == null)', () => {
    const a = composeActiveExecutions({
      n8n: { executions: [], capped: false },
      workerManagement: {
        sessions: [
          session('s1', 'running', null),
          session('s2', 'success', '2026-07-08T00:05:00.000Z'),
          session('s3', 'error', '2026-07-08T00:06:00.000Z'),
        ],
        truncated: false,
      },
      correlationById: new Map(),
    });
    expect(a.rows.map((r) => r.execution_id)).toEqual(['s1']);
  });

  test('a capped source marks the whole count a floor (UI renders "N+")', () => {
    const a = composeActiveExecutions({
      n8n: { executions: [exec(1, 'running')], capped: true },
      workerManagement: { sessions: [], truncated: false },
      correlationById: new Map(),
    });
    expect(a.capped).toBe(true);

    const b = composeActiveExecutions({
      n8n: { executions: [exec(1, 'running')], capped: false },
      workerManagement: { sessions: [], truncated: true },
      correlationById: new Map(),
    });
    expect(b.capped).toBe(true);
  });

  test('an unreachable source is available:false without dropping the other one', () => {
    const a = composeActiveExecutions({
      n8n: null,
      workerManagement: { sessions: [session('s1', 'running', null)], truncated: false },
      correlationById: new Map(),
    });
    expect(a.n8n_available).toBe(false);
    expect(a.worker_management_available).toBe(true);
    expect(a.rows).toHaveLength(1);
  });

  // -- Defect C: three distinct correlation facts, not one blank column -------

  test('correlation fold: mapped id → present; unmapped id → not_fr_initiated', () => {
    const a = composeActiveExecutions({
      n8n: { executions: [exec(1, 'running'), exec(2, 'waiting')], capped: false },
      workerManagement: { sessions: [], truncated: false },
      correlationById: new Map([['1', 'corr-abc']]),
    });
    const mapped = a.rows.find((r) => r.execution_id === '1')!;
    expect(mapped.correlation_id).toBe('corr-abc');
    expect(mapped.correlation_state).toBe('present');

    // Started by an n8n schedule/webhook — genuinely has no fr correlation id.
    const unmapped = a.rows.find((r) => r.execution_id === '2')!;
    expect(unmapped.correlation_id).toBeNull();
    expect(unmapped.correlation_state).toBe('not_fr_initiated');
  });

  test('a failed mapping lookup is unavailable, NOT not_fr_initiated', () => {
    const a = composeActiveExecutions({
      n8n: { executions: [exec(1, 'running')], capped: false },
      workerManagement: { sessions: [], truncated: false },
      correlationById: null,
    });
    expect(a.rows[0]!.correlation_state).toBe('unavailable');
    expect(a.rows[0]!.correlation_id).toBeNull();
  });

  test('worker-management carries its correlation id inline (never unavailable)', () => {
    const a = composeActiveExecutions({
      n8n: { executions: [], capped: false },
      workerManagement: {
        sessions: [session('s1', 'running', null, 'corr-wm'), session('s2', 'running', null, null)],
        truncated: false,
      },
      correlationById: null,
    });
    expect(a.rows.find((r) => r.execution_id === 's1')!.correlation_state).toBe('present');
    expect(a.rows.find((r) => r.execution_id === 's2')!.correlation_state).toBe('not_fr_initiated');
  });
});

describe('wmUnavailableReason (WM#324, fr row 15)', () => {
  test('a MISSING_TENANT refusal is named as such, not as an outage', () => {
    const refused = new IntegrationError({ code: 'MISSING_TENANT', message: 'no tenant' });
    expect(wmUnavailableReason(refused)).toBe('not called: no tenant resolved for this request');
  });
  test('[control] any other failure still reads unreachable', () => {
    const down = new IntegrationError({ code: 'UPSTREAM_UNREACHABLE', message: 'down' });
    expect(wmUnavailableReason(down)).toBe('unreachable');
    expect(wmUnavailableReason(new Error('boom'))).toBe('unreachable');
  });
});
