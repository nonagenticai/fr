import { describe, expect, it } from 'vitest';
import {
  ALL_CARDS,
  UNPLACED,
  boardFilterShown,
  blockedWords,
  cardCost,
  cardsInFilter,
  mergeFlowRuns,
  runStatusWords,
  sortFlowRuns,
  timeInColumnWords,
  type HookRunIn,
} from './board';
import type { BoardCard } from '$lib/types/cockpit';

const phases = [{ name: 'setup' }, { name: 'execution' }, { name: 'closure' }];

describe('boardFilterShown', () => {
  it('the pick wins; else the current phase; else the first phase; no phases ⇒ every card', () => {
    expect(boardFilterShown(phases, 'execution', 'setup')).toBe('setup');
    expect(boardFilterShown(phases, 'execution', null)).toBe('execution');
    expect(boardFilterShown(phases, 'execution', 'not-a-phase')).toBe('execution');
    expect(boardFilterShown(phases, null, null)).toBe('setup');
    expect(boardFilterShown([], 'execution', null)).toBe(ALL_CARDS);
    expect(boardFilterShown(phases, 'execution', UNPLACED)).toBe(UNPLACED);
  });
});

const c = (id: string, phase: string | null): Pick<BoardCard, 'id' | 'phase'> => ({ id, phase });

describe('cardsInFilter', () => {
  it('filters on the exact phase only', () => {
    const cards = [c('a', 'setup'), c('b', 'execution'), c('z', null)] as BoardCard[];
    expect(cardsInFilter(cards, 'execution').map((x) => x.id)).toEqual(['b']);
    expect(cardsInFilter(cards, UNPLACED).map((x) => x.id)).toEqual(['z']);
    expect(cardsInFilter(cards, ALL_CARDS)).toHaveLength(3);
  });
});

describe('timeInColumnWords / blockedWords', () => {
  const now = Date.parse('2026-10-27T12:00:00Z');
  it('says how long, or when it was done, or that it is not recorded', () => {
    expect(timeInColumnWords({ in_column_since: '2026-10-27T11:48:00Z', list_name: 'Doing', done: false }, now)).toBe('In Doing 12 min');
    expect(timeInColumnWords({ in_column_since: null, list_name: 'Doing', done: false }, now)).toBe('In Doing; when it arrived is not recorded');
    expect(timeInColumnWords({ in_column_since: '2026-10-27T11:48:00Z', list_name: 'Done', done: true }, now)).toMatch(/^Done /);
  });
  it('a blocked card shows its reason, or says none was recorded', () => {
    expect(blockedWords({ blocked: true, block_reason: 'tests fail', block_kind: 'lane' })).toBe('Blocked: tests fail');
    expect(blockedWords({ blocked: true, block_reason: null, block_kind: 'lane' })).toBe('Blocked: no reason was recorded on the card');
    expect(blockedWords({ blocked: false, block_reason: null, block_kind: null })).toBeNull();
  });
});

const hook = (id: string, status: string, started: string, extra: Partial<HookRunIn> = {}): HookRunIn => ({
  execution_id: id,
  workflow_id: 'w',
  workflow_name: `flow-${id}`,
  card_id: 'c1',
  status,
  n8n_status: status,
  started_at: started,
  stopped_at: started,
  failed_node: null,
  error_class: null,
  ...extra,
});

describe('mergeFlowRuns / sortFlowRuns', () => {
  it('one row per execution: the hook row wins, a member run adds who started it', () => {
    const rows = mergeFlowRuns(
      [hook('1', 'success', '2026-10-27T10:00:00Z')],
      [
        { id: '1', status: 'success', started_by: 'you' },
        { id: '2', status: 'error', workflow_id: 'wf-2', started_at: '2026-10-27T09:00:00Z', stopped_at: '2026-10-27T09:05:00Z', started_by: 'a member' },
      ],
    );
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.execution_id === '1')).toMatchObject({ source: 'conveyor', flow: 'flow-1', started_by: 'you' });
    expect(rows.find((r) => r.execution_id === '2')).toMatchObject({ source: 'member', flow: 'wf-2', duration_ms: 300_000 });
  });

  it('while running, failures come first (newest first in each group); finished = newest first', () => {
    const rows = mergeFlowRuns(
      [
        hook('a', 'success', '2026-10-27T12:00:00Z'),
        hook('b', 'error', '2026-10-27T10:00:00Z'),
        hook('c', 'crashed', '2026-10-27T11:00:00Z'),
        hook('d', 'success', '2026-10-27T09:00:00Z'),
      ],
      [],
    );
    expect(sortFlowRuns(rows, true).map((r) => r.execution_id)).toEqual(['c', 'b', 'a', 'd']);
    expect(sortFlowRuns(rows, false).map((r) => r.execution_id)).toEqual(['a', 'c', 'b', 'd']);
  });

  it('status words: the conveyor verdict, n8n status apart', () => {
    expect(runStatusWords({ status: 'error', n8n_status: 'success' })).toBe('Failed');
    expect(runStatusWords({ status: 'waiting', n8n_status: 'waiting' })).toBe('Waiting');
  });
});

describe('cardCost', () => {
  const base = { by_card_since: '2026-10-25T00:00:00Z', currency: 'USD' };
  it('an amount when billing attributed calls to the card', () => {
    expect(cardCost({ ...base, by_card: [{ card_id: 'c1', cost: 1.5, calls: 4 }] }, 'c1')).toEqual({ kind: 'amount', cost: 1.5, calls: 4, currency: 'USD' });
  });
  it('no call carries a card ⇒ "not attributed", never $0', () => {
    expect(cardCost({ ...base, by_card: [{ card_id: null, cost: 9, calls: 30 }] }, 'c1')).toEqual({ kind: 'not_attributed', unattributed_calls: 30 });
    expect(cardCost({ ...base, by_card: [] }, 'c1')).toEqual({ kind: 'not_attributed', unattributed_calls: 0 });
  });
  it('other cards attributed, this one not ⇒ none recorded since …; billing unread ⇒ unavailable', () => {
    expect(cardCost({ ...base, by_card: [{ card_id: 'c2', cost: 1, calls: 1 }] }, 'c1')).toEqual({ kind: 'none_recorded', since: base.by_card_since });
    expect(cardCost(null, 'c1')).toEqual({ kind: 'unavailable' });
  });
});
