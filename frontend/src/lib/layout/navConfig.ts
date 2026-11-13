import { ADMIN_NAV_ITEMS } from '$lib/admin/adminNav';

// The claim strings the nav layer recognises. ⚠️ This union is NARROWER than what can
// arrive, so membership is enforced at RUNTIME by `toNavRoles()` below — never by a
// type assertion.
//
// fr#1221 (CLOSED): all three consumers — SidebarNav.svelte, CmdK.svelte,
// OperateSummaryCard.svelte — used to write `auth.tenantRoles as NavRole[]`, an
// UNCHECKED assertion that gave the union assurance it had not earned: it would have
// silently swallowed any widening of the store's own role union, and it could not have
// caught a nav/guard drift because an assertion checks nothing. All three now call
// `toNavRoles()`.
//
// `'admin'` is here because `isWorkspaceAdminVia`
// (backend/src/services/user-roles.ts) treats it as EQUIVALENT to `workspace-admin` on
// its claim arm, and a nav flag that is stricter than the gate it fronts hides a page the
// user can actually use. Measured in production 2026-09-25: `fr-test` holds `admin` and
// not `workspace-admin`, and lost the Workers entry while its writes were still accepted.
// ⇒ Any role added to `isWorkspaceAdminVia`'s claim arm belongs here too.
export type NavRole = 'workspace-admin' | 'workspace-member' | 'admin';

/**
 * Runtime mirror of the `NavRole` union, declared IMMEDIATELY below it so the two
 * cannot drift unnoticed. A union exists only at compile time; fr#1221 is precisely
 * the observation that something must check membership when the values ARRIVE, and
 * only a value list can do that.
 */
export const NAV_ROLES: readonly NavRole[] = [
  'workspace-admin',
  'workspace-member',
  'admin',
] as const;

const NAV_ROLE_SET: ReadonlySet<string> = new Set<string>(NAV_ROLES);

/** Type predicate, NOT an assertion — this file must obey the guard that polices it. */
function isNavRole(value: string): value is NavRole {
  return NAV_ROLE_SET.has(value);
}

/**
 * Legacy spellings folded onto their canonical `NavRole`.
 *
 * ⭐ MEASURED, NOT ASSUMED. The only alias anywhere in the frontend is
 * `admin` → `workspace-admin`, and the only code that performs it today is the auth
 * store: `stores/auth.svelte.ts` reads the ACTIVE workspace's single role string and
 * returns `['workspace-admin']` for BOTH `'workspace-admin'` and `'admin'`.
 *
 * It REPLACES rather than adds, and this map reproduces that exactly. `'admin'` is
 * therefore never in the OUTPUT. Two consequences, both deliberate:
 *
 *  - It loses no visibility. The only two NAV_ITEMS that name `'admin'` in
 *    `requiredAnyRole` (workers, channels) name `'workspace-admin'` FIRST, so folding
 *    `admin` onto it satisfies the same arm. Replacement and addition produce
 *    IDENTICAL visibility over today's NAV_ITEMS.
 *  - `'admin'` stays a member of the union anyway, because those two item literals
 *    still spell it and because `isWorkspaceAdminVia` accepts it on its claim arm.
 *    Dropping it from the union would red-line two correct declarations.
 */
export const NAV_ROLE_ALIASES: Readonly<Record<string, NavRole | undefined>> = {
  admin: 'workspace-admin',
};

/**
 * THE fr#1221 BOUNDARY. Narrow an arbitrary role/claim list to `NavRole` at RUNTIME,
 * dropping anything the nav layer does not recognise and folding the legacy spellings
 * in `NAV_ROLE_ALIASES`. Output is de-duplicated and keeps first-seen order.
 *
 * Takes `readonly string[]` on purpose: `auth.tenantRoles` is `readonly TenantRole[]`
 * today, and the whole defect was that an assertion made the call site immune to that
 * type changing. A `string[]` parameter means a widening upstream flows in here, where
 * an unknown value is DROPPED, instead of being asserted into the union unexamined.
 *
 * ⚠️ WHAT THIS IS NOT. It is a normaliser, not an authorisation gate. Every surface
 * behind these items re-gates on the server; this only governs whether the rail and
 * the command palette OFFER the link. And it must stay the single normalisation
 * boundary: `navConfig.test.ts` pins the /chat entry EQUAL to `chatGate` over a role
 * matrix that includes a raw `['admin']`, and that equality holds because BOTH sides
 * read post-store values. Normalising on one side of that comparison only would break
 * it — if you ever feed raw claims to one, feed them to the other.
 */
export function toNavRoles(claims: readonly string[]): NavRole[] {
  const out: NavRole[] = [];
  const add = (role: NavRole): void => {
    if (!out.includes(role)) out.push(role);
  };
  for (const raw of claims) {
    // ⛔ `Object.hasOwn`, NOT a bare `NAV_ROLE_ALIASES[raw]`. A bare index reaches the
    // OBJECT PROTOTYPE, so a claim literally named `toString` / `constructor` / `valueOf`
    // / `hasOwnProperty` / `__proto__` resolves to an inherited member, is `!== undefined`,
    // and lands in the output WITHOUT EVER REACHING `isNavRole`. Measured before this
    // guard: `toNavRoles(['toString'])` returned `[[Function: toString]]` — a function
    // inside a declared `NavRole[]`, i.e. exactly the unchecked-widening class fr#1221
    // exists to close, reintroduced by its own fix. Pinned by navConfig.test.ts.
    const aliased = Object.hasOwn(NAV_ROLE_ALIASES, raw) ? NAV_ROLE_ALIASES[raw] : undefined;
    if (aliased !== undefined) {
      add(aliased);
      continue;
    }
    if (isNavRole(raw)) add(raw);
  }
  return out;
}

export type BadgeSource =
  | 'pending-approvals'
  | 'unread-notifications'
  // R4: THIS project's Needs you list (projectCockpit.needsYouFor) — project rail only.
  | 'project-needs-you';

export type NavZone =
  | 'work'
  | 'knowledge'
  | 'engine'
  | 'govern'
  // Personal settings for the signed-in user. Rendered by SidebarNav as the
  // bottom-pinned "Account" group rather than in the zone loop, but declared
  // here so CmdK sees the same routes the rail does. These used
  // to be tabs inside /settings — a second menu inside a page — and are now
  // top-level rows like everything else.
  | 'account'
  // Administration, as two SEPARATE top-level sections rather than one nested
  // area. The two have different audiences and different blast radius, and
  // merging them is what made the old area confusing: a workspace admin saw
  // headings for fleet-wide surfaces they could not use, and a super-admin had
  // no visual line between "this workspace" and "every tenant".
  | 'workspace'
  | 'administration';

// ===========================================================================
// PROJECT-SCOPED NAV — the project shell's rail.
//
// Separate from the global NAV_ITEMS registry below (which CmdK
// consumes as absolute routes). These items are PROJECT-SCOPED: their href is
// built at render time as `/projects/<activeProjectId>/<sub>` by SidebarNav, so
// they are NOT in ALL_ROUTES (a global command palette shouldn't list a
// project sub-route with no active project).
//
// FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 / R1 (D1): ONE group. The rail used to
// carry ~30 rows across four collapsible groups (Steer / Inspect / Architecture /
// Assets) with Board buried under "Inspect · evidence", so owners could not find
// it. Now:
//   - MAIN:    the rows an owner uses, always visible, in this order —
//              Overview, Needs you, Board, Outputs, Plan & scope.
//   - DETAILS: every other existing project page, unchanged, folded under one
//              collapsible "Details" header (collapsed by default, visible to
//              every member, auto-expanded while one of its pages is open).
// No route was deleted and none redirects yet: none of the Details pages has a
// replacement until R3–R6, so each stays reachable from here.
// ===========================================================================

export type ProjectNavGroup = 'main' | 'knowledge' | 'kag' | 'details';

export interface ProjectNavItem {
  id: string;
  label: string;
  /** Lucide icon key in the SidebarNav ICONS map. */
  iconName: string;
  /** Path segment under /projects/<id>/ . '' = the project overview. */
  sub: string;
  group: ProjectNavGroup;
  /** Optional badge (resolved by SidebarNav from navCounts / project state). */
  badgeSource?: BadgeSource;
}

/**
 * The collapsible headers in the project rail. MAIN rows render as plain rows
 * with no header, so only `knowledge`, `kag` and `details` have a label and a header icon. The
 * icon-only rail shows the collapsed header as its icon with title=label, so it
 * must not repeat a row icon (rail-wide uniqueness, navConfig.test.ts).
 */
export const PROJECT_NAV_GROUP_LABELS: Readonly<Record<'knowledge' | 'kag' | 'details', string>> = {
  knowledge: 'Knowledge',
  kag: 'Project KAG',
  details: 'Details',
};

export const PROJECT_NAV_GROUP_ICONS: Readonly<Record<'knowledge' | 'kag' | 'details', string>> = {
  knowledge: 'Library',
  kag: 'LibraryBig',
  details: 'Microscope',
};

/** The sidebar-store key of the Knowledge group (its expanded state persists in localStorage). */
export const PROJECT_KNOWLEDGE_GROUP_ID = 'project:knowledge';

/** The sidebar-store key of the Project KAG group (its expanded state persists in localStorage). */
export const PROJECT_KAG_GROUP_ID = 'project:kag';

/** The sidebar-store key of the Details group (its expanded state persists in localStorage). */
export const PROJECT_DETAILS_GROUP_ID = 'project:details';

/**
 * The project sidebar's items, in render order: MAIN, KNOWLEDGE, PROJECT KAG, DETAILS.
 */
export const PROJECT_NAV: readonly ProjectNavItem[] = [
  // MAIN — always visible, in the spec §3 order.
  { id: 'overview', label: 'Overview', iconName: 'House', sub: '', group: 'main' },
  // ⛔ NO `badgeSource`, AND THAT IS THE FIX, NOT AN OVERSIGHT. This row is
  // PROJECT-SCOPED (`/projects/<id>/needs-you`); `pending-approvals` is
  // `navCounts.pendingApprovals`, which is `GET /api/approvals/all` — the
  // CROSS-WORKSPACE pending population (a super-admin in home view gets every
  // tenant's rows; see the scope note in $lib/stores/navCounts.svelte).
  //
  // MEASURED 2026-09-15 on project 328639ef…: this rail row read "Needs you
  // 99+" (SidebarBadge caps >99) while the NeedsYouQueue widget on the page it
  // links to said "Nothing needs you right now. 🎉" — two counters over what the
  // operator reads as the same thing, contradicting each other on ONE screen.
  //
  // ⭐ THE PRECEDENT IS IN THIS FILE'S OWN TEST: NAV_ITEMS' `home` row had its
  // `pending-approvals` badge removed for exactly this reason ("a badge on a nav
  // row is a promise that the row leads to those N items"). The project count is
  // rendered by NeedsYouQueue itself, on the page this row opens.
  //
  // ⭐ R4: the row now carries ITS OWN, project-scoped badge — `project-needs-you`, the length of
  // the cockpit's C2 list (`actions` / header `needs_you`), which is exactly the list the page it
  // opens renders. Same source as the list, so the two cannot disagree.
  { id: 'needs-you', label: 'Needs you', iconName: 'Hand', sub: 'needs-you', group: 'main', badgeSource: 'project-needs-you' },
  // D1: moved up from "Inspect · evidence".
  { id: 'board', label: 'Board', iconName: 'SquareKanban', sub: 'board', group: 'main' },
  // "Outputs" (R3 / DOC-3): the document trail per phase; /projects/[id]/artifacts is its route.
  { id: 'artifacts', label: 'Outputs', iconName: 'PackageOpen', sub: 'artifacts', group: 'main' },
  // fr#1483 (U-TX-VIEW-PLAN): the project's phase plan — phases, gates,
  // deliverables and exit facts. R6 merged the brief into Plan & scope.
  { id: 'plan', label: 'Plan & scope', iconName: 'ChartGantt', sub: 'plan', group: 'main' },
  // REG-3 (FR-PROJECT-HOME-REDESIGN §7.3): risks, criteria and decisions, filterable by phase.
  { id: 'registers', label: 'Registers', iconName: 'Sheet', sub: 'registers', group: 'main' },
  // Architecture is a fundamental part of every project (George, 2026-10-28):
  // always visible. The hub gathers the conformance verdict, the project's
  // ArchiMate / UML models and the code-graph views. Label == pageTitle.ts.
  { id: 'architecture', label: 'Architecture', iconName: 'Layers', sub: 'architecture', group: 'main' },
  // R6 (cockpit C7): spend vs budget, settled vs today, by phase / capability / card. The rail
  // order is fixed by design §3: Cost is the LAST main row (after Registers and Architecture).
  { id: 'cost', label: 'Cost', iconName: 'Coins', sub: 'cost', group: 'main' },

  // KNOWLEDGE — the project's knowledge work in one group (George 2026-10-30:
  // every knowledge screen of the tenant nav, reachable inside the project).
  // Effective assets + reasoning, the ArchiMate asset lists filtered by
  // ?project_id=, and the assets explicitly bound to this project, one row per
  // kind. KAG has its own collapsible group below (twelve views, like the
  // tenant rail's KAG sub-group).
  { id: 'knowledge', label: 'Effective assets', iconName: 'Combine', sub: 'knowledge', group: 'knowledge' },
  { id: 'reasoning', label: 'Reasoning (LTP)', iconName: 'Brain', sub: 'reasoning', group: 'knowledge' },
  // The tenant traceability graph scoped to this project's relationships.
  { id: 'traceability', label: 'Project traceability', iconName: 'Merge', sub: 'traceability', group: 'knowledge' },
  // ArchiMate asset lists filtered to this project (RM list ops accept project_id).
  { id: 'library-architecture-elements', label: 'Project architecture elements', iconName: 'Container', sub: 'library/architecture/elements', group: 'knowledge' },
  { id: 'library-architecture-relationships', label: 'Project architecture relationships', iconName: 'Spline', sub: 'library/architecture/relationships', group: 'knowledge' },
  { id: 'library-architecture-views', label: 'Project architecture views', iconName: 'AppWindow', sub: 'library/architecture/views', group: 'knowledge' },
  { id: 'library-architecture-standards', label: 'Project architecture standards', iconName: 'Award', sub: 'library/architecture/standards', group: 'knowledge' },
  // LIBRARY — the assets bound to this project, one row per kind (nav standard
  // 2026-10-03). Artifacts is NOT repeated: /projects/[id]/library/artifacts is a
  // 308 to the `artifacts` (Outputs) row.
  //
  // ⛔ LABELS AND ICONS ARE "Project …" + A VARIANT ICON ON PURPOSE: a project
  // row must never read like (or share an icon with) a global row — validator
  // NO, 2026-10-03. Labels match pageTitle.ts. The PM row is the READ-ONLY
  // requirements_management library (fr-agui SPEC §16 D12, P2-b).
  { id: 'library-requirements', label: 'Project requirements', iconName: 'ClipboardPen', sub: 'library/requirements', group: 'knowledge' },
  { id: 'library-principles', label: 'Project principles', iconName: 'Signpost', sub: 'library/principles', group: 'knowledge' },
  { id: 'library-decisions', label: 'Project decisions', iconName: 'GitFork', sub: 'library/decisions', group: 'knowledge' },
  { id: 'library-workflows', label: 'Project workflows', iconName: 'Route', sub: 'library/workflows', group: 'knowledge' },
  { id: 'library-triggers', label: 'Project triggers', iconName: 'Webhook', sub: 'library/triggers', group: 'knowledge' },
  { id: 'library-channels', label: 'Project channels', iconName: 'RadioTower', sub: 'library/channels', group: 'knowledge' },
  { id: 'library-pm', label: 'Project PM library', iconName: 'CalendarRange', sub: 'library/pm', group: 'knowledge' },

  // PROJECT KAG — the tenant /library/kag/* views inside the project shell, one
  // row per view in the tenant KAG sub-group's order, collapsed under ONE header
  // (collapsed by default). The pages reuse routes/library/kag/KagPage + Kag*Tab;
  // ask/search calls carry project_id while the project is open
  // ($lib/api/kagProjectScope). The bound-documents list leads the group.
  { id: 'library-kag-documents', label: 'Project KAG documents', iconName: 'FileStack', sub: 'library/kag-documents', group: 'kag' },
  { id: 'kag-upload', label: 'Project KAG upload', iconName: 'FileInput', sub: 'library/kag/documents', group: 'kag' },
  { id: 'kag-web-sources', label: 'Project KAG web sources', iconName: 'Rss', sub: 'library/kag/web-sources', group: 'kag' },
  { id: 'kag-media', label: 'Project KAG media', iconName: 'Clapperboard', sub: 'library/kag/media', group: 'kag' },
  { id: 'kag-graph', label: 'Project KAG graph explorer', iconName: 'ChartNetwork', sub: 'library/kag/graph', group: 'kag' },
  { id: 'kag-entities', label: 'Project KAG entities', iconName: 'Hexagon', sub: 'library/kag/entities', group: 'kag' },
  { id: 'kag-discover', label: 'Project KAG discovery', iconName: 'Binoculars', sub: 'library/kag/discover', group: 'kag' },
  { id: 'kag-scientific', label: 'Project KAG scientific', iconName: 'TestTubes', sub: 'library/kag/scientific', group: 'kag' },
  { id: 'kag-text-analysis', label: 'Project KAG text analysis', iconName: 'ScanText', sub: 'library/kag/text-analysis', group: 'kag' },
  { id: 'kag-ask', label: 'Project KAG ask & search', iconName: 'MessageCircleQuestionMark', sub: 'library/kag/ask', group: 'kag' },
  { id: 'kag-health', label: 'Project KAG verification health', iconName: 'Stethoscope', sub: 'library/kag/health', group: 'kag' },
  { id: 'kag-benchmarks', label: 'Project KAG retrieval quality', iconName: 'Ruler', sub: 'library/kag/benchmarks', group: 'kag' },
  { id: 'kag-capabilities', label: 'Project KAG formats & models', iconName: 'MemoryStick', sub: 'library/kag/capabilities', group: 'kag' },

  // DETAILS — every other project page, unchanged and still reachable.
  // No "Project brief" row: R6 merged the brief into Plan & scope (/projects/[id]/brief 308s there).
  { id: 'goal', label: 'Goal integrity', iconName: 'Flag', sub: 'goal', group: 'details' },
  // No "Project approvals" / "Project threads" rows (R4): both pages 308 to Needs you, which
  // lists every open ask / sign-off / review, the decided history, and the caller's project threads.
  // R5 (cockpit C5): Flow runs — the Execution hub's and Project executions' run lists merged into one
  // (status, flow, card, start, duration, n8n status; failures first while the project runs), with the
  // hub's conveyor failures + start retry and agent activity below. /execution and /executions 308 here.
  { id: 'flow-runs', label: 'Flow runs', iconName: 'Radar', sub: 'flow-runs', group: 'details' },
  { id: 'repositories', label: 'Project repositories', iconName: 'FolderGit', sub: 'repositories', group: 'details' },
  // fr#1305 — STORED quality result per repo at a known commit + CI for that
  // commit. The top-level /quality route stays retired (fr#1306).
  { id: 'quality', label: 'Project code quality', iconName: 'SearchCheck', sub: 'quality', group: 'details' },
  { id: 'governance', label: 'Governance', iconName: 'GitCompare', sub: 'governance', group: 'details' },
  // ARCHITECTURE — the project's code-graph container. Each view is a route + a
  // row (owner ruling 2026-10-03); the MAIN `architecture` row above is the hub
  // that links them. Labels == pageTitle.ts.
  { id: 'architecture-graph', label: 'Project architecture graph', iconName: 'Orbit', sub: 'architecture/graph', group: 'details' },
  { id: 'architecture-dependencies', label: 'Project dependency report', iconName: 'Cable', sub: 'architecture/dependencies', group: 'details' },
  { id: 'architecture-quality-gate', label: 'Project quality gate', iconName: 'Goal', sub: 'architecture/quality-gate', group: 'details' },
  // Project settings (andon, provisioning). Also the ⚙ in the rail's project
  // block; a row here so the collapsed rail reaches it too.
  { id: 'settings', label: 'Project settings', iconName: 'SlidersHorizontal', sub: 'settings', group: 'details' },
] as const;

export interface ProjectNavView {
  /** Always-visible rows, in render order. */
  main: ProjectNavItem[];
  /** The collapsible Knowledge group. */
  knowledge: { id: string; label: string; iconName: string; items: ProjectNavItem[] };
  /** The collapsible Project KAG group. */
  kag: { id: string; label: string; iconName: string; items: ProjectNavItem[] };
  /** The collapsible Details group. */
  details: { id: string; label: string; iconName: string; items: ProjectNavItem[] };
}

/** Split PROJECT_NAV into the main rows and the Knowledge / Project KAG / Details groups (declaration order). */
export function projectNavGroups(): ProjectNavView {
  return {
    main: PROJECT_NAV.filter((i) => i.group === 'main'),
    knowledge: {
      id: PROJECT_KNOWLEDGE_GROUP_ID,
      label: PROJECT_NAV_GROUP_LABELS.knowledge,
      iconName: PROJECT_NAV_GROUP_ICONS.knowledge,
      items: PROJECT_NAV.filter((i) => i.group === 'knowledge'),
    },
    kag: {
      id: PROJECT_KAG_GROUP_ID,
      label: PROJECT_NAV_GROUP_LABELS.kag,
      iconName: PROJECT_NAV_GROUP_ICONS.kag,
      items: PROJECT_NAV.filter((i) => i.group === 'kag'),
    },
    details: {
      id: PROJECT_DETAILS_GROUP_ID,
      label: PROJECT_NAV_GROUP_LABELS.details,
      iconName: PROJECT_NAV_GROUP_ICONS.details,
      items: PROJECT_NAV.filter((i) => i.group === 'details'),
    },
  };
}

/** Build a project-scoped href for a nav item. '' sub → the cockpit root. */
export function projectNavHref(projectId: string, sub: string): string {
  return sub ? `/projects/${projectId}/${sub}` : `/projects/${projectId}`;
}

export interface NavItem {
  id: string;
  label: string;
  href: string;
  /** Lookup key in the SidebarNav ICONS map; matches a lucide-svelte icon name. */
  iconName: string;
  zone: NavZone;
  /** If undefined, item is visible to all authenticated users. */
  requiredAnyRole?: NavRole[];
  /**
   * Gate behind super-admin (auth.isSuperAdmin). This is a SEPARATE axis from
   * the tenant `requiredAnyRole` (member/admin) — both gates must pass. Kept
   * distinct because super-admin is sourced from the allowlist, not tenantRoles.
   */
  requiresSuperAdmin?: boolean;
  /**
   * A platform super-admin passes `requiredAnyRole` without holding the tenant
   * role — for pages whose backend admits "workspace-admin OR super-admin"
   * (e.g. /chat). Without it a super-admin outside a workspace they administer
   * loses the entry to a page the backend would serve them.
   */
  superAdminPassesRole?: boolean;
  /** If set, render a SidebarBadge sourced from navCounts. */
  badgeSource?: BadgeSource;
  /**
   * The collapsible rail sub-group this row belongs to (see NAV_SUB_GROUPS).
   * Rows of one group must be CONTIGUOUS in NAV_ITEMS and share its zone
   * (pinned by navConfig.test.ts). The row stays a normal, flat NAV_ITEMS
   * entry — ALL_ROUTES and CmdK see it like any other row; only
   * SidebarNav folds it under the group header.
   */
  group?: NavSubGroupId;
  /**
   * Sub-routes rendered as an inline disclosure under this item. Currently
   * unused — the `/tools/*` family that used this was dissolved into the
   * asset/engine pages it belonged to (control-plane roadmap phases 1–3). The
   * plumbing stays for future grouped items. Children inherit no gating
   * implicitly — gate each.
   */
  children?: NavItem[];
}

export const ZONE_LABELS: Readonly<Record<NavZone, string>> = {
  work: 'Work',
  knowledge: 'Knowledge',
  engine: 'Engine',
  govern: 'Govern',
  account: 'Account',
  workspace: 'Workspace',
  administration: 'Administration',
};

// ===========================================================================
// COLLAPSIBLE SUB-GROUPS (nav standard, owner ruling 2026-10-03).
//
// "No menu inside a page" applies to tab hubs too: every former tab of
// /library/kag, /library/architecture, /govern/architecture,
// /executions and /repositories — and every /reports/asset-changes/<type> the
// /reports <select> used to launch — is now its own route AND its own NAV_ITEMS
// row. To keep the rail scannable those rows fold under ONE header per former
// hub: collapsed by default, auto-expanded when the current route is inside.
//
// Declared as a flat `group` key on each row rather than as `children`: a
// group header is not a page (the hub root is a 308 to its first row), and the
// `children` plumbing assumes a navigable parent. Exactly one level deep.
//
// `prefix` is the former hub path, now redirect-only — the common parent of
// the group's rows.
// ===========================================================================

export type NavSubGroupId =
  | 'architecture-library'
  | 'kag'
  | 'executions'
  | 'repositories'
  | 'architecture-conformance'
  | 'asset-changes'
  | 'licensing'
  | 'platform-assets'
  | 'conveyor-catalogue';

export interface NavSubGroup {
  id: NavSubGroupId;
  label: string;
  /** Lucide icon key in the SidebarNav ICONS map (header icon; title=label when the rail is collapsed). */
  iconName: string;
  zone: NavZone;
  /**
   * The common parent path of the group's rows. For a former hub it is the
   * hub path (redirect-only now); for a group like Licensing it is a row's
   * own page (/admin/licenses).
   */
  prefix: string;
}

export const NAV_SUB_GROUPS: Readonly<Record<NavSubGroupId, NavSubGroup>> = {
  'architecture-library': { id: 'architecture-library', label: 'Architecture', iconName: 'Landmark', zone: 'knowledge', prefix: '/library/architecture' },
  kag: { id: 'kag', label: 'KAG', iconName: 'Network', zone: 'knowledge', prefix: '/library/kag' },
  executions: { id: 'executions', label: 'Executions', iconName: 'History', zone: 'engine', prefix: '/executions' },
  repositories: { id: 'repositories', label: 'Repositories', iconName: 'FolderGit2', zone: 'engine', prefix: '/repositories' },
  'architecture-conformance': { id: 'architecture-conformance', label: 'Conformance', iconName: 'Scale', zone: 'govern', prefix: '/govern/architecture' },
  'asset-changes': { id: 'asset-changes', label: 'Asset changes', iconName: 'FileClock', zone: 'govern', prefix: '/reports/asset-changes' },
  // Administration had 16 flat rows; the licence trio and the six platform
  // asset kinds fold under one header each (validator N1, 2026-10-03).
  licensing: { id: 'licensing', label: 'Licensing', iconName: 'Stamp', zone: 'administration', prefix: '/admin/licenses' },
  'platform-assets': { id: 'platform-assets', label: 'Platform assets', iconName: 'Warehouse', zone: 'administration', prefix: '/admin/assets' },
  // The tenant's conveyor catalogue in requirements_management (phases, conveyor
  // capabilities, card types, project types). One route per section —
  // tab hubs are not exempt — and /library/conveyor/catalogue is a 308.
  'conveyor-catalogue': { id: 'conveyor-catalogue', label: 'Conveyor catalogue', iconName: 'Blocks', zone: 'knowledge', prefix: '/library/conveyor/catalogue' },
};

/** A rail segment: a plain row, or one sub-group header with its rows. */
export type NavSegment =
  | { kind: 'item'; item: NavItem }
  | { kind: 'group'; group: NavSubGroup; items: NavItem[] };

/**
 * Fold a zone's (already visibility-filtered) rows into render segments. A
 * group renders where its FIRST row would have; a group none of whose rows
 * survive the filter is dropped, so the rail never shows an empty header.
 */
export function navSegments(items: readonly NavItem[]): NavSegment[] {
  const out: NavSegment[] = [];
  const byGroup = new Map<NavSubGroupId, { kind: 'group'; group: NavSubGroup; items: NavItem[] }>();
  for (const item of items) {
    if (!item.group) {
      out.push({ kind: 'item', item });
      continue;
    }
    let seg = byGroup.get(item.group);
    if (!seg) {
      seg = { kind: 'group', group: NAV_SUB_GROUPS[item.group], items: [] };
      byGroup.set(item.group, seg);
      out.push(seg);
    }
    seg.items.push(item);
  }
  return out;
}

/** Same matching rule as the rail's active detection: exact or a path below. */
export function navHrefMatches(href: string, path: string): boolean {
  if (href === '/') return path === '/';
  return path === href || path.startsWith(href + '/');
}

/**
 * 4-zone control-plane IA, mapped 1:1 onto the AA philosophy
 * (n8n_custom_nodes/AA_IMPLEMENTATION/PHILOSOPHY.md):
 *  - Work:      the mantra — cards flowing TODO→READY→DOING→QA→DONE.
 *               A "Project" IS its Planka board; Kanban is the flow view.
 *  - Knowledge: the 5D asset space (Principles → Requirements → Decisions →
 *               Architecture → KAG), in canonical order.
 *  - Engine:    the muscle — n8n workflows + executions, per-asset jobs
 *               (repos, workers), channels; absorbs the dissolved /tools.
 *  - Govern:    the controls — approvals (BLOCKED gate), QA verdicts, T/I/OE
 *               measurement, improvement (kaizen) loops, settings.
 *
 * Item order within each zone defines render order. Zones render in the
 * declaration order of ZONE_ORDER (work → knowledge → engine → govern).
 *
 * New surfaces from the control-plane roadmap (Executions, Architecture,
 * Project Management, Traceability, Measure) are added in the phase that
 * builds their route — never as dead links.
 */
export const NAV_ITEMS: readonly NavItem[] = [
  // Work — the mantra flow
  // No badge. A badge on a nav row promises that the row leads to those N
  // items — Home does not, `approvals` does, and carrying the same number on
  // both left a reader unable to tell 2 items from 4. The count still reaches
  // Home twice on the page itself: the hero sentence (now a link to the queue)
  // and PendingApprovalsCard.
  { id: 'home', label: 'Home', href: '/', iconName: 'MessageSquare', zone: 'work' },
  { id: 'kanban', label: 'Kanban', href: '/kanban', iconName: 'LayoutGrid', zone: 'work' },
  { id: 'threads', label: 'Assistant', href: '/threads', iconName: 'MessageCircle', zone: 'work' },
  // Chat is a TENANT-ADMIN tool for testing the workspace's own provider keys
  // (owner ruling 2026-10-01). Same gate as Workers: the backend
  // (`routes/assets/workers.ts handleWorkerChatCompletions`) admits a
  // workspace-admin or a platform super-admin and answers 403 to a member.
  //
  // ⚠️ `['workspace-admin']` ONLY — no legacy `'admin'` arm, unlike Workers and
  // Channels below (fr BYO validator D5). The /chat PAGE gates on
  // `chatGate` (`routes/chat/chat-access.ts`: super-admin OR
  // `hasTenantRole('workspace-admin')`), so an `'admin'` arm here could only ever
  // offer an entry the page then refuses. A PINNED realm `admin` still gets in:
  // `/api/me/workspaces` folds it into the workspace row and the store
  // normalises it to `'workspace-admin'`. `navConfig.test.ts` pins this entry
  // EQUAL to `chatGate` over a role matrix.
  { id: 'chat', label: 'Chat', href: '/chat', iconName: 'MessagesSquare', zone: 'work', requiredAnyRole: ['workspace-admin'], superAdminPassesRole: true },
  // Project-execution notification inbox (WS1). Personal feed of non-approval
  // lifecycle/outcome events; the unread count drives the sidebar badge.
  { id: 'notifications', label: 'Notifications', href: '/notifications', iconName: 'Bell', zone: 'work', badgeSource: 'unread-notifications' },
  // The Common Practice → fr bridge inbox: drafts forwarded for a human to
  // review + approve into a project. It had NO sidebar row and no in-app link
  // (only /projects/intake's post-submit goto to one request), so the inbox
  // itself was unreachable. Ungated like its page: GET /api/project-requests is
  // `validateAuth` + tenant-scoped, and the page carries no role check.
  { id: 'project-requests', label: 'Project requests', href: '/projects/requests', iconName: 'Inbox', zone: 'work' },

  // Knowledge — the 5D asset space, canonical order. There is no `Library`
  // row: /library was a launcher (card grid of these same rows) and is now a
  // 308 to /principles, the first row below (nav standard, 2026-10-03).
  { id: 'principles', label: 'Principles', href: '/principles', iconName: 'Compass', zone: 'knowledge' },
  { id: 'requirements', label: 'Requirements', href: '/requirements', iconName: 'ClipboardList', zone: 'knowledge' },
  { id: 'decisions', label: 'Decisions', href: '/decisions', iconName: 'GitBranch', zone: 'knowledge' },
  // Architecture (ArchiMate) asset library — control-plane roadmap Phase 4.
  // Formerly an AssetTabs hub under /library; each kind is now its own list
  // route + row (owner ruling 2026-10-03: tab hubs are not exempt).
  // /library/architecture is a 308 to the first kind and translates legacy
  // `?tab=`. Distinct from the code-graph /architecture route — hence the
  // "Architecture …" qualifier. No page gate on any of them (the hub had none).
  // The fr PM library (programmes/projects/activities/risks/dependencies) is
  // retired; that vocabulary lives in the requirements_management catalogue.
  { id: 'architecture-elements', label: 'Architecture elements', href: '/library/architecture/elements', iconName: 'Box', zone: 'knowledge', group: 'architecture-library' },
  { id: 'architecture-relationships', label: 'Architecture relationships', href: '/library/architecture/relationships', iconName: 'Link2', zone: 'knowledge', group: 'architecture-library' },
  { id: 'architecture-views', label: 'Architecture views', href: '/library/architecture/views', iconName: 'LayoutDashboard', zone: 'knowledge', group: 'architecture-library' },
  { id: 'architecture-standards', label: 'Architecture standards', href: '/library/architecture/standards', iconName: 'BadgeCheck', zone: 'knowledge', group: 'architecture-library' },
  // ArchiMate models: versions, rule checks, reviews, publishing, exchange files (requirements_management modeling).
  { id: 'architecture-models', label: 'Architecture models', href: '/library/architecture/models', iconName: 'DraftingCompass', zone: 'knowledge', group: 'architecture-library' },
  // KAG — the twelve former /library/kag tabs, in the hub's section order
  // (Knowledge: feed · Explore: browse · Ask: query · Verify: trust), flattened
  // under one header. /library/kag is a 308 to KAG documents (the old default
  // tab, uploading is the primary task) and maps legacy `?tab=<id>`.
  // Every label carries "KAG …" (validator N2): the label is also the CmdK
  // entry, the page h1 and the tab title, none of which show the group header,
  // and the other groups' rows are qualified the same way (Architecture …).
  { id: 'kag-documents', label: 'KAG documents', href: '/library/kag/documents', iconName: 'FileUp', zone: 'knowledge', group: 'kag' },
  { id: 'kag-web-sources', label: 'KAG web sources', href: '/library/kag/web-sources', iconName: 'Globe', zone: 'knowledge', group: 'kag' },
  { id: 'kag-media', label: 'KAG media', href: '/library/kag/media', iconName: 'Film', zone: 'knowledge', group: 'kag' },
  { id: 'kag-graph', label: 'KAG graph explorer', href: '/library/kag/graph', iconName: 'Share2', zone: 'knowledge', group: 'kag' },
  { id: 'kag-entities', label: 'KAG entities', href: '/library/kag/entities', iconName: 'Shapes', zone: 'knowledge', group: 'kag' },
  { id: 'kag-discover', label: 'KAG discovery', href: '/library/kag/discover', iconName: 'Telescope', zone: 'knowledge', group: 'kag' },
  { id: 'kag-scientific', label: 'KAG scientific', href: '/library/kag/scientific', iconName: 'Atom', zone: 'knowledge', group: 'kag' },
  { id: 'kag-text-analysis', label: 'KAG text analysis', href: '/library/kag/text-analysis', iconName: 'TextSearch', zone: 'knowledge', group: 'kag' },
  { id: 'kag-ask', label: 'KAG ask & search', href: '/library/kag/ask', iconName: 'Search', zone: 'knowledge', group: 'kag' },
  { id: 'kag-health', label: 'KAG verification health', href: '/library/kag/health', iconName: 'HeartPulse', zone: 'knowledge', group: 'kag' },
  { id: 'kag-benchmarks', label: 'KAG retrieval quality', href: '/library/kag/benchmarks', iconName: 'Crosshair', zone: 'knowledge', group: 'kag' },
  { id: 'kag-capabilities', label: 'KAG formats & models', href: '/library/kag/capabilities', iconName: 'Cpu', zone: 'knowledge', group: 'kag' },
  { id: 'research', label: 'Research', href: '/library/research', iconName: 'FlaskConical', zone: 'knowledge' },
  { id: 'artifacts', label: 'Artifacts', href: '/library/artifacts', iconName: 'Package', zone: 'knowledge' },
  // Triggers had no row: its only entry point was a card on the retired
  // /library launcher. It is the generic /library/[type] lens for `trigger`.
  { id: 'triggers', label: 'Triggers', href: '/library/triggers', iconName: 'Zap', zone: 'knowledge' },
  // Conveyor map (fr#1478, design D8 view A): the read-only catalogue of
  // phases × capabilities with every card type placed, from
  // GET /api/conveyor/taxonomy. A static route beside /library/[type]. Ungated
  // like its API (any authenticated caller; the roster is universal).
  { id: 'conveyor-map', label: 'Conveyor map', href: '/library/conveyor', iconName: 'Grid3x3', zone: 'knowledge' },
  // Conveyor catalogue (RM tenant PM catalogue via /api/conveyor/catalogue):
  // ungated like its reads; writes are tenant_admin on the backend and the
  // pages render read-only for everyone else. Labels == pageTitle.ts.
  { id: 'catalogue-phases', label: 'Project phases', href: '/library/conveyor/catalogue/phases', iconName: 'SquareStack', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-capabilities', label: 'Conveyor capabilities', href: '/library/conveyor/catalogue/capabilities', iconName: 'Puzzle', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-card-types', label: 'Card types', href: '/library/conveyor/catalogue/card-types', iconName: 'Component', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-project-types', label: 'Project types', href: '/library/conveyor/catalogue/project-types', iconName: 'Boxes', zone: 'knowledge', group: 'conveyor-catalogue' },
  // RM Tier 2 vocabulary (rm#208), read-only lists in fr.
  { id: 'catalogue-wip-limits', label: 'WIP limits', href: '/library/conveyor/catalogue/wip-limits', iconName: 'TrafficCone', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-priority-levels', label: 'Priority levels', href: '/library/conveyor/catalogue/priority-levels', iconName: 'ArrowDownWideNarrow', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-deliverable-kinds', label: 'Deliverable kinds', href: '/library/conveyor/catalogue/deliverable-kinds', iconName: 'PackageCheck', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-milestone-kinds', label: 'Milestone kinds', href: '/library/conveyor/catalogue/milestone-kinds', iconName: 'FlagTriangleRight', zone: 'knowledge', group: 'conveyor-catalogue' },
  { id: 'catalogue-board-templates', label: 'Board templates', href: '/library/conveyor/catalogue/board-templates', iconName: 'LayoutTemplate', zone: 'knowledge', group: 'conveyor-catalogue' },
  // Traceability — the cross-domain graph over architecture_relationships
  // (control-plane roadmap Phase 8). Distinct from the code-graph /architecture
  // route; lives at /knowledge/graph and renders the 5D asset edge set.
  { id: 'traceability', label: 'Traceability', href: '/knowledge/graph', iconName: 'Waypoints', zone: 'knowledge' },
  // Reasoning (TOC) — the Dettmer Logical Thinking Process surface: objective
  // IO-Maps, CLR reasoning lenses, Evaporating-Cloud conflicts and CLR quality
  // scores, read from requirements_management's `/toc` API. Lives at
  // /knowledge/toc; distinct from Traceability (the architecture_relationships
  // graph) — this renders the TOC tree/cloud structures + the 8-CLR scorer.
  { id: 'reasoning-toc', label: 'Reasoning (TOC)', href: '/knowledge/toc', iconName: 'Target', zone: 'knowledge' },

  // Engine — the muscle: n8n + per-asset jobs. Absorbed the dissolved /tools:
  // n8n + activity → the Executions group; coding analysis → the Repositories
  // group. Both were AssetTabs hubs; /executions and /repositories are now
  // 308s to their first row and map legacy `?tab=` (nav standard 2026-10-03).
  { id: 'workflows', label: 'Workflows', href: '/workflows', iconName: 'Workflow', zone: 'engine' },
  { id: 'executions-n8n', label: 'n8n executions', href: '/executions/n8n', iconName: 'Play', zone: 'engine', group: 'executions' },
  { id: 'executions-activity', label: 'Execution activity', href: '/executions/activity', iconName: 'Activity', zone: 'engine', group: 'executions' },
  { id: 'repositories-registry', label: 'Repository registry', href: '/repositories/registry', iconName: 'Database', zone: 'engine', group: 'repositories' },
  { id: 'repositories-analysis', label: 'Code analysis', href: '/repositories/analysis', iconName: 'ScanSearch', zone: 'engine', group: 'repositories' },
  // Workers is the workspace worker registry — admin-only, exactly like
  // Channels below. `requiredAnyRole` mirrors the channels entry because the
  // BACKEND now matches it: POST/PUT/DELETE /api/assets/workers require a
  // workspace-admin (`backend/src/routes/assets/workers.ts`, isWorkspaceAdminVia).
  // Without the flag an ordinary member is shown /workers → "New worker" and
  // gets a 403 on submit — a dead-end form is a worse defect than the
  // ungated write it replaced. The READS stay member-level (chat lists
  // workers with a member token); this hides only the nav ENTRY POINT to the
  // admin surface.
  //
  // The flag must be at least as permissive as the gate it fronts, or it hides a
  // page the user can actually use — the exact inverse of the dead-end form above.
  //
  // Where `roles` comes from NOW: not token claims. All consumers pass
  // `auth.tenantRoles` (stores/auth.svelte.ts), which is derived from the active
  // workspace's row in `GET /api/me/workspaces`. That row already folds in a
  // `user_roles` grant AND the Keycloak realm role `tenant_admin`, and the store
  // normalises both `admin` and `workspace-admin` to `'workspace-admin'`. So a
  // DB-only grant and a realm tenant admin both see this entry, and `tenantRoles`
  // never actually contains `'admin'`.
  //
  // `'admin'` stays in the list as a harmless belt-and-braces entry: it dates from
  // when roles were read from claims (2026-09-25, `fr-test` held the `admin` claim
  // but not `workspace-admin` and lost the entry for ~20 minutes). Removing it is
  // safe only while the store keeps normalising `admin` → `workspace-admin`.
  { id: 'workers', label: 'Workers', href: '/workers', iconName: 'Bot', zone: 'engine', requiredAnyRole: ['workspace-admin', 'admin'] },
  // Channels is the workspace/dept registry — admin-only. Its gate (routes/channels.ts
  // → isWorkspaceAdminVia) accepts `workspace-admin` OR `admin`, so the flag lists both,
  // exactly like Workers above (fr#1220: it used to list only `workspace-admin` and so
  // hid a page an `admin`-claim principal could use).
  { id: 'channels', label: 'Channels', href: '/channels', iconName: 'Radio', zone: 'engine', requiredAnyRole: ['workspace-admin', 'admin'] },
  // Secrets (manifest-driven AssetWorkspace: list / detail / create; values
  // redacted) and BYOC credentials (saved URL credentials the KAG web-ingestion
  // form uses) had no sidebar row — /secrets had no in-app link at all, /byoc
  // only a "Manage credentials →" link inside the KAG Ingestion tab. Both are
  // live features (nav standard audit, 2026-10-03). UNGATED, exactly like their
  // pages: neither page checks a role, and backend routes/assets/secrets.ts and
  // routes/urlCredentials.ts call `validateAuth` only (tenant-scoped).
  { id: 'secrets', label: 'Secrets', href: '/secrets', iconName: 'Lock', zone: 'engine' },
  { id: 'byoc', label: 'BYOC credentials', href: '/byoc', iconName: 'GlobeLock', zone: 'engine' },

  // Govern — the controls: BLOCKED gate, QA verdicts, T/I/OE, improvement loops.
  // Measure is the analytics surface re-homed from /tools/analytics (roadmap
  // Phase 3), the precursor to the full T/I/OE dashboard (Phase 7). The bridge
  // (analysis→kanban) lives at /bridge but has no nav item — it is reached via
  // the PromoteButton flow + deep links, not the sidebar.
  // Same badge source as Home: the count that made a user open the sidebar
  // belongs on the row that answers it, not only on the row above it.
  { id: 'approvals', label: 'Approvals', href: '/approvals', iconName: 'CheckCircle2', zone: 'govern', badgeSource: 'pending-approvals' },
  // Architecture Governance — as-built (code-graph) vs as-designed (ArchiMate)
  // conformance dashboard (fr-phase-5-architecture-lucky-fog P3). Distinct from
  // the Knowledge "Architecture" library (the asset CRUD): this is the
  // measurement lens over the same model + the code-graph bound containers.
  // Its Dashboard / Graph / Proposals tabs are now three routes (the
  // ?projectId= / ?container= query is carried between them by the page).
  { id: 'conformance-dashboard', label: 'Conformance dashboard', href: '/govern/architecture/dashboard', iconName: 'ChartPie', zone: 'govern', group: 'architecture-conformance' },
  { id: 'conformance-graph', label: 'Conformance graph', href: '/govern/architecture/graph', iconName: 'GitGraph', zone: 'govern', group: 'architecture-conformance' },
  { id: 'measure', label: 'Measure', href: '/measure', iconName: 'BarChart3', zone: 'govern' },
  // Reports — the read-only reporting surface (approval backlog, project
  // status, worker activity, asset change history) plus the stored n8n-pushed
  // project_reports. Sits in Govern next to Measure: both are read-only lenses
  // over how the machine is running, and the approval-backlog report is
  // literally a view of the Govern zone's own BLOCKED gate.
  //
  // DELIBERATELY UNGATED — no requiresSuperAdmin, no requiredAnyRole. All six
  // endpoints (server.ts:2076-2083) call `validateAuth(req)` and nothing more;
  // tenant scoping happens inside the query (migration 080) or upstream in the
  // integration client, not via a role. Gating the rail here would hide a
  // surface every authenticated user can actually open — the inverse of the
  // rule that the rail must never offer a link the page will bounce.
  { id: 'reports', label: 'Reports', href: '/reports', iconName: 'FileText', zone: 'govern' },
  // Approval backlog was reachable ONLY from a link card on /reports (a
  // launcher inside a page, removed by the nav standard). Same gate as its page
  // and Reports above: none — /api/reports/approval-backlog calls
  // `validateAuth` only and scopes to the CALLING user.
  { id: 'reports-approval-backlog', label: 'Approval backlog', href: '/reports/approval-backlog', iconName: 'Hourglass', zone: 'govern' },
  // Asset change history, one row per asset family. These were launched from
  // a <select> on /reports and a chip strip on the detail page — a dropdown
  // menu over a FIXED list (ASSET_TYPES in $lib/api/reports), so they are rows.
  // Same gate as their page: none (validateAuth only).
  { id: 'asset-changes-requirements', label: 'Requirement changes', href: '/reports/asset-changes/requirements', iconName: 'FileDiff', zone: 'govern', group: 'asset-changes' },
  { id: 'asset-changes-decisions', label: 'Decision changes', href: '/reports/asset-changes/decisions', iconName: 'FileCheck', zone: 'govern', group: 'asset-changes' },
  { id: 'asset-changes-principles', label: 'Principle changes', href: '/reports/asset-changes/principles', iconName: 'FileSearch', zone: 'govern', group: 'asset-changes' },
  // Local-LLM prompt/response quality — the analysis that feeds the prompt /
  // workflow continuous-improvement projects (Brain → mapped icon).
  // Control tower — the super-admin fleet-wide operator cockpit (Session 11).
  // Unifies fleet health, tenant/board health, matrix coverage, telemetry,
  // improvement lanes, and the global andon control. Super-admin gate mirrors
  // the read model's 404-for-non-super-admins (the surface stays invisible).
  { id: 'control-tower', label: 'Control tower', href: '/operate', iconName: 'TowerControl', zone: 'govern', requiresSuperAdmin: true },
  // Verification — the Live Verification* Prometheus alerts (the determinism
  // benchmark view was deleted 2026-11-01 with asset-evaluator). Sibling of
  // the control tower under /operate, same gate: the read routes 404 for
  // non-super-admins, so the rail must not offer the link. /operate/verification
  // 308s to it. (Its Computed verification sibling, and with it the
  // "Verification" sub-group, was deleted 2026-11-01 with the retired ILS.)
  { id: 'verification-determinism', label: 'Verification', href: '/operate/verification/determinism', iconName: 'Dices', zone: 'govern', requiresSuperAdmin: true },
  // Workflow-improvement observatory — super-admin lens on the workflow
  // continuous-improvement machine (Session 5). The prompt and procedure lenses
  // were retired 2026-10-30 (George). Super-admin gate mirrors the read
  // model's 404-for-non-super-admins (the surface stays invisible).
  // Deliveries is the only page under /engagements. The rail used to land on a
  // one-card launcher (/engagements) whose card and tab both pointed here; the
  // launcher is now a 308 to this route.
  { id: 'engagements', label: 'Deliveries', href: '/engagements/deliveries', iconName: 'Headset', zone: 'govern' },

  // ── Account — every signed-in user, their own settings ────────────────────
  //
  // These replace the /settings page's internal tab strip and its card index
  // (both removed; /settings is now a 308 to /settings/account). Ungated: each
  // page reads only the caller's own data or the active workspace's.
  // /settings/preferences is gone — it held only the theme toggle, which the
  // Profile page already has.
  { id: 'account-profile', label: 'Profile', href: '/settings/account', iconName: 'Settings', zone: 'account' },
  { id: 'account-communication', label: 'Communication settings', href: '/settings/communication', iconName: 'BellRing', zone: 'account' },
  { id: 'account-licenses', label: 'Licenses & tokens', href: '/settings/licenses', iconName: 'KeyRound', zone: 'account' },
  { id: 'account-github', label: 'GitHub', href: '/settings/github', iconName: 'CodeXml', zone: 'account' },
  { id: 'account-usage', label: 'Workspace usage', href: '/settings/usage', iconName: 'ChartNoAxesColumn', zone: 'account' },

  // ── Workspace — tenant-admin, scoped to the ACTIVE workspace ──────────────
  //
  // `requiredAnyRole: ['workspace-admin']` and NOT `requiresSuperAdmin`: the
  // authority is the caller's row in `user_roles` for the workspace they are
  // currently in, the same row the backend gates on. A super-admin sees this
  // zone through the same rule: George 2026-10-27, they are tenant-admin of
  // every workspace they switch into, and `/api/me/workspaces` stamps each row
  // it offers them `workspace-admin`.
  //
  // `groupedNavFor` drops a zone with no visible items, so a plain member sees
  // no "Workspace" header at all rather than an empty one.
  // Members leads the zone: managing who is in the workspace is the thing a
  // workspace admin comes here to do. It was held back from the first cut of
  // this zone because the route did not exist yet, and navConfig's rule is
  // that a surface is added in the phase that BUILDS it — never as a dead link.
  { id: 'workspace-members', label: 'Members', href: '/admin/members', iconName: 'Users', zone: 'workspace', requiredAnyRole: ['workspace-admin'] },
  { id: 'workspace-byo-tokens', label: 'LLM provider', href: '/settings/llm-provider', iconName: 'PlugZap', zone: 'workspace', requiredAnyRole: ['workspace-admin'] },
  { id: 'workspace-budget', label: 'Usage & budget', href: '/admin/budget', iconName: 'Wallet', zone: 'workspace', requiredAnyRole: ['workspace-admin'] },
  { id: 'workspace-spend', label: 'Spend breakdown', href: '/admin/billing', iconName: 'Receipt', zone: 'workspace', requiredAnyRole: ['workspace-admin'] },
  // No Channels row here: the workspace channel registry is /channels, already
  // in the Engine zone under the same gate. This row used to point at
  // /settings/channels, which 308s to PERSONAL notification preferences — a
  // workspace-admin link that landed on the wrong page.

  // ── Administration — super-admin, fleet-wide ──────────────────────────────
  //
  // Everything here crosses tenant boundaries. The gate mirrors each page's own
  // server-side check, so the rail never offers a link that the page will
  // bounce. This is UI shell only: every endpoint behind these re-gates on the
  // server, so a forged claim buys a rendered page and nothing else.
  { id: 'admin-overview', label: 'Overview', href: '/admin/home', iconName: 'PanelsTopLeft', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-tenants', label: 'Tenants', href: '/admin/tenants', iconName: 'Building2', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-users', label: 'Users', href: '/admin/users', iconName: 'UserCog', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-licences', label: 'Tenant licenses', href: '/admin/licenses', iconName: 'FileKey', zone: 'administration', requiresSuperAdmin: true, group: 'licensing' },
  // Catalog + Offerings were tabs inside /admin/licenses (a menu inside a
  // page). Same gate as their parent: the licenses layout's super-admin probe.
  { id: 'admin-licence-catalog', label: 'License catalog', href: '/admin/licenses/catalog', iconName: 'BookKey', zone: 'administration', requiresSuperAdmin: true, group: 'licensing' },
  { id: 'admin-licence-offerings', label: 'License offerings', href: '/admin/licenses/offerings', iconName: 'Tags', zone: 'administration', requiresSuperAdmin: true, group: 'licensing' },
  { id: 'admin-billing', label: 'Billing', href: '/admin/pricing', iconName: 'CircleDollarSign', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-andon', label: 'Andon', href: '/admin/andon', iconName: 'AlertTriangle', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-kata', label: 'Kata', href: '/admin/kata', iconName: 'Wrench', zone: 'administration', requiresSuperAdmin: true },
  // These three were reachable ONLY from /admin/home's link list or a typed
  // URL: they exist in ADMIN_NAV_ITEMS but had no rail slot, so nothing in the
  // product pointed at them. `/admin/metering` is the sharpest case — it was
  // called ZERO times in production while the container logged 3,146 lines, so
  // the credential fix that landed for it had never once been exercised. A page
  // nobody can find generates no evidence that it works.
  { id: 'admin-metering', label: 'Metering', href: '/admin/metering', iconName: 'Gauge', zone: 'administration', requiresSuperAdmin: true },
  { id: 'admin-tenant-budgets', label: 'Tenant budgets', href: '/admin/tenant-budgets', iconName: 'PiggyBank', zone: 'administration', requiresSuperAdmin: true },
  // The six asset kinds, formerly tiles on the /admin/assets launcher (now a
  // 308 to /admin/assets/principles). Owner ruling 2026-10-03 superseded the
  // adminNav "hidden" ruling: every real page is a sidebar row. Platform-scoped
  // and super-admin only, exactly as before — a menu change, not a privilege one.
  { id: 'admin-assets-principles', label: 'Platform principles', href: '/admin/assets/principles', iconName: 'BookMarked', zone: 'administration', requiresSuperAdmin: true, group: 'platform-assets' },
  { id: 'admin-assets-requirements', label: 'Platform requirements', href: '/admin/assets/requirements', iconName: 'ClipboardType', zone: 'administration', requiresSuperAdmin: true, group: 'platform-assets' },
  { id: 'admin-assets-decisions', label: 'Platform decisions', href: '/admin/assets/decisions', iconName: 'Milestone', zone: 'administration', requiresSuperAdmin: true, group: 'platform-assets' },
  { id: 'admin-assets-workflows', label: 'Platform workflows', href: '/admin/assets/workflows', iconName: 'Cog', zone: 'administration', requiresSuperAdmin: true, group: 'platform-assets' },
  { id: 'admin-assets-projects', label: 'Platform projects', href: '/admin/assets/projects', iconName: 'FolderTree', zone: 'administration', requiresSuperAdmin: true, group: 'platform-assets' },
] as const;

// Administration sits LAST, below the daily-work zones: it is the least
// frequently used and the most destructive, and burying it under Settings is
// what made it unfindable in the first place.
const ZONE_ORDER: readonly NavZone[] = [
  'work',
  'knowledge',
  'engine',
  'govern',
  'account',
  'workspace',
  'administration',
] as const;

/**
 * Flat registry of every navigable destination — top-level items plus any
 * `children`. This is the single source of truth that non-sidebar consumers
 * (command palette) read so their route lists never drift from
 * the sidebar's. Order follows NAV_ITEMS, each parent immediately followed by
 * its children.
 */
export const ALL_ROUTES: readonly NavItem[] = NAV_ITEMS.flatMap((item) =>
  item.children && item.children.length > 0 ? [item, ...item.children] : [item],
);

/** Visibility context beyond the tenant role axis. */
export interface NavVisibilityCtx {
  isSuperAdmin?: boolean;
}

/**
 * Single predicate for "should this user see this item". Two independent
 * gates, both must pass: the super-admin gate (allowlist) and the tenant-role
 * gate (`requiredAnyRole`). Exported so the sidebar AND the command palette
 * apply identical rules.
 */
export function isItemVisible(
  item: NavItem,
  roles: NavRole[],
  ctx: NavVisibilityCtx = {},
): boolean {
  if (item.requiresSuperAdmin && !ctx.isSuperAdmin) return false;
  if (!item.requiredAnyRole) return true;
  if (item.superAdminPassesRole && ctx.isSuperAdmin) return true;
  return item.requiredAnyRole.some((r) => roles.includes(r));
}

export function visibleNavFor(
  roles: NavRole[],
  ctx: NavVisibilityCtx = {},
): readonly NavItem[] {
  return NAV_ITEMS.filter((item) => isItemVisible(item, roles, ctx));
}

export interface NavZoneGroup {
  zone: NavZone;
  label: string;
  items: NavItem[];
}

/**
 * Groups visibleNavFor() output into zones in declaration order. Empty zones
 * are dropped so the rail never renders a header with no items below it.
 */
export function groupedNavFor(
  roles: NavRole[],
  ctx: NavVisibilityCtx = {},
): NavZoneGroup[] {
  const visible = visibleNavFor(roles, ctx);
  return ZONE_ORDER
    .map((zone): NavZoneGroup => ({
      zone,
      label: ZONE_LABELS[zone],
      items: visible.filter((i) => i.zone === zone),
    }))
    .filter((g) => g.items.length > 0);
}

// ===========================================================================
// TOP-NAV SECTIONS. The top bar switches between three sections, each with its
// own sidebar: Tenant (home, projects + tenant assets), Administration
// (workspace admin) and Super-admin. Project pages are not a section: they
// render their own project sidebar (SidebarNav in the project shell).
// The section is a partition of NAV_ITEMS, derived from zone + flags so a new
// row lands in a section without a second list to keep in sync.
// ===========================================================================

export type NavSection = 'tenant' | 'admin' | 'super';

export function sectionOf(item: NavItem): NavSection {
  if (item.zone === 'workspace') return 'admin';
  if (item.zone === 'administration' || (item.zone === 'govern' && item.requiresSuperAdmin)) return 'super';
  return 'tenant';
}

/** One section's sidebar: the visible zones, narrowed to that section's rows. */
export function sectionNavFor(
  section: NavSection,
  roles: NavRole[],
  ctx: NavVisibilityCtx = {},
): NavZoneGroup[] {
  return groupedNavFor(roles, ctx)
    .map((g) => ({ ...g, items: g.items.filter((i) => sectionOf(i) === section) }))
    .filter((g) => g.items.length > 0);
}

/**
 * The section a path belongs to: the section of the longest NAV_ITEMS href the
 * path sits under; else Tenant (project pages included).
 */
export function sectionForPath(path: string): NavSection {
  let best: NavItem | null = null;
  for (const item of ALL_ROUTES) {
    if (item.href === '/') continue;
    if (navHrefMatches(item.href, path) && (best === null || item.href.length > best.href.length)) best = item;
  }
  if (best) return sectionOf(best);
  // Admin pages with no NAV_ITEMS row (e.g. /admin/onboarding, /admin/departments):
  // the admin registry's tier says which section they belong to.
  const admin = ADMIN_NAV_ITEMS.filter((i) => navHrefMatches(i.href, path)).sort((a, b) => b.href.length - a.href.length)[0];
  if (admin?.scope === 'platform') return 'super';
  if (admin?.scope === 'tenant') return 'admin';
  return 'tenant';
}
