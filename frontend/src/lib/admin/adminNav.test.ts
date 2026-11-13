import { describe, it, expect } from 'vitest';
import {
  ADMIN_NAV_ITEMS,
  visibleAdminNav,
  activeAdminHref,
} from './adminNav';

// George 2026-10-27: every workspace row a super-admin is offered is
// `workspace-admin` (backend routes/me/workspaces.ts), so in practice a
// super-admin is BOTH flags. SUPER_ONLY is the edge where the active row is not
// admin (e.g. the workspace list failed to load).
const SUPER = { isSuperAdmin: true, isWorkspaceAdmin: true };
const SUPER_ONLY = { isSuperAdmin: true, isWorkspaceAdmin: false };
const WS_ADMIN = { isSuperAdmin: false, isWorkspaceAdmin: true };
const NOBODY = { isSuperAdmin: false, isWorkspaceAdmin: false };

describe('visibleAdminNav', () => {
  it('never shows a platform item to a workspace admin', () => {
    // The security-consequential assertion. Each of these re-gates server-side
    // too, but a rendered licence registry is still a disclosure.
    const hrefs = visibleAdminNav(WS_ADMIN).map((i) => i.href);
    for (const platform of [
      '/admin/tenants',
      '/admin/users',
      '/admin/licenses',
      '/admin/pricing',
      '/admin/metering',
      '/admin/tenant-budgets',
      '/admin/andon',
      '/admin/kata',
      '/admin/assets/principles',
      '/admin/assets/requirements',
      '/admin/assets/decisions',
      '/admin/assets/workflows',
      '/admin/assets/projects',
    ]) {
      expect(hrefs).not.toContain(platform);
    }
  });

  it('shows the workspace section to a workspace admin', () => {
    const hrefs = visibleAdminNav(WS_ADMIN).map((i) => i.href);
    expect(hrefs).toContain('/admin/budget');
    expect(hrefs).toContain('/channels');
  });

  it('a hidden item is withheld from EVERY tier, super-admin included', () => {
    // Departments is hidden, not deleted — wanted long term as skill groups,
    // premature today. `hidden` must beat scope, or a super-admin still sees a
    // menu entry we deliberately withdrew.
    for (const viewer of [SUPER, WS_ADMIN, NOBODY]) {
      expect(visibleAdminNav(viewer).map((i) => i.href)).not.toContain('/admin/departments');
    }
    // ...and the entry is still THERE, so re-enabling is one word. A test that
    // only checked absence would pass just as happily if someone deleted it.
    expect(ADMIN_NAV_ITEMS.map((i) => i.href)).toContain('/admin/departments');
  });

  it('a super-admin (tenant-admin of the active workspace) sees BOTH tiers', () => {
    const hrefs = visibleAdminNav(SUPER).map((i) => i.href);
    expect(hrefs).toContain('/admin/licenses'); // platform tier
    expect(hrefs).toContain('/admin/budget'); // tenant tier
    // Everything except what is explicitly hidden.
    const shown = ADMIN_NAV_ITEMS.filter((i) => !i.hidden).length;
    expect(visibleAdminNav(SUPER).length).toBe(shown);
  });

  it('the tenant tier follows the ACTIVE workspace role, never isSuperAdmin alone (same predicate as the backend)', () => {
    const hrefs = visibleAdminNav(SUPER_ONLY).map((i) => i.href);
    expect(hrefs).toContain('/admin/licenses'); // platform tier still there
    for (const tenant of ADMIN_NAV_ITEMS.filter((i) => i.scope === 'tenant' && !i.hidden)) {
      expect(hrefs).not.toContain(tenant.href);
    }
  });

  it('someone with neither tier sees only the way out', () => {
    // They should never reach the shell (the layout redirects), but if the
    // component renders during that redirect it must not leak the menu.
    const items = visibleAdminNav(NOBODY);
    expect(items.every((i) => i.scope === 'any')).toBe(true);
    expect(items.map((i) => i.href)).toContain('/');
  });

  it('every item declares a scope — a missing one must not default to visible', () => {
    for (const item of ADMIN_NAV_ITEMS) {
      expect(['platform', 'tenant', 'any']).toContain(item.scope);
    }
  });

  it('hrefs are unique, so nothing renders twice', () => {
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('activeAdminHref', () => {
  const items = [...ADMIN_NAV_ITEMS];

  it('picks the LONGEST match, not the first parent', () => {
    // /admin/licenses must not stay lit on a child route while the child is
    // also lit — a plain startsWith highlights two items at once.
    expect(activeAdminHref('/admin/licenses/catalog', items)).toBe('/admin/licenses');
  });

  it('matches an exact path', () => {
    expect(activeAdminHref('/admin/budget', items)).toBe('/admin/budget');
  });

  it('does not match a sibling that merely shares a prefix', () => {
    // '/admin/users' must not light up for '/admin/users-export'.
    expect(activeAdminHref('/admin/users-export', items)).toBeNull();
  });

  it('/admin/tenants does not steal /admin/tenant-budgets', () => {
    // The two nearest neighbours in the table: both start `/admin/tenant` and
    // both are Platform items rendered a few rows apart. Only the
    // exact-or-followed-by-slash rule keeps them from lighting up together.
    expect(activeAdminHref('/admin/tenant-budgets', items)).toBe('/admin/tenant-budgets');
    expect(activeAdminHref('/admin/tenants', items)).toBe('/admin/tenants');
  });

  it('returns null off the admin area', () => {
    expect(activeAdminHref('/projects/123', items)).toBeNull();
  });

  it('ignores external items so "Back to Non-Agentic AI" never reads as active', () => {
    // '/' is a prefix of nothing here, but the guard is explicit: every admin
    // path would otherwise match the root item.
    expect(activeAdminHref('/admin/budget', items)).not.toBe('/');
  });
});

describe('scope separation is not accidental', () => {
  it('the platform budget view is NOT the workspace one', () => {
    // Two same-named pages in different route groups are a SvelteKit build
    // error, not a silent shadow — `/admin/(platform)/budget` and
    // `/admin/(tenant)/budget` refused to compile. The platform view is
    // therefore `/admin/tenant-budgets`; this pins the pair apart so the
    // collision cannot be reintroduced by a rename.
    const hrefs = ADMIN_NAV_ITEMS.map((i) => i.href);
    expect(hrefs).toContain('/admin/budget');
    expect(hrefs).toContain('/admin/tenant-budgets');

    const platform = ADMIN_NAV_ITEMS.filter((i) => i.scope === 'platform').map((i) => i.href);
    const tenant = ADMIN_NAV_ITEMS.filter((i) => i.scope === 'tenant').map((i) => i.href);
    expect(platform).toContain('/admin/tenant-budgets');
    expect(tenant).toContain('/admin/budget');
    // No href may be claimed by both tiers.
    expect(platform.filter((h) => tenant.includes(h))).toEqual([]);
  });
});

describe('every admin page names itself', () => {
  const ASSET_KINDS = [
    'decisions',
    'principles',
    'projects',
    'requirements',
    'workflows',
  ];

  it('the asset sub-pages resolve to DISTINCT labels', () => {
    // They used to prefix-match a single `/admin/assets` entry, so all six
    // rendered the tab title "Assets · Administration" — six different screens
    // claiming to be the same one. Asserting DISTINCTNESS, not six literal
    // strings: the labels may be reworded, but two pages sharing one is the
    // defect.
    const items = [...ADMIN_NAV_ITEMS];
    const labels = ASSET_KINDS.map((kind) => {
      const href = activeAdminHref(`/admin/assets/${kind}`, items);
      return ADMIN_NAV_ITEMS.find((i) => i.href === href)?.label ?? null;
    });

    expect(labels).not.toContain(null);
    expect(new Set(labels).size).toBe(ASSET_KINDS.length);
    expect(labels).not.toContain('Assets');
  });

  it('the /admin/assets launcher is gone from the table (it is a 308 now)', () => {
    // Nav standard 2026-10-03: /admin/assets was a tile-grid launcher and is a
    // redirect to /admin/assets/principles. No entry may name a redirect.
    expect(ADMIN_NAV_ITEMS.map((i) => i.href)).not.toContain('/admin/assets');
    expect(activeAdminHref('/admin/assets', [...ADMIN_NAV_ITEMS])).toBeNull();
  });

  it('the asset kinds are no longer hidden, and stay platform-scoped', () => {
    // Ruling 2026-10-03 supersedes the old "hidden" ruling: the six kinds are
    // top-level Administration rows. Their scope must not move — that would be
    // a privilege change, not a menu change.
    const visibleToSuper = visibleAdminNav({ isSuperAdmin: true, isWorkspaceAdmin: true }).map(
      (i) => i.href,
    );
    const visibleToWsAdmin = visibleAdminNav(WS_ADMIN).map((i) => i.href);
    for (const kind of ASSET_KINDS) {
      const href = `/admin/assets/${kind}`;
      const item = ADMIN_NAV_ITEMS.find((i) => i.href === href);
      expect(item?.hidden, href).toBeUndefined();
      expect(item?.scope, href).toBe('platform');
      expect(visibleToSuper).toContain(href);
      expect(visibleToWsAdmin).not.toContain(href);
    }
  });
});
