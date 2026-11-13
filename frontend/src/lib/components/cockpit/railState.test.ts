import { describe, it, expect } from 'vitest';
import { deriveRailState, formatAge, readinessWord } from './railState';
import type { PhaseColumn, CockpitCard } from '$lib/types/cockpit';

const col = (over: Partial<PhaseColumn>): PhaseColumn => ({
  phase: 'DOING',
  list_name: 'Doing',
  count: 0,
  active: false,
  oldest_card_age_ms: null,
  ...over,
});

const card = (over: Partial<CockpitCard>): CockpitCard => ({
  id: 'c1',
  name: 'Card',
  phase: 'PUBLISHING',
  list_name: 'Publishing',
  labels: [],
  age_in_phase_ms: null,
  updated_at: null,
  blocked: true,
  blocked_reason: 'awaiting approval',
  ...over,
});

describe('formatAge', () => {
  it('passes null through', () => expect(formatAge(null)).toBeNull());
  it('reads sub-minute as just now', () => expect(formatAge(5_000)).toBe('just now'));
  it('reads minutes / hours / days', () => {
    expect(formatAge(45 * 60_000)).toBe('45m');
    expect(formatAge(3 * 3_600_000)).toBe('3h');
    expect(formatAge(2 * 86_400_000)).toBe('2d');
  });
});

describe('deriveRailState', () => {
  it('marks the busiest in-flight column active and empties clear', () => {
    const rail = [col({ phase: 'READYING', count: 0 }), col({ phase: 'DOING', count: 2, active: true })];
    const out = deriveRailState(rail, []);
    expect(out.find((c) => c.phase === 'READYING')!.state).toBe('empty');
    expect(out.find((c) => c.phase === 'DOING')!.state).toBe('active');
  });

  it('overlays gate when a blocked card sits in the phase (over active)', () => {
    const rail = [col({ phase: 'PUBLISHING', count: 1, active: true })];
    const out = deriveRailState(rail, [card({ phase: 'PUBLISHING' })]);
    expect(out[0].state).toBe('gate');
  });

  it('does not gate an empty column even if a stray blocked card names it', () => {
    const rail = [col({ phase: 'PUBLISHING', count: 0 })];
    const out = deriveRailState(rail, [card({ phase: 'PUBLISHING' })]);
    expect(out[0].state).toBe('empty');
  });

  it('surfaces the oldest-card age label', () => {
    const rail = [col({ phase: 'DOING', count: 1, oldest_card_age_ms: 3 * 3_600_000 })];
    expect(deriveRailState(rail, [])[0].age_label).toBe('3h');
  });
});

describe('deriveRailState — DONE is terminal', () => {
  it('labels a populated Done column "done", never in flight/active, with no age', () => {
    const rail = [
      col({ phase: 'PUBLISHING', list_name: 'DONE', count: 9, oldest_card_age_ms: 2 * 3_600_000 }),
      col({ phase: 'DOING', count: 0 }),
    ];
    const done = deriveRailState(rail, [])[0];
    expect(done.state).toBe('done');
    expect(readinessWord(done.state)).toBe('done');
    expect(done.age_label).toBeNull();
  });

  it('a Done column the backend marked busiest is still done, not active', () => {
    const out = deriveRailState([col({ phase: 'PUBLISHING', count: 3, active: true })], []);
    expect(out[0].state).toBe('done');
  });

  it('an empty Done column stays clear', () => {
    expect(deriveRailState([col({ phase: 'PUBLISHING', count: 0 })], [])[0].state).toBe('empty');
  });
});

describe('readinessWord', () => {
  it('names each state', () => {
    expect(readinessWord('active')).toBe('active');
    expect(readinessWord('gate')).toBe('needs you');
    expect(readinessWord('empty')).toBe('clear');
    expect(readinessWord('has-work')).toBe('in flight');
  });
});
