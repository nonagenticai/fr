// tests/unit/routes/project-request-direct-decide-guard.test.ts
//
// While an OUTLINE is in flight, the direct approve/reject routes must refuse.
// Otherwise a reviewer can approve a request sitting in `outline_proposed`
// straight into a project — bypassing the agent's outline — and the outline's
// own approval stays pending and answerable in the queue for a request that no
// longer needs it. Rejecting mid-outline strands it the same way.
//
// Unit scope: the status set and the fact that BOTH handlers consult the guard
// before doing anything else. Driving the handlers needs a database (see the
// scope note in tests/unit/routes/tenant/members.test.ts).

import { describe, test, expect } from 'bun:test';
import { OUTLINE_IN_FLIGHT_STATUSES } from '../../../src/routes/project-requests';

const SOURCE = await Bun.file(
  new URL('../../../src/routes/project-requests.ts', import.meta.url),
).text();

function body(fn: string): string {
  const start = SOURCE.indexOf(`export async function ${fn}(`);
  expect(start).toBeGreaterThan(-1);
  return SOURCE.slice(start, SOURCE.indexOf('\nexport ', start + 10));
}

describe('the outline owns a request from submit until promotion', () => {
  test('every in-flight lifecycle state is guarded', () => {
    expect([...OUTLINE_IN_FLIGHT_STATUSES].sort()).toEqual(
      ['analysing', 'approved', 'outline_proposed', 'submitted'].sort(),
    );
  });

  test('draft and failed stay directly decidable — the legacy road still works', () => {
    for (const s of ['draft', 'failed']) {
      expect(OUTLINE_IN_FLIGHT_STATUSES).not.toContain(s);
    }
  });
});

describe('both direct routes consult the guard, before any write', () => {
  for (const fn of ['handleApproveProjectRequest', 'handleRejectProjectRequest']) {
    test(`${fn} returns the outline_in_flight conflict first`, () => {
      const b = body(fn);
      const guard = b.indexOf('outlineInFlightConflict(row)');
      expect(guard).toBeGreaterThan(-1);
      // Before the first write or the project engine — a guard that runs after
      // the side effect guards nothing.
      for (const later of ['db\n', '.update(', 'promoteProjectRequest(']) {
        const at = b.indexOf(later);
        if (at !== -1) expect(guard).toBeLessThan(at);
      }
    });
  }
});
