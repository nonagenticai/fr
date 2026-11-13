// tests/unit/routes/conveyor-refusal-visibility.test.ts
//
// A refused inbound conveyor event must be OBSERVABLE, whether the refusal was
// correct or not. Measured 2026-09-10 in the prod fr pod over one hour: three
// separate inbound writeback channels 404ing (execution-event x3, card comments
// x2, kaizen/log x2) with nothing anywhere holding a number for any of them —
// the only trace was pod stdout, which dies with the pod.
//
// Also pins the id-KIND diagnosis. `0195f48b-d000-7000-8000-000000000004` was
// being refused as a missing PROJECT; it is the `prompt-improvement` WORKSPACE
// id (migration 062), so it can never match a `projects` row under any tenant
// and the event was structurally unanswerable. That one fact separates "n8n
// referenced something deleted" (nothing to do) from "n8n is naming the wrong
// entity kind" (a producer fix), and nothing was drawing the distinction.

import { describe, test, expect } from 'bun:test';

import {
  canonicalTenantName,
  INTERNAL_SYSTEM_TENANT_ID,
  EXECUTION_TENANT_ID,
} from '../../../src/middleware/internal-tenant-only';
import {
  reportConveyorRefusal,
  renderConveyorRefusalMetrics,
} from '../../../src/lib/conveyor-refusal-metrics';
import { CANONICAL_TENANTS } from '../../../src/routes/tenants';


describe('canonicalTenantName — a workspace id mistaken for a project id', () => {
  test('the deleted prompt-improvement tenant id is no longer a canonical tenant (2026-11-03)', () => {
    // The id production was refusing in 2026-09 was the prompt-improvement
    // WORKSPACE. That workspace is gone, so it now reads as an ordinary uuid.
    expect(canonicalTenantName('0195f48b-d000-7000-8000-000000000004')).toBeNull();
  });

  test('both canonical tenants resolve', () => {
    expect(canonicalTenantName(INTERNAL_SYSTEM_TENANT_ID)).toBe('system');
    expect(canonicalTenantName(EXECUTION_TENANT_ID)).toBe('execution');
  });

  test('CONTROL — an ordinary uuid is not a tenant', () => {
    // Without this the diagnosis would fire on every 404 and say nothing.
    expect(canonicalTenantName('0195f48b-d000-7000-8000-000000000099')).toBeNull();
    expect(canonicalTenantName('11111111-1111-4111-8111-111111111111')).toBeNull();
    expect(canonicalTenantName('')).toBeNull();
    expect(canonicalTenantName(null)).toBeNull();
    expect(canonicalTenantName(undefined)).toBeNull();
  });

  test('routes/tenants.ts and the diagnostic map cannot disagree', () => {
    // They used to be two lists of literals. A drifted name would make the
    // refusal message name a tenant the switcher does not.
    for (const t of CANONICAL_TENANTS) {
      expect(canonicalTenantName(t.id)).toBe(t.name);
    }
  });
});

describe('fr_conveyor_inbound_refused_total', () => {

  test('every series is exported before it fires (pre-seeded, not minted on first fire)', () => {
    // ⛔ A counter that only appears once it fires is indistinguishable from an
    // exporter that was never wired up — and "no series" reads as "no problem".
    // Values are process-global (no reset hook), so presence is asserted, not zero.
    const text = renderConveyorRefusalMetrics().join('\n');
    expect(text).toContain('# TYPE fr_conveyor_inbound_refused_total counter');
    expect(text).toMatch(/^fr_conveyor_inbound_refused_total\{surface="project_read",reason="project_not_found"\} \d+$/m);
    expect(text).toMatch(
      /^fr_conveyor_inbound_refused_total\{surface="n8n_execution_event",reason="project_id_is_tenant_id"\} \d+$/m,
    );
  });

  test('the exposition text carries the incremented value', () => {
    const key = 'fr_conveyor_inbound_refused_total{surface="project_read",reason="project_id_is_tenant_id"} ';
    const valueOf = () =>
      Number(renderConveyorRefusalMetrics().find((l) => l.startsWith(key))?.slice(key.length) ?? NaN);
    const before = valueOf();
    reportConveyorRefusal({ surface: 'project_read', reason: 'project_id_is_tenant_id' });
    expect(valueOf()).toBe(before + 1);
  });

});
