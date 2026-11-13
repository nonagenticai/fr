// R5 board read model (services/cockpit/board.ts): columns in Planka order, time in column, blocked
// reasons, the exact phase from the spine, waits on a person apart from blocks.
import { describe, expect, it } from 'bun:test';

import { composeBoard, type BoardIn } from '../../../../src/services/cockpit/board';
import { normalizePhase } from '../../../../src/services/cockpit/project-cockpit';

function board(): BoardIn {
  return {
    included: {
      lists: [
        { id: 'l-done', name: 'DONE', position: 5 },
        { id: 'l-todo', name: 'TODO', position: 1 },
        { id: 'l-blocked', name: 'BLOCKED', position: 4 },
        { id: 'l-doing', name: 'DOING', position: 2 },
        { id: 'l-arch', name: 'Archive', position: 9, type: 'archive' },
      ],
      cards: [
        { id: 'c1', name: 'Setup', listId: 'l-done', position: 1, listChangedAt: '2026-10-27T10:00:00Z', createdAt: '2026-10-27T09:00:00Z', commentsTotal: 2 },
        { id: 'c2', name: 'Fix', listId: 'l-blocked', position: 2, listChangedAt: '2026-10-27T11:00:00Z' },
        { id: 'c3', name: 'Write', listId: 'l-todo', position: 3, createdAt: '2026-10-27T11:30:00Z' },
        { id: 'c4', name: 'Doing labelled', listId: 'l-doing', position: 4 },
        { id: 'c5', name: 'Flow failed', listId: 'l-doing', position: 5 },
        { id: 'c6', name: 'Archived', listId: 'l-arch', position: 6 },
        { id: 'c7', name: 'Waiting', listId: 'l-doing', position: 7 },
      ],
      labels: [{ id: 'lab', name: 'On hold' }],
      cardLabels: [{ cardId: 'c4', labelId: 'lab' }],
      customFields: [
        { id: 'f-reason', name: 'block_reason' },
        { id: 'f-type', name: 'card_type' },
      ],
      customFieldValues: [
        { cardId: 'c2', customFieldId: 'f-reason', content: 'tests fail on import' },
        { cardId: 'c1', customFieldId: 'f-type', content: 'project_setup' },
      ],
    },
  };
}

const compose = (over: Partial<Parameters<typeof composeBoard>[0]> = {}) =>
  composeBoard({
    boardId: 'b-1',
    board: board(),
    normalize: normalizePhase,
    phases: new Map([
      ['c1', { phase: 'setup', placed_by: 'card_phase' as const }],
      ['c2', { phase: 'execution', placed_by: 'card_phase' as const }],
    ]),
    approvals: [
      { id: 'a-1', status: 'pending', card_id: 'c7', description: 'Approve the plan', created_at: '2026-10-27T11:00:00Z' },
      { id: 'a-0', status: 'approved', card_id: 'c3', description: 'old', created_at: null },
    ],
    flowFailures: [
      { card_id: 'c5', workflow_name: 'ct.fix.doing', workflow_id: 'w', failed_node: 'Run tests' },
      { card_id: 'c1', workflow_name: 'ct.setup.done', workflow_id: 'w', failed_node: null },
    ],
    ...over,
  });

describe('composeBoard', () => {
  it('columns in Planka position order; archive/trash lists and their cards left out', () => {
    const b = compose();
    expect(b.columns.map((c) => c.name)).toEqual(['TODO', 'DOING', 'BLOCKED', 'DONE']);
    expect(b.columns.map((c) => c.kind)).toEqual(['READYING', 'DOING', 'BLOCKED', 'PUBLISHING']);
    expect(b.cards.map((c) => c.id)).not.toContain('c6');
  });

  it('time in column: listChangedAt, else creation, with its basis', () => {
    const b = compose();
    const by = new Map(b.cards.map((c) => [c.id, c]));
    expect(by.get('c2')).toMatchObject({ in_column_since: '2026-10-27T11:00:00Z', in_column_basis: 'moved' });
    expect(by.get('c3')).toMatchObject({ in_column_since: '2026-10-27T11:30:00Z', in_column_basis: 'created' });
    expect(by.get('c4')).toMatchObject({ in_column_since: null, in_column_basis: null });
  });

  it('blocked: lane with its block_reason, label, and an unsuperseded flow failure — never a done card', () => {
    const by = new Map(compose().cards.map((c) => [c.id, c]));
    expect(by.get('c2')).toMatchObject({ blocked: true, block_kind: 'lane', block_reason: 'tests fail on import' });
    expect(by.get('c4')).toMatchObject({ blocked: true, block_kind: 'label', block_reason: 'Labelled "On hold"' });
    expect(by.get('c5')).toMatchObject({ blocked: true, block_kind: 'flow_failed', block_reason: 'ct.fix.doing failed at step "Run tests"' });
    expect(by.get('c1')).toMatchObject({ blocked: false, block_kind: null, done: true });
  });

  it('an open approval is a wait on a person, not a block', () => {
    const by = new Map(compose().cards.map((c) => [c.id, c]));
    expect(by.get('c7')).toMatchObject({ blocked: false, waiting_on: { approval_id: 'a-1', description: 'Approve the plan' } });
    expect(by.get('c3')?.waiting_on).toBeNull();
  });

  it('phase is exactly the spine placement; the rest is counted unplaced', () => {
    const b = compose();
    const by = new Map(b.cards.map((c) => [c.id, c]));
    expect(by.get('c1')).toMatchObject({ phase: 'setup', placed_by: 'card_phase', card_type: 'project_setup', comment_count: 2 });
    expect(by.get('c3')).toMatchObject({ phase: null, placed_by: null, comment_count: null });
    expect(b.unplaced).toBe(4);
  });

  it('a break-glass DONE card is not done work', () => {
    const by = new Map(compose({ humanOverrideCardIds: new Set(['c1']) }).cards.map((c) => [c.id, c]));
    expect(by.get('c1')).toMatchObject({ kind: 'OTHER', done: false });
  });
});
