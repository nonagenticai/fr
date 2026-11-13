// R4 helpers: a phase tag only for an exact phase; history = decided rows, newest first.
import { describe, expect, it } from 'vitest';
import { historyRows, openItems, outcomeWords, phaseTag, readerHref } from './needsYou';
import type { CockpitActionItem, CockpitDecision } from '$lib/types/cockpit';

const labels = new Map([['execution', 'Execution']]);

describe('phaseTag', () => {
  it('labels an exact phase, falls back to its name, and tags nothing without one', () => {
    expect(phaseTag('execution', labels)).toBe('Execution');
    expect(phaseTag('closure', labels)).toBe('closure');
    expect(phaseTag(null, labels)).toBeNull();
    expect(phaseTag('', labels)).toBeNull();
  });
});

describe('historyRows', () => {
  const d = (id: string, open: boolean, decided_at: string | null) => ({ approval_id: id, open, decided_at }) as CockpitDecision;
  it('drops open rows and sorts by decision time, newest first, undated last', () => {
    const rows = historyRows([d('a', false, '2026-10-27T08:00:00Z'), d('b', true, null), d('c', false, null), d('e', false, '2026-10-27T09:00:00Z')]);
    expect(rows.map((r) => r.approval_id)).toEqual(['e', 'a', 'c']);
  });
});

describe('openItems / outcomeWords / readerHref', () => {
  it('hides only the items decided here, keeping the server order', () => {
    const i = (key: string) => ({ key }) as CockpitActionItem;
    expect(openItems([i('x'), i('y'), i('z')], new Set(['y'])).map((r) => r.key)).toEqual(['x', 'z']);
  });
  it('prefers the written answer, else the decision word', () => {
    expect(outcomeWords({ answer: 'FIFO', decision: 'approved' })).toBe('FIFO');
    expect(outcomeWords({ answer: null, decision: 'approved' })).toBe('Approved');
    expect(outcomeWords({ answer: '  ', decision: 'rejected' })).toBe('Rejected');
  });
  it('links a review to the document reader', () => {
    expect(readerHref('p 1', 'a/b')).toBe('/projects/p%201/documents/a%2Fb');
  });
});
