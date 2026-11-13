// fr-agui SPEC §7.3 / §7.5 (m2): the project "Assets" area keeps its URLs at
// /projects/[id]/library/* — the nav LABEL changed, the paths did not — so the
// legacy /projects/[id]/assets 308 stays EXACTLY one hop. This pins it: every
// target the stub can answer is a real page (not another redirect stub), and
// the move into the (project) route group changed none of the targets.
//
// TO MAKE THIS FILE GO RED: rename `library/` (e.g. to `assets/<kind>`) and add
// a second redirect, or point a KINDS entry at a redirect stub.

import { describe, expect, it } from 'vitest';
import { load } from './+page';
import { isRedirectOnly, resolve } from '$lib/nav/tests/routeTree';

const P = '328639ef-0000-4000-8000-000000000001';

function hopOf(search: string): { status: number; location: string } {
  try {
    load({ params: { id: P }, url: new URL(`http://localhost/projects/${P}/assets${search}`) } as never);
  } catch (e) {
    return e as { status: number; location: string };
  }
  throw new Error('assets load did not redirect');
}

describe('/projects/[id]/assets — the single-hop 308 is pinned', () => {
  const cases: Array<[string, string]> = [
    ['', `/projects/${P}/library/principles`],
    ['?tab=principles', `/projects/${P}/library/principles`],
    ['?tab=requirements', `/projects/${P}/library/requirements`],
    ['?tab=decision', `/projects/${P}/library/decisions`],
  ];

  it.each(cases)('assets%s → 308 %s', (search, target) => {
    const r = hopOf(search);
    expect(r.status).toBe(308);
    expect(r.location).toBe(target);
  });

  it.each(cases)('the target of assets%s is a final page, never a second redirect', (search) => {
    const { location } = hopOf(search);
    const route = resolve(location);
    expect(route, `${location} resolves to no route`).not.toBeNull();
    expect(route!.id.startsWith('/projects/[id]/library/')).toBe(true);
    expect(isRedirectOnly(route!), `${location} is itself a redirect stub`).toBe(false);
  });

  it('the stub itself is still redirect-only (it did not grow a page)', () => {
    const route = resolve(`/projects/${P}/assets`);
    expect(route?.id).toBe('/projects/[id]/assets');
    expect(isRedirectOnly(route!)).toBe(true);
  });
});
