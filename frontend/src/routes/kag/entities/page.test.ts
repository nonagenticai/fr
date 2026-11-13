// /kag/entities +page.ts — superseded by /library/kag/entities (same
// endpoint, richer panel); 308 so bookmarks keep working.
import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(): { status?: number; location?: string } {
  try {
    const res = load({} as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    return e as { status: number; location: string };
  }
}

describe('/kag/entities +page.ts redirect', () => {
  it('308-redirects to /library/kag/entities', () => {
    const r = redirectOf();
    expect(r.status).toBe(308);
    expect(r.location).toBe('/library/kag/entities');
  });
});
