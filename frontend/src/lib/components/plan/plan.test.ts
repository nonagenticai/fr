// plan.test.ts — the milestone words on Plan & scope (R6 / C10) and the per-phase capability
// grouping (§3). A closed project's milestone state is DERIVED from its target date and the closing
// date, and the words say so; nothing here claims a completion fr does not hold. Capabilities are
// grouped by the phase the CARD records, never by a date, and spend no card owns is not a capability.
import { describe, it, expect } from 'vitest';
import { capabilitiesByPhase, dateWords, milestoneView, MILESTONE_BASIS_WORDS } from './plan';
import type { CostCardRow } from '$lib/types/cockpit';

const row = (over: Partial<CostCardRow>): CostCardRow => ({
  card_id: 'c1',
  cost: 1,
  calls: 1,
  phase: null,
  card_type: null,
  capability: null,
  ...over,
});

const PHASES = [
  { name: 'setup', label: 'Setup' },
  { name: 'execution', label: 'Execution' },
];

describe('capabilitiesByPhase', () => {
  it('groups each card under the phase IT records, in the project phase order', () => {
    const groups = capabilitiesByPhase(
      [
        row({ card_id: 'c1', phase: 'execution', capability: 'development' }),
        row({ card_id: 'c2', phase: 'setup', capability: 'project_management' }),
        row({ card_id: 'c3', phase: 'setup', capability: 'project_management' }),
      ],
      PHASES,
    );
    expect(groups).toEqual([
      { name: 'setup', label: 'Setup', capabilities: ['Project management'], cardsWithoutCapability: 0, cards: 2 },
      { name: 'execution', label: 'Execution', capabilities: ['Development'], cardsWithoutCapability: 0, cards: 1 },
    ]);
  });

  it('a card with no phase is a "Not tied to a phase" group, last — never guessed into one', () => {
    const groups = capabilitiesByPhase(
      [row({ card_id: 'c1', phase: null, capability: 'development' }), row({ card_id: 'c2', phase: 'setup', capability: 'qa' })],
      PHASES,
    );
    expect(groups.map((g) => [g.name, g.label])).toEqual([
      ['setup', 'Setup'],
      [null, 'Not tied to a phase'],
    ]);
  });

  it('spend no card owns is left out; cards whose type names no capability are counted, not named', () => {
    const groups = capabilitiesByPhase(
      [
        row({ card_id: null, phase: null, capability: null }),
        row({ card_id: 'c1', phase: 'execution', capability: null }),
        row({ card_id: 'c2', phase: 'execution', capability: 'development' }),
      ],
      PHASES,
    );
    expect(groups).toEqual([
      { name: 'execution', label: 'Execution', capabilities: ['Development'], cardsWithoutCapability: 1, cards: 2 },
    ]);
  });

  it('no rows is no groups — the page says "none", never invents one', () => {
    expect(capabilitiesByPhase([], PHASES)).toEqual([]);
  });
});

const m = (target_date: string | null, position = 1) => ({ position, name: 'Beta live', target_date });

describe('dateWords', () => {
  it('formats a date-only value in UTC without shifting the day', () => {
    expect(dateWords('2026-10-25')).toBe('25 Oct 2026');
    expect(dateWords('2026-10-25T23:30:00Z')).toBe('25 Oct 2026');
    expect(dateWords(null)).toBeNull();
  });
});

describe('milestoneView — a running project', () => {
  it('states the target date, or that there is none', () => {
    expect(milestoneView(m('2026-10-25'), false, null)).toMatchObject({
      state: 'scheduled',
      words: 'Target date 25 Oct 2026',
    });
    expect(milestoneView(m(null), false, null).words).toBe('No target date');
  });
});

describe('milestoneView — a closed project (C10), honestly', () => {
  it('a target date on or before the closing day reads as reached, derived from the dates', () => {
    const v = milestoneView(m('2026-10-25'), true, '2026-10-25T10:44:00Z');
    expect(v.state).toBe('reached');
    expect(v.words).toBe('Reached by its target date, 25 Oct 2026; the project closed 25 Oct 2026.');
  });

  it('a target date after the closure is NOT reached', () => {
    const v = milestoneView(m('2026-11-05'), true, '2026-10-25T10:44:00Z');
    expect(v.state).toBe('missed');
    expect(v.words).toContain('was after the project closed');
  });

  it('no target date, or no closing day, is "not recorded" — never reached', () => {
    expect(milestoneView(m(null), true, '2026-10-25T10:44:00Z').state).toBe('unknown');
    expect(milestoneView(m('2026-10-20'), true, null).state).toBe('unknown');
  });

  it('the panel-level caveat says the state is derived and no completion is recorded', () => {
    expect(MILESTONE_BASIS_WORDS).toContain('derived from the dates');
    expect(MILESTONE_BASIS_WORDS).toContain('no separate completion is recorded');
  });
});
