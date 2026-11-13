// tests/unit/services/cockpit/cockpit-status.test.ts
//
// R-CK4: the ONE state chip, derived by fr. Table-driven over the precedence
// completed/cancelled > paused > blocked > waiting_on_you > running.
import { describe, expect, test } from 'bun:test';

import {
  deriveCockpitState,
  isFinishedState,
  unresolvedFlowFailures,
  type StatusInputs,
} from '../../../../src/services/cockpit/cockpit-status';

const base: StatusInputs = {
  frStatus: 'active',
  rmStatus: 'executing',
  andonEngaged: false,
  openApprovals: 0,
  blockedCards: 0,
  unresolvedFlowFailures: 0,
};

// FR-PROJECT-HOME-REDESIGN §4: Running · Waiting on you · Blocked · Paused (andon) · Completed · Cancelled.
const TABLE: { name: string; over: Partial<StatusInputs>; state: string; reasons: string[] }[] = [
  { name: 'nothing special', over: {}, state: 'running', reasons: [] },
  { name: 'RM closed ⇒ completed, even with open asks', over: { rmStatus: 'closed', openApprovals: 8 }, state: 'completed', reasons: ['rm_closed'] },
  { name: 'fr delivered ⇒ completed', over: { frStatus: 'delivered', andonEngaged: true }, state: 'completed', reasons: ['project_delivered'] },
  { name: 'fr archived, RM not closed ⇒ cancelled', over: { frStatus: 'archived' }, state: 'cancelled', reasons: ['project_archived'] },
  { name: 'fr archived AND RM closed ⇒ completed (RM wins)', over: { frStatus: 'archived', rmStatus: 'closed' }, state: 'completed', reasons: ['rm_closed'] },
  { name: 'andon engaged ⇒ paused, outranks asks', over: { andonEngaged: true, openApprovals: 2 }, state: 'paused', reasons: ['andon_engaged'] },
  { name: 'paused outranks blocked', over: { andonEngaged: true, blockedCards: 2 }, state: 'paused', reasons: ['andon_engaged'] },
  { name: 'a blocked card', over: { blockedCards: 1 }, state: 'blocked', reasons: ['card_blocked'] },
  { name: 'a failed flow, no later success', over: { unresolvedFlowFailures: 1 }, state: 'blocked', reasons: ['flow_failed'] },
  {
    name: 'every blocker at once',
    over: { blockedCards: 2, unresolvedFlowFailures: 1, openApprovals: 1 },
    state: 'blocked',
    reasons: ['card_blocked', 'flow_failed'],
  },
  { name: 'an open ask', over: { openApprovals: 1 }, state: 'waiting_on_you', reasons: ['open_approvals'] },
  { name: 'RM unreadable is still running', over: { rmStatus: null }, state: 'running', reasons: [] },
];

describe('deriveCockpitState — the derived-state table', () => {
  for (const row of TABLE) {
    test(row.name, () => {
      const d = deriveCockpitState({ ...base, ...row.over });
      expect(d.state).toBe(row.state as never);
      expect(d.reasons).toEqual(row.reasons as never);
    });
  }
});

describe('unresolvedFlowFailures', () => {
  const run = (id: string, wf: string, card: string | null, status: string, at: string) => ({
    execution_id: id,
    workflow_id: wf,
    workflow_name: wf,
    card_id: card,
    status,
    started_at: new Date(at),
    stopped_at: null,
    received_at: new Date(at),
  });

  test('a failure followed by a success of the same flow on the same card is resolved', () => {
    const rows = [run('1', 'qa', 'c1', 'error', '2026-10-25T10:00:00Z'), run('2', 'qa', 'c1', 'success', '2026-10-25T10:05:00Z')];
    expect(unresolvedFlowFailures(rows as never)).toEqual([]);
  });

  test('a success on ANOTHER card does not resolve it', () => {
    const rows = [run('1', 'qa', 'c1', 'error', '2026-10-25T10:00:00Z'), run('2', 'qa', 'c2', 'success', '2026-10-25T10:05:00Z')];
    expect(unresolvedFlowFailures(rows as never).map((r) => r.execution_id)).toEqual(['1']);
  });

  test('a failure AFTER the success is unresolved; running/waiting rows do not count either way', () => {
    const rows = [
      run('1', 'dev', 'c1', 'success', '2026-10-25T10:00:00Z'),
      run('2', 'dev', 'c1', 'crashed', '2026-10-25T10:10:00Z'),
      run('3', 'dev', 'c1', 'running', '2026-10-25T10:20:00Z'),
      run('4', 'dev', 'c1', 'waiting', '2026-10-25T10:30:00Z'),
    ];
    expect(unresolvedFlowFailures(rows as never).map((r) => r.execution_id)).toEqual(['2']);
  });
});

describe('isFinishedState', () => {
  test('only completed and cancelled are finished', () => {
    expect(['running', 'waiting_on_you', 'blocked', 'paused', 'completed', 'cancelled'].filter((x) => isFinishedState(x as never))).toEqual([
      'completed',
      'cancelled',
    ]);
  });
});
