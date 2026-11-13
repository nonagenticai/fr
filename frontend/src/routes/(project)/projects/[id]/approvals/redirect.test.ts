// R4: /projects/[id]/approvals and /projects/[id]/threads are merged into Needs you — both 308 there.
// The detail pages (/projects/[id]/approve/[approvalId], /projects/[id]/threads/[threadId]) stay.
import { describe, expect, it } from 'vitest';
import { load as approvalsLoad } from './+page';
import { load as threadsLoad } from '../threads/+page';

function redirectOf(load: (e: never) => unknown, id: string): { status: number; location: string } {
  try {
    load({ params: { id }, url: new URL(`http://h/projects/${id}/x`) } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
  throw new Error('no redirect');
}

describe('R4 redirects to Needs you', () => {
  it('/projects/[id]/approvals → 308 /projects/[id]/needs-you', () => {
    expect(redirectOf(approvalsLoad as never, 'p-1')).toMatchObject({ status: 308, location: '/projects/p-1/needs-you' });
  });
  it('/projects/[id]/threads → 308 /projects/[id]/needs-you', () => {
    expect(redirectOf(threadsLoad as never, 'p 2')).toMatchObject({ status: 308, location: '/projects/p%202/needs-you' });
  });
});
