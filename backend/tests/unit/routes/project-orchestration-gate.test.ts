// tests/unit/routes/project-orchestration-gate.test.ts
//
// Unit coverage for shouldOrchestrateProjectStart — the gate that decides
// whether a newly-created project enters the AA project-start orchestration.
// WS3 added the customer CVE-sweep entry: a NON-EXEC tenant may orchestrate an
// `it` project IFF cve_sweep=true, while non-cve_sweep customer `it`/`feature`
// projects stay EXEC-pinned (no accidental pipeline triggers).
//
// ⚠️ The frontend mirrors this gate in ProjectTypeAnalysisWarning.svelte
// (`orchestratesProjectStart`), asserted against the SAME matrix in
// frontend/src/lib/components/ProjectTypeAnalysisWarning.test.ts. The two drifting
// apart is not hypothetical — it is exactly what happened: the frontend kept a
// hardcoded {feature, it} set through the 2026-07-07 widening, so it warned
// "analysis will be skipped" on every EXEC-tenant project while the analysis was in
// fact running. Change this rule ⇒ change both, and both suites.

import { test, expect, describe } from 'bun:test';
import { shouldOrchestrateProjectStart } from '../../../src/routes/projects';

const EXEC = '0195f48b-d000-7000-8000-000000000003';
const CUSTOMER = '0199aaaa-bbbb-7ccc-8ddd-000000000abc';

describe('shouldOrchestrateProjectStart', () => {
  test('EXEC `it` project (no cve_sweep) orchestrates', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'it',
        cveSweep: false,
        tenantId: EXEC,
        execTenantId: EXEC,
      }),
    ).toBe(true);
  });

  test('EXEC `feature` project orchestrates', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'feature',
        cveSweep: undefined,
        tenantId: EXEC,
        execTenantId: EXEC,
      }),
    ).toBe(true);
  });

  test('WS3: customer (non-EXEC) `it` + cve_sweep=true orchestrates', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'it',
        cveSweep: true,
        tenantId: CUSTOMER,
        execTenantId: EXEC,
      }),
    ).toBe(true);
  });

  test('customer `it` WITHOUT cve_sweep does NOT orchestrate (no scope creep)', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'it',
        cveSweep: false,
        tenantId: CUSTOMER,
        execTenantId: EXEC,
      }),
    ).toBe(false);
  });

  test('customer `feature` does NOT orchestrate (EXEC-pinned)', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'feature',
        cveSweep: true,
        tenantId: CUSTOMER,
        execTenantId: EXEC,
      }),
    ).toBe(false);
  });

  test('cve_sweep only generalizes `it` — customer non-it + cve_sweep stays gated', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'program',
        cveSweep: true,
        tenantId: CUSTOMER,
        execTenantId: EXEC,
      }),
    ).toBe(false);
  });

  test('EXEC `it` + cve_sweep orchestrates', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: 'it',
        cveSweep: true,
        tenantId: EXEC,
        execTenantId: EXEC,
      }),
    ).toBe(true);
  });

  // Widened 2026-07-07: EVERY EXEC-tenant project orchestrates (any
  // project_type), so no internal project is born bypassing its analysis card.
  // Types drawn from the closed vocabulary (fr#1476) — the retired free-text
  // values (poc / greenfield / maintenance / business) can no longer be created.
  for (const projectType of ['program', 'kaizen', 'meta_prompt', 'meta_procedure']) {
    test(`EXEC \`${projectType}\` project now orchestrates (widening)`, () => {
      expect(
        shouldOrchestrateProjectStart({
          projectType,
          cveSweep: false,
          tenantId: EXEC,
          execTenantId: EXEC,
        }),
      ).toBe(true);
    });
  }

  test('EXEC project with undefined project_type orchestrates (widening)', () => {
    expect(
      shouldOrchestrateProjectStart({
        projectType: undefined,
        cveSweep: undefined,
        tenantId: EXEC,
        execTenantId: EXEC,
      }),
    ).toBe(true);
  });

  test('customer non-it/feature (any type) still does NOT orchestrate — tenant isolation preserved', () => {
    for (const projectType of ['program', 'kaizen', 'meta_prompt', undefined]) {
      expect(
        shouldOrchestrateProjectStart({
          projectType,
          cveSweep: false,
          tenantId: CUSTOMER,
          execTenantId: EXEC,
        }),
      ).toBe(false);
    }
  });

  // fr#1487: system_ops NEVER orchestrates, on any tenant. The frontend mirror
  // (ProjectTypeAnalysisWarning.svelte) missed this clause until fr#1476.
  test('system_ops never orchestrates — EXEC or customer, cve_sweep or not', () => {
    for (const tenantId of [EXEC, CUSTOMER]) {
      for (const cveSweep of [undefined, false, true]) {
        expect(
          shouldOrchestrateProjectStart({ projectType: 'system_ops', cveSweep, tenantId, execTenantId: EXEC }),
        ).toBe(false);
      }
    }
  });
});
