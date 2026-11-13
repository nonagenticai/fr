// /admin/assets +page.ts — no content of its own; 308 to /admin/assets/principles (nav standard, fr#1331).
// Direct load() test: the rail-level "no row targets a redirect" check only
// proves the stub is DETECTED as a redirect, not where it sends people.
import { describe, it, expect } from 'vitest';
import { load } from './+page';

function redirectOf(): { status?: number; location?: string } {
  try {
    const res = load({} as never);
    return { status: undefined, location: undefined, ...(res as object) };
  } catch (e) {
    // SvelteKit redirect() throws a { status, location } object.
    return e as { status: number; location: string };
  }
}

describe('/admin/assets +page.ts redirect', () => {
  it('308-redirects to /admin/assets/principles', () => {
    const r = redirectOf();
    expect(r.status).toBe(308);
    expect(r.location).toBe('/admin/assets/principles');
  });
});
