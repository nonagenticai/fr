import { describe, it, expect } from 'vitest';
import {
  NOT_SET,
  byRank,
  cardTypeBody,
  changedFields,
  gateBody,
  gateForm,
  cardTypeForm,
  dodOptionsFor,
  displayValue,
  gateSummary,
  gatesByPhase,
  moveEntry,
  numberOrRaw,
  phaseBody,
  phaseForm,
  projectTypeBody,
  projectTypeForm,
} from './forms';
import type { Gate } from '$lib/api/conveyor-catalogue';

describe('displayValue — absent Tier 1 fields read "not set"', () => {
  it('maps absent/null/empty to not set and keeps real values', () => {
    expect(displayValue(undefined)).toBe(NOT_SET);
    expect(displayValue(null)).toBe(NOT_SET);
    expect(displayValue('  ')).toBe(NOT_SET);
    expect(displayValue([])).toBe(NOT_SET);
    expect(displayValue(['a', 'b'])).toBe('a, b');
    expect(displayValue(false)).toBe('no');
    expect(displayValue(0)).toBe('0');
  });
});

describe('phase', () => {
  it('a NULL output/exit_rule hydrates as not set (null) and is sent back as null, not ""', () => {
    const f = phaseForm({ id: 'p', name: 'intake', title: 'Intake', output: null, exit_rule: null });
    expect(f).toEqual({ name: 'intake', title: 'Intake', description: '', output: null, exit_rule: null });
    expect(phaseBody(f)).toEqual({ name: 'intake', title: 'Intake', description: null, output: null, exit_rule: null });
  });

  it('"" (deliberately cleared) stays "" — it is not collapsed into null', () => {
    const f = phaseForm({ id: 'p', name: 'intake', title: 'Intake', output: '', exit_rule: 'x' });
    expect(phaseBody(f).output).toBe('');
  });

  it('an update sends only what changed: an untouched null is not sent', () => {
    const row = { id: 'p', name: 'intake', title: 'Intake', output: null, exit_rule: 'old' };
    const before = phaseForm(row);
    const after = { ...before, exit_rule: 'new' };
    expect(changedFields(phaseBody(before), phaseBody(after))).toEqual({ exit_rule: 'new' });
  });
});

describe('card type', () => {
  it('NULL lists / human_task hydrate as not set and stay null; a set list drops blank rows', () => {
    const f = cardTypeForm({
      id: 'c',
      name: 'bug_fix',
      title: 'Bug fix',
      capability_id: 'cap',
      inputs: null,
      outputs: null,
      acceptance: null,
      rules: null,
      human_task: null,
    });
    expect(f.inputs).toBeNull();
    expect(f.human_task).toBe('');
    f.inputs = ['bug_report', ' '];
    f.rules = ['R33'];
    f.human_task = 'yes';
    expect(cardTypeBody(f)).toEqual({
      name: 'bug_fix',
      title: 'Bug fix',
      description: null,
      capability_id: 'cap',
      inputs: ['bug_report'],
      // ⛔ untouched nulls stay null — never [] (which would mean "cleared").
      outputs: null,
      acceptance: null,
      rules: ['R33'],
      human_task: true,
      definition_of_done: null,
    });
    f.definition_of_done = 'pr_merged';
    expect(cardTypeBody(f).definition_of_done).toBe('pr_merged');
  });

  it('[] (cleared) stays []; explicit false human_task is kept', () => {
    const f = cardTypeForm({ id: 'c', name: 'n', title: 't', capability_id: 'cap', inputs: [], human_task: false });
    expect(cardTypeBody(f).inputs).toEqual([]);
    expect(cardTypeBody(f).human_task).toBe(false);
  });

  it('an edit that touches one list sends only that list (never [] for the untouched nulls)', () => {
    const row = { id: 'c', name: 'n', title: 't', capability_id: 'cap', inputs: null, outputs: null, rules: ['R1'] };
    const before = cardTypeForm(row);
    const after = { ...before, rules: ['R1', 'R2'] };
    expect(changedFields(cardTypeBody(before), cardTypeBody(after))).toEqual({ rules: ['R1', 'R2'] });
    expect(changedFields(cardTypeBody(before), cardTypeBody(before))).toEqual({});
  });
});

describe('project type', () => {
  it('derives ordered phase_ids from phases[] by position for edits', () => {
    const f = projectTypeForm({
      id: 'pt',
      name: 'bug_hunt_fix',
      title: 'Bug hunt',
      phases: [
        { phase_id: 'b', name: 'b', title: 'B', position: 1 },
        { phase_id: 'a', name: 'a', title: 'A', position: 0 },
      ],
    });
    expect(f.phase_ids).toEqual(['a', 'b']);
    expect(projectTypeBody(f).phase_ids).toEqual(['a', 'b']);
  });

  it('moveEntry reorders and ignores out-of-range moves', () => {
    expect(moveEntry(['a', 'b', 'c'], 2, -1)).toEqual(['a', 'c', 'b']);
    expect(moveEntry(['a', 'b'], 0, -1)).toEqual(['a', 'b']);
  });
});

describe('numberOrRaw', () => {
  it('passes a non-number through for RM to refuse', () => {
    expect(numberOrRaw('')).toBeNull();
    expect(numberOrRaw('3')).toBe(3);
    expect(numberOrRaw('three')).toBe('three');
    // A number box bound by Svelte yields a number, or null when emptied.
    expect(numberOrRaw(4 as unknown as string)).toBe(4);
    expect(numberOrRaw(null as unknown as string)).toBeNull();
  });
});

describe('priority levels', () => {
  it('byRank orders by rank ascending, never by name', () => {
    const lv = (name: string, rank: number) => ({ id: name, name, title: name.toUpperCase(), rank });
    expect(byRank([lv('p2', 2), lv('p0', 0), lv('p3', 3), lv('p1', 1)]).map((l) => l.name)).toEqual(['p0', 'p1', 'p2', 'p3']);
    expect(byRank([lv('a', 1), lv('z', 0)]).map((l) => l.name)).toEqual(['z', 'a']);
  });
});

describe('gate form', () => {
  it('round-trips a gate; blank expiry is null (never expires)', () => {
    const g: Gate = { id: 'g', name: 'exit', title: 'Exit', phase_id: 'p1', approver_role: 'tenant_admin', quorum: 2, expires_after_hours: null };
    const f = gateForm(g);
    expect(gateBody(f)).toEqual({ name: 'exit', title: 'Exit', description: null, phase_id: 'p1', approver_role: 'tenant_admin', quorum: 2, expires_after_hours: null });
    expect(gateForm(undefined, 'p9').phase_id).toBe('p9');
  });
});

describe('gates (on the phase row)', () => {
  it('groups by phase and summarises', () => {
    const g: Gate = { id: 'g', name: 'exit', title: 'Exit gate', phase_id: 'p1', approver_role: 'tenant_admin', quorum: 2, expires_after_hours: null };
    const m = gatesByPhase([g]);
    expect(m.get('p1')).toEqual([g]);
    expect(gateSummary(g)).toBe('Exit gate: approver tenant_admin, quorum 2, never expires');
  });
});

describe('dodOptionsFor', () => {
  it("offers 'not set' then RM's values, in RM order", () => {
    expect(dodOptionsFor(['pr_merged', 'asset_persisted'], '')).toEqual([
      { value: '', label: 'not set' },
      { value: 'pr_merged', label: 'pr_merged' },
      { value: 'asset_persisted', label: 'asset_persisted' },
    ]);
  });

  it("a failed enum read offers only 'not set' (no invented list)", () => {
    expect(dodOptionsFor(null, '')).toEqual([{ value: '', label: 'not set' }]);
  });

  it('keeps a current value RM no longer lists, so opening the form never rewrites it', () => {
    expect(dodOptionsFor(['pr_merged'], 'legacy_done').at(-1)).toEqual({
      value: 'legacy_done',
      label: 'legacy_done (current value)',
    });
    expect(dodOptionsFor(['pr_merged'], 'pr_merged')).toHaveLength(2);
  });
});
