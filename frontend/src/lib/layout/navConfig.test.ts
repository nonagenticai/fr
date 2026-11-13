import { describe, it, expect } from 'vitest';
import { chatGate } from '../../routes/chat/chat-access';
import { ADMIN_NAV_ITEMS } from '../admin/adminNav';
import { load as libraryTypeLoad } from '../../routes/library/[type]/+page';
import {
  SVELTE_PAGES,
  ROUTES,
  isRedirectOnly,
  resolve,
  paramsOf,
  CONDITIONAL_LOADS,
} from '../nav/tests/routeTree';
import {
  NAV_ITEMS,
  PROJECT_NAV,
  ALL_ROUTES,
  ZONE_LABELS,
  visibleNavFor,
  groupedNavFor,
  isItemVisible,
  toNavRoles,
  NAV_ROLES,
  NAV_ROLE_ALIASES,
  NAV_SUB_GROUPS,
  PROJECT_NAV_GROUP_ICONS,
  PROJECT_NAV_GROUP_LABELS,
  PROJECT_DETAILS_GROUP_ID,
  PROJECT_KAG_GROUP_ID,
  PROJECT_KNOWLEDGE_GROUP_ID,
  projectNavGroups,
  navSegments,
  type NavRole,
  type NavZone,
  type NavItem,
} from './navConfig';

/** Every icon-bearing rail entry, labelled by where it comes from. */
function railIconEntries(): { who: string; icon: string }[] {
  return [
    ...ALL_ROUTES.map((i) => ({ who: `NAV_ITEMS ${i.id}`, icon: i.iconName })),
    ...Object.values(NAV_SUB_GROUPS).map((g) => ({ who: `NAV_SUB_GROUPS ${g.id}`, icon: g.iconName })),
    ...PROJECT_NAV.map((i) => ({ who: `PROJECT_NAV ${i.id}`, icon: i.iconName })),
    ...Object.entries(PROJECT_NAV_GROUP_ICONS).map(([g, icon]) => ({ who: `PROJECT_NAV_GROUP ${g}`, icon })),
  ];
}

function railIconClashes(entries: readonly { who: string; icon: string }[]): string[] {
  const seen = new Map<string, string>();
  const out: string[] = [];
  for (const e of entries) {
    const prev = seen.get(e.icon);
    if (prev) out.push(`${e.icon}: ${prev} + ${e.who}`);
    else seen.set(e.icon, e.who);
  }
  return out;
}

describe('NAV_ITEMS', () => {
  it('every item has a non-empty iconName', () => {
    for (const item of NAV_ITEMS) {
      // A separate `expect(item.iconName.length).toBeGreaterThan(0)` used to
      // follow; it restated this line (for a string, truthy == non-empty). Removed
      // 2026-10-31 — one claim, one assertion.
      expect(item.iconName, `item ${item.id} missing iconName`).toBeTruthy();
    }
  });

  it('every item id is unique', () => {
    const ids = NAV_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // The rail and CmdK show the label and nothing else, so two rows with one
  // label are two different pages the user cannot tell apart. This happened on
  // 2026-10-03: the six /admin/assets/<kind> rows were labelled "Principles",
  // "Requirements", … — identical to the Knowledge-zone rows. Checked over ALL
  // items (not just one viewer's visible set) so a duplicate cannot hide behind
  // a gate that today's test persona happens not to pass.
  it('no two items share a label (case-insensitive)', () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const item of NAV_ITEMS) {
      const key = item.label.trim().toLowerCase();
      const prev = seen.get(key);
      if (prev) dupes.push(`"${item.label}": ${prev} + ${item.id}`);
      else seen.set(key, item.id);
    }
    expect(dupes).toEqual([]);
  });

  it('labels are unique in the rail of a viewer who passes every gate', () => {
    const all = visibleNavFor([...NAV_ROLES] as NavRole[], { isSuperAdmin: true });
    // Non-vacuity: this persona must see the super-admin asset rows.
    expect(all.some((i) => i.href === '/admin/assets/principles')).toBe(true);
    const labels = all.map((i) => i.label.toLowerCase());
    expect(new Set(labels).size).toBe(labels.length);
  });

  // ⛔ The rail AS RENDERED with a project open: SidebarNav draws every
  // PROJECT_NAV group ABOVE the global zones, and the collapsed rail shows only
  // icon + title. The checks above cover NAV_ITEMS alone, so they passed while
  // the project Library group repeated "Principles" … "Channels" (same icons)
  // right above the global rows — validator NO, 2026-10-03.
  it('labels are unique across the rail rendered with a project open (PROJECT_NAV + every visible NAV_ITEMS row)', () => {
    const all = visibleNavFor([...NAV_ROLES] as NavRole[], { isSuperAdmin: true });
    const rows: { key: string; who: string }[] = [
      ...PROJECT_NAV.map((i) => ({ key: i.label.trim().toLowerCase(), who: `PROJECT_NAV[${i.group}] ${i.id}` })),
      ...all.map((i) => ({ key: i.label.trim().toLowerCase(), who: `NAV_ITEMS[${i.zone}] ${i.id}` })),
    ];
    // Per-group row counts pinned here until 2026-10-31 (15 / 13 / >= 9) went
    // red whenever a project row was added and asserted nothing the duplicate
    // scan below does not. The union is built from PROJECT_NAV, so counting it
    // was a restatement; `exemptHits` below proves the rows are non-empty.
    expect(all.some((i) => i.href === '/admin/assets/principles')).toBe(true);
    // ONE named exemption, and why it is safe: FR-PROJECT-HOME-REDESIGN R1 names
    // the project home "Overview" (spec §3). The only other "Overview" is the
    // super-admin Administration zone's /admin/home row, and the two can never be
    // on screen together — SidebarNav renders the tenant zones only under
    // `{#if !projectMode}` (SPEC §7.2). Any OTHER clash
    // still fails here.
    const EXEMPT: Readonly<Record<string, string>> = {
      overview: 'PROJECT_NAV overview vs NAV_ITEMS admin-overview: never rendered in the same rail mode',
    };
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    const exemptHits: string[] = [];
    for (const r of rows) {
      const prev = seen.get(r.key);
      if (prev && EXEMPT[r.key]) exemptHits.push(r.key);
      else if (prev) dupes.push(`"${r.key}": ${prev} + ${r.who}`);
      else seen.set(r.key, r.who);
    }
    expect(dupes).toEqual([]);
    // The exemption must still be needed; delete it when it is not.
    expect(exemptHits).toEqual(['overview']);
  });

  it('labels are unique within the project-mode rail (PROJECT_NAV rows + the group headers)', () => {
    const labels = [
      ...PROJECT_NAV.map((i) => i.label.trim().toLowerCase()),
      ...Object.values(PROJECT_NAV_GROUP_LABELS).map((l) => l.trim().toLowerCase()),
    ];
    // No length pin: `labels` is built from PROJECT_NAV + its group headers, so
    // the duplicate scan below is the assertion (a header repeating a row label).
    expect(labels.filter((l, i) => labels.indexOf(l) !== i)).toEqual([]);
  });

  // ⛔ ONE ICON PER RAIL ENTRY, rail-wide (owner ruling 2026-10-03; validator
  // B2 on b4065c80). The collapsed rail is icon + title only, and with a project
  // open PROJECT_NAV renders ABOVE every zone — so a Gauge on "Control tower",
  // "Metering" and project "Quality" is three rows the operator cannot tell
  // apart. The old rule here only forbade icon AND kind together, which let 16
  // names repeat. Every row (ALL_ROUTES: NAV_ITEMS + any children), every
  // sub-group header, every PROJECT_NAV row and every project group header.
  // No row is excluded: NAV_ITEMS has no never-rendered (hidden) rows.
  it('every rail icon is unique: rows, sub-group headers, project rows, project group headers', () => {
    const entries = railIconEntries();
    // No length pin: `entries` is built from ALL_ROUTES / NAV_SUB_GROUPS /
    // PROJECT_NAV / PROJECT_NAV_GROUP_ICONS, so a pin here restated the union by
    // construction and went red on every added row. The clash scan is the claim.
    expect(railIconClashes(entries)).toEqual([]);
  });

  it('self-check: the rail-wide clash detector is red on one duplicate across sections', () => {
    const mutated = railIconEntries().map((e) =>
      e.who === 'PROJECT_NAV quality' ? { ...e, icon: 'Workflow' } : e,
    );
    expect(railIconClashes(mutated)).toEqual(['Workflow: NAV_ITEMS workflows + PROJECT_NAV quality']);
  });

  it('admin asset rows carry the same label as ADMIN_NAV_ITEMS (one name per page)', () => {
    const adminRows = NAV_ITEMS.filter((i) => i.href.startsWith('/admin/assets/'));
    // No `toHaveLength(6)`: the six ids are named in the super-admin diff test
    // below, which fails if one disappears. This loop checks whatever rows exist.
    for (const row of adminRows) {
      const admin = ADMIN_NAV_ITEMS.find((a) => a.href === row.href);
      expect(admin?.label, row.href).toBe(row.label);
      expect(row.label.startsWith('Platform ')).toBe(true);
    }
  });

  it('every item has a valid zone', () => {
    const validZones: NavZone[] = [
      'work',
      'knowledge',
      'engine',
      'govern',
      'account',
      'workspace',
      'administration',
    ];
    for (const item of NAV_ITEMS) {
      expect(validZones).toContain(item.zone);
    }
  });

  it('contains the Work mantra-flow items', () => {
    const workIds = NAV_ITEMS.filter((i) => i.zone === 'work').map((i) => i.id);
    expect(workIds).toEqual(['home', 'kanban', 'threads', 'chat', 'notifications', 'project-requests']);
  });

  it('contains the Knowledge 5D asset-space items in canonical order', () => {
    const knowledgeIds = NAV_ITEMS.filter((i) => i.zone === 'knowledge').map((i) => i.id);
    // No 'library' row: /library is a 308 to /principles (nav standard).
    expect(knowledgeIds).toEqual([
      'principles',
      'requirements',
      'decisions',
      // Former tab hubs, one row per kind (nav standard 2026-10-03).
      'architecture-elements',
      'architecture-relationships',
      'architecture-views',
      'architecture-standards',
      'architecture-models',
      'kag-documents',
      'kag-web-sources',
      'kag-media',
      'kag-graph',
      'kag-entities',
      'kag-discover',
      'kag-scientific',
      'kag-text-analysis',
      'kag-ask',
      'kag-health',
      'kag-benchmarks',
      'kag-capabilities',
      'research',
      'artifacts',
      'triggers',
      'conveyor-map',
      // Conveyor catalogue sections (RM tenant PM catalogue), one route each.
      'catalogue-phases',
      'catalogue-capabilities',
      'catalogue-card-types',
      'catalogue-project-types',
      'catalogue-wip-limits',
      'catalogue-priority-levels',
      'catalogue-deliverable-kinds',
      'catalogue-milestone-kinds',
      'catalogue-board-templates',
      'traceability',
      'reasoning-toc',
    ]);
  });

  it('Reasoning (TOC) points at /knowledge/toc in the Knowledge zone', () => {
    const toc = NAV_ITEMS.find((i) => i.id === 'reasoning-toc');
    expect(toc?.href).toBe('/knowledge/toc');
    expect(toc?.zone).toBe('knowledge');
    expect(toc?.iconName).toBe('Target');
  });

  it('Traceability points at /knowledge/graph in the Knowledge zone', () => {
    const trace = NAV_ITEMS.find((i) => i.id === 'traceability');
    expect(trace?.href).toBe('/knowledge/graph');
    expect(trace?.zone).toBe('knowledge');
  });

  it('Architecture kinds are rows under their /library prefix; the retired PM library has none', () => {
    const arch = NAV_ITEMS.filter((i) => i.group === 'architecture-library').map((i) => i.href);
    expect(arch).toEqual([
      '/library/architecture/elements',
      '/library/architecture/relationships',
      '/library/architecture/views',
      '/library/architecture/standards',
      '/library/architecture/models',
    ]);
    // The fr PM library is retired (vocabulary moved to the RM catalogue).
    expect(NAV_ITEMS.filter((i) => i.href.startsWith('/library/pm'))).toEqual([]);
    // The hub root is a 308, never a row.
    expect(NAV_ITEMS.some((i) => i.href === '/library/architecture')).toBe(false);
  });

  it('KAG: twelve rows, the former hub tabs in section order, upload (documents) first', () => {
    const kag = NAV_ITEMS.filter((i) => i.group === 'kag');
    expect(kag.map((i) => i.href)).toEqual([
      '/library/kag/documents',
      '/library/kag/web-sources',
      '/library/kag/media',
      '/library/kag/graph',
      '/library/kag/entities',
      '/library/kag/discover',
      '/library/kag/scientific',
      '/library/kag/text-analysis',
      '/library/kag/ask',
      '/library/kag/health',
      '/library/kag/benchmarks',
      '/library/kag/capabilities',
    ]);
    expect(NAV_ITEMS.some((i) => i.href === '/library/kag')).toBe(false);
    // N2: one naming convention — every KAG row is "KAG …" (the label is also
    // the CmdK entry, the h1 and the tab title, none of which show the header).
    expect(kag.filter((i) => !i.label.startsWith('KAG ')).map((i) => i.label)).toEqual([]);
  });

  it('Administration folds the licence trio and the six platform asset kinds into sub-groups (N1)', () => {
    expect(NAV_ITEMS.filter((i) => i.group === 'licensing').map((i) => i.href)).toEqual([
      '/admin/licenses',
      '/admin/licenses/catalog',
      '/admin/licenses/offerings',
    ]);
    expect(NAV_ITEMS.filter((i) => i.group === 'platform-assets').map((i) => i.href)).toEqual(
      ['principles', 'requirements', 'decisions', 'workflows', 'projects'].map((k) => `/admin/assets/${k}`),
    );
    const admin = NAV_ITEMS.filter((i) => i.zone === 'administration');
    // Name the folded groups rather than pinning `admin.length - 9 + 2`
    // (a literal offset that went red on any added Administration row).
    expect(navSegments(admin).filter((s) => s.kind === 'group').map((s) => s.group.id)).toEqual([
      'licensing',
      'platform-assets',
    ]);
    expect(NAV_SUB_GROUPS.licensing.iconName).not.toBe(NAV_SUB_GROUPS['platform-assets'].iconName);
  });

  it('contains the Engine run-the-line items (no /tools — dissolved)', () => {
    const engineIds = NAV_ITEMS.filter((i) => i.zone === 'engine').map((i) => i.id);
    expect(engineIds).toEqual([
      'workflows',
      'executions-n8n',
      'executions-activity',
      'repositories-registry',
      'repositories-analysis',
      'workers',
      'channels',
      // Formerly orphaned pages (no row, no in-app link) — nav standard audit.
      'secrets',
      'byoc',
    ]);
  });

  it('contains the Govern control items, with Conformance + Measure after Approvals', () => {
    const governIds = NAV_ITEMS.filter((i) => i.zone === 'govern').map((i) => i.id);
    expect(governIds).toEqual([
      'approvals',
      'conformance-dashboard',
      'conformance-graph',
      'measure',
      // Reports sits beside Measure: both are read-only lenses on how the
      // machine is running, and the approval-backlog report is a view of this
      // very zone's BLOCKED gate.
      'reports',
      // Was reachable only from a link card on /reports (removed launcher).
      'reports-approval-backlog',
      // Were launched by a <select> on /reports (a dropdown menu).
      'asset-changes-requirements',
      'asset-changes-decisions',
      'asset-changes-principles',
      'control-tower',
      'verification-determinism',
      'engagements',
    ]);
  });

  it('the pending-approvals badge sits on Approvals and ONLY on Approvals', () => {
    // The count used to live on Home — a row that does not lead to the queue —
    // while /approvals, the row that actually ANSWERS it, carried no badge at
    // all. Moving it is not cosmetic: a badge on a nav row is a promise that
    // the row leads to those N items, and while both rows carried the same
    // number a reader could not tell 2 items from 4. Home keeps the count on
    // the PAGE (the hero sentence links to the queue, plus
    // PendingApprovalsCard) — it just no longer claims it in the rail.
    const home = NAV_ITEMS.find((i) => i.id === 'home');
    const approvals = NAV_ITEMS.find((i) => i.id === 'approvals');
    expect(approvals?.badgeSource).toBe('pending-approvals');
    expect(approvals?.href).toBe('/approvals');
    expect(home?.badgeSource).toBeUndefined();

    // Exactly one top-level row may claim this counter. A second one re-opens
    // the ambiguity this test exists to close.
    const claimants = NAV_ITEMS.filter((i) => i.badgeSource === 'pending-approvals').map((i) => i.id);
    expect(claimants).toEqual(['approvals']);
  });

  it('NO project-scoped row carries the cross-workspace pending-approvals count', () => {
    // ⛔ THE SAME BROKEN PROMISE, ONE REGISTRY DOWN, AND IT SHIPPED. PROJECT_NAV
    // was never brought under the rule above, so `needs-you` —
    // `/projects/<id>/needs-you`, a PROJECT page — badged
    // `navCounts.pendingApprovals`, which is `GET /api/approvals/all`: every
    // workspace's pending rows for a super-admin in home view.
    //
    // MEASURED 2026-09-15 on project 328639ef…: the rail read "Needs you 99+"
    // while the NeedsYouQueue widget on that very page read "Nothing needs you
    // right now. 🎉". Two counters over what the operator reads as one thing,
    // disagreeing on one screen. The widget's half was a discard bug (fixed
    // separately); this half is a
    // SCOPE bug and survives that fix — 31 beside 99+ is still a rail row
    // promising items it does not lead to.
    //
    // The project count belongs to the surface that can compute it: the widget
    // renders it at [data-testid="needs-you-count"] on the page this row opens.
    const badged = PROJECT_NAV.filter((i) => i.badgeSource === 'pending-approvals').map(
      (i) => i.id,
    );
    expect(badged).toEqual([]);
  });

  it('R4: Needs you carries the PROJECT-scoped badge, and nothing else does', () => {
    // The badge is the length of the cockpit's C2 list — the list the Needs you page renders —
    // so the rail and the page cannot disagree (projectCockpit.needsYouFor).
    const claimants = [...NAV_ITEMS, ...PROJECT_NAV]
      .filter((i) => i.badgeSource === 'project-needs-you')
      .map((i) => i.id);
    expect(claimants).toEqual(['needs-you']);
  });

  it('R4: the redirected Project approvals / Project threads pages are no longer Details rows', () => {
    const ids = PROJECT_NAV.map((i) => i.id);
    expect(ids).not.toContain('approvals');
    expect(ids).not.toContain('threads');
    expect(ids).toContain('needs-you');
  });

  it('exposes exactly the four super-admin cockpit surfaces (Operate sidebar group)', () => {
    // The SidebarNav "Operate · fleet" group derives its members from
    // NAV_ITEMS.filter(requiresSuperAdmin) via isItemVisible — the same source
    // the command palette uses. Pin the set so a stray requiresSuperAdmin flag
    // (or a removed cockpit route) can't silently change what the rail shows.
    // Scoped to the GOVERN zone. The `administration` zone is super-admin
    // gated too, and selecting on the flag alone is exactly the bug this
    // caught: those items would render in Operate AND vanish from their own
    // section. Zone is the partition.
    const superAdminIds = NAV_ITEMS.filter(
      (i) => i.requiresSuperAdmin && i.zone === 'govern',
    ).map((i) => i.id);
    expect(superAdminIds).toEqual([
      'control-tower',
      'verification-determinism',
    ]);
  });

  it('Measure points at the re-homed analytics surface', () => {
    const measure = NAV_ITEMS.find((i) => i.id === 'measure');
    expect(measure?.href).toBe('/measure');
    expect(measure?.zone).toBe('govern');
  });

  it('Architecture Conformance is a Govern sub-group of two views under /govern/architecture', () => {
    const conf = NAV_ITEMS.filter((i) => i.group === 'architecture-conformance');
    expect(conf.map((i) => i.href)).toEqual([
      '/govern/architecture/dashboard',
      '/govern/architecture/graph',
    ]);
    expect(conf.every((i) => i.zone === 'govern')).toBe(true);
    expect(NAV_SUB_GROUPS['architecture-conformance'].zone).toBe('govern');
  });

  it('the retired top-level /quality route stays retired (fr#1306)', () => {
    // The top-level /quality page never worked in prod and was removed. Neither
    // the rail nor the route tree may bring it back. (The PROJECT-scoped tab
    // came back in fr#1305 over stored results — see the next test.)
    for (const item of ALL_ROUTES) {
      expect(item.id, `nav item ${item.id} re-adds Quality`).not.toBe('quality');
      expect(item.href.startsWith('/quality'), `nav item ${item.id} links to /quality`).toBe(false);
    }

    const pages = Object.keys(import.meta.glob('../../routes/**/+page.svelte'));
    // Negative control: the glob must actually see the route tree, or the
    // absence assertions below pass vacuously.
    expect(pages.length).toBeGreaterThan(0);
    expect(pages.some((p) => p.startsWith('../../routes/approvals/'))).toBe(true);
    expect(pages.filter((p) => p.startsWith('../../routes/quality/'))).toEqual([]);
  });

  it('the project Quality tab exists and is under Details (fr#1305)', () => {
    const item = PROJECT_NAV.find((i) => i.id === 'quality');
    expect(item?.sub).toBe('quality');
    expect(item?.group).toBe('details');
    const pages = Object.keys(import.meta.glob('../../routes/**/+page.svelte'));
    expect(pages).toContain('../../routes/(project)/projects/[id]/quality/+page.svelte');
    // …and it did not drag the retired top-level route back with it.
    expect(pages.some((p) => p.startsWith('../../routes/quality/'))).toBe(false);
  });

  it('declares no Tools item and no /tools/* children (dissolution complete)', () => {
    expect(NAV_ITEMS.some((i) => i.id === 'tools')).toBe(false);
    // The /tools surfaces were re-homed; nothing should still declare a
    // /tools href, and no item carries children any more.
    for (const item of NAV_ITEMS) {
      expect(item.href.startsWith('/tools')).toBe(false);
      expect(item.children).toBeUndefined();
    }
  });
});

describe('visibleNavFor', () => {
  it('returns all items for a workspace-admin super-admin', () => {
    // isSuperAdmin gates the observatories. A super-admin sees everything.
    const visible = visibleNavFor(['workspace-admin'] as NavRole[], {
      isSuperAdmin: true,
    });
    expect(visible).toHaveLength(NAV_ITEMS.length);
  });

  it('hides admin-only Channels entry from workspace-member', () => {
    // Channels (the workspace/dept registry) is admin-only; it lives in Engine.
    const visible = visibleNavFor(['workspace-member'] as NavRole[]);
    expect(visible.map((i) => i.id)).not.toContain('channels');
    expect(visible.map((i) => i.id)).not.toContain('control-tower');
    expect(visible.map((i) => i.id)).not.toContain('verification');
    // Workers is admin-only too, for the same reason as Channels: the three
    // write verbs on /api/assets/workers now require workspace-admin.
    expect(visible.map((i) => i.id)).not.toContain('workers');
    // The named absences above prove WHICH rows a member loses. No `- 28` pin:
    // that literal offset counted today's gated items and went red whenever one
    // was added. The property is that only GATED rows may disappear.
    expect(visible.map((i) => i.id)).not.toContain('chat');
    expect(visible.map((i) => i.id)).not.toContain('workspace-byo-tokens');
    expect(visible.map((i) => i.id)).not.toContain('admin-tenants');
    const visibleIds = new Set(visible.map((i) => i.id));
    expect(
      NAV_ITEMS.filter((i) => !visibleIds.has(i.id)).every((i) => i.requiredAnyRole || i.requiresSuperAdmin),
    ).toBe(true);
  });

  it('Workers and Channels each cover every claim arm of isWorkspaceAdminVia', () => {
    // The flags are not cosmetic and not optional. POST/PUT/DELETE
    // /api/assets/workers and the channels routes require workspace-admin
    // (isWorkspaceAdminVia, backend/src/services/user-roles.ts). Without the gate
    // the sidebar offers a member /workers → "New worker", and the form 403s.
    //
    // ⭐ PINNED AS COVERAGE OF THE GATE, never as an exact literal. An earlier
    // `toEqual(['workspace-admin'])` pinned the flag to a value NARROWER than
    // `isWorkspaceAdminVia`, so it certified the regression instead of catching it:
    // measured in production 2026-09-25, an `admin`-claim principal (fr-test) lost the
    // Workers entry while the backend still accepted its writes; Channels carried the
    // same over-strictness until fr#1220. A nav flag must be at least as permissive as
    // the gate it fronts, so assert CONTAINMENT of each gate arm.
    const GATE_CLAIM_ARMS = ['workspace-admin', 'admin'];
    for (const id of ['workers', 'channels']) {
      const item = NAV_ITEMS.find((i) => i.id === id);
      expect(item, `nav item ${id} missing`).toBeDefined();
      expect(item?.requiredAnyRole).toEqual(expect.arrayContaining(GATE_CLAIM_ARMS));
      expect(item?.requiresSuperAdmin).toBeUndefined();
    }

    // NEGATIVE CONTROL — the gate must not refuse the people it is for.
    // Without this arm a `requiredAnyRole: ['nobody']` typo would pass the
    // hidden-from-member assertion above just as well.
    const member = visibleNavFor(['workspace-member'] as NavRole[]);
    expect(member.map((i) => i.id)).not.toContain('workers');
    expect(member.map((i) => i.id)).not.toContain('channels');
    const admin = visibleNavFor(['workspace-admin'] as NavRole[]);
    expect(admin.map((i) => i.id)).toContain('workers');
    expect(admin.map((i) => i.id)).toContain('channels');
  });

  it('an `admin`-claim principal sees Channels and Workers (fr#1220)', () => {
    // The backend gate accepts `admin` as a workspace-admin arm; the rail must too.
    const channels = NAV_ITEMS.find((i) => i.id === 'channels')!;
    const workers = NAV_ITEMS.find((i) => i.id === 'workers')!;
    expect(isItemVisible(channels, ['admin'] as NavRole[])).toBe(true);
    expect(isItemVisible(workers, ['admin'] as NavRole[])).toBe(true);
    // Control: the same helper still refuses a plain member, so the `true` above
    // is the `admin` arm working, not an ungated item.
    expect(isItemVisible(channels, ['workspace-member'] as NavRole[])).toBe(false);
    const visible = visibleNavFor(['admin'] as NavRole[]);
    expect(visible.map((i) => i.id)).toContain('channels');
  });

  it('hides admin-only Channels entry from anonymous users too', () => {
    const visible = visibleNavFor([]);
    expect(visible.map((i) => i.id)).not.toContain('channels');
    expect(visible.map((i) => i.id)).not.toContain('control-tower');
    expect(visible.map((i) => i.id)).not.toContain('verification');
    expect(visible.map((i) => i.id)).not.toContain('workers');
    // Same property as the member case: only GATED rows may be missing.
    expect(visible.map((i) => i.id)).not.toContain('chat');
    expect(visible.map((i) => i.id)).not.toContain('workspace-byo-tokens');
    expect(visible.map((i) => i.id)).not.toContain('admin-tenants');
    const visibleIds = new Set(visible.map((i) => i.id));
    expect(
      NAV_ITEMS.filter((i) => !visibleIds.has(i.id)).every((i) => i.requiredAnyRole || i.requiresSuperAdmin),
    ).toBe(true);
  });
});

describe('groupedNavFor', () => {
  it('returns the declared zones in declaration order for workspace-admin', () => {
    // A workspace-admin now also gets `workspace` (their own tenant's admin
    // surfaces). NOT `administration` — that zone is super-admin only, and its
    // absence here is the assertion that matters most in this file.
    const groups = groupedNavFor(['workspace-admin'] as NavRole[]);
    expect(groups.map((g) => g.zone)).toEqual([
      'work',
      'knowledge',
      'engine',
      'govern',
      'account',
      'workspace',
    ]);
    expect(groups.map((g) => g.label)).toEqual([
      ZONE_LABELS.work,
      ZONE_LABELS.knowledge,
      ZONE_LABELS.engine,
      ZONE_LABELS.govern,
      ZONE_LABELS.account,
      ZONE_LABELS.workspace,
    ]);
  });

  it('does NOT include channels for workspace-member', () => {
    const groups = groupedNavFor(['workspace-member'] as NavRole[]);
    const flat = groups.flatMap((g) => g.items.map((i) => i.id));
    expect(flat).not.toContain('channels');
  });

  it('member still sees the work zones + Account — Engine renders without Channels', () => {
    const groups = groupedNavFor(['workspace-member'] as NavRole[]);
    expect(groups.map((g) => g.zone)).toEqual(['work', 'knowledge', 'engine', 'govern', 'account']);
    // Engine drops the admin-only Channels AND Workers but keeps the rest.
    // Workers left this list when the /api/assets/workers write verbs became
    // workspace-admin-only: a member shown /workers gets a "New worker" form
    // that 403s on submit.
    const engine = groups.find((g) => g.zone === 'engine');
    expect(engine?.items.map((i) => i.id)).toEqual([
      'workflows',
      'executions-n8n',
      'executions-activity',
      'repositories-registry',
      'repositories-analysis',
      'secrets',
      'byoc',
    ]);
    // Govern has no admin-only items; Kaizen is operator-gated (passed above).
    // `reports` is present for a plain member ON PURPOSE — all six /api/reports
    // endpoints gate on validateAuth alone, so hiding it would hide a surface
    // this user can open.
    const govern = groups.find((g) => g.zone === 'govern');
    expect(govern?.items.map((i) => i.id)).toEqual([
      'approvals',
      'conformance-dashboard',
      'conformance-graph',
      'measure',
      'reports',
      'reports-approval-backlog',
      'asset-changes-requirements',
      'asset-changes-decisions',
      'asset-changes-principles',
      'engagements',
    ]);
  });

  it('preserves intra-zone ordering from NAV_ITEMS', () => {
    const groups = groupedNavFor(['workspace-admin'] as NavRole[]);
    const work = groups.find((g) => g.zone === 'work');
    expect(work?.items.map((i) => i.id)).toEqual([
      'home',
      'kanban',
      'threads',
      'chat',
      'notifications',
      'project-requests',
    ]);
  });
});

describe('isItemVisible — super-admin axis', () => {
  const base: NavItem = {
    id: 'x',
    label: 'X',
    href: '/x',
    iconName: 'Wrench',
    zone: 'engine',
  };

  it('shows an ungated item to everyone', () => {
    expect(isItemVisible(base, [])).toBe(true);
    expect(isItemVisible(base, ['workspace-member'] as NavRole[])).toBe(true);
  });

  it('hides a requiresSuperAdmin item unless ctx.isSuperAdmin', () => {
    const item: NavItem = { ...base, requiresSuperAdmin: true };
    expect(isItemVisible(item, ['workspace-admin'] as NavRole[])).toBe(false);
    expect(isItemVisible(item, ['workspace-admin'] as NavRole[], { isSuperAdmin: false })).toBe(false);
    expect(isItemVisible(item, [], { isSuperAdmin: true })).toBe(true);
  });

  it('treats super-admin and tenant-role as independent AND-gates', () => {
    // Both gates must pass: super-admin alone does not satisfy requiredAnyRole.
    const item: NavItem = {
      ...base,
      requiresSuperAdmin: true,
      requiredAnyRole: ['workspace-admin'],
    };
    expect(isItemVisible(item, ['workspace-member'] as NavRole[], { isSuperAdmin: true })).toBe(false);
    expect(isItemVisible(item, ['workspace-admin'] as NavRole[], { isSuperAdmin: true })).toBe(true);
    expect(isItemVisible(item, ['workspace-admin'] as NavRole[], { isSuperAdmin: false })).toBe(false);
  });
});

describe('visibleNavFor — ctx is additive, never widens tenant gates', () => {
  it('super-admin sees admin items plus the super-admin-gated improvement lenses', () => {
    const admin = visibleNavFor(['workspace-admin'] as NavRole[]);
    const superAdmin = visibleNavFor(['workspace-admin'] as NavRole[], { isSuperAdmin: true });
    // The only difference is the super-admin-gated observatory items.
    const superAdminOnly = [
      'control-tower',
      'verification-determinism',
      // The Administration zone is super-admin gated too.
      'admin-overview',
      'admin-tenants',
      'admin-users',
      'admin-licences',
      'admin-billing',
      'admin-andon',
      'admin-kata',
      'admin-metering',
      'admin-tenant-budgets',
      'admin-licence-catalog',
      'admin-licence-offerings',
      'admin-assets-principles',
      'admin-assets-requirements',
      'admin-assets-decisions',
      'admin-assets-workflows',
      'admin-assets-projects',
    ];
    for (const id of superAdminOnly) {
      expect(admin.map((i) => i.id)).not.toContain(id);
      expect(superAdmin.map((i) => i.id)).toContain(id);
    }
    expect(superAdmin.filter((i) => !superAdminOnly.includes(i.id)).map((i) => i.id)).toEqual(
      admin.map((i) => i.id),
    );
  });

  it('isSuperAdmin does NOT leak admin-only Channels to a member', () => {
    // Proves the two axes are independent: super-admin flag must not satisfy
    // a tenant `requiredAnyRole` gate.
    const visible = visibleNavFor(['workspace-member'] as NavRole[], {
      isSuperAdmin: true,
    });
    expect(visible.map((i) => i.id)).not.toContain('channels');
    expect(visible.map((i) => i.id)).not.toContain('workers');
    // The Workspace zone gates on the workspace-admin ROLE, so a super-admin
    // who is only a member here still does not get it — that independence is
    // exactly what this case exists to prove.
    expect(visible.map((i) => i.id)).not.toContain('workspace-byo-tokens');
    // ...while the Administration zone IS visible, on the super-admin axis.
    expect(visible.map((i) => i.id)).toContain('admin-tenants');
    // No `- 7` pin (today's hidden channels + workers + workspace rows): only
    // GATED rows may disappear, which is what this asserts instead.
    const visibleIds = new Set(visible.map((i) => i.id));
    expect(
      NAV_ITEMS.filter((i) => !visibleIds.has(i.id)).every((i) => i.requiredAnyRole || i.requiresSuperAdmin),
    ).toBe(true);
  });
});

describe('SidebarNav icon coverage', () => {
  // The rail now renders the full zoned NAV_ITEMS registry (plus the
  // project-scoped PROJECT_NAV), each row resolving its icon through the ICONS
  // map in SidebarNav.svelte. An iconName with no ICONS entry silently falls
  // back to Compass. This set MUST mirror the keys of that ICONS map — when you
  // add a NAV_ITEM/PROJECT_NAV item with a new icon, add the icon import + ICONS
  // entry in SidebarNav.svelte AND the name here, or this test fails.
  const SIDEBAR_MAPPED_ICONS = new Set([
    'House', 'SlidersHorizontal', 'CheckCircle2', 'Target', 'LayoutGrid', 'Building2', 'Brain',
    'Compass', 'Network', 'Package', 'History', 'FolderGit2', 'ShieldCheck',
    'GitCompare', 'ListChecks', 'Gauge', 'FolderKanban',
    'Settings', 'KeyRound', 'MessageSquare', 'MessageCircle', 'Bell',
    'ClipboardList', 'GitBranch', 'CalendarClock', 'FlaskConical', 'Waypoints',
    'Workflow', 'Bot', 'Radio', 'BarChart3', 'TrendingUp', 'Headset',
    // Govern → Reports (the /api/reports reading surface).
    'FileText',
    // Workspace + Administration zones.
    'Users', 'Receipt', 'AlertTriangle', 'Wrench', 'Wallet',
    // Rows that replaced in-page menus (triggers).
    'Zap',
    // Project-scoped variants, so no project row repeats a global row's icon.
    'PackageOpen', 'ScrollText', 'Radar', 'FolderGit', 'FileStack', 'ClipboardPen',
    'Signpost', 'GitFork', 'ListOrdered', 'Route', 'Webhook', 'RadioTower',
    // Project → PM library (fr-agui §16 D12, P2-b).
    'CalendarRange',
    // Govern → Approval backlog (was a link card on /reports).
    'Hourglass',
    // Project → Project traceability (the graph scoped to the project).
    'Merge',
    // Formerly orphaned pages: project requests, secrets, BYOC credentials.
    'Inbox', 'Lock', 'GlobeLock',
    // Former tab-hub rows, the asset-changes rows, sub-group headers, and the
    // per-row icons that keep every zone free of repeats (nav standard).
    'Box', 'Link2', 'LayoutDashboard', 'BadgeCheck', 'DraftingCompass', 'Layers', 'Briefcase',
    'ListTodo', 'ShieldAlert', 'GitMerge', 'FileUp', 'Globe', 'Film', 'Share2',
    'Shapes', 'Telescope', 'Atom', 'TextSearch', 'Search', 'HeartPulse',
    'Crosshair', 'Cpu', 'Play', 'Activity', 'Database', 'ScanSearch', 'Scale',
    'ChartPie', 'GitGraph', 'ListPlus', 'FileClock', 'FileDiff', 'FileCheck',
    'FileSearch', 'FileCog', 'BookKey', 'Tags', 'BookMarked', 'ClipboardType',
    'Milestone', 'ListTree', 'Cog', 'FolderTree', 'BellRing',
    // Project Details group header (FR-PROJECT-HOME-REDESIGN R1).
    'Microscope',
    // Project Architecture rows; Verification / Licensing / Platform-assets.
    'Orbit', 'Cable', 'Goal', 'Calculator', 'Dices', 'Stamp', 'Warehouse',
    // Rail-wide unique icons (validator B2, 2026-10-03): one per row/header.
    'MessagesSquare', 'BrainCircuit', 'GitPullRequestArrow', 'TowerControl', 'CodeXml', 'ChartNoAxesColumn', 'PlugZap', 'WandSparkles', 'PanelsTopLeft', 'UserCog',
    'FileKey', 'CircleDollarSign', 'PiggyBank', 'Landmark', 'Hand', 'Flag', 'SquareKanban', 'Combine', 'SearchCheck',
    // Project → "Project approvals" (UI review 2026-10-07).
    'UserCheck',
    // Knowledge → Conveyor map (fr#1478).
    'Grid3x3',
    // Knowledge → Conveyor catalogue sub-group header + its ten section rows.
    'Blocks',
    'SquareStack',
    'Puzzle',
    'Component',
    'Boxes',
    'PackageCheck',
    'LayoutTemplate',
    'TrafficCone',
    'ArrowDownWideNarrow',
    'FlagTriangleRight',
    // Project → "Project plan" (fr#1483).
    'ChartGantt',
    'Sheet',
    // R6: the project Cost row.
    'Coins',
    // Project → "Project threads" (fr-agui P1a, SPEC §7.3 "Agent").
    'BotMessageSquare',
    // Project Knowledge + Project KAG groups (2026-10-30): headers, ArchiMate lists, KAG views.
    'Library', 'LibraryBig', 'Container', 'Spline', 'AppWindow', 'Award',
    'FileInput', 'Rss', 'Clapperboard', 'ChartNetwork', 'Hexagon', 'Binoculars',
    'TestTubes', 'ScanText', 'MessageCircleQuestionMark', 'Stethoscope', 'Ruler', 'MemoryStick',
  ]);

  // The set above is hand-maintained; this pins it to the real ICONS map in
  // SidebarNav.svelte so "mapped here" cannot drift from "mapped there".
  it('SIDEBAR_MAPPED_ICONS equals the keys of SidebarNav ICONS', () => {
    const src = Object.values(
      import.meta.glob('./SidebarNav.svelte', { query: '?raw', import: 'default', eager: true }),
    )[0] as string;
    const block = /const ICONS = \{([\s\S]*?)\} as const;/.exec(src)?.[1] ?? '';
    const keys = block
      .split(',')
      .map((l) => l.trim().split(':')[0]!.trim())
      .filter((k) => /^[A-Za-z0-9]+$/.test(k));
    // The set equality below is the assertion; a key-count floor here only
    // restated how many icons exist today.
    expect(new Set(keys)).toEqual(SIDEBAR_MAPPED_ICONS);
  });

  it('every NAV_ITEMS iconName is mapped (no silent Compass fallback)', () => {
    for (const item of NAV_ITEMS) {
      expect(
        SIDEBAR_MAPPED_ICONS.has(item.iconName),
        `NAV_ITEM ${item.id} uses unmapped icon "${item.iconName}" — add it to ICONS in SidebarNav.svelte`,
      ).toBe(true);
    }
  });

  it('every sub-group and project-group header icon is mapped', () => {
    for (const g of Object.values(NAV_SUB_GROUPS)) {
      expect(SIDEBAR_MAPPED_ICONS.has(g.iconName), `sub-group ${g.id} icon "${g.iconName}"`).toBe(true);
    }
    for (const [g, icon] of Object.entries(PROJECT_NAV_GROUP_ICONS)) {
      expect(SIDEBAR_MAPPED_ICONS.has(icon), `project group ${g} icon "${icon}"`).toBe(true);
    }
  });

  it('every PROJECT_NAV iconName is mapped', () => {
    for (const item of PROJECT_NAV) {
      expect(
        SIDEBAR_MAPPED_ICONS.has(item.iconName),
        `PROJECT_NAV ${item.id} uses unmapped icon "${item.iconName}"`,
      ).toBe(true);
    }
  });
});

describe('ALL_ROUTES — flat single-source registry', () => {
  it('includes every top-level NAV_ITEMS entry, in order', () => {
    const topLevel = ALL_ROUTES.filter((r) => NAV_ITEMS.some((n) => n.id === r.id));
    expect(topLevel.map((i) => i.id)).toEqual(NAV_ITEMS.map((i) => i.id));
  });

  it('equals NAV_ITEMS while no item declares children (/tools dissolved)', () => {
    // The /tools family was the only item with children; after the
    // dissolution ALL_ROUTES is a 1:1 flat copy of NAV_ITEMS.
    const childCount = NAV_ITEMS.reduce((n, i) => n + (i.children?.length ?? 0), 0);
    expect(childCount).toBe(0);
    // The id equality below implies the same length; a separate `ALL_ROUTES`
    // count pinned the size of the registry, not its contents.
    expect(ALL_ROUTES.map((r) => r.id)).toEqual(NAV_ITEMS.map((i) => i.id));
  });

  it('every route has a unique href', () => {
    const hrefs = ALL_ROUTES.map((r) => r.href);
    expect(new Set(hrefs).size).toBe(hrefs.length);
  });
});

describe('Administration lives in the MAIN sidebar, split by audience', () => {
  // The admin area used to be a single `/admin` leaf that opened a SECOND
  // sidebar nested inside the page — two rails on screen at once, and the two
  // audiences (this workspace vs the whole fleet) merged under one heading.
  // It is now two top-level zones gated independently.

  const zoneIds = (zone: NavZone) =>
    NAV_ITEMS.filter((i) => i.zone === zone).map((i) => i.id);

  it('workspace items gate on workspace-admin, NOT on super-admin', () => {
    const items = NAV_ITEMS.filter((i) => i.zone === 'workspace');
    // Non-vacuity is covered by the named workspace row asserted below.
    for (const i of items) {
      // A super-admin gate here would hide the workspace tier from the very
      // people who own it — workspace admins are not super-admins.
      expect(i.requiresSuperAdmin).toBeUndefined();
      expect(i.requiredAnyRole).toContain('workspace-admin');
    }
  });

  it('every administration item is super-admin gated', () => {
    const items = NAV_ITEMS.filter((i) => i.zone === 'administration');
    // Non-vacuity is covered by the named administration rows asserted below.
    // Fleet-wide surfaces. A single ungated item here leaks cross-tenant
    // navigation to every workspace admin, so assert on ALL of them.
    for (const i of items) expect(i.requiresSuperAdmin).toBe(true);
  });

  it('a plain member sees NEITHER header', () => {
    const groups = groupedNavFor(['workspace-member'] as NavRole[], {
      isSuperAdmin: false,
    });
    const zones = groups.map((g) => g.zone);
    expect(zones).not.toContain('workspace');
    expect(zones).not.toContain('administration');
  });

  it('a workspace-admin sees Workspace but NOT Administration', () => {
    const groups = groupedNavFor(['workspace-admin'] as NavRole[], {
      isSuperAdmin: false,
    });
    const zones = groups.map((g) => g.zone);
    expect(zones).toContain('workspace');
    expect(zones).not.toContain('administration');
  });

  it('a super-admin sees BOTH, with Administration last', () => {
    const groups = groupedNavFor(['workspace-admin'] as NavRole[], {
      isSuperAdmin: true,
    });
    const zones = groups.map((g) => g.zone);
    expect(zones).toContain('workspace');
    expect(zones).toContain('administration');
    // Least-used and most destructive sits at the bottom of the rail.
    expect(zones[zones.length - 1]).toBe('administration');
  });

  it('both zones have labels and carry the pages the owner asked for', () => {
    expect(ZONE_LABELS.workspace).toBe('Workspace');
    expect(ZONE_LABELS.administration).toBe('Administration');
    expect(zoneIds('workspace')).toContain('workspace-byo-tokens');
    expect(zoneIds('administration')).toEqual(
      expect.arrayContaining(['admin-tenants', 'admin-users', 'admin-licences']),
    );
  });
});

describe('Account zone — settings are top-level rows, not a menu inside /settings', () => {
  const accountIds = () => NAV_ITEMS.filter((i) => i.zone === 'account').map((i) => i.id);

  it('carries every personal settings page, ungated, in render order', () => {
    expect(accountIds()).toEqual([
      'account-profile',
      'account-communication',
      'account-licenses',
      'account-github',
      'account-usage',
    ]);
    for (const i of NAV_ITEMS.filter((n) => n.zone === 'account')) {
      expect(i.requiredAnyRole, i.id).toBeUndefined();
      expect(i.requiresSuperAdmin, i.id).toBeUndefined();
      expect(i.href.startsWith('/settings/'), i.id).toBe(true);
    }
    expect(ZONE_LABELS.account).toBe('Account');
  });

  it('a plain member sees the Account zone', () => {
    const groups = groupedNavFor(['workspace-member'] as NavRole[]);
    expect(groups.find((g) => g.zone === 'account')?.items.map((i) => i.id)).toEqual(accountIds());
  });

  it('Engagements row opens the delivery log directly', () => {
    const e = NAV_ITEMS.find((i) => i.id === 'engagements');
    expect(e?.href).toBe('/engagements/deliveries');
  });
});

// Owner ruling 2026-10-01: /chat is a tenant-admin tool (workspace-admin or
// super-admin). The nav entry must hide from a plain member and show to both.
describe('chat nav entry — tenant-admin tool', () => {
  const chat = NAV_ITEMS.find((i) => i.id === 'chat')!;

  it('is hidden from a plain workspace member', () => {
    expect(isItemVisible(chat, ['workspace-member'] as NavRole[])).toBe(false);
    expect(isItemVisible(chat, [] as NavRole[], { isSuperAdmin: false })).toBe(false);
  });

  it('is shown to a workspace-admin', () => {
    expect(isItemVisible(chat, ['workspace-admin'] as NavRole[])).toBe(true);
  });

  it('is shown to a super-admin without a workspace-admin role', () => {
    expect(isItemVisible(chat, ['workspace-member'] as NavRole[], { isSuperAdmin: true })).toBe(true);
  });
});

// fr BYO validator D5: the /chat nav entry and the /chat page gate must agree
// on EVERY input — an entry shown to someone the page refuses is a dead end, and
// one hidden from someone the page admits hides a tool they can use.
describe('chat nav entry === chatGate (the /chat page gate)', () => {
  const chat = NAV_ITEMS.find((i) => i.id === 'chat')!;
  const ROLE_SETS: NavRole[][] = [
    [],
    ['workspace-member'],
    ['workspace-admin'],
    ['admin'] as NavRole[],
    ['workspace-member', 'admin'] as NavRole[],
  ];
  for (const roles of ROLE_SETS) {
    for (const isSuperAdmin of [false, true]) {
      it(`roles=${JSON.stringify(roles)} superAdmin=${isSuperAdmin}`, () => {
        const page =
          chatGate({
            isLoading: false,
            isSuperAdmin,
            hasTenantRole: (r) => (roles as string[]).includes(r),
          }) === 'allowed';
        expect(isItemVisible(chat, roles, { isSuperAdmin })).toBe(page);
      });
    }
  }
});

// ===========================================================================
// toNavRoles — the fr#1221 RUNTIME BOUNDARY
//
// Why this block exists: nothing else says the function NARROWS anything. Gutting its body to
// `return [...claims]` keeps the type-check and every other test in
// this file green — so the cast would have been replaced by a function that is
// the cast. Every assertion below is chosen to FAIL against that no-op.
//
// Semantics pinned here were MEASURED against the implementation, not assumed:
//   - unknown claims are DROPPED (exact match only; no case folding, no trimming)
//   - `admin` is REPLACED by `workspace-admin` — `'admin'` is never in the output,
//     mirroring stores/auth.svelte.ts:213 which returns `['workspace-admin']`
//   - the output is de-duplicated and keeps first-seen order
//   - a fresh array is always returned, so a caller cannot mutate the store's roles
// ===========================================================================
describe('toNavRoles — runtime narrowing (fr#1221)', () => {
  // --- 1. unknown / garbage claims are DROPPED -----------------------------
  it('drops a claim that is not a NavRole', () => {
    expect(toNavRoles(['superuser'])).toEqual([]);
  });

  it('drops the empty string', () => {
    expect(toNavRoles([''])).toEqual([]);
  });

  it('matches EXACTLY — no case folding', () => {
    // If this ever starts passing case-insensitively, the nav layer and the
    // server gate have diverged: the backend compares claim strings verbatim.
    expect(toNavRoles(['WORKSPACE-ADMIN'])).toEqual([]);
    expect(toNavRoles(['Admin'])).toEqual([]);
  });

  it('does not trim surrounding whitespace', () => {
    expect(toNavRoles([' workspace-admin '])).toEqual([]);
  });

  it('drops a near-miss that merely CONTAINS a NavRole', () => {
    expect(toNavRoles(['workspace-admin-readonly', 'not-admin'])).toEqual([]);
  });

  // --- 2. valid claims are KEPT -------------------------------------------
  it('keeps every canonical NavRole', () => {
    expect(toNavRoles(['workspace-admin'])).toEqual(['workspace-admin']);
    expect(toNavRoles(['workspace-member'])).toEqual(['workspace-member']);
  });

  it('keeps each member of NAV_ROLES, modulo the documented aliases', () => {
    // Guards the NAV_ROLES ⇄ NavRole mirror: a value in the runtime list that
    // toNavRoles cannot produce means the two have drifted.
    for (const role of NAV_ROLES) {
      const expected = NAV_ROLE_ALIASES[role] ?? role;
      expect(toNavRoles([role]), `NAV_ROLES member ${role} not survivable`).toEqual([expected]);
    }
  });

  // --- 3. the `admin` alias REPLACES, it does not add ----------------------
  it('maps the admin alias onto workspace-admin', () => {
    expect(toNavRoles(['admin'])).toEqual(['workspace-admin']);
  });

  it('REPLACES rather than adds — "admin" is never in the output', () => {
    // The load-bearing half. A no-op, and an implementation that merely APPENDED
    // the alias, both leak the raw 'admin' through. stores/auth.svelte.ts:213
    // returns ['workspace-admin'] for an 'admin' role; this mirrors it exactly.
    expect(toNavRoles(['admin'])).not.toContain('admin');
    expect(toNavRoles(['admin', 'workspace-member'])).not.toContain('admin');
  });

  it('folds the alias onto the canonical value already present, in either order', () => {
    expect(toNavRoles(['admin', 'workspace-admin'])).toEqual(['workspace-admin']);
    expect(toNavRoles(['workspace-admin', 'admin'])).toEqual(['workspace-admin']);
  });

  it('agrees with NAV_ROLE_ALIASES for every alias it declares', () => {
    for (const [alias, canonical] of Object.entries(NAV_ROLE_ALIASES)) {
      expect(toNavRoles([alias]), `alias ${alias}`).toEqual([canonical]);
      expect(toNavRoles([alias]), `alias ${alias} leaked itself`).not.toContain(alias);
    }
  });

  // --- 4. duplicates collapse (the implementation DOES dedupe) -------------
  it('de-duplicates a repeated valid claim', () => {
    expect(toNavRoles(['workspace-member', 'workspace-member'])).toEqual(['workspace-member']);
  });

  it('de-duplicates a repeated alias', () => {
    expect(toNavRoles(['admin', 'admin'])).toEqual(['workspace-admin']);
  });

  it('keeps first-seen order while de-duplicating', () => {
    expect(toNavRoles(['workspace-member', 'workspace-admin', 'workspace-member'])).toEqual([
      'workspace-member',
      'workspace-admin',
    ]);
  });

  // --- 5. empty input -----------------------------------------------------
  it('returns an empty ARRAY for empty input, not undefined', () => {
    const out = toNavRoles([]);
    expect(out).toBeDefined();
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
  });

  it('returns an empty array when every claim is unrecognised', () => {
    const out = toNavRoles(['superuser', '', 'root', 'WORKSPACE-ADMIN']);
    expect(Array.isArray(out)).toBe(true);
    expect(out).toEqual([]);
  });

  // --- 6. the output is a NEW array ---------------------------------------
  it('returns a new array, never the input reference', () => {
    const input = ['workspace-admin'];
    expect(toNavRoles(input)).not.toBe(input);
  });

  it('mutating the result cannot reach the caller/store array', () => {
    // The practical consequence: `auth.tenantRoles` is handed straight in, so a
    // consumer that sorted or pushed onto the result must not corrupt the store.
    const input = ['workspace-admin', 'workspace-member'];
    const out = toNavRoles(input);
    out.push('admin');
    out.length = 0;
    expect(input).toEqual(['workspace-admin', 'workspace-member']);
  });

  it('two calls do not share one array', () => {
    expect(toNavRoles(['admin'])).not.toBe(toNavRoles(['admin']));
  });

  // --- the whole-boundary invariant ---------------------------------------
  it('output is ALWAYS a subset of NAV_ROLES, over a hostile matrix', () => {
    // The single assertion that a no-op cannot survive for any garbage input.
    const hostile: string[][] = [
      ['superuser'],
      [''],
      ['WORKSPACE-ADMIN'],
      ['workspace-admin', 'superuser'],
      ['admin', 'root', 'workspace-member'],
      ['null'],
      ['0'],
      ['workspace-admin workspace-member'],
    ];
    for (const claims of hostile) {
      for (const role of toNavRoles(claims)) {
        expect(NAV_ROLES, `leaked ${String(role)} from ${JSON.stringify(claims)}`).toContain(role);
      }
    }
  });

  it('realistic mixed claim list narrows to exactly the recognised roles', () => {
    expect(toNavRoles(['workspace-member', 'superuser', 'admin', 'billing-viewer'])).toEqual([
      'workspace-member',
      'workspace-admin',
    ]);
  });

  // --- ⚠️ DEFECT PINNED, NOT BLESSED -------------------------------------
  // `toNavRoles` looks the alias up as `NAV_ROLE_ALIASES[raw]` on a PLAIN OBJECT
  // literal, so the lookup walks Object.prototype. A claim literally named
  // 'constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__', … resolves
  // to an INHERITED member, which is `!== undefined`, so it is add()-ed into the
  // output WITHOUT ever being shown to `isNavRole`. MEASURED: toNavRoles(['toString'])
  // returns `[[Function: toString]]` — a function inside a declared `NavRole[]`.
  //
  // Impact today is containment, not escalation: `requiredAnyRole` is compared with
  // `.includes()` against string literals, so a function matches no nav item and
  // reveals nothing. But it is exactly the class fr#1221 was closed to prevent — an
  // unchecked non-NavRole crossing the narrowing boundary.
  //
  // ✅ FIXED in this same commit: navConfig.ts now guards the lookup with
  // `Object.hasOwn(NAV_ROLE_ALIASES, raw)`, so a prototype-named claim never reaches
  // `add()`. This was written first as `it.fails` by the agent that found it; it is a
  // plain `it` now because the defect is closed, and it must STAY plain — if it is ever
  // green as `it.fails` again, the guard has been removed.
  it('drops a claim that names an Object.prototype member', () => {
    for (const key of ['constructor', 'toString', 'valueOf', 'hasOwnProperty', '__proto__']) {
      expect(toNavRoles([key]), `prototype key ${key} leaked`).toEqual([]);
    }
  });

  it('never emits a value outside NAV_ROLES, for any mixture of input', () => {
    // The GENERAL invariant, which outlives any single leak. Deliberately replaces an
    // earlier containment pin ("a leaked value is at least a non-string"): once the leak
    // is fixed that pin's loop body never executes, so it would assert NOTHING while
    // still reporting green — a vacuous test is worse than no test.
    const mixed = [
      'workspace-admin', 'admin', 'workspace-member',
      'constructor', 'toString', '__proto__', 'hasOwnProperty',
      'superuser', '', 'WORKSPACE-ADMIN', ' workspace-admin ',
    ];
    const out = toNavRoles(mixed) as unknown[];
    expect(out.length).toBeGreaterThan(0); // non-vacuity: the probe must see SOMETHING
    for (const v of out) {
      expect(typeof v, `emitted a non-string: ${String(v)}`).toBe('string');
      expect(NAV_ROLES as readonly string[], `emitted an undeclared role: ${String(v)}`).toContain(
        v as string,
      );
    }
  });
});

// ===========================================================================
// Every rail row resolves to a REAL page on disk — and never to a redirect.
//
// This replaces a tautological check ("no admin item is a dead link") that
// compared NAV_ITEMS hrefs against ALL_ROUTES — which is BUILT from NAV_ITEMS,
// so it could not fail. The route set below comes from the files on disk, an
// instrument independent of the registry it judges.
// ===========================================================================
describe('nav rows resolve to real, non-redirect routes on disk', () => {
  // The route tree + redirect-stub detector live in $lib/nav/tests/routeTree
  // (shared with no-links-to-redirects.test.ts, so the rail rule and the
  // in-app-link rule use ONE definition of "redirect-only").

  // Every href the rails can render: global rows (+ children) and project rows.
  const PROJECT_PLACEHOLDER = '00000000-0000-4000-8000-000000000000';
  const NAV_HREFS: { who: string; href: string }[] = [
    ...ALL_ROUTES.map((i) => ({ who: `NAV_ITEMS ${i.id}`, href: i.href })),
    ...PROJECT_NAV.map((i) => ({
      who: `PROJECT_NAV ${i.id}`,
      href: i.sub ? `/projects/${PROJECT_PLACEHOLDER}/${i.sub}` : `/projects/${PROJECT_PLACEHOLDER}`,
    })),
  ];

  it('non-vacuity: the globs see the route tree, and the known redirect stubs', () => {
    // A glob that matches nothing makes every assertion below pass vacuously;
    // the named route and redirect checks are what prove it did not.
    expect(ROUTES.get('/approvals')?.hasSvelte).toBe(true);
    // The redirect detector must actually detect: each of these is a 308 stub.
    const redirectOnly = [...ROUTES.values()].filter(isRedirectOnly).map((r) => r.id);
    expect(redirectOnly).toEqual(
      expect.arrayContaining([
        '/settings',
        '/engagements',
        '/library',
        '/admin/assets',
        '/admin',
        '/projects/[id]/library/artifacts',
        '/settings/channels',
        '/artifacts',
        // Former tab hubs (nav standard, 2026-10-03).
        '/library/kag',
        '/library/architecture',
        '/govern/architecture',
        // The removed Proposals view (RM #238): a 308 to the dashboard, not a 404.
        '/govern/architecture/proposals',
        '/executions',
        '/repositories',
        // Validator round (A1-A3): project 5D tab page, verification tablist.
        // (/projects/[id]/architecture is the project Architecture hub since
        // 2026-10-28 — a page, pinned below as NOT redirect-only.)
        '/projects/[id]/assets',
        '/operate/verification',
      ]),
    );
    // …and must not over-detect: a page with a component is never redirect-only,
    // even when its +page.ts redirects some params (/library/[type]).
    expect(redirectOnly).not.toContain('/library/[type]');
    // The project Architecture hub is a page (its +page.ts only 308s a legacy ?tab=).
    expect(redirectOnly).not.toContain('/projects/[id]/architecture');
  });

  it('every NAV_ITEMS and PROJECT_NAV href resolves to a real route', () => {
    const dead = NAV_HREFS.filter(({ href }) => resolve(href) === null).map(
      ({ who, href }) => `${who} → ${href}`,
    );
    expect(dead).toEqual([]);
  });

  it('no row targets a redirect-only route (a launcher stub or an alias)', () => {
    // The sidebar must link the FINAL page. A row on a 308 stub is the launcher
    // menu reintroduced one hop away.
    const toRedirect = NAV_HREFS.filter(({ href }) => {
      const r = resolve(href);
      return r !== null && isRedirectOnly(r);
    }).map(({ who, href }) => `${who} → ${href}`);
    expect(toRedirect).toEqual([]);
  });

  it('no row lands on a param the route\'s own load() redirects', () => {
    const conditional = NAV_HREFS.map(({ who, href }) => ({ who, href, r: resolve(href) })).filter(
      (x) => x.r !== null && x.r.hasSvelte && x.r.universalRedirects,
    );
    // Non-vacuity: the Triggers row (/library/triggers) lands on /library/[type].
    expect(conditional.some((x) => x.href === '/library/triggers')).toBe(true);
    const problems: string[] = [];
    for (const { who, href, r } of conditional) {
      const load = CONDITIONAL_LOADS[r!.id];
      if (!load) {
        problems.push(`${who} → ${href}: ${r!.id} redirects conditionally — add its load() to CONDITIONAL_LOADS`);
        continue;
      }
      try {
        load(paramsOf(r!.id, href));
      } catch (e) {
        const st = (e as { status?: number }).status;
        if (st && st >= 300 && st < 400) problems.push(`${who} → ${href}: load() ${st} → ${(e as { location?: string }).location}`);
        else throw e;
      }
    }
    expect(problems).toEqual([]);
  });

  it('the conditional-load check would catch a governance slug (self-check)', () => {
    expect(() => libraryTypeLoad({ params: paramsOf('/library/[type]', '/library/requirements') } as never)).toThrow();
    expect(() => libraryTypeLoad({ params: paramsOf('/library/[type]', '/library/triggers') } as never)).not.toThrow();
  });

  it('NAV_ITEMS hrefs are unique (no two rows open the same page)', () => {
    const hrefs = ALL_ROUTES.map((r) => r.href);
    const dupes = hrefs.filter((h, i) => hrefs.indexOf(h) !== i);
    expect(dupes).toEqual([]);
  });

  it('PROJECT_NAV subs are unique too', () => {
    const subs = PROJECT_NAV.map((i) => i.sub);
    expect(subs.filter((s, i) => subs.indexOf(s) !== i)).toEqual([]);
  });

  it('the matcher refuses a path with no route (self-check of the instrument)', () => {
    expect(resolve('/does-not-exist')).toBeNull();
    // Static beats dynamic: /library/kag is its own route (a 308 stub now), not /library/[type].
    expect(resolve('/library/kag')?.id).toBe('/library/kag');
    expect(resolve('/library/kag/documents')?.id).toBe('/library/kag/documents');
    expect(resolve('/library/triggers')?.id).toBe('/library/[type]');
    // fr#1478: the conveyor map is its own static route, not swallowed by [type].
    expect(resolve('/library/conveyor')?.id).toBe('/library/conveyor');
  });
});

describe('PROJECT_NAV — project library kinds are sidebar rows, not tabs', () => {
  it('carries one Library row per bound kind, artifacts excluded (the Outputs row owns it)', () => {
    const lib = PROJECT_NAV.filter(
      (i) => i.sub.startsWith('library/') && !i.sub.startsWith('library/kag/') && !i.sub.startsWith('library/architecture/'),
    ).map((i) => i.sub);
    expect(
      PROJECT_NAV.filter((i) => i.sub.startsWith('library/')).every((i) => i.group === 'knowledge' || i.group === 'kag'),
    ).toBe(true);
    expect(lib).toEqual([
      'library/requirements',
      'library/principles',
      'library/decisions',
      'library/workflows',
      'library/triggers',
      'library/channels',
      // fr-agui §16 D12 (P2-b): the read-only PM library (not a bound kind: RM's PM records).
      'library/pm',
      // The bound KAG documents list leads the Project KAG group.
      'library/kag-documents',
    ]);
    expect(PROJECT_NAV.find((i) => i.id === 'artifacts')?.sub).toBe('artifacts');
    expect(PROJECT_NAV.some((i) => i.sub === 'library/artifacts')).toBe(false);
  });
});

// FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 / R1 (D1), R6: one project group — eight
// always-visible rows (Cost last), then the collapsible Knowledge, Project KAG and Details groups.
describe('PROJECT_NAV — R1 project rail: main rows + Knowledge + Project KAG + Details', () => {
  it('the main rows are exactly Overview, Needs you, Board, Outputs, Plan & scope, Registers, Architecture, Cost — in that order', () => {
    const { main } = projectNavGroups();
    expect(main.map((i) => [i.label, i.sub])).toEqual([
      ['Overview', ''],
      ['Needs you', 'needs-you'],
      ['Board', 'board'],
      ['Outputs', 'artifacts'],
      ['Plan & scope', 'plan'],
      ['Registers', 'registers'],
      // George 2026-10-28: architecture is always reachable within a project.
      ['Architecture', 'architecture'],
      ['Cost', 'cost'],
    ]);
  });

  it('R6: the Cost row opens a real cost page (last main row), and the brief page is a redirect now', () => {
    expect(PROJECT_NAV.some((i) => i.sub === 'cost')).toBe(true);
    expect(PROJECT_NAV.find((i) => i.sub === 'cost')?.group).toBe('main');
    expect(SVELTE_PAGES.some((p) => p.includes('/projects/[id]/cost/'))).toBe(true);
    // The brief merged into Plan & scope: no rail row and no page of its own.
    expect(PROJECT_NAV.some((i) => i.sub === 'brief')).toBe(false);
    expect(SVELTE_PAGES.some((p) => p.includes('/projects/[id]/brief/'))).toBe(false);
  });

  it('the groups are main, knowledge, kag, details — each contiguous, in that order', () => {
    const order = ['main', 'knowledge', 'kag', 'details'];
    const runs = PROJECT_NAV.map((i) => i.group).filter((g, i, a) => i === 0 || a[i - 1] !== g);
    expect(runs).toEqual(order);
    const { knowledge, kag, details } = projectNavGroups();
    expect([knowledge.id, kag.id, details.id]).toEqual([
      PROJECT_KNOWLEDGE_GROUP_ID,
      PROJECT_KAG_GROUP_ID,
      PROJECT_DETAILS_GROUP_ID,
    ]);
    expect([knowledge.label, kag.label, details.label]).toEqual(['Knowledge', 'Project KAG', 'Details']);
    expect(Object.keys(PROJECT_NAV_GROUP_ICONS)).toEqual(['knowledge', 'kag', 'details']);
  });

  it('Knowledge holds effective assets, reasoning, the project ArchiMate lists and the bound kinds; Project KAG holds the twelve KAG views', () => {
    const { knowledge, kag } = projectNavGroups();
    expect(knowledge.items.map((i) => i.sub)).toEqual(
      expect.arrayContaining([
        'knowledge',
        'reasoning',
        'traceability',
        'library/architecture/elements',
        'library/architecture/relationships',
        'library/architecture/views',
        'library/architecture/standards',
      ]),
    );
    expect(kag.items.filter((i) => i.sub.startsWith('library/kag/')).map((i) => i.sub.slice('library/kag/'.length))).toEqual([
      'documents', 'web-sources', 'media', 'graph', 'entities', 'discover',
      'scientific', 'text-analysis', 'ask', 'health', 'benchmarks', 'capabilities',
    ]);
  });

  it('no project row is role-gated: Details is visible to every member', () => {
    // ProjectNavItem has no gate field; this pins that nobody adds one silently.
    for (const i of PROJECT_NAV) {
      expect(Object.keys(i).sort(), i.id).toEqual(
        expect.arrayContaining(['group', 'iconName', 'id', 'label', 'sub']),
      );
      expect(
        Object.keys(i).filter((k) => !['group', 'iconName', 'id', 'label', 'sub', 'badgeSource'].includes(k)),
        i.id,
      ).toEqual([]);
    }
  });

  it('every non-redirect, param-free project page on disk is a row (nothing lost from the rail)', () => {
    // Project pages that need a second id (a card, a thread, an approval) are
    // reached from their list pages, not the rail.
    const prefix = '/projects/[id]';
    const pages = [...ROUTES.values()]
      .filter((r) => r.id === prefix || r.id.startsWith(`${prefix}/`))
      .filter((r) => r.hasSvelte && !isRedirectOnly(r))
      .map((r) => (r.id === prefix ? '' : r.id.slice(prefix.length + 1)))
      .filter((sub) => !sub.includes('['))
      .sort();
    // The equality below is the claim; a `pages.length` floor only restated how
    // many project pages exist today.
    expect([...PROJECT_NAV.map((i) => i.sub)].sort()).toEqual(pages);
  });
});

// ===========================================================================
// Collapsible sub-groups (nav standard, owner ruling 2026-10-03): the former
// tab hubs' tabs are rows, folded under one header per hub in the rail.
// ===========================================================================
describe('NAV_SUB_GROUPS — collapsible rail sub-groups', () => {
  const groupIds = Object.keys(NAV_SUB_GROUPS);

  it('every group has rows, and every row group is declared', () => {
    // No group-count floor: NAV_SUB_GROUPS' ids are named (architecture-library,
    // kag, conveyor-catalogue) in the navSegments tests below.
    for (const id of groupIds) {
      expect(NAV_ITEMS.filter((i) => i.group === id).length, id).toBeGreaterThanOrEqual(2);
    }
    for (const item of NAV_ITEMS) {
      if (item.group) expect(groupIds, item.id).toContain(item.group);
    }
  });

  it("a group's rows are contiguous in NAV_ITEMS and live in the group's zone", () => {
    for (const id of groupIds) {
      const idx = NAV_ITEMS.map((i, n) => (i.group === id ? n : -1)).filter((n) => n >= 0);
      expect(idx[idx.length - 1]! - idx[0]! + 1, `${id} rows are split`).toBe(idx.length);
      const zone = NAV_SUB_GROUPS[id as keyof typeof NAV_SUB_GROUPS].zone;
      expect(NAV_ITEMS.filter((i) => i.group === id).every((i) => i.zone === zone), id).toBe(true);
    }
  });

  it("a group's prefix is the common parent of its rows (legacy hub)", () => {
    for (const g of Object.values(NAV_SUB_GROUPS)) {
      for (const row of NAV_ITEMS.filter((i) => i.group === g.id)) {
        const under = row.href === g.prefix || row.href.startsWith(g.prefix + '/');
        expect(under, `${row.id} not under ${g.prefix}`).toBe(true);
      }
    }
  });

  it('group header labels are unique and never repeat a row label (rail-wide)', () => {
    const rowLabels = new Set(NAV_ITEMS.map((i) => i.label.toLowerCase()));
    const headers = Object.values(NAV_SUB_GROUPS).map((g) => g.label.toLowerCase());
    expect(new Set(headers).size).toBe(headers.length);
    expect(headers.filter((h) => rowLabels.has(h))).toEqual([]);
  });

  it('navSegments folds a group where its first row sits and keeps every row', () => {
    const knowledge = visibleNavFor(['workspace-member'] as NavRole[]).filter((i) => i.zone === 'knowledge');
    const segs = navSegments(knowledge);
    const kinds = segs.map((s) => (s.kind === 'item' ? s.item.id : `group:${s.group.id}`));
    expect(kinds).toEqual([
      'principles',
      'requirements',
      'decisions',
      'group:architecture-library',
      'group:kag',
      'research',
      'artifacts',
      'triggers',
      'conveyor-map',
      'group:conveyor-catalogue',
      'traceability',
      'reasoning-toc',
    ]);
    // Nothing is lost by folding: the rows inside + the plain rows == the input.
    const flat = segs.flatMap((s) => (s.kind === 'item' ? [s.item] : s.items));
    expect(flat.map((i) => i.id)).toEqual(knowledge.map((i) => i.id));
  });

  it('navSegments drops a group whose rows were all filtered out (no empty header)', () => {
    const noKag = NAV_ITEMS.filter((i) => i.zone === 'knowledge' && i.group !== 'kag');
    expect(navSegments(noKag).some((s) => s.kind === 'group' && s.group.id === 'kag')).toBe(false);
  });

  it('every grouped row stays in the flat ALL_ROUTES projection (CmdK)', () => {
    const grouped = NAV_ITEMS.filter((i) => i.group);
    // The ALL_ROUTES/NAV_ITEMS id equality above already covers this; a
    // `grouped.length` floor only restated how many grouped rows exist today.
    for (const row of grouped) expect(ALL_ROUTES.map((r) => r.id)).toContain(row.id);
  });
});

// ===========================================================================
// Distinct icons. The collapsed rail is icon + title only, so two rows of one
// zone (or one sub-group, or one project group) with the same icon are two
// entries the operator cannot tell apart. Six "Platform …" rows all drew
// Package, three licence rows KeyRound — owner audit 2026-10-03.
// ===========================================================================
/** Pure so the mutation self-check below can feed it a broken registry. */
function iconClashesByZone(
  items: readonly { id: string; zone: string; iconName: string; group?: string }[],
  headers: readonly { id: string; zone: string; iconName: string }[],
): string[] {
  const out: string[] = [];
  const zones = new Set([...items.map((i) => i.zone), ...headers.map((h) => h.zone)]);
  for (const zone of zones) {
    const seen = new Map<string, string>();
    const entries = [
      ...items.filter((i) => i.zone === zone).map((i) => ({ who: i.id, icon: i.iconName })),
      ...headers.filter((h) => h.zone === zone).map((h) => ({ who: `group:${h.id}`, icon: h.iconName })),
    ];
    for (const e of entries) {
      const prev = seen.get(e.icon);
      if (prev) out.push(`${zone}: ${e.icon} on ${prev} + ${e.who}`);
      else seen.set(e.icon, e.who);
    }
  }
  return out;
}

describe('icons are distinct within every zone, sub-group and project group', () => {
  it('no two rows (or group headers) of one zone share an icon', () => {
    expect(iconClashesByZone(NAV_ITEMS, Object.values(NAV_SUB_GROUPS))).toEqual([]);
  });

  it('no two PROJECT_NAV rows or project group headers share an icon', () => {
    const icons = [...PROJECT_NAV.map((i) => i.iconName), ...Object.values(PROJECT_NAV_GROUP_ICONS)];
    const dupes = icons.filter((n, i) => icons.indexOf(n) !== i);
    expect(dupes).toEqual([]);
  });

  it('self-check: the clash detector goes red on a mutated registry', () => {
    // Mutation 1: one Platform row back on Package (the original defect).
    const mutated = NAV_ITEMS.map((i) =>
      i.id === 'admin-assets-decisions' ? { ...i, iconName: 'Package' } : i.id === 'admin-assets-projects' ? { ...i, iconName: 'Package' } : i,
    );
    expect(iconClashesByZone(mutated, Object.values(NAV_SUB_GROUPS))).toEqual([
      'administration: Package on admin-assets-decisions + admin-assets-projects',
    ]);
    // Mutation 2: a sub-group header repeating one of its own rows' icons.
    const headers = Object.values(NAV_SUB_GROUPS).map((g) => (g.id === 'kag' ? { ...g, iconName: 'Search' } : g));
    expect(iconClashesByZone(NAV_ITEMS, headers)).toEqual(['knowledge: Search on kag-ask + group:kag']);
  });
});
