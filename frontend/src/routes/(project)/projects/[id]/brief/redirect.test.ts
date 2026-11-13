// R6: /projects/[id]/brief is merged into Plan & scope — it 308s there (the brief is that page's
// first section). The API routes (GET /api/projects/:id/brief*) are unchanged.
import { describe, expect, it } from 'vitest';
import { load as briefLoad } from './+page';

function redirectOf(load: (e: never) => unknown, id: string): { status: number; location: string } {
  try {
    load({ params: { id }, url: new URL(`http://h/projects/${id}/x`) } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
  throw new Error('no redirect');
}

describe('R6 redirects to Plan & scope', () => {
  it('/projects/[id]/brief → 308 /projects/[id]/plan', () => {
    expect(redirectOf(briefLoad as never, 'p-1')).toMatchObject({ status: 308, location: '/projects/p-1/plan' });
  });
  it('the project id is path-encoded', () => {
    expect(redirectOf(briefLoad as never, 'p 2')).toMatchObject({ status: 308, location: '/projects/p%202/plan' });
  });
});
