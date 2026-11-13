import { describe, it, expect } from 'vitest';
import { capabilityGroups, matrixHasTier1, matrixPutBody, matrixState, toggleCardType, toggleEntry } from './matrix';
import type { ProjectTypeMatrix } from '$lib/api/conveyor-catalogue';

const base: ProjectTypeMatrix = {
  project_type_id: 'pt',
  name: 'bug_hunt_fix',
  title: 'Bug hunt',
  phases: [
    {
      phase_id: 'p2',
      name: 'fix',
      title: 'Fix',
      position: 1,
      capabilities: [],
    },
    {
      phase_id: 'p1',
      name: 'hunt',
      title: 'Hunt',
      position: 0,
      capabilities: [
        { capability_id: 'cap', name: 'qa', title: 'QA', card_types: [{ card_type_id: 'c1', name: 'a', title: 'A' }] },
      ],
    },
  ],
};

const tier1: ProjectTypeMatrix = {
  ...base,
  phases: [
    {
      phase_id: 'p1',
      name: 'hunt',
      title: 'Hunt',
      position: 0,
      // Effective values (display only) + the override fields, as RM's GET emits them.
      output: 'override text',
      output_overridden: true,
      output_override: 'override text',
      exit_rule: 'phase default',
      exit_rule_overridden: false,
      exit_rule_override: null,
      capabilities: [
        {
          capability_id: 'cap',
          name: 'qa',
          title: 'QA',
          card_types: [
            { card_type_id: 'c1', name: 'a', title: 'A', is_entry: true },
            { card_type_id: 'c2', name: 'b', title: 'B', is_entry: false },
          ],
        },
      ],
    },
  ],
};

describe('matrix PUT payload', () => {
  it('pre-Tier-1 RM: every phase, in order, card_type_ids only (no keys RM would 422)', () => {
    const s = matrixState(base);
    expect(matrixHasTier1(base)).toBe(false);
    expect(matrixPutBody(s)).toEqual({
      phases: [
        { phase_id: 'p1', card_type_ids: ['c1'] },
        // An empty phase is still sent: a phase left out would be emptied anyway,
        // and sending it keeps the body a full picture of the matrix.
        { phase_id: 'p2', card_type_ids: [] },
      ],
    });
  });

  it('Tier 1, untouched: entries go back, overrides are OMITTED (omitted = unchanged)', () => {
    const s = matrixState(tier1);
    expect(s.tier1).toBe(true);
    expect(matrixPutBody(s)).toEqual({
      phases: [{ phase_id: 'p1', card_type_ids: ['c1', 'c2'], entry_card_type_ids: ['c1'] }],
    });
  });

  // ⛔ Trap 2 (RM rm#208): GET `output` is the EFFECTIVE value; PUT `output`
  // SETS the override. Copying GET `output` into the PUT would freeze the
  // phase's own value as an override. The editor hydrates from
  // `output_override` and sends `output` only when the override was changed.
  it('never copies the effective GET output/exit_rule into the PUT', () => {
    const inherited: ProjectTypeMatrix = {
      ...base,
      phases: [
        {
          phase_id: 'p1',
          name: 'hunt',
          title: 'Hunt',
          position: 0,
          output: "the phase's own output",
          output_overridden: false,
          output_override: null,
          exit_rule: "the phase's own exit rule",
          exit_rule_overridden: false,
          exit_rule_override: null,
          capabilities: [],
        },
      ],
    };
    const s = matrixState(inherited);
    // The override box starts EMPTY, not pre-filled with the effective value.
    expect(s.phases[0]!.outputOverride).toBe('');
    expect(s.phases[0]!.exitRuleOverride).toBe('');
    // A save that touches only card types sends no override key at all.
    s.phases[0] = toggleCardType(s.phases[0]!, 'c1');
    const put = matrixPutBody(s).phases[0]!;
    expect(put).toEqual({ phase_id: 'p1', card_type_ids: ['c1'], entry_card_type_ids: [] });
    expect('output' in put).toBe(false);
    expect('exit_rule' in put).toBe(false);
    expect(JSON.stringify(matrixPutBody(s))).not.toContain("the phase's own");
  });

  it('hydrates from output_override even when it differs from the effective output', () => {
    const odd: ProjectTypeMatrix = {
      ...base,
      phases: [{ ...tier1.phases[0]!, output: 'EFFECTIVE', output_override: 'OVERRIDE' }],
    };
    const s = matrixState(odd);
    expect(s.phases[0]!.outputOverride).toBe('OVERRIDE');
    s.phases[0]!.outputOverride = 'NEW';
    expect(matrixPutBody(s).phases[0]!.output).toBe('NEW');
  });

  it('a changed override is sent as `output` / `exit_rule` (the override), the other stays omitted', () => {
    const s = matrixState(tier1);
    s.phases[0]!.exitRuleOverride = 'done when merged';
    const put = matrixPutBody(s).phases[0]!;
    expect(put.exit_rule).toBe('done when merged');
    expect('output' in put).toBe(false);
  });

  it('entry_card_type_ids is always a subset of card_type_ids', () => {
    const s = matrixState(tier1);
    s.phases[0] = { ...s.phases[0]!, entry: ['c1', 'ghost'] };
    expect(matrixPutBody(s).phases[0]!.entry_card_type_ids).toEqual(['c1']);
  });

  it('unticking a card type drops it as an entry; entry toggles independently', () => {
    const p = matrixState(tier1).phases[0]!;
    const off = toggleCardType(p, 'c1');
    expect(off.selected).toEqual(['c2']);
    expect(off.entry).toEqual([]);
    const on = toggleEntry(toggleCardType(off, 'c3'), 'c3');
    expect(on.selected).toEqual(['c2', 'c3']);
    expect(on.entry).toEqual(['c3']);
  });

  it('a cleared override box sends null (= remove the override)', () => {
    const s = matrixState(tier1);
    s.phases[0]!.outputOverride = '   ';
    const put = matrixPutBody(s).phases[0]!;
    expect('output' in put).toBe(true);
    expect(put.output).toBeNull();
  });
});

describe('capabilityGroups', () => {
  it('groups every card type under its capability, unknown capabilities kept visibly', () => {
    const groups = capabilityGroups(
      [{ id: 'cap', name: 'qa', title: 'QA' }],
      [
        { id: 'c1', name: 'a', title: 'A', capability_id: 'cap' },
        { id: 'c9', name: 'z', title: 'Z', capability_id: 'gone' },
      ],
    );
    expect(groups.map((g) => [g.capability.id, g.cardTypes.map((c) => c.id)])).toEqual([
      ['cap', ['c1']],
      ['gone', ['c9']],
    ]);
    expect(groups[1]!.capability.title).toBe('Unknown capability gone');
  });
});
