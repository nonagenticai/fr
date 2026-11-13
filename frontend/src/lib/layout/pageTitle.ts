// src/lib/layout/pageTitle.ts
// ===========================================================================
// The ONE place a browser-tab title is decided.
//
// Why this file exists: SvelteKit renders `<title>` from whichever
// `<svelte:head>` is currently mounted, and a route that sets none does not
// fall back to a default — on client navigation it KEEPS THE PREVIOUS PAGE'S
// title. Measured on origin/main: 139 of 168 `+page.svelte` set none, so the
// tab routinely lied — /kanban read "Control tower", /decisions once read
// "Notifications". A per-page convention cannot fix that, because the failure
// mode IS a page forgetting. The admin area already learned this the expensive
// way and centralised its title in `routes/(admin)/admin/+layout.svelte`; this
// generalises that fix to the whole product.
//
// PURITY: no runes, no `$app/*`, no DOM, no imports, no side effects. That
// keeps the rule with the actual consequence — which title wins — in the pure
// vitest project where it is unit-tested rather than eyeballed in a browser.
// The reactive half (the runtime override store) is `pageTitle.svelte.ts`.
//
// The map below is a plain object literal with quoted keys — see the admin note below.
// ===========================================================================

/**
 * Product brand, and the KAG-shell brand. Also the tab title for `/`. The SAME
 * name the shell shows (BrandMark / SidebarNav "Non-Agentic AI") — never the
 * internal service name.
 */
export const BRAND = 'Non-Agentic AI';
export const KAG_BRAND = 'KAG';

/** A runtime title pushed by a page, pinned to the pathname it was set on. */
export interface PageTitleOverride {
  path: string;
  title: string;
}

/**
 * Route id → short human page name, for EVERY `+page.svelte` in the app.
 *
 * Keys are SvelteKit ROUTE IDS: layout groups `(admin)` / `(platform)` /
 * `(tenant)` are not part of a route id and never appear here.
 *
 * The suffix (`· fr`) is NOT stored here — `resolveTitle` composes it, so the
 * KAG shell can swap the brand without a second map.
 *
 * For a dynamic route the value is the entity NOUN, used for SSR and as the
 * fallback until the real name arrives; the page pushes the loaded entity's
 * name through `setPageTitle()` at runtime. Never a placeholder: "fr", "Page",
 * "TODO", "Untitled", a blank, or the route id echoed back are rejected by
 * `pageTitle.test.ts`, because a map full of those satisfies the coverage guard
 * while leaving every tab useless.
 */
export const TITLES: Record<string, string> = {
  // ── Work ────────────────────────────────────────────────────────────────
  // `/` is listed so the map can be audited 1:1 against the filesystem, but the
  // resolver renders the brand alone for it — the tab for the product root is
  // the product's name.
  '/': 'Home',
  '/kanban': 'Kanban',
  '/threads': 'Assistant',
  '/threads/[id]': 'Thread',
  '/chat': 'Chat',
  '/notifications': 'Notifications',
  '/login': 'Sign in',
  '/cards/[id]': 'Card',
  '/license-upgrade': 'Upgrade licence',
  '/byoc': 'BYOC credentials',

  // ── Knowledge ───────────────────────────────────────────────────────────
  '/library/[type]': 'Asset library',
  '/library/artifacts': 'Artifacts',
  '/library/conveyor': 'Conveyor map',
  // Conveyor catalogue (RM tenant PM catalogue). /library/conveyor/catalogue is a
  // 308 to the first section: no page, no title. Titles == rail row labels.
  '/library/conveyor/catalogue/phases': 'Project phases',
  '/library/conveyor/catalogue/phases/[id]': 'Project phase',
  '/library/conveyor/catalogue/capabilities': 'Conveyor capabilities',
  '/library/conveyor/catalogue/card-types': 'Card types',
  '/library/conveyor/catalogue/project-types': 'Project types',
  '/library/conveyor/catalogue/project-types/[id]': 'Project type',
  '/library/conveyor/catalogue/wip-limits': 'WIP limits',
  '/library/conveyor/catalogue/priority-levels': 'Priority levels',
  '/library/conveyor/catalogue/deliverable-kinds': 'Deliverable kinds',
  '/library/conveyor/catalogue/milestone-kinds': 'Milestone kinds',
  '/library/conveyor/catalogue/board-templates': 'Board templates',
  // KAG — the former /library/kag hub tabs, one route each (nav standard
  // 2026-10-03). /library/kag is a 308 now: no page, no title. Each title is
  // its rail row's label.
  '/library/kag/documents': 'KAG documents',
  '/library/kag/web-sources': 'KAG web sources',
  '/library/kag/media': 'KAG media',
  '/library/kag/graph': 'KAG graph explorer',
  '/library/kag/entities': 'KAG entities',
  '/library/kag/discover': 'KAG discovery',
  '/library/kag/scientific': 'KAG scientific',
  '/library/kag/text-analysis': 'KAG text analysis',
  '/library/kag/ask': 'KAG ask & search',
  '/library/kag/health': 'KAG verification health',
  '/library/kag/benchmarks': 'KAG retrieval quality',
  '/library/kag/capabilities': 'KAG formats & models',
  '/library/research': 'Research',
  '/knowledge/graph': 'Traceability',
  '/knowledge/toc': 'Reasoning (TOC)',
  '/kag/entities/[id]': 'KAG entity',

  // The 5D asset space — list / detail / edit / new, one shape per dimension.
  '/principles': 'Principles',
  '/principles/[id]': 'Principle',
  '/principles/[id]/edit': 'Edit principle',
  '/principles/new': 'New principle',
  '/requirements': 'Requirements',
  '/requirements/[id]': 'Requirement',
  '/requirements/[id]/edit': 'Edit requirement',
  '/requirements/new': 'New requirement',
  '/decisions': 'Decisions',
  '/decisions/[id]': 'Decision',
  '/decisions/[id]/edit': 'Edit decision',
  '/decisions/new': 'New decision',

  // Architecture (ArchiMate) asset library. Distinct from
  // `/projects/[id]/architecture` (the project's Architecture hub) and
  // `/govern/architecture` (the conformance lens) — three different pages that
  // all used to be findable only as "Architecture". The unscoped
  // `/architecture` route was a 307 redirect shim and has been deleted.
  // The four list routes were 308s into the /library/architecture tab hub;
  // they are the pages now and /library/architecture is the 308.
  '/library/architecture/elements': 'Architecture elements',
  '/library/architecture/relationships': 'Architecture relationships',
  '/library/architecture/views': 'Architecture views',
  '/library/architecture/standards': 'Architecture standards',
  '/library/architecture/elements/[id]': 'Architecture element',
  '/library/architecture/elements/[id]/edit': 'Edit architecture element',
  '/library/architecture/elements/new': 'New architecture element',
  '/library/architecture/relationships/[id]': 'Architecture relationship',
  '/library/architecture/relationships/new': 'New architecture relationship',
  '/library/architecture/standards/[id]': 'Architecture standard',
  '/library/architecture/standards/[id]/edit': 'Edit architecture standard',
  '/library/architecture/standards/new': 'New architecture standard',
  '/library/architecture/views/[id]': 'Architecture view',
  '/library/architecture/views/[id]/edit': 'Edit architecture view',
  '/library/architecture/views/new': 'New architecture view',
  '/library/architecture/models': 'Architecture models',
  '/library/architecture/models/[id]': 'Architecture model',
  '/library/architecture/models/[id]/versions/[rid]': 'Model version',
  '/library/architecture/models/[id]/validation/[runId]': 'Model rule check',
  '/library/architecture/models/[id]/changes/[csid]': 'Model changes',
  '/library/architecture/uml/elements/[eid]': 'UML element',
  '/library/architecture/uml/relationships/[rid]': 'UML relationship',
  '/library/architecture/uml/interactions/[iid]': 'UML interaction',
  '/library/architecture/uml/diagrams/[did]': 'UML diagram',

  // ── Engine ──────────────────────────────────────────────────────────────
  '/workflows': 'Workflows',
  '/workflows/[id]': 'Workflow',
  // /executions and /repositories were tab pages; each tab is a route now and
  // the roots are 308s.
  '/executions/n8n': 'n8n executions',
  '/executions/activity': 'Execution activity',
  '/repositories/registry': 'Repository registry',
  '/repositories/analysis': 'Code analysis',
  '/repositories/jobs/[id]': 'Analysis job',
  '/workers': 'Workers',
  '/workers/[name]': 'Worker',
  '/workers/new': 'New worker',
  '/channels': 'Channels',
  '/channels/[id]': 'Channel',
  '/channels/new': 'New channel',
  '/secrets': 'Secrets',
  '/secrets/[secret_id]': 'Secret',
  '/secrets/new': 'New secret',
  '/bridge': 'Promote to kanban',
  '/bridge/[id]': 'Promotion draft',

  // ── Govern ──────────────────────────────────────────────────────────────
  '/approvals': 'Approvals',
  '/approvals/[id]': 'Approval',
  '/govern/architecture/dashboard': 'Conformance dashboard',
  '/govern/architecture/graph': 'Conformance graph',
  '/measure': 'Measure',
  '/operate': 'Control tower',
  '/operate/verification/determinism': 'Verification',
  '/engagements/deliveries': 'Delivery log',
  '/engagements/deliveries/[id]': 'Delivery',
  '/reports': 'Reports',
  '/reports/[reportId]': 'Report',
  '/reports/approval-backlog': 'Approval backlog',
  '/reports/asset-changes/[assetType]': 'Asset changes',
  '/reports/project-status/[projectId]': 'Project status',
  '/reports/worker-activity/[workerId]': 'Worker activity',

  // ── Projects (Work zone) ────────────────────────────────────────────────
  // The project-scoped views take their names from PROJECT_NAV in
  // `navConfig.ts` where one exists (Needs you, Goal integrity, Effective
  // assets, Reasoning (LTP)); the rest are prefixed "Project " so the tab says
  // WHICH scope it shows — `/projects/[id]/architecture` and `/architecture`
  // are different pages and would otherwise be indistinguishable.
  '/projects/[id]': 'Project',
  '/projects/new': 'New project',
  '/projects/intake': 'Project intake',
  '/projects/requests': 'Project requests',
  '/projects/requests/[id]': 'Project request',
  '/projects/[id]/approve/[approvalId]': 'Project approval',
  '/projects/[id]/architecture': 'Architecture',
  '/projects/[id]/architecture/graph': 'Project architecture graph',
  '/projects/[id]/architecture/dependencies': 'Project dependency report',
  '/projects/[id]/architecture/quality-gate': 'Project quality gate',
  '/projects/[id]/artifacts': 'Project artifacts',
  '/projects/[id]/documents/[artifactId]': 'Project document',
  '/projects/[id]/board': 'Project board',
  '/projects/[id]/cards/[cardId]': 'Project card',
  '/projects/[id]/threads/[threadId]': 'Project thread',
  '/projects/[id]/flow-runs': 'Flow runs',
  '/projects/[id]/goal': 'Goal integrity',
  '/projects/[id]/plan': 'Plan & scope',
  '/projects/[id]/governance': 'Project governance',
  '/projects/[id]/knowledge': 'Effective assets',
  '/projects/[id]/needs-you': 'Needs you',
  '/projects/[id]/reasoning': 'Reasoning (LTP)',
  '/projects/[id]/traceability': 'Project traceability',
  '/projects/[id]/registers': 'Registers',
  '/projects/[id]/cost': 'Cost',
  '/projects/[id]/quality': 'Project code quality',
  '/projects/[id]/repositories': 'Project repositories',
  '/projects/[id]/settings': 'Project settings',
  '/projects/[id]/library/channels': 'Project channels',
  '/projects/[id]/library/pm': 'Project PM library',
  '/projects/[id]/library/decisions': 'Project decisions',
  '/projects/[id]/library/kag-documents': 'Project KAG documents',
  '/projects/[id]/library/principles': 'Project principles',
  '/projects/[id]/library/requirements': 'Project requirements',
  '/projects/[id]/library/triggers': 'Project triggers',
  '/projects/[id]/library/workflows': 'Project workflows',
  // The project Knowledge + Project KAG groups (2026-10-30): the tenant KAG
  // views inside the project shell and the ArchiMate lists filtered to the
  // project. Labels == PROJECT_NAV.
  '/projects/[id]/library/kag/documents': 'Project KAG upload',
  '/projects/[id]/library/kag/web-sources': 'Project KAG web sources',
  '/projects/[id]/library/kag/media': 'Project KAG media',
  '/projects/[id]/library/kag/graph': 'Project KAG graph explorer',
  '/projects/[id]/library/kag/entities': 'Project KAG entities',
  '/projects/[id]/library/kag/discover': 'Project KAG discovery',
  '/projects/[id]/library/kag/scientific': 'Project KAG scientific',
  '/projects/[id]/library/kag/text-analysis': 'Project KAG text analysis',
  '/projects/[id]/library/kag/ask': 'Project KAG ask & search',
  '/projects/[id]/library/kag/health': 'Project KAG verification health',
  '/projects/[id]/library/kag/benchmarks': 'Project KAG retrieval quality',
  '/projects/[id]/library/kag/capabilities': 'Project KAG formats & models',
  '/projects/[id]/library/architecture/elements': 'Project architecture elements',
  '/projects/[id]/library/architecture/relationships': 'Project architecture relationships',
  '/projects/[id]/library/architecture/views': 'Project architecture views',
  '/projects/[id]/library/architecture/standards': 'Project architecture standards',

  // ── Settings ────────────────────────────────────────────────────────────
  // `/settings/communication` and `/settings/channels` are NOT "Notifications"
  // and "Channels": those names already belong to `/notifications` (the inbox)
  // and `/channels` (the registry), and two tabs reading the same word is the
  // ambiguity this map exists to remove. `/settings/communication` is where you
  // are reached AND how you operate fr from other channels; `/settings/channels`
  // is a legacy redirect to it.
  '/settings/account': 'Account',
  '/settings/channels': 'Notification channels',
  '/settings/communication': 'Communication settings',
  '/settings/notifications': 'Notification settings (moved)',
  '/settings/github': 'GitHub',
  '/settings/licenses': 'My licenses & tokens',
  '/settings/llm-provider': 'LLM provider',
  '/settings/usage': 'Workspace usage',

  // ── Administration ──────────────────────────────────────────────────────
  // These names are OWNED BY `lib/admin/adminNav.ts` — `ADMIN_NAV_ITEMS` is
  // where the admin area's labels live, including the six `/admin/assets/*`
  // kinds, listed there so each sub-page names itself instead of all six
  // claiming "Assets". (`/admin/assets` itself is a 308 now — no page, no key.)
  //
  // They are COPIED here rather than derived; the delegation is
  // enforced by TEST — `pageTitle.test.ts` asserts every entry below
  // still equals its `ADMIN_NAV_ITEMS` label, so a label edit that is not
  // mirrored here fails rather than drifting.
  //
  // One label is qualified on the way across, because a nav label is read
  // INSIDE the admin shell whereas a tab title is read beside 30 other tabs:
  // "Overview" does not say which area it is the overview of. The six asset
  // kinds need no qualification — their nav labels are already "Platform
  // <kind>", so they cannot collide with the top-level /decisions, /principles,
  // /projects, /requirements and /workflows pages.
  '/admin/home': 'Admin overview',
  '/admin/tenants': 'Tenants',
  '/admin/tenants/[nameOrId]': 'Tenant',
  '/admin/users': 'Users',
  '/admin/onboarding': 'Early access',
  '/admin/licenses': 'Tenant licenses',
  '/admin/licenses/catalog': 'License catalog',
  '/admin/licenses/offerings': 'License offerings',
  '/admin/pricing': 'Pricing',
  '/admin/metering': 'Metering',
  '/admin/tenant-budgets': 'Tenant budgets',
  '/admin/andon': 'Andon',
  '/admin/kata': 'Kata',
  '/admin/kata/[id]': 'Kata detail',
  '/admin/assets/decisions': 'Platform decisions',
  '/admin/assets/principles': 'Platform principles',
  '/admin/assets/projects': 'Platform projects',
  '/admin/assets/requirements': 'Platform requirements',
  '/admin/assets/workflows': 'Platform workflows',
  '/admin/members': 'Members',
  '/admin/budget': 'Usage & budget',
  '/admin/billing': 'Spend breakdown',
  '/admin/departments': 'Departments',
  '/admin/departments/[id]': 'Department',
  '/admin/departments/[id]/knowledge': 'Department knowledge',
  '/admin/departments/new': 'New department',
};

/**
 * The tab title for one navigation, as a pure function of four inputs.
 *
 * @param routeId   SvelteKit `page.route.id` (`/cards/[id]`), or null.
 * @param pathname  The live `page.url.pathname` (`/cards/abc-123`).
 * @param override  A runtime title pushed by a page, pinned to the pathname it
 *                  was set on (see `pageTitle.svelte.ts`).
 * @param kagMode   True inside the KAG shell, which brands itself "KAG".
 */
/**
 * SvelteKit's `page.route.id` carries LAYOUT GROUP segments — `(admin)`,
 * `(platform)`, `(tenant)` — which are organisational only and never appear in
 * the URL. `TITLES` is keyed by URL-shaped path, so the raw route id must be
 * normalised before lookup.
 *
 * ⛔ THIS IS NOT COSMETIC, AND ITS ABSENCE WAS SILENT. Measured on the first
 * cut of this module: plain routes matched a key 144/144, grouped routes 0/24 —
 * every single `(admin)` page fell through to the bare brand. The CI guard did
 * NOT catch it, because the guard derives its route ids FROM THE FILESYSTEM and
 * strips groups there too; both sides agreed on a key the running app never
 * asks for. Guard green, 24 tabs wrong.
 *
 * That is why `pageTitle.test.ts` asserts group stripping directly against real
 * route ids rather than trusting the guard's coverage count: two components that
 * derive the same key the same wrong way cannot check each other.
 */
export function normaliseRouteId(routeId: string | null): string | null {
  if (routeId === null) return null;
  const stripped = routeId
    .split('/')
    .filter((seg) => !/^\(.*\)$/.test(seg))
    .join('/');
  return stripped === '' ? '/' : stripped;
}

export function resolveTitle(
  routeId: string | null,
  pathname: string,
  override: PageTitleOverride | null,
  kagMode: boolean,
): string {
  const brand = kagMode ? KAG_BRAND : BRAND;

  // ── The rule that makes a stale title STRUCTURALLY UNREPRESENTABLE ───────
  //
  // The override is honoured ONLY when `override.path === pathname`. Otherwise
  // it is discarded. An entity page that has navigated away can therefore never
  // leak its name onto the next route, REGARDLESS OF UNMOUNT/MOUNT ORDERING —
  // there is no window in which a leftover override can win, because winning
  // requires agreeing with the pathname currently in the address bar. That is
  // strictly stronger than "clear it on unmount", which is what the per-page
  // and breadcrumb-style conventions relied on, and which fails whenever the
  // new page mounts before the old one tears down.
  let name: string | null = null;
  if (override && override.path === pathname) {
    // A blank or whitespace-only override is not a title: discard it and fall
    // back to the map rather than render a tab with no name.
    const trimmed = override.title.trim();
    if (trimmed) name = trimmed;
  }

  if (name === null) {
    const key = normaliseRouteId(routeId);

    // The product root's tab is the product's name, with no page prefix.
    if (key === '/') return brand;

    // `hasOwnProperty`, not a truthiness check: a route id of "constructor" or
    // "toString" would otherwise resolve to a function off Object.prototype.
    if (key !== null && Object.prototype.hasOwnProperty.call(TITLES, key)) {
      const mapped = TITLES[key].trim();
      if (mapped) name = mapped;
    }
  }

  // An unknown or null route id falls back to the BARE brand — never to
  // whatever the last resolved page was called. A missing entry must degrade to
  // "fr", not to a neighbouring page's title.
  return name === null ? brand : `${name} · ${brand}`;
}
