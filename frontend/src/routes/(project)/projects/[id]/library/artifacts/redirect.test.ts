// /projects/[id]/library/artifacts — a 308 to the canonical Inspect row.

import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(id: string): { status?: number; location?: string } {
  try {
    const res = load({ params: { id } } as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('/projects/[id]/library/artifacts +page.ts redirect', () => {
  it('308-redirects to /projects/[id]/artifacts', () => {
    const r = redirectOf('328639ef-0000-4000-8000-000000000001');
    expect(r.status).toBe(308);
    expect(r.location).toBe('/projects/328639ef-0000-4000-8000-000000000001/artifacts');
  });
});
