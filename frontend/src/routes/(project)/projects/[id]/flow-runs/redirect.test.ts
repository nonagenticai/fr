// R5: /projects/[id]/execution (Execution hub) and /projects/[id]/executions (Project executions) are
// merged into Flow runs — both 308 there.
import { describe, expect, it } from 'vitest';
import { load as hubLoad } from '../execution/+page';
import { load as execLoad } from '../executions/+page';

function redirectOf(load: (e: never) => unknown, id: string): { status: number; location: string } {
  try {
    load({ params: { id }, url: new URL(`http://h/projects/${id}/x`) } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
  throw new Error('no redirect');
}

describe('R5 redirects to Flow runs', () => {
  it('/projects/[id]/execution → 308 /projects/[id]/flow-runs', () => {
    expect(redirectOf(hubLoad as never, 'p-1')).toMatchObject({ status: 308, location: '/projects/p-1/flow-runs' });
  });
  it('/projects/[id]/executions → 308 /projects/[id]/flow-runs', () => {
    expect(redirectOf(execLoad as never, 'p 2')).toMatchObject({ status: 308, location: '/projects/p%202/flow-runs' });
  });
});
