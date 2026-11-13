// tests/unit/scripts/rank-integration-failures.test.ts
//
// The ranking is the instrument the defect list is read off, so its own biases
// matter more than usual. Two of them would quietly change the answer:
//
//   1. `service` is `?? null` BY DESIGN in the emitter — a caller-side refusal
//      (BAD_REQUEST / MISSING_TENANT / PAYLOAD_TOO_LARGE) names no upstream
//      because none was contacted. A parser keyed on `service` that skips those
//      would drop an entire failure family, and the resulting list would look
//      complete. That is the same blindness the telemetry exists to end.
//   2. Grouping must not collide distinct failures. The key is joined on a unit
//      separator precisely so a path containing the separator character cannot
//      merge two groups into one and halve the apparent count.

import { describe, expect, test } from 'bun:test';
import {
  groupKeyFor,
  linesFromLokiBody,
  rank,
} from '../../../scripts/rank-integration-failures';

const at = (ms: number) => String(BigInt(ms) * 1_000_000n);

const line = (o: Record<string, unknown>) =>
  JSON.stringify({ telemetry: 'integration_error', ...o });

describe('caller-side refusals are kept, not skipped', () => {
  test('a null service is ranked, labelled, and not dropped', () => {
    const { groups, parsed } = rank([
      {
        tsNs: at(1_000),
        line: line({
          code: 'BAD_REQUEST',
          service: null,
          message: 'listOutputs requires params.job_id and params.user_id',
        }),
      },
    ]);
    expect(parsed).toBe(1);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.service).toBe('(caller-side)');
    expect(groups[0]?.code).toBe('BAD_REQUEST');
  });

  test('a null service does not collide with a real service named the same way', () => {
    const { groups } = rank([
      { tsNs: at(1), line: line({ code: 'BAD_REQUEST', service: null }) },
      { tsNs: at(2), line: line({ code: 'BAD_REQUEST', service: 'kanban' }) },
    ]);
    expect(groups).toHaveLength(2);
  });
});

describe('grouping', () => {
  test('identical failures accumulate and keep first/last seen', () => {
    const { groups } = rank([
      { tsNs: at(5_000), line: line({ code: 'UPSTREAM_BAD_STATUS', service: 'kanban', method: 'POST', path: '/c', upstream_status: 422 }) },
      { tsNs: at(1_000), line: line({ code: 'UPSTREAM_BAD_STATUS', service: 'kanban', method: 'POST', path: '/c', upstream_status: 422 }) },
      { tsNs: at(9_000), line: line({ code: 'UPSTREAM_BAD_STATUS', service: 'kanban', method: 'POST', path: '/c', upstream_status: 422 }) },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.count).toBe(3);
    // Loki is queried backward, so lines do NOT arrive in time order — first/last
    // must be a min/max, not "the first one seen".
    expect(groups[0]?.firstSeenNs).toBe(BigInt(at(1_000)));
    expect(groups[0]?.lastSeenNs).toBe(BigInt(at(9_000)));
  });

  test('the same path under a different upstream status ranks separately', () => {
    // A 422 and a 500 on one path are different defects with different owners;
    // merging them would hide whichever is rarer.
    const { groups } = rank([
      { tsNs: at(1), line: line({ code: 'UPSTREAM_BAD_STATUS', service: 'kanban', path: '/c', upstream_status: 422 }) },
      { tsNs: at(2), line: line({ code: 'UPSTREAM_BAD_STATUS', service: 'kanban', path: '/c', upstream_status: 500 }) },
    ]);
    expect(groups).toHaveLength(2);
  });

  test('ranked by count, descending', () => {
    const { groups } = rank([
      { tsNs: at(1), line: line({ code: 'A', service: 's' }) },
      { tsNs: at(2), line: line({ code: 'B', service: 's' }) },
      { tsNs: at(3), line: line({ code: 'B', service: 's' }) },
    ]);
    expect(groups[0]?.code).toBe('B');
    expect(groups[0]?.count).toBe(2);
  });

  test('a separator character in a path cannot merge two groups', () => {
    // The key is joined on U+001F rather than a printable delimiter for exactly
    // this reason: a path carrying the delimiter would otherwise realign the
    // fields and fuse two distinct failures into one, halving the count.
    const a = groupKeyFor({ code: 'X', service: 's', method: 'GET', path: '/a|b', upstream_status: 1 });
    const b = groupKeyFor({ code: 'X', service: 's', method: 'GET', path: '/a', upstream_status: 1 });
    expect(a).not.toBe(b);
  });
});

describe('parsing is honest about what it could not read', () => {
  test('non-JSON lines are counted, never silently dropped', () => {
    const { parsed, unparseable } = rank([
      { tsNs: at(1), line: 'not json at all' },
      { tsNs: at(2), line: line({ code: 'A', service: 's' }) },
    ]);
    expect(parsed).toBe(1);
    expect(unparseable).toBe(1);
  });

  test('lines that are JSON but not this telemetry are ignored without counting', () => {
    // The Loki filter is a substring match, so unrelated lines mentioning
    // "integration_error" do arrive. They are not failures and must not rank.
    const { groups, parsed, unparseable } = rank([
      { tsNs: at(1), line: JSON.stringify({ telemetry: 'something_else', code: 'A' }) },
    ]);
    expect(groups).toHaveLength(0);
    expect(parsed).toBe(0);
    expect(unparseable).toBe(0);
  });
});

describe('linesFromLokiBody', () => {
  test('flattens every stream, not just the first', () => {
    // One pod per stream: reading only `result[0]` would silently rank a single
    // pod's failures and look like a full window.
    const lines = linesFromLokiBody({
      data: {
        result: [
          { values: [[at(1), 'a'], [at(2), 'b']] },
          { values: [[at(3), 'c']] },
        ],
      },
    });
    expect(lines).toHaveLength(3);
  });

  test('an empty or malformed body yields nothing rather than throwing', () => {
    expect(linesFromLokiBody({})).toEqual([]);
    expect(linesFromLokiBody(null)).toEqual([]);
  });
});
