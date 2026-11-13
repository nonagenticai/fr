// src/lib/layout/pageTitle.test.ts
//
// The reported defect: SvelteKit leaves the PREVIOUS page's <title> mounted
// when the next page sets none, so /kanban showed "Control tower" and
// /decisions once showed "Notifications". The fix is not "remember to set a
// title" — it is that a title belonging to another pathname CANNOT be
// rendered. `resolveTitle` is where that is enforced, so it is tested here.

import { describe, it, expect } from 'vitest';
import { TITLES, resolveTitle, normaliseRouteId } from './pageTitle';
import { ADMIN_NAV_ITEMS } from '../admin/adminNav';

const PLACEHOLDER = /^(fr|KAG|Page|TODO|Untitled)$/i;

describe('resolveTitle — suffix', () => {
  it('renders "<page> · Non-Agentic AI"', () => {
    expect(resolveTitle('/kanban', '/kanban', null, false)).toBe('Kanban · Non-Agentic AI');
    expect(resolveTitle('/approvals', '/approvals', null, false)).toBe('Approvals · Non-Agentic AI');
  });

  it('renders "<page> · KAG" in kag mode', () => {
    expect(resolveTitle('/kanban', '/kanban', null, true)).toBe('Kanban · KAG');
  });

  it('renders the bare brand for the root route', () => {
    expect(resolveTitle('/', '/', null, false)).toBe('Non-Agentic AI');
    expect(resolveTitle('/', '/', null, true)).toBe('KAG');
  });
});

describe('resolveTitle — the runtime override', () => {
  it('applies the override when its path is the live pathname', () => {
    expect(
      resolveTitle('/cards/[id]', '/cards/abc-123', { path: '/cards/abc-123', title: 'Ship the thing' }, false),
    ).toBe('Ship the thing · Non-Agentic AI');
  });

  it('DISCARDS an override whose path is not the live pathname — the stale-title regression', () => {
    // The exact reported shape: /cards/abc-123 pushed its name, the user
    // navigated to /kanban, and the card's override is still in the store
    // because the old page had not torn down yet. It must NOT be rendered.
    const leftBehind = { path: '/cards/abc-123', title: 'Ship the thing' };

    expect(resolveTitle('/kanban', '/kanban', leftBehind, false)).toBe('Kanban · Non-Agentic AI');
    expect(resolveTitle('/decisions', '/decisions', leftBehind, false)).toBe('Decisions · Non-Agentic AI');
    // Even the SAME route id with a different entity id must not inherit it.
    expect(resolveTitle('/cards/[id]', '/cards/zzz-999', leftBehind, false)).toBe('Card · Non-Agentic AI');
    // And an unmapped route falls to the brand, not to the leftover name.
    expect(resolveTitle('/not/a/route', '/not/a/route', leftBehind, false)).toBe('Non-Agentic AI');
  });

  it('discards an empty or whitespace-only override and falls back to the map', () => {
    expect(resolveTitle('/cards/[id]', '/cards/abc', { path: '/cards/abc', title: '' }, false)).toBe(
      'Card · Non-Agentic AI',
    );
    expect(resolveTitle('/cards/[id]', '/cards/abc', { path: '/cards/abc', title: '   ' }, false)).toBe(
      'Card · Non-Agentic AI',
    );
  });

  it('trims a valid override', () => {
    expect(
      resolveTitle('/reports/[reportId]', '/reports/r1', { path: '/reports/r1', title: '  Q3 spend  ' }, false),
    ).toBe('Q3 spend · Non-Agentic AI');
  });
});

describe('resolveTitle — unknown routes', () => {
  it('falls back to the bare brand, never to a neighbouring title', () => {
    expect(resolveTitle(null, '/whatever', null, false)).toBe('Non-Agentic AI');
    expect(resolveTitle('/does/not/exist', '/does/not/exist', null, false)).toBe('Non-Agentic AI');
    expect(resolveTitle(null, '/whatever', null, true)).toBe('KAG');
  });

  it('does not resolve inherited Object properties as titles', () => {
    // `TITLES` is a plain object; a route id of "constructor" or "toString"
    // must miss, not return a function off the prototype.
    expect(resolveTitle('constructor', '/x', null, false)).toBe('Non-Agentic AI');
    expect(resolveTitle('toString', '/x', null, false)).toBe('Non-Agentic AI');
  });
});

describe('TITLES — the map itself', () => {
  it('covers every +page.svelte route id, and contains no stale keys', () => {
    // Route id = the file path with `src/routes` and `/+page.svelte` stripped
    // and layout groups — (admin), (platform), (tenant) — dropped, since a
    // group is not part of a route id.
    const files = Object.keys(import.meta.glob('../../routes/**/+page.svelte'));
    // No `files.length > 0` pin: the two-way coverage check below fails if the
    // glob finds nothing while TITLES is populated, and vice versa.

    const routeIds = files
      .map((f) =>
        f
          .replace(/^.*\/routes/, '')
          .replace(/\/\+page\.svelte$/, '')
          .replace(/\/\([^/]+\)/g, ''),
      )
      .map((r) => (r === '' ? '/' : r))
      .sort();

    const keys = Object.keys(TITLES).sort();
    expect(routeIds.filter((r) => !(r in TITLES))).toEqual([]);
    expect(keys.filter((k) => !routeIds.includes(k))).toEqual([]);
  });

  it('contains no placeholder titles', () => {
    // A map stuffed with "fr" / "Page" / "TODO" looks complete and leaves every
    // tab useless — the exact failure this change exists to prevent.
    const bad = Object.entries(TITLES).filter(([, t]) => PLACEHOLDER.test(t.trim()));
    expect(bad).toEqual([]);
  });

  it('contains no blank titles', () => {
    const bad = Object.entries(TITLES).filter(([, t]) => t.trim() === '');
    expect(bad).toEqual([]);
  });

  it('never echoes the route id back as its own title', () => {
    // The other shape of placeholder-stuffing: `'/kanban': '/kanban'` satisfies
    // the coverage guard and gives the user a tab reading a URL.
    const bad = Object.entries(TITLES).filter(([routeId, t]) => t.trim() === routeId);
    expect(bad).toEqual([]);
  });

  it('gives no two route ids the same title', () => {
    const byTitle = new Map<string, string[]>();
    for (const [routeId, title] of Object.entries(TITLES)) {
      const key = title.trim().toLowerCase();
      byTitle.set(key, [...(byTitle.get(key) ?? []), routeId]);
    }
    const dupes = [...byTitle.entries()].filter(([, ids]) => ids.length > 1);
    expect(dupes).toEqual([]);
  });

});

describe('TITLES — admin entries stay in step with the admin nav table', () => {
  // The admin area's names are OWNED by lib/admin/adminNav.ts. They are copied
  // into TITLES rather than derived from it.
  //
  // So the delegation is enforced here instead: rename a label in
  // ADMIN_NAV_ITEMS without mirroring it, and this test fails. Without it the
  // copy is just duplication waiting to drift.

  /** Labels deliberately qualified on the way across, with the reason. */
  const QUALIFIED: Readonly<Record<string, string>> = {
    // "Overview" alone does not say which area it is the overview of.
    '/admin/home': 'Admin overview',
    // The six asset kinds are NOT here: their nav labels are already
    // "Platform <kind>", distinct from the top-level pages, so the tab title
    // uses them verbatim.
  };

  const adminNavRoutes = ADMIN_NAV_ITEMS
    // `external: true` items leave the admin area ("Back to Non-Agentic AI" → `/`,
    // "Channels" → `/channels`); their titles belong to those routes, and
    // `activeAdminHref` skips them for the same reason.
    .filter((i) => !i.external && i.href.startsWith('/admin'));

  it('covers every non-external admin nav href', () => {
    // Non-vacuity comes from ADMIN_NAV_ITEMS itself: adminNav.test.ts names the
    // /admin rows, so an emptied table fails there rather than a count here.
    const missing = adminNavRoutes.map((i) => i.href).filter((h) => !(h in TITLES));
    expect(missing).toEqual([]);
  });

  it('uses each item’s label verbatim, except where deliberately qualified', () => {
    const drifted = adminNavRoutes
      .map((i) => ({ href: i.href, expected: QUALIFIED[i.href] ?? i.label, actual: TITLES[i.href] }))
      .filter((r) => r.actual !== r.expected);
    expect(drifted).toEqual([]);
  });

  it('keeps the admin asset kinds distinct from the top-level pages', () => {
    // /admin/assets is a 308 to /admin/assets/principles: no page, no title.
    expect('/admin/assets' in TITLES).toBe(false);
    expect(TITLES['/admin/assets/decisions']).not.toBe(TITLES['/decisions']);
    expect(TITLES['/admin/assets/workflows']).not.toBe(TITLES['/workflows']);
  });

  it('superseded orphan routes are 308 stubs with no title (nav standard)', () => {
    // /documents → /library/kag/documents, /kag/entities → /library/kag/entities.
    expect('/documents' in TITLES).toBe(false);
    expect('/kag/entities' in TITLES).toBe(false);
    // The per-entity detail page is untouched and keeps its title.
    expect(TITLES['/kag/entities/[id]']).toBe('KAG entity');
  });
});

describe('route-group normalisation — the hole the CI guard cannot see', () => {
  // ⛔ WHY THIS SUITE EXISTS, AND WHY IT USES HARDCODED ROUTE IDS.
  // TITLES is keyed by URL-shaped path; SvelteKit hands the app a
  // `page.route.id` that still carries layout-group segments. The first cut of
  // resolveTitle looked the raw id up directly: plain routes matched 144/144,
  // grouped routes 0/24 — every (admin) tab silently read "fr".
  //
  // Deriving route ids from the FILESYSTEM strips groups, producing a key
  // the running app never asks for. Two components deriving the same key the
  // same wrong way cannot check each other, so these ids are written out
  // literally, exactly as SvelteKit emits them (confirmed against
  // .svelte-kit/types/route_meta_data.json), rather than derived from anything.
  const REAL_GROUPED_IDS: [string, string][] = [
    ['/(admin)/admin/(platform)/tenants', '/admin/tenants'],
    ['/(admin)/admin/(platform)/licenses/catalog', '/admin/licenses/catalog'],
    ['/(admin)/admin/(tenant)/departments/[id]', '/admin/departments/[id]'],
    ['/(admin)/admin/home', '/admin/home'],
  ];

  it.each(REAL_GROUPED_IDS)('strips layout groups from %s', (routeId, expected) => {
    expect(normaliseRouteId(routeId)).toBe(expected);
  });

  it('resolves a real grouped route id to its mapped title, not the bare brand', () => {
    for (const [routeId] of REAL_GROUPED_IDS) {
      const title = resolveTitle(routeId, '/irrelevant', null, false);
      expect(title, `${routeId} fell through to the bare brand`).not.toBe('Non-Agentic AI');
      expect(title).toMatch(/ · Non-Agentic AI$/);
    }
  });

  it('EVERY grouped route id in the app resolves to something other than the bare brand', () => {
    // The population check. Any (admin) route that regresses shows up here.
    const groupedKeys = Object.keys(TITLES).filter((k) => k.startsWith('/admin'));
    // No key-count floor: REAL_GROUPED_IDS above names real admin routes, and
    // the `broken` scan is empty only when the resolver works.
    const broken = groupedKeys.filter(
      (urlKey) => resolveTitle(`/(admin)${urlKey.replace('/admin', '/admin')}`, '/x', null, false) === 'Non-Agentic AI',
    );
    expect(broken).toEqual([]);
  });

  it('leaves an ungrouped route id untouched', () => {
    expect(normaliseRouteId('/cards/[id]')).toBe('/cards/[id]');
    expect(normaliseRouteId('/')).toBe('/');
    expect(normaliseRouteId(null)).toBeNull();
  });
});
