// src/lib/admin/adminNav.ts
//
// The admin area's navigation, as data.
//
// Why this file exists at all: before the consolidation there was no admin nav.
// Reaching an admin page meant the Settings sidebar (4 conditional entries),
// the global sidebar (3 more, under different rules), or one of two tile grids
// — and `/admin/metering`, `/settings/admin/departments/new` and
// `/settings/admin/departments/[id]/knowledge` were reachable ONLY by typing
// the URL. Three different guard mechanisms decided who saw what.
//
// One table, one predicate. Keeping it free of Svelte runes and DOM keeps it in
// the pure vitest project, so the visibility rules — the part with security
// consequence — are unit-tested rather than eyeballed in a browser.
//
// Note on URLs: SvelteKit route GROUPS `(platform)` and `(tenant)` do not
// appear in the URL, so `/admin/licenses` and `/admin/budget` are siblings —
// and two same-named pages in different groups are a BUILD ERROR, not a
// silent shadow ("routes conflict with each other").
//
// This is why specra prefixes its cross-scope pages. fr hit it the moment a
// platform-wide budget view was added beside the workspace-scoped one, so the
// platform page is `/admin/tenant-budgets` ("budgets, by tenant") and the
// workspace one stays `/admin/budget`. Singular-vs-plural alone would have
// been too weak a signal to tell them apart in a URL bar.

import { BRAND } from '../layout/pageTitle';

export type AdminScope = 'platform' | 'tenant' | 'any';

export interface AdminNavItem {
  label: string;
  /** Lucide icon key, resolved by the sidebar's ICONS map (fr convention). */
  iconName: string;
  href: string;
  /**
   * Section heading rendered ABOVE this item. Flat marker rather than nested
   * arrays: array order is the grouping, so re-ordering is a one-line move and
   * an item can never end up in two sections at once.
   */
  section?: string;
  /** Which tier may see it. */
  scope: AdminScope;
  /** Leaves the admin shell (rendered with an out-arrow). */
  external?: boolean;
  /**
   * Kept in the table but not rendered. Use this instead of deleting an entry
   * when the FEATURE stays and only the menu placement is premature — the route
   * remains reachable by URL, the backend is untouched, and re-enabling is one
   * word rather than an archaeology exercise.
   */
  hidden?: boolean;
  /** Hover text — say what the page is FOR when the label cannot. */
  title?: string;
}

/** Everything, in render order. Filtered per-user by `visibleAdminNav`. */
export const ADMIN_NAV_ITEMS: readonly AdminNavItem[] = [
  // The product name the shell shows (pageTitle `BRAND`), never the internal service name.
  { label: `Back to ${BRAND}`, iconName: 'Home', href: '/', scope: 'any', external: true },

  // The shared landing for BOTH tiers, so it carries no section heading. A
  // super-admin and a workspace-admin both start here; what differs is what
  // follows it.
  { label: 'Overview', iconName: 'LayoutGrid', href: '/admin/home', scope: 'any' },

  // ── Platform ────────────────────────────────────────────────────────────
  // Deliberately ABOVE "This workspace": a super-admin gets the platform tier
  // stacked ON TOP of the tenant tier, which is how the two are actually used —
  // you administer the fleet, then drop into one workspace. A workspace-admin
  // never sees this block at all, so for them the tenant section is simply the
  // top of the menu.
  // `/admin/tenants`, not `/admin/licenses/tenants`. A tenant is the unit every
  // other platform screen is scoped BY, not a licensing detail — and the old
  // URL made the register reachable only by going looking for licences.
  //
  // It does NOT collide with `/admin/tenant-budgets`: `activeAdminHref` matches
  // on `pathname === href` or `pathname.startsWith(href + '/')`, and
  // `/admin/tenant-budgets` satisfies neither for `/admin/tenants`.
  {
    label: 'Tenants',
    iconName: 'Building2',
    href: '/admin/tenants',
    section: 'Platform',
    scope: 'platform',
    title: 'Every tenant: rename, archive and BYO posture',
  },
  {
    label: 'Users',
    iconName: 'Users',
    href: '/admin/users',
    scope: 'platform',
    title: 'Provision and offboard people across tenants',
  },
  {
    label: 'Early access',
    iconName: 'Users',
    href: '/admin/onboarding',
    scope: 'platform',
    title: 'Early-access requests and invites: approve, reject, invite',
  },
  { label: 'Tenant licenses', iconName: 'FileKey', href: '/admin/licenses', scope: 'platform' },

  // ── Billing ─────────────────────────────────────────────────────────────
  // Pricing, metering and per-tenant budgets are one job — what a tenant is
  // charged and what they have consumed — and were previously scattered across
  // two sections. Grouping them also disambiguates the pair that read almost
  // identically in the old menu: platform "Tenant budgets" vs workspace
  // "Budget". The workspace one is now "Usage & budget", below.
  {
    label: 'Pricing',
    iconName: 'Receipt',
    href: '/admin/pricing',
    section: 'Billing',
    scope: 'platform',
  },
  {
    label: 'Metering',
    iconName: 'Gauge',
    href: '/admin/metering',
    scope: 'platform',
    title: 'Cross-tenant incurred vs billed vs margin',
  },
  {
    label: 'Tenant budgets',
    iconName: 'Wallet',
    href: '/admin/tenant-budgets',
    scope: 'platform',
    title: 'Token budgets across every tenant',
  },

  // ── Operations ──────────────────────────────────────────────────────────
  // Andon and the asset kinds below are platform-scoped and STAY
  // platform-scoped. Assets reads like a workspace concern and was a candidate to move into the tenant section, but
  // its scope is what decides who may see it — moving it would have turned a
  // menu reshuffle into a privilege change. Left alone deliberately; revisit by
  // checking the backend gate on /api/admin/assets/*, not the label.
  {
    label: 'Andon',
    iconName: 'ShieldCheck',
    href: '/admin/andon',
    section: 'Operations',
    scope: 'platform',
    title: 'Engage or release the andon cord across every project',
  },
  {
    label: 'Kata',
    iconName: 'Wrench',
    href: '/admin/kata',
    scope: 'platform',
    title: 'Every kata the coach opened to fix the conveyor, and whether the fix held',
  },
  // The six asset kinds. There is no `/admin/assets` entry any more: that URL
  // was a tile-grid launcher and is now a 308 to `/admin/assets/principles`.
  //
  // RULING 2026-10-03 (nav standard, supersedes the "hidden" ruling written for
  // the retired admin rail): every real page is a top-level sidebar row and no
  // page carries an in-page menu. The six kinds are therefore Administration
  // rows in the MAIN sidebar — `NAV_ITEMS` in `$lib/layout/navConfig.ts`,
  // `requiresSuperAdmin` — and are no longer `hidden` here.
  //
  // They stay in this table because it still owns the admin area's labels:
  // `activeAdminHref` resolves by LONGEST prefix, and `pageTitle.test.ts` holds
  // TITLES to these labels, so each sub-page names itself instead of all five
  // claiming one parent's name. Still `platform` scope — moving them would be a
  // privilege change, not a menu change.
  { label: 'Platform principles', iconName: 'Package', href: '/admin/assets/principles', scope: 'platform' },
  { label: 'Platform requirements', iconName: 'Package', href: '/admin/assets/requirements', scope: 'platform' },
  { label: 'Platform decisions', iconName: 'Package', href: '/admin/assets/decisions', scope: 'platform' },
  { label: 'Platform workflows', iconName: 'Package', href: '/admin/assets/workflows', scope: 'platform' },
  { label: 'Platform projects', iconName: 'Package', href: '/admin/assets/projects', scope: 'platform' },

  // ── This workspace ──────────────────────────────────────────────────────
  // Scoped to the ACTIVE workspace. A workspace switch can add or remove this
  // whole section, which is correct: the role is per-workspace.
  {
    label: 'Members',
    iconName: 'Users',
    href: '/admin/members',
    section: 'This workspace',
    scope: 'tenant',
    title: 'People with access to this workspace, and their role',
  },
  {
    label: 'Usage & budget',
    iconName: 'Wallet',
    href: '/admin/budget',
    section: 'This workspace',
    scope: 'tenant',
    title: 'This workspace’s consumption and token budget',
  },
  {
    label: 'Spend breakdown',
    iconName: 'Receipt',
    href: '/admin/billing',
    section: 'This workspace',
    scope: 'tenant',
    title: 'This workspace’s spend by project and by member, with what is unattributed',
  },
  {
    label: 'Channels',
    iconName: 'MessageSquare',
    href: '/channels',
    scope: 'tenant',
    external: true,
  },

  // HIDDEN, not deleted. Departments is wanted LONG TERM — the intent is skill
  // groups, so the system can route a question to the people who can answer it
  // once fr becomes a full communication surface. It is simply too early: every
  // workspace has exactly one auto-created `default` row and nothing to manage.
  //
  // ⛔ Do NOT "clean this up". The table, its routes and that default row are
  // load-bearing for asset-scope promote/override/block, projectDeptGate,
  // requireDeptRole, stream policy and scheduled-report visibility. Hiding the
  // menu entry costs nothing; deleting the feature would be a large migration
  // against something that is wired but currently inert.
  {
    label: 'Departments',
    iconName: 'Building2',
    href: '/admin/departments',
    scope: 'tenant',
    hidden: true,
  },
];

export interface AdminViewer {
  isSuperAdmin: boolean;
  /**
   * Workspace-admin in the ACTIVE workspace (not a realm-wide claim) —
   * `auth.hasTenantRole('workspace-admin')`, i.e. the active row of
   * `GET /api/me/workspaces`, which the backend computes with the SAME
   * predicate its tenant-admin gates use.
   */
  isWorkspaceAdmin: boolean;
}

/**
 * The items this viewer may see.
 *
 * Platform items: super-admins only. Tenant items: whoever is workspace-admin
 * of the ACTIVE workspace — and nothing else. George 2026-10-27: a super-admin
 * is tenant-admin in every workspace they switch into, and the backend now says
 * so on every row it offers them (`role: 'workspace-admin'`), so a super-admin
 * still sees the tenant section everywhere the backend admits them — but the UI
 * no longer shows it on the strength of `isSuperAdmin` alone, which offered
 * controls the backend could refuse.
 */
export function visibleAdminNav(viewer: AdminViewer): AdminNavItem[] {
  return ADMIN_NAV_ITEMS.filter((item) => {
    if (item.hidden) return false;
    if (item.scope === 'any') return true;
    if (item.scope === 'platform') return viewer.isSuperAdmin;
    return viewer.isWorkspaceAdmin;
  });
}

/**
 * Whether `href` is the active item for `pathname`, by LONGEST prefix.
 *
 * A plain `startsWith` makes every parent light up with its child, so
 * `/admin/licenses` would stay highlighted on `/admin/licenses/catalog` — and,
 * worse, two items would read as active at once. Comparing candidates and
 * keeping the longest match gives exactly one.
 */
export function activeAdminHref(pathname: string, items: readonly AdminNavItem[]): string | null {
  let best: string | null = null;
  for (const item of items) {
    if (item.external) continue;
    if (pathname === item.href || pathname.startsWith(`${item.href}/`)) {
      if (best === null || item.href.length > best.length) best = item.href;
    }
  }
  return best;
}

