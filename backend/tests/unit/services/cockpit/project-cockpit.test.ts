// tests/unit/services/cockpit/project-cockpit.test.ts
//
// Unit coverage for the project-cockpit read-model's PURE composers — the
// functions that hold the real logic (phase-rail derivation, timeline
// composition, goal coverage). DB- and upstream-touching paths were covered by
// the project-cockpit integration suite, deleted 2026-10-29 — no longer in the suite.

import { test, expect, describe } from 'bun:test';
import {
  normalizePhase,
  deriveBoardViews,
  composeTimeline,
  deriveGoal,
  filterActionableArtifacts,
  selectConveyorReports,
  tallyBoundByKind,
  type CockpitApproval,
  type CockpitCard,
} from '../../../../src/services/cockpit/project-cockpit';
import type { BoardDetail, Card, List } from '../../../../src/services/planka/types';
import type { GraphExecutionSession } from '../../../../src/integrations/workers';
import type { ArtifactOut } from '../../../../src/integrations/artifacts';

const NOW = Date.parse('2026-07-08T12:00:00.000Z');
const HOUR = 3600_000;

function makeList(id: string, name: string): List {
  return {
    id,
    boardId: 'b1',
    type: 'active',
    position: 0,
    name,
    color: null,
    createdAt: null,
    updatedAt: null,
  } as List;
}

function makeCard(partial: Partial<Card> & { id: string; listId: string; name: string }): Card {
  return {
    boardId: 'b1',
    creatorUserId: null,
    prevListId: null,
    type: 'project',
    position: 0,
    description: null,
    dueDate: null,
    isDueCompleted: null,
    stopwatch: null,
    commentsTotal: 0,
    isClosed: false,
    listChangedAt: null,
    createdAt: null,
    updatedAt: null,
    ...partial,
  } as Card;
}

function makeBoard(lists: List[], cards: Card[], extra?: Partial<BoardDetail['included']>): BoardDetail {
  return {
    item: { id: 'b1' } as BoardDetail['item'],
    included: { lists, cards, labels: [], cardLabels: [], ...extra },
  };
}

describe('normalizePhase', () => {
  test('maps mantra column names onto canonical phases', () => {
    expect(normalizePhase('Readying')).toBe('READYING');
    expect(normalizePhase('DOING')).toBe('DOING');
    expect(normalizePhase('In Progress')).toBe('DOING');
    expect(normalizePhase('Inspecting')).toBe('INSPECTING');
    expect(normalizePhase('QA Review')).toBe('INSPECTING');
    expect(normalizePhase('Publishing')).toBe('PUBLISHING');
    expect(normalizePhase('Done')).toBe('PUBLISHING');
    expect(normalizePhase('Backlog')).toBe('OTHER');
    // One mapping with the Board (UI review 2026-10-07).
    expect(normalizePhase('TODO')).toBe('READYING');
    expect(normalizePhase('BLOCKED')).toBe('BLOCKED');
    expect(normalizePhase(null)).toBe('OTHER');
  });
});

describe('deriveBoardViews', () => {
  const lists = [
    makeList('l-ready', 'Readying'),
    makeList('l-doing', 'Doing'),
    makeList('l-inspect', 'Inspecting'),
    makeList('l-publish', 'Publishing'),
  ];

  test('counts phases, picks active column, and splits active/blocked cards', () => {
    const cards = [
      makeCard({ id: 'c1', listId: 'l-doing', name: 'Doing A', listChangedAt: new Date(NOW - 2 * HOUR).toISOString() }),
      makeCard({ id: 'c2', listId: 'l-doing', name: 'Doing B', listChangedAt: new Date(NOW - 5 * HOUR).toISOString() }),
      makeCard({ id: 'c3', listId: 'l-inspect', name: 'Inspecting A' }),
      makeCard({ id: 'c4', listId: 'l-publish', name: 'Published A' }),
      makeCard({ id: 'c5', listId: 'l-ready', name: 'Ready A' }),
    ];
    const board = makeBoard(lists, cards);
    const { phase_rail, active_cards, blocked_cards } = deriveBoardViews(board, new Set(), NOW);

    const doing = phase_rail.find((p) => p.phase === 'DOING')!;
    expect(doing.count).toBe(2);
    expect(doing.active).toBe(true); // most in-flight → active column
    expect(doing.oldest_card_age_ms).toBe(5 * HOUR);

    expect(phase_rail.find((p) => p.phase === 'PUBLISHING')!.count).toBe(1);
    // active_cards = DOING + INSPECTING, none blocked
    expect(active_cards.map((c) => c.id).sort()).toEqual(['c1', 'c2', 'c3']);
    expect(blocked_cards).toHaveLength(0);
    // OTHER column is omitted when empty
    expect(phase_rail.some((p) => p.phase === 'OTHER')).toBe(false);
  });

  test('marks cards blocked by a pending-approval gate and by a blocked label', () => {
    const cards = [
      makeCard({ id: 'c1', listId: 'l-doing', name: 'Gated', listChangedAt: new Date(NOW - HOUR).toISOString() }),
      makeCard({ id: 'c2', listId: 'l-doing', name: 'Labelled blocked' }),
      makeCard({ id: 'c3', listId: 'l-doing', name: 'Fine' }),
    ];
    const board = makeBoard(lists, cards, {
      labels: [{ id: 'lab1', boardId: 'b1', name: 'blocked', color: 'berry-red', position: 0, createdAt: null, updatedAt: null } as never],
      cardLabels: [{ id: 'cl1', cardId: 'c2', labelId: 'lab1', createdAt: null } as never],
    });

    const { active_cards, blocked_cards } = deriveBoardViews(board, new Set(['c1']), NOW);
    expect(blocked_cards.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(blocked_cards.find((c) => c.id === 'c1')!.blocked_reason).toBe('awaiting approval');
    expect(blocked_cards.find((c) => c.id === 'c2')!.blocked_reason).toBe('labelled blocked');
    // blocked cards are excluded from active_cards
    expect(active_cards.map((c) => c.id)).toEqual(['c3']);
  });
});

describe('deriveBoardViews — the BLOCKED lane', () => {
  test('a card in the BLOCKED list is blocked, has its own column, and is not active', () => {
    const lists = [
      makeList('l-todo', 'TODO'),
      makeList('l-doing', 'DOING'),
      makeList('l-blocked', 'BLOCKED'),
      makeList('l-done', 'DONE'),
    ];
    const cards = [
      makeCard({ id: 'c1', listId: 'l-blocked', name: 'Stuck' }),
      makeCard({ id: 'c2', listId: 'l-blocked', name: 'Stuck too' }),
      makeCard({ id: 'c3', listId: 'l-todo', name: 'Waiting' }),
      makeCard({ id: 'c4', listId: 'l-done', name: 'Shipped' }),
    ];
    const { phase_rail, active_cards, blocked_cards } = deriveBoardViews(
      makeBoard(lists, cards),
      new Set(),
      NOW,
    );
    expect(blocked_cards.map((c) => c.id).sort()).toEqual(['c1', 'c2']);
    expect(blocked_cards[0]!.blocked_reason).toBe('in the BLOCKED lane');
    expect(phase_rail.find((p) => p.phase === 'BLOCKED')!.count).toBe(2);
    expect(phase_rail.find((p) => p.phase === 'READYING')!.count).toBe(1);
    expect(phase_rail.some((p) => p.phase === 'OTHER')).toBe(false);
    expect(active_cards).toHaveLength(0);
  });

  test('the BLOCKED column is omitted when the lane is empty', () => {
    const { phase_rail } = deriveBoardViews(
      makeBoard([makeList('l-doing', 'DOING')], [makeCard({ id: 'c1', listId: 'l-doing', name: 'x' })]),
      new Set(),
      NOW,
    );
    expect(phase_rail.some((p) => p.phase === 'BLOCKED')).toBe(false);
  });
});

describe('composeTimeline', () => {
  const baseSession = (over: Partial<GraphExecutionSession>): GraphExecutionSession => ({
    session_id: 's1',
    graph_id: 'g1',
    status: 'completed',
    validation_passed: null,
    correlation_id: 'corr-1',
    request_payload: {},
    final_response: {},
    created_at: new Date(NOW - 3 * HOUR).toISOString(),
    completed_at: new Date(NOW - 2 * HOUR).toISOString(),
    ...over,
  });

  test('emits typed_action, worker_inference, qa_verdict, decision_write and phase_transition, sorted desc', () => {
    const mappings = [
      { execution_id: '1001', workflow_id: 'wf-1', correlation_id: 'corr-1', triggered_at: new Date(NOW - 4 * HOUR).toISOString() },
    ];
    const sessions = [
      baseSession({ session_id: 's-pass', validation_passed: true }),
      baseSession({ session_id: 's-null', validation_passed: null }),
    ];
    const approvals: CockpitApproval[] = [
      {
        id: 'a1',
        kind: 'generic',
        status: 'approved',
        description: 'x',
        card_id: 'c1',
        created_at: null,
        expires_at: null,
        metadata: null,
        required_approvers: [],
        decisions: [
          {
            approver_id: 'u1',
            decision: 'approved',
            comment: null,
            decided_at: new Date(NOW - HOUR).toISOString(),
            decided_by_kind: 'human',
          },
        ],
        tenant_id: 't1',
        source: 'n8n',
        requester_id: null,
        action_id: null,
        change_summary: null,
        impact_analysis: null,
      },
    ];
    const cards: CockpitCard[] = [
      { id: 'c1', name: 'C1', phase: 'DOING', list_name: 'Doing', labels: [], age_in_phase_ms: 6 * HOUR, updated_at: null, blocked: false, blocked_reason: null },
    ];

    const events = composeTimeline({ mappings, sessions, approvals, cards, now: NOW });

    const types = events.map((e) => e.type);
    expect(types).toContain('typed_action');
    expect(types).toContain('worker_inference');
    expect(types).toContain('qa_verdict');
    expect(types).toContain('decision_write');
    expect(types).toContain('phase_transition');

    // qa_verdict only for the session with a non-null validation verdict
    expect(events.filter((e) => e.type === 'qa_verdict')).toHaveLength(1);
    // worker_inference for BOTH sessions
    expect(events.filter((e) => e.type === 'worker_inference')).toHaveLength(2);

    // sorted strictly descending by timestamp
    const ts = events.map((e) => Date.parse(e.at));
    expect(ts).toEqual([...ts].sort((a, b) => b - a));

    // decision_write carries the correct tone + card linkage
    const decision = events.find((e) => e.type === 'decision_write')!;
    expect(decision.card_id).toBe('c1');
    expect(decision.pills[0]!.tone).toBe('success');
  });

  test('caps the timeline at 60 events', () => {
    const mappings = Array.from({ length: 100 }, (_, i) => ({
      execution_id: String(i),
      workflow_id: 'wf',
      correlation_id: 'corr',
      triggered_at: new Date(NOW - i * 1000).toISOString(),
    }));
    const events = composeTimeline({ mappings, sessions: [], approvals: [], cards: [], now: NOW });
    expect(events).toHaveLength(60);
    // newest first
    expect(events[0]!.execution_id).toBe('0');
  });
});

describe('deriveGoal', () => {
  test('computes coverage as published / total, plus open gates', () => {
    const rail = [
      { phase: 'READYING' as const, list_name: 'Readying', count: 2, active: false, oldest_card_age_ms: null },
      { phase: 'DOING' as const, list_name: 'Doing', count: 3, active: true, oldest_card_age_ms: null },
      { phase: 'PUBLISHING' as const, list_name: 'Publishing', count: 5, active: false, oldest_card_age_ms: null },
    ];
    const goal = deriveGoal(rail, 2);
    expect(goal.cards_total).toBe(10);
    expect(goal.cards_published).toBe(5);
    expect(goal.coverage_pct).toBe(50);
    expect(goal.open_gates).toBe(2);
  });

  test('coverage is 0 when the board is empty', () => {
    expect(deriveGoal([], 0)).toEqual({ cards_total: 0, cards_published: 0, coverage_pct: 0, open_gates: 0 });
  });
});

describe('filterActionableArtifacts', () => {
  const artifact = (over: Partial<ArtifactOut> & { id: string }): ArtifactOut =>
    ({
      version: 1,
      filename: `${over.id}.md`,
      content_type: 'text/markdown',
      kind: 'document',
      project_id: 'p1',
      sensitivity: 'internal',
      size: 10,
      sha256: 'x',
      storage_key: 'k',
      created_at: '2026-07-08T00:00:00.000Z',
      created_by: 'agent',
      ...over,
    }) as ArtifactOut;

  test('keeps only pending / needs_revision and projects to the customer-safe shape', () => {
    const rows = [
      artifact({ id: 'a-pending', status: 'pending' }),
      artifact({ id: 'a-revise', status: 'needs_revision' }),
      artifact({ id: 'a-approved', status: 'approved' }),
      artifact({ id: 'a-rejected', status: 'rejected' }),
      artifact({ id: 'a-nostatus' }), // status undefined ⇒ dropped
    ];
    const out = filterActionableArtifacts(rows);
    expect(out.map((a) => a.id).sort()).toEqual(['a-pending', 'a-revise']);
    // projected shape: no storage_key / sha256 / size leak to the customer view
    expect(out[0]).toEqual({
      id: 'a-pending',
      filename: 'a-pending.md',
      kind: 'document',
      project_id: 'p1',
      created_at: '2026-07-08T00:00:00.000Z',
      status: 'pending',
    });
    expect(Object.keys(out[0]!)).not.toContain('storage_key');
  });

  test('a conveyor report sent back for revision is the conveyor\'s move, not the human\'s', () => {
    const rows = [
      artifact({ id: 'r-revise', filename: 'report.json', status: 'needs_revision' }),
      artifact({ id: 'r-pending', filename: 'report.json', status: 'pending' }),
      artifact({ id: 'd-revise', filename: 'design.md', status: 'needs_revision' }),
    ];
    expect(filterActionableArtifacts(rows).map((a) => a.id).sort()).toEqual(['d-revise', 'r-pending']);
  });

  test('empty in → empty out', () => {
    expect(filterActionableArtifacts([])).toEqual([]);
  });
});

describe('tallyBoundByKind', () => {
  test('tallies asset_bindings rows per governance kind', () => {
    const out = tallyBoundByKind([
      { asset_kind: 'principle' },
      { asset_kind: 'principle' },
      { asset_kind: 'requirement' },
      { asset_kind: 'decision' },
    ]);
    expect(out).toEqual({ principle: 2, requirement: 1, decision: 1 });
  });

  test('no rows → all-zero counts (a real "none bound" answer, not a data gap)', () => {
    expect(tallyBoundByKind([])).toEqual({
      principle: 0,
      requirement: 0,
      decision: 0,
    });
  });

  test('ignores non-governance kinds (workflow/prompt/kag_source/artifact)', () => {
    const out = tallyBoundByKind([
      { asset_kind: 'workflow' },
      { asset_kind: 'prompt' },
      { asset_kind: 'kag_source' },
      { asset_kind: 'artifact' },
      { asset_kind: 'principle' },
    ]);
    expect(out).toEqual({ principle: 1, requirement: 0, decision: 0 });
  });
});

describe('selectConveyorReports (G5)', () => {
  const artifact = (over: Partial<ArtifactOut> & { id: string }): ArtifactOut =>
    ({
      version: 1,
      filename: 'report.json',
      content_type: 'application/json',
      kind: 'JSON',
      project_id: 'p1',
      sensitivity: 'internal',
      size: 10,
      sha256: 'x',
      storage_key: 'k',
      card_id: null,
      step: null,
      status: 'pending',
      created_at: '2026-10-25T08:00:00.000Z',
      created_by: 'n8n',
      ...over,
    }) as ArtifactOut;

  test('run 7 shape: published before drafts, newest published = final, review status kept separately', () => {
    // Measured 2026-10-25 (artifact_registry.artifacts, fr 0ad49b9c): 8 report.json,
    // all status=pending, 2 published (08:09, 08:50), 6 draft, card_id/step NULL.
    const rows = [
      artifact({ id: 'd-0750', publish_status: 'draft', created_at: '2026-10-25T07:50:00.930Z' }),
      artifact({ id: 'p-0809', publish_status: 'published', created_at: '2026-10-25T08:09:43.926Z' }),
      artifact({ id: 'd-0844', publish_status: 'draft', created_at: '2026-10-25T08:44:38.867Z' }),
      artifact({ id: 'p-0850', publish_status: 'published', created_at: '2026-10-25T08:50:33.442Z' }),
      artifact({ id: 'other', filename: 'notes.md', publish_status: 'published' }),
    ];
    const out = selectConveyorReports(rows, new Map());
    expect(out.map((r) => r.id)).toEqual(['p-0850', 'p-0809', 'd-0844', 'd-0750']);
    expect(out.map((r) => r.is_final)).toEqual([true, false, false, false]);
    expect(out[0]).toEqual({
      id: 'p-0850',
      filename: 'report.json',
      card_id: null,
      card_name: null,
      step: null,
      status: 'pending',
      publish_status: 'published',
      is_final: true,
      created_at: '2026-10-25T08:50:33.442Z',
    });
    expect(Object.keys(out[0]!)).not.toContain('storage_key');
  });

  test('no published report ⇒ no final; an unserved publish_status is unknown (null), sorted last', () => {
    const out = selectConveyorReports(
      [
        artifact({ id: 'old', created_at: '2026-10-25T07:00:00.000Z' }),
        artifact({ id: 'draft', publish_status: 'draft', card_id: 'c1' }),
      ],
      new Map([['c1', 'Project setup']]),
    );
    expect(out.map((r) => [r.id, r.publish_status, r.is_final])).toEqual([
      ['draft', 'draft', false],
      ['old', null, false],
    ]);
    expect(out[0]!.card_name).toBe('Project setup');
  });
});
