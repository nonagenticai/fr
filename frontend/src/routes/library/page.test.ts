// /library +page.ts — the old asset-type launcher is a 308 to the first
// Library-zone row (nav standard: no launcher pages, every page is a sidebar
// row). Same shape as library/[type]/redirect.test.ts.

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

describe('/library +page.ts redirect', () => {
  it('308-redirects the retired launcher to /principles', () => {
    const r = redirectOf();
    expect(r.status).toBe(308);
    expect(r.location).toBe('/principles');
  });
});
