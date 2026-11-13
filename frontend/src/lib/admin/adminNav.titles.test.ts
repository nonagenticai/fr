// src/lib/admin/adminNav.titles.test.ts
//
// Every admin page reachable from the nav must take its <title> from the ONE
// place that derives it — `routes/(admin)/admin/+layout.svelte` — and must not
// set its own.
//
// This convention already failed once, and the layout records why: per-page
// titles were the obvious approach and "8 of ~18 admin pages set one, so
// navigating to a page that did not simply LEFT THE LAST ONE UP —
// /admin/budget reading 'Departments · Admin'". Deriving centrally fixed that.
//
// MEASURED in the live UI 2026-09-05, signed in as a super-admin: four pages
// still overrode it, producing three different shapes in one area —
//   Tenants        -> "Tenants · Administration — fr"   (derived, correct)
//   Metering       -> "System metering · admin"
//   Pricing        -> "Pricing · Admin"
//   Users          -> "Super-admin: provision user"
// A stale title is the cheapest possible way to make a working area feel broken,
// which is precisely the complaint this Administration work started from.
//
// ⚠️ HIDDEN pages are exempt, deliberately. `departments` is `hidden: true`, so
// the layout can derive no label for it and would fall back to a bare
// "Administration — fr" — strictly less informative than the title it sets for
// itself. The rule is about pages the nav can reach, not about every file.

import { describe, expect, it } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

import { BRAND, TITLES, resolveTitle } from '../layout/pageTitle';
import { ADMIN_NAV_ITEMS } from './adminNav';

const ROUTES = join(process.cwd(), 'src', 'routes', '(admin)', 'admin');

/** The `+page.svelte` for an `/admin/...` href, across the (platform)/(tenant) groups. */
function pageFileFor(href: string): string | null {
  const rest = href.replace(/^\/admin\/?/, '');
  if (!rest) return null;
  for (const group of ['(platform)', '(tenant)', '']) {
    const p = join(ROUTES, group, rest, '+page.svelte');
    if (existsSync(p)) return p;
  }
  return null;
}

const navPages = ADMIN_NAV_ITEMS
  .filter((i) => !i.hidden && !i.external && i.href.startsWith('/admin/'))
  .map((i) => ({ label: i.label, href: i.href, file: pageFileFor(i.href) }))
  .filter((x): x is { label: string; href: string; file: string } => x.file !== null);

describe('admin page titles come from one place', () => {
  it('the scan actually found the nav pages', () => {
    // Guard against a vacuous pass: zero files resolved would make every
    // assertion below trivially true. Named, not a count of how many there are.
    expect(navPages.map((p) => p.href)).toContain('/admin/tenants');
  });

  it.each(navPages)('$label ($href) does not set its own <title>', ({ file }) => {
    const src = readFileSync(file, 'utf8');
    const head = /<svelte:head>[\s\S]*?<\/svelte:head>/.exec(src);
    const setsTitle = head ? /<title>/.test(head[0]) : false;

    expect(setsTitle).toBe(false);
  });
});

describe('hidden pages still get a real title (negative control)', () => {
  // ⚠️ THIS TEST'S MECHANISM CHANGED; ITS GUARANTEE DID NOT.
  //
  // It used to assert that /admin/departments sets its OWN <svelte:head><title>,
  // because the admin layout derived titles from ADMIN_NAV_ITEMS and could
  // produce no label for a page absent from that table. Titles now come from a
  // single resolver keyed by route id (src/lib/layout/pageTitle.ts), and NO page
  // sets its own title — so the old assertion is not merely failing, its premise
  // no longer exists.
  //
  // The thing worth protecting is unchanged: a page HIDDEN FROM THE ADMIN NAV
  // must still resolve to a real name and never to a bare brand. That is what is
  // asserted here now. Rewritten rather than deleted, because deleting it would
  // silently drop the guarantee along with the obsolete mechanism.
  it('a route absent from ADMIN_NAV_ITEMS still resolves to a real title', () => {
    const navHrefs = new Set(ADMIN_NAV_ITEMS.map((i) => i.href));
    const hidden = Object.keys(TITLES).filter(
      (k) => k.startsWith('/admin') && !navHrefs.has(k),
    );
    // Positive control: if this is empty the test proves nothing.
    expect(hidden.length, 'no hidden admin routes found — the test is vacuous').toBeGreaterThan(0);

    const bare = hidden.filter(
      (k) => resolveTitle(`/(admin)${k}`, '/x', null, false) === BRAND,
    );
    expect(bare).toEqual([]);
  });

  it('/admin/departments specifically still has a name', () => {
    expect(TITLES['/admin/departments']).toBeTruthy();
    expect(TITLES['/admin/departments']).not.toBe(BRAND);
  });
});
