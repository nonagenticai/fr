// tests/unit/routes/project-request-scope-and-withdraw.test.ts
//
// The two pure halves of the lifecycle-honesty unit:
//
//   1. `buildApprovedScopeRows` — the mapping from a decided outline to the
//      rows migration 127 stores. The thing worth pinning here is the POSITION
//      SEQUENCE: `project_deliverables` carries UNIQUE (project_id, position)
//      and holds both kinds, so the two kinds MUST share one sequence. Giving
//      each kind its own 0-based sequence is the near-miss, and it does not
//      fail at the type level — it fails at 23505, in production, on the first
//      request that has one of each. So it is pinned here (its behavioural
//      integration pin was deleted 2026-10-29).
//
//   2. `EVENT_SOURCES.withdraw` — which four statuses a requester may withdraw
//      from. `approved` and `failed` are deliberately not among them.

import { describe, expect, test } from 'bun:test';

import { eventSources, type RequestStatus } from '../../../src/routes/project-request-lifecycle';
import { buildApprovedScopeRows } from '../../../src/routes/project-requests';

const OUTLINE_ID = '00000000-0000-4000-8000-0000127a0001';
const PROJECT_ID = '00000000-0000-4000-8000-0000127a0002';

const deliverable = (title: string, criteria: string[] = []) => ({
  // ⚠️ The outline item's OWN `kind` — the conveyor roadmap's free-string
  // contract kind. It is NOT project_deliverables.kind and must not become it:
  // 'artifact' would 23514 against project_deliverables_kind_check.
  kind: 'artifact',
  title,
  description: `${title} description`,
  acceptance_criteria: criteria,
});

describe('buildApprovedScopeRows', () => {
  test('deliverables and intermediates share ONE position sequence', () => {
    const rows = buildApprovedScopeRows(
      {
        id: OUTLINE_ID,
        deliverables: [deliverable('D1'), deliverable('D2')],
        intermediate_deliverables: [deliverable('I1'), deliverable('I2')],
        milestones: [],
        effort_estimate: null,
      },
      PROJECT_ID,
    );

    // The whole point: 0,1,2,3 — NOT 0,1 then 0,1. Per-kind sequences collide
    // on UNIQUE (project_id, position) as soon as both kinds are non-empty.
    expect(rows.deliverables.map((r) => r.position)).toEqual([0, 1, 2, 3]);
    expect(new Set(rows.deliverables.map((r) => r.position)).size).toBe(4);
    expect(rows.deliverables.map((r) => r.kind)).toEqual([
      'deliverable',
      'deliverable',
      'intermediate',
      'intermediate',
    ]);
    // Deliverables first, then intermediates — the order the outline stated.
    expect(rows.deliverables.map((r) => r.title)).toEqual(['D1', 'D2', 'I1', 'I2']);
  });

  test('intermediates alone still start at 0, so an empty deliverables list wastes no positions', () => {
    const rows = buildApprovedScopeRows(
      {
        id: OUTLINE_ID,
        deliverables: [],
        intermediate_deliverables: [deliverable('only')],
        milestones: [],
        effort_estimate: null,
      },
      PROJECT_ID,
    );
    expect(rows.deliverables).toHaveLength(1);
    expect(rows.deliverables[0]!.position).toBe(0);
    expect(rows.deliverables[0]!.kind).toBe('intermediate');
  });

  test('acceptance criteria, description and outline provenance are carried; the item kind is dropped', () => {
    const rows = buildApprovedScopeRows(
      {
        id: OUTLINE_ID,
        deliverables: [deliverable('D1', ['crit A', 'crit B'])],
        intermediate_deliverables: [],
        milestones: [],
        effort_estimate: null,
      },
      PROJECT_ID,
    );
    const row = rows.deliverables[0]!;
    expect(row.acceptance_criteria).toEqual(['crit A', 'crit B']);
    expect(row.description).toBe('D1 description');
    expect(row.project_id).toBe(PROJECT_ID);
    expect(row.source_outline_id).toBe(OUTLINE_ID);
    // 'artifact' went in; the CLOSED vocabulary came out.
    expect(row.kind).toBe('deliverable');
  });

  test('milestones get their OWN sequence (their own table, its own composite PK)', () => {
    const rows = buildApprovedScopeRows(
      {
        id: OUTLINE_ID,
        deliverables: [deliverable('D1')],
        intermediate_deliverables: [deliverable('I1')],
        milestones: [{ name: 'M1', target_date: '2026-12-01' }, { name: 'M2' }],
        effort_estimate: { value: 5, unit: 'days' },
      },
      PROJECT_ID,
    );
    expect(rows.milestones.map((m) => m.position)).toEqual([0, 1]);
    expect(rows.milestones[0]!.target_date).toBe('2026-12-01');
    // NULLABLE by design: an outline may agree an order without dates, and a
    // fabricated date is worse than none.
    expect(rows.milestones[1]!.target_date).toBeNull();
    expect(rows.effortEstimate).toEqual({ value: 5, unit: 'days' });
  });

  test('a missing/empty outline scope produces no rows and a null effort estimate', () => {
    const rows = buildApprovedScopeRows(
      {
        id: OUTLINE_ID,
        deliverables: [],
        intermediate_deliverables: [],
        milestones: [],
        effort_estimate: null,
      },
      PROJECT_ID,
    );
    expect(rows.deliverables).toEqual([]);
    expect(rows.milestones).toEqual([]);
    expect(rows.effortEstimate).toBeNull();
  });

  test('a malformed stored outline THROWS rather than writing a half-shaped row', () => {
    expect(() =>
      buildApprovedScopeRows(
        {
          id: OUTLINE_ID,
          // `title` is required by OutlineDeliverableSchema.
          deliverables: [{ kind: 'artifact', acceptance_criteria: [] }],
          intermediate_deliverables: [],
          milestones: [],
          effort_estimate: null,
        },
        PROJECT_ID,
      ),
    ).toThrow();
  });
});

describe('withdraw sources', () => {
  test('exactly the four pre-decision statuses may be withdrawn', () => {
    const LEGAL: RequestStatus[] = ['draft', 'submitted', 'analysing', 'outline_proposed'];
    expect([...eventSources('withdraw')].sort()).toEqual([...LEGAL].sort());
  });
});
