// tests/unit/lib/project-start-template.test.ts — the PROJECT_START_TEMPLATE_REQUIRED
// flag (default OFF) and the template-start record promote builds.

import { afterEach, describe, expect, test } from 'bun:test';

import {
  PROJECT_START_TEMPLATE_REQUIRED_ENV,
  projectStartTemplateRequired,
  templateRequiredForCreate,
  templateStartProjectData,
  outlineClosedGatePhase,
} from '../../../src/lib/project-start-template';
import { startTemplateFromOutline } from '../../../src/routes/project-requests';

const EXEC = '0195f48b-d000-7000-8000-000000000003';
const OTHER = '0195f48b-d000-7000-8000-0000000000ff';
const saved = process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV];
afterEach(() => {
  if (saved === undefined) delete process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV];
  else process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV] = saved;
});

describe('projectStartTemplateRequired', () => {
  test('defaults OFF (unset)', () => {
    delete process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV];
    expect(projectStartTemplateRequired()).toBe(false);
  });
  test('only the literal "true" turns it on', () => {
    for (const v of ['1', 'yes', 'on', '', 'false', 'TRUE ']) {
      process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV] = v;
      expect(projectStartTemplateRequired()).toBe(v.trim().toLowerCase() === 'true');
    }
  });
});

describe('templateRequiredForCreate', () => {
  const base = { orchestrated: true, ownerTenantId: EXEC, execTenantId: EXEC, hasTemplate: false };
  test('flag OFF ⇒ never required, whatever the create', () => {
    delete process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV];
    expect(templateRequiredForCreate(base)).toBe(false);
  });
  test('flag ON ⇒ required exactly for an orchestrated EXEC create without a template', () => {
    process.env[PROJECT_START_TEMPLATE_REQUIRED_ENV] = 'true';
    expect(templateRequiredForCreate(base)).toBe(true);
    expect(templateRequiredForCreate({ ...base, hasTemplate: true })).toBe(false);
    expect(templateRequiredForCreate({ ...base, orchestrated: false })).toBe(false);
    expect(templateRequiredForCreate({ ...base, ownerTenantId: OTHER })).toBe(false);
  });
});

describe('startTemplateFromOutline', () => {
  const plan = { template_id: 'it.bug_hunt', template_hash: 'e'.repeat(64), phases: ['deep_analysis', 'closure'] };
  const outline = {
    id: '00000000-0000-4000-8000-000000000001',
    deliverables: [],
    intermediate_deliverables: [],
    milestones: [],
    effort_estimate: null,
    version: 2,
    phase_plan: plan,
    phase_plan_hash: 'f'.repeat(64),
    approval_id: '00000000-0000-4000-8000-0000000000a1',
    decided_by: 'u1',
    decided_at: new Date('2026-10-09T00:00:00Z'),
  };

  test('no outline, or an outline without a plan ⇒ no template (legacy start)', () => {
    expect(startTemplateFromOutline(undefined)).toBeUndefined();
    expect(startTemplateFromOutline({ ...outline, phase_plan: null })).toBeUndefined();
  });

  test('a plan ⇒ the template coordinates + the approval that closes the contract', () => {
    const t = startTemplateFromOutline(outline)!;
    expect(t.templateId).toBe('it.bug_hunt');
    expect(t.templateHash).toBe('e'.repeat(64));
    expect(t.phasePlan.phases[0]).toBe('deep_analysis');
    expect(t.outlineVersion).toBe(2);
    const data = templateStartProjectData(t) as { start_mode: string; contract_close: Record<string, unknown> };
    expect(data.start_mode).toBe('template');
    expect(data.contract_close).toEqual({
      source: 'outline_approval',
      approval_id: outline.approval_id,
      outline_id: outline.id,
      outline_version: 2,
      phase_plan_hash: 'f'.repeat(64),
      decided_by: 'u1',
      decided_at: '2026-10-09T00:00:00.000Z',
    });
  });

  test('fr#1481 F3: a plan whose gate slug maps to no approval THROWS phase_plan_gate_unknown (promote fails, never a stranded project)', () => {
    const stranded = { ...plan, gates: { deep_analysis: ['ready_signoff', 'nonsense_gate'] } };
    expect(() => startTemplateFromOutline({ ...outline, phase_plan: stranded })).toThrow(/^phase_plan_gate_unknown: .*deep_analysis:nonsense_gate/);
    const fine = { ...plan, gates: { deep_analysis: ['ready_signoff', 'bug_fix_authorization'] } };
    expect(startTemplateFromOutline({ ...outline, phase_plan: fine })!.templateId).toBe('it.bug_hunt');
  });

  test('a malformed stored plan, or a plan without its hash, THROWS (never a silent legacy start)', () => {
    expect(() => startTemplateFromOutline({ ...outline, phase_plan: { template_id: 'x' } })).toThrow();
    expect(() => startTemplateFromOutline({ ...outline, phase_plan_hash: null })).toThrow(/phase_plan_hash/);
  });
});

describe('outlineClosedGatePhase — the gated phase comes from RM, never an fr constant', () => {
  // Shapes as the RM project-type route answers them (TypePhaseSchema), listed
  // OUT of position order on purpose.
  const TYPE = [
    { name: 'deep_analysis', position: 3, has_gate: false },
    { name: 'request', position: 0, has_gate: false },
    { name: 'signoff', position: 2, has_gate: true },
    { name: 'scoping', position: 1, has_gate: true },
    { name: 'closure', position: 4, has_gate: false },
  ];

  test('the LAST gated phase before the first plan phase, whatever it is named', () => {
    // MUTATION THAT MUST RED THIS: return the literal 'contract' (the old fr
    // vocabulary) — this type has no phase by that name.
    expect(outlineClosedGatePhase(TYPE, 'deep_analysis')).toBe('signoff');
    expect(outlineClosedGatePhase(TYPE, 'closure')).toBe('signoff');
    expect(outlineClosedGatePhase(TYPE, 'signoff')).toBe('scoping');
  });

  test('no gated phase before the first plan phase → null (no fallback)', () => {
    const ungated = TYPE.map((p) => ({ ...p, has_gate: false }));
    expect(outlineClosedGatePhase(ungated, 'deep_analysis')).toBeNull();
    expect(outlineClosedGatePhase(TYPE, 'scoping')).toBeNull();
    // A gate AFTER the first plan phase is not the one the outline closes.
    expect(outlineClosedGatePhase(TYPE, 'request')).toBeNull();
  });

  test('a first plan phase the type does not have → null', () => {
    expect(outlineClosedGatePhase(TYPE, 'contract')).toBeNull();
    expect(outlineClosedGatePhase([], 'deep_analysis')).toBeNull();
  });

  test('has_gate absent counts as ungated', () => {
    expect(outlineClosedGatePhase([{ name: 'a', position: 0 }, { name: 'b', position: 1 }], 'b')).toBeNull();
  });
});
