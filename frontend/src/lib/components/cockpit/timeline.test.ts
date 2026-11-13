import { describe, it, expect } from 'vitest';
import { eventKicker, filterEvents, TIMELINE_FILTERS } from './timeline';
import type { TimelineEvent } from '$lib/types/cockpit';

const ev = (over: Partial<TimelineEvent>): TimelineEvent => ({
  id: 'e1',
  type: 'worker_inference',
  at: '2026-07-08T09:14:00Z',
  title: 'A narrow worker inference ran',
  card_id: null,
  execution_id: null,
  correlation_id: null,
  status: null,
  pills: [],
  ...over,
});

describe('eventKicker', () => {
  it('gives a customer-safe label per type', () => {
    expect(eventKicker('phase_transition')).toBe('Card phase transition');
    expect(eventKicker('qa_verdict')).toBe('QA verdict');
    expect(eventKicker('kag_write')).toBe('Knowledge memory write');
    // A decision is not necessarily a person's: the approval agent decides most conveyor sign-offs (R-CK1).
    expect(eventKicker('decision_write')).toBe('Decision');
  });
});

describe('filterEvents', () => {
  const events = [ev({ id: 'a', type: 'worker_inference' }), ev({ id: 'b', type: 'qa_verdict' })];

  it("returns everything for 'all'", () => {
    expect(filterEvents(events, 'all')).toHaveLength(2);
  });
  it('narrows to a single type', () => {
    expect(filterEvents(events, 'qa_verdict').map((e) => e.id)).toEqual(['b']);
  });
});

describe('TIMELINE_FILTERS', () => {
  it("starts with 'all'", () => expect(TIMELINE_FILTERS[0]).toBe('all'));
  // improvement-loop is not a source (F4): there is no conveyor-run filter any more.
  it('offers no conveyor-run filter', () => expect(TIMELINE_FILTERS as readonly string[]).not.toContain('conveyor_run'));
});
