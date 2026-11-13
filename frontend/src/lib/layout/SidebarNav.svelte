<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import { page } from '$app/state';
  import { afterNavigate, beforeNavigate } from '$app/navigation';
  import {
    projectNavGroups,
    projectNavHref,
    navHrefMatches,
    navSegments,
    sectionNavFor,
    toNavRoles,
    type BadgeSource,
    type NavItem,
    type NavSection,
  } from './navConfig';
  import { isProjectShellRoute } from './shellKind';
  import { auth } from '$lib/stores/auth.svelte';
  import { activeProject } from '$lib/stores/activeProject.svelte';
  import { phaseTitles } from '$lib/projects/phaseTitles.svelte';
  import { navCounts } from '$lib/stores/navCounts.svelte';
  import { projectCockpit } from '$lib/stores/projectCockpit.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { sidebar } from '$lib/stores/sidebar.svelte';
  // NOTE: `lucide-svelte` barrel import fails (per Task 5 Step 1.5 probe);
  // using per-icon paths instead.
  // Project rail (FR-PROJECT-HOME-REDESIGN R1): Overview + Project settings rows.
  import House from 'lucide-svelte/icons/house';
  import SlidersHorizontal from 'lucide-svelte/icons/sliders-horizontal';
  // Rail-wide unique icons (validator B2, 2026-10-03): one icon per row/header.
  import MessagesSquare from 'lucide-svelte/icons/messages-square';
  import BrainCircuit from 'lucide-svelte/icons/brain-circuit';
  import GitPullRequestArrow from 'lucide-svelte/icons/git-pull-request-arrow';
  import TowerControl from 'lucide-svelte/icons/tower-control';
  import CodeXml from 'lucide-svelte/icons/code-xml';
  import ChartNoAxesColumn from 'lucide-svelte/icons/chart-no-axes-column';
  import PlugZap from 'lucide-svelte/icons/plug-zap';
  import WandSparkles from 'lucide-svelte/icons/wand-sparkles';
  import PanelsTopLeft from 'lucide-svelte/icons/panels-top-left';
  import UserCog from 'lucide-svelte/icons/user-cog';
  import FileKey from 'lucide-svelte/icons/file-key';
  import CircleDollarSign from 'lucide-svelte/icons/circle-dollar-sign';
  import PiggyBank from 'lucide-svelte/icons/piggy-bank';
  import Landmark from 'lucide-svelte/icons/landmark';
  import Hand from 'lucide-svelte/icons/hand';
  import Flag from 'lucide-svelte/icons/flag';
  import SquareKanban from 'lucide-svelte/icons/square-kanban';
  import Combine from 'lucide-svelte/icons/combine';
  import SearchCheck from 'lucide-svelte/icons/search-check';
  import CheckCircle2 from 'lucide-svelte/icons/check-circle-2';
  import Target from 'lucide-svelte/icons/target';
  import LayoutGrid from 'lucide-svelte/icons/layout-grid';
  import Building2 from 'lucide-svelte/icons/building-2';
  import Brain from 'lucide-svelte/icons/brain';
  import Compass from 'lucide-svelte/icons/compass';
  import Network from 'lucide-svelte/icons/network';
  import DraftingCompass from 'lucide-svelte/icons/drafting-compass';
  import Package from 'lucide-svelte/icons/package';
  import History from 'lucide-svelte/icons/history';
  import FolderGit2 from 'lucide-svelte/icons/folder-git-2';
  import ShieldCheck from 'lucide-svelte/icons/shield-check';
  import GitCompare from 'lucide-svelte/icons/git-compare';
  import ListChecks from 'lucide-svelte/icons/list-checks';
  import Gauge from 'lucide-svelte/icons/gauge';
  import FolderKanban from 'lucide-svelte/icons/folder-kanban';
  import SettingsIcon from 'lucide-svelte/icons/settings';
  import KeyRound from 'lucide-svelte/icons/key-round';
  import Plus from 'lucide-svelte/icons/plus';
  // Icons for the global zoned nav (Work/Knowledge/Engine/Govern). Every
  // NAV_ITEMS.iconName must have an entry in ICONS below or it silently falls
  // back to Compass — navConfig.test.ts pins this so a new item can't regress it.
  import MessageSquare from 'lucide-svelte/icons/message-square';
  import MessageCircle from 'lucide-svelte/icons/message-circle';
  import Bell from 'lucide-svelte/icons/bell';
  import ClipboardList from 'lucide-svelte/icons/clipboard-list';
  import GitBranch from 'lucide-svelte/icons/git-branch';
  import CalendarClock from 'lucide-svelte/icons/calendar-clock';
  import FlaskConical from 'lucide-svelte/icons/flask-conical';
  import Waypoints from 'lucide-svelte/icons/waypoints';
  import Workflow from 'lucide-svelte/icons/workflow';
  import Bot from 'lucide-svelte/icons/bot';
  import Radio from 'lucide-svelte/icons/radio';
  import BarChart3 from 'lucide-svelte/icons/bar-chart-3';
  import FileText from 'lucide-svelte/icons/file-text';
  import TrendingUp from 'lucide-svelte/icons/trending-up';
  import Headset from 'lucide-svelte/icons/headset';
  // Rows that replaced in-page menus (nav standard 2026-10-03): Triggers.
  import Zap from 'lucide-svelte/icons/zap';
  // Administration + Workspace zones (see navConfig.ts). Added with their
  // items: the icon-coverage test fails the build on an unmapped iconName
  // rather than letting it silently fall back to Compass.
  import Users from 'lucide-svelte/icons/users';
  import Receipt from 'lucide-svelte/icons/receipt';
  import AlertTriangle from 'lucide-svelte/icons/triangle-alert';
  import Wrench from 'lucide-svelte/icons/wrench';
  import Wallet from 'lucide-svelte/icons/wallet';
  // Project-scoped variants (PROJECT_NAV): a project row must never share
  // icon AND meaning with a global row, or the collapsed rail shows two
  // identical entries opening different pages.
  import PackageOpen from 'lucide-svelte/icons/package-open';
  import ScrollText from 'lucide-svelte/icons/scroll-text';
  import Radar from 'lucide-svelte/icons/radar';
  import FolderGit from 'lucide-svelte/icons/folder-git';
  import FileStack from 'lucide-svelte/icons/file-stack';
  import ClipboardPen from 'lucide-svelte/icons/clipboard-pen';
  import Signpost from 'lucide-svelte/icons/signpost';
  import GitFork from 'lucide-svelte/icons/git-fork';
  import ListOrdered from 'lucide-svelte/icons/list-ordered';
  import Route from 'lucide-svelte/icons/route';
  import Webhook from 'lucide-svelte/icons/webhook';
  import RadioTower from 'lucide-svelte/icons/radio-tower';
  import CalendarRange from 'lucide-svelte/icons/calendar-range';
  import Hourglass from 'lucide-svelte/icons/hourglass';
  import Merge from 'lucide-svelte/icons/merge';
  // Rows for formerly orphaned pages (project requests, secrets, BYOC).
  import Inbox from 'lucide-svelte/icons/inbox';
  import Lock from 'lucide-svelte/icons/lock';
  import GlobeLock from 'lucide-svelte/icons/globe-lock';
  // Rows that replaced the tab hubs (KAG, PM, Architecture, Conformance,
  // Executions, Repositories) and the /reports asset-type <select>, their
  // sub-group headers, and the per-row icons that keep every zone free of
  // repeated icons (nav standard 2026-10-03; pinned by navConfig.test.ts).
  import Box from 'lucide-svelte/icons/box';
  import Link2 from 'lucide-svelte/icons/link-2';
  import LayoutDashboard from 'lucide-svelte/icons/layout-dashboard';
  import BadgeCheck from 'lucide-svelte/icons/badge-check';
  import Layers from 'lucide-svelte/icons/layers';
  import Briefcase from 'lucide-svelte/icons/briefcase';
  import ListTodo from 'lucide-svelte/icons/list-todo';
  import ShieldAlert from 'lucide-svelte/icons/shield-alert';
  import GitMerge from 'lucide-svelte/icons/git-merge';
  import FileUp from 'lucide-svelte/icons/file-up';
  import Globe from 'lucide-svelte/icons/globe';
  import Film from 'lucide-svelte/icons/film';
  import Share2 from 'lucide-svelte/icons/share-2';
  import Shapes from 'lucide-svelte/icons/shapes';
  import Telescope from 'lucide-svelte/icons/telescope';
  import Atom from 'lucide-svelte/icons/atom';
  import TextSearch from 'lucide-svelte/icons/text-search';
  import Search from 'lucide-svelte/icons/search';
  import HeartPulse from 'lucide-svelte/icons/heart-pulse';
  import Crosshair from 'lucide-svelte/icons/crosshair';
  import Cpu from 'lucide-svelte/icons/cpu';
  import Play from 'lucide-svelte/icons/play';
  import Activity from 'lucide-svelte/icons/activity';
  import Database from 'lucide-svelte/icons/database';
  import ScanSearch from 'lucide-svelte/icons/scan-search';
  import Scale from 'lucide-svelte/icons/scale';
  import ChartPie from 'lucide-svelte/icons/chart-pie';
  import GitGraph from 'lucide-svelte/icons/git-graph';
  import ListPlus from 'lucide-svelte/icons/list-plus';
  import FileClock from 'lucide-svelte/icons/file-clock';
  import FileDiff from 'lucide-svelte/icons/file-diff';
  import FileCheck from 'lucide-svelte/icons/file-check';
  import FileSearch from 'lucide-svelte/icons/file-search';
  import FileCog from 'lucide-svelte/icons/file-cog';
  import BookKey from 'lucide-svelte/icons/book-key';
  import Tags from 'lucide-svelte/icons/tags';
  import BookMarked from 'lucide-svelte/icons/book-marked';
  import ClipboardType from 'lucide-svelte/icons/clipboard-type';
  import Milestone from 'lucide-svelte/icons/milestone';
  import ListTree from 'lucide-svelte/icons/list-tree';
  import Cog from 'lucide-svelte/icons/cog';
  import FolderTree from 'lucide-svelte/icons/folder-tree';
  import BellRing from 'lucide-svelte/icons/bell-ring';
  import Microscope from 'lucide-svelte/icons/microscope';
  // Validator round 2026-10-03: project Architecture group rows, the
  // Verification / Licensing / Platform-assets sub-groups and their rows.
  import Orbit from 'lucide-svelte/icons/orbit';
  import Cable from 'lucide-svelte/icons/cable';
  import Goal from 'lucide-svelte/icons/goal';
  import Calculator from 'lucide-svelte/icons/calculator';
  import Dices from 'lucide-svelte/icons/dices';
  import Stamp from 'lucide-svelte/icons/stamp';
  import UserCheck from 'lucide-svelte/icons/user-check';
  // Knowledge → Conveyor map (/library/conveyor, fr#1478).
  import Grid3x3 from 'lucide-svelte/icons/grid-3x3';
  import Blocks from 'lucide-svelte/icons/blocks';
  import SquareStack from 'lucide-svelte/icons/square-stack';
  import Puzzle from 'lucide-svelte/icons/puzzle';
  import Component from 'lucide-svelte/icons/component';
  import Boxes from 'lucide-svelte/icons/boxes';
  import PackageCheck from 'lucide-svelte/icons/package-check';
  import LayoutTemplate from 'lucide-svelte/icons/layout-template';
  import TrafficCone from 'lucide-svelte/icons/traffic-cone';
  import ArrowDownWideNarrow from 'lucide-svelte/icons/arrow-down-wide-narrow';
  import FlagTriangleRight from 'lucide-svelte/icons/flag-triangle-right';
  import ChartGantt from 'lucide-svelte/icons/chart-gantt';
  import Sheet from 'lucide-svelte/icons/sheet';
  // R6: the project Cost row (spend vs budget).
  import Coins from 'lucide-svelte/icons/coins';
  import Warehouse from 'lucide-svelte/icons/warehouse';
  import ChevronRight from 'lucide-svelte/icons/chevron-right';
  // Project shell "Agent" area (fr-agui SPEC §7.3): the project's threads.
  import BotMessageSquare from 'lucide-svelte/icons/bot-message-square';
  // Project Knowledge + Project KAG groups: headers, ArchiMate lists, KAG views.
  import Library from 'lucide-svelte/icons/library';
  import LibraryBig from 'lucide-svelte/icons/library-big';
  import FileInput from 'lucide-svelte/icons/file-input';
  import Rss from 'lucide-svelte/icons/rss';
  import Clapperboard from 'lucide-svelte/icons/clapperboard';
  import ChartNetwork from 'lucide-svelte/icons/chart-network';
  import Hexagon from 'lucide-svelte/icons/hexagon';
  import Binoculars from 'lucide-svelte/icons/binoculars';
  import TestTubes from 'lucide-svelte/icons/test-tubes';
  import ScanText from 'lucide-svelte/icons/scan-text';
  import MessageCircleQuestionMark from 'lucide-svelte/icons/message-circle-question-mark';
  import Stethoscope from 'lucide-svelte/icons/stethoscope';
  import Ruler from 'lucide-svelte/icons/ruler';
  import MemoryStick from 'lucide-svelte/icons/memory-stick';
  import Container from 'lucide-svelte/icons/container';
  import Spline from 'lucide-svelte/icons/spline';
  import AppWindow from 'lucide-svelte/icons/app-window';
  import Award from 'lucide-svelte/icons/award';
  import Icon from '$lib/components/ui/Icon.svelte';
  import SidebarBadge from './SidebarBadge.svelte';

  const ICONS = {
    House,
    SlidersHorizontal,
    CheckCircle2,
    Target,
    LayoutGrid,
    Building2,
    Brain,
    Compass,
    Network,
    Package,
    History,
    FolderGit2,
    ShieldCheck,
    GitCompare,
    ListChecks,
    Gauge,
    FolderKanban,
    Settings: SettingsIcon,
    KeyRound,
    MessageSquare,
    MessageCircle,
    Bell,
    ClipboardList,
    GitBranch,
    CalendarClock,
    FlaskConical,
    Waypoints,
    Workflow,
    Bot,
    Radio,
    BarChart3,
    FileText,
    TrendingUp,
    Headset,
    Users,
    Receipt,
    AlertTriangle,
    Wrench,
    Wallet,
    Zap,
    PackageOpen,
    ScrollText,
    Radar,
    FolderGit,
    FileStack,
    ClipboardPen,
    Signpost,
    GitFork,
    ListOrdered,
    Route,
    Webhook,
    RadioTower,
    CalendarRange,
    Hourglass,
    Merge,
    Inbox,
    Lock,
    GlobeLock,
    Box,
    Link2,
    LayoutDashboard,
    BadgeCheck,
    DraftingCompass,
    Layers,
    Briefcase,
    ListTodo,
    ShieldAlert,
    GitMerge,
    FileUp,
    Globe,
    Film,
    Share2,
    Shapes,
    Telescope,
    Atom,
    TextSearch,
    Search,
    HeartPulse,
    Crosshair,
    Cpu,
    Play,
    Activity,
    Database,
    ScanSearch,
    Scale,
    ChartPie,
    GitGraph,
    ListPlus,
    FileClock,
    FileDiff,
    FileCheck,
    FileSearch,
    FileCog,
    BookKey,
    Tags,
    BookMarked,
    ClipboardType,
    Milestone,
    ListTree,
    Cog,
    FolderTree,
    BellRing,
    Microscope,
    Orbit,
    Cable,
    Goal,
    Calculator,
    Dices,
    Stamp,
    UserCheck,
    Grid3x3,
    Blocks,
    SquareStack,
    Puzzle,
    Component,
    Boxes,
    PackageCheck,
    LayoutTemplate,
    TrafficCone,
    ArrowDownWideNarrow,
    FlagTriangleRight,
    ChartGantt,
    Sheet,
    Coins,
    Warehouse,
    MessagesSquare,
    BrainCircuit,
    GitPullRequestArrow,
    TowerControl,
    CodeXml,
    ChartNoAxesColumn,
    PlugZap,
    WandSparkles,
    PanelsTopLeft,
    UserCog,
    FileKey,
    CircleDollarSign,
    PiggyBank,
    Landmark,
    Hand,
    Flag,
    SquareKanban,
    Combine,
    SearchCheck,
    BotMessageSquare,
    Library,
    LibraryBig,
    Container,
    Spline,
    AppWindow,
    Award,
    FileInput,
    Rss,
    Clapperboard,
    ChartNetwork,
    Hexagon,
    Binoculars,
    TestTubes,
    ScanText,
    MessageCircleQuestionMark,
    Stethoscope,
    Ruler,
    MemoryStick,
  } as const;

  function iconFor(name: string) {
    return ICONS[name as keyof typeof ICONS] ?? Compass;
  }

  // One sidebar per top-nav section (TopNav.svelte): inside a project (the
  // (project) route group) it is that project's rail; otherwise the section's
  // own zones of NAV_ITEMS — Tenant, Administration or Super-admin.
  // A section's sidebar never shows another section's rows.
  let { section = 'tenant' }: { section?: NavSection } = $props();
  const inProjectShell = $derived(isProjectShellRoute(page.route.id));
  const proj = $derived(activeProject.active);
  // Null-safe projections of `proj` for the template below. Leaving a project
  // releases the route's hold on the store (`activeProject.leaveRoute()` in the
  // project layout) and Svelte 5 re-evaluates the expressions inside `{#if proj}`
  // BEFORE the block tears down — so a bare `proj.id` there threw
  // "Cannot read properties of undefined (reading 'id')" in production.
  // Nothing inside the block may dereference `proj` directly.
  // In the project shell the route param is authoritative from the first
  // paint; the store's stub only lands after the project layout's effect runs.
  const projId = $derived(inProjectShell ? (page.params?.id ?? proj?.id ?? '') : '');
  const projName = $derived(proj?.name ?? '');
  const projPhase = $derived(proj?.phase);
  // FR-PROJECT-HOME-REDESIGN R1: the main rows (always visible) + the collapsible
  // Knowledge, Project KAG and Details groups (collapsed by default; auto-expanded while one of
  // their pages is open; the user's open/closed choice persists via the sidebar store).
  const projectNav = projectNavGroups();
  const projectNavAll = [
    ...projectNav.main,
    ...projectNav.knowledge.items,
    ...projectNav.kag.items,
    ...projectNav.details.items,
  ];
  const currentPath = $derived(page.url.pathname);

  // Every href the rail renders — used for longest-match active detection so a
  // parent (/library) doesn't false-highlight when a child (/library/kag) is the
  // real destination, and the project cockpit root doesn't co-highlight with a
  // sub-route (/projects/<id> vs /projects/<id>/board).
  // fr#1221: RUNTIME narrowing — `toNavRoles` drops roles the nav layer does not know.
  const roles = $derived(toNavRoles(auth.tenantRoles));
  const zoneSegments = $derived(
    sectionNavFor(section, roles, { isSuperAdmin: auth.isSuperAdmin }).map((zg) => ({
      ...zg,
      segments: navSegments(zg.items),
    })),
  );
  const rowOf = (i: NavItem) => ({ key: i.id, href: i.href, label: i.label, iconName: i.iconName, badge: i.badgeSource });

  const renderedHrefs = $derived(
    projId
      ? projectNavAll.map((it) => projectNavHref(projId, it.sub))
      : ['/projects/new', ...zoneSegments.flatMap((g) => g.items.map((i) => i.href))],
  );

  // The single active row = the longest rendered href the current path matches.
  const activeHref = $derived.by(() => {
    let best: string | null = null;
    for (const h of renderedHrefs) {
      if (navHrefMatches(h, currentPath) && (best === null || h.length > best.length)) {
        best = h;
      }
    }
    return best;
  });

  function isActive(href: string): boolean {
    return href === activeHref;
  }

  // A rendered row, normalised so one `subgroup` snippet serves both the
  // global sub-groups (NAV_SUB_GROUPS) and the project groups (PROJECT_NAV).
  interface RailRow {
    key: string;
    href: string;
    label: string;
    iconName: string;
    badge: BadgeSource | undefined;
  }


  /** Header click: in the icon-only rail, expand the rail and open the group. */
  function onGroupHeader(id: string, containsActive: boolean): void {
    if (sidebar.collapsed) {
      sidebar.setCollapsed(false);
      sidebar.openGroup(id);
      return;
    }
    sidebar.toggleGroup(id, containsActive);
  }

  function badgeFor(source?: BadgeSource): number {
    if (source === 'pending-approvals') return navCounts.pendingApprovals;
    if (source === 'unread-notifications') return navCounts.unreadNotifications;
    if (source === 'project-needs-you') return projId ? (projectCockpit.needsYouFor(projId)?.count ?? 0) : 0;
    return 0;
  }

  /**
   * WHAT EACH BADGE COUNTS, in words, one entry per source.
   *
   * ⛔ THE DEFECT THIS CLOSES. `SidebarBadge` hard-coded the word `pending` for
   * every source. `unread-notifications` counts unread notifications — it is not
   * pending anything, and its row does not lead to a queue of pending anything. On main that
   * wrong word reached screen readers only (`aria-label="3 pending"`); this change
   * added a `title` beside it, which would have made the same wrong word a
   * tooltip for every reader. The badge now says what the SOURCE counts.
   *
   * ⭐ A `Record<BadgeSource, …>`, NOT AN `if`-CHAIN OR A DEFAULT. A fifth badge
   * source added to `navConfig.ts` is then a `svelte-check` error here — which CI
   * runs — instead of silently inheriting whichever word happens to be first.
   * That inheritance is exactly how one source's vocabulary came to describe all
   * three.
   */
  const BADGE_WHAT: Record<BadgeSource, string> = {
    'pending-approvals': 'pending',
    'unread-notifications': 'unread',
    'project-needs-you': 'waiting on you in this project',
  };

  /**
   * The noun phrase for a source, or `''` for a row that has no badge at all.
   *
   * `''` renders as the bare number (see `SidebarBadge`'s `counted`) and is
   * unreachable in practice — `badgeFor(undefined)` is 0 and the badge hides at 0
   * — but it degrades to saying NOTHING rather than to borrowing another source's
   * word, which is the failure mode this map exists to end.
   */
  function badgeWhat(source?: BadgeSource): string {
    return source === undefined ? '' : BADGE_WHAT[source];
  }

  /**
   * What the badged number COVERS, for the one source whose population is not
   * the workspace on screen.
   *
   * ⛔ `'pending-approvals'` ONLY, and the narrowness is the point.
   * `/api/approvals/all` drops the tenant predicate for a super-admin in their
   * home view, so that badge can be a FLEET census rendered beside the name of a
   * workspace holding none of it (measured 2026-09-26: fleet 5, `fr-test` 0).
   * The other two sources are tenant-scoped server-side and state no scope, so
   * they get `undefined` — an unqualified number, exactly as before. Handing
   * them `'workspace'` would be a claim this component has not measured, which
   * is the shape of the bug it is fixing.
   *
   * ⭐ READ, NOT DERIVED. The store keeps what the envelope said
   * (`pendingApprovalsScopeKind`); nothing here re-computes scope from the
   * active workspace, because the active workspace is precisely what the backend
   * may have ignored.
   */
  function badgeScope(source?: BadgeSource): 'fleet' | 'workspace' | undefined {
    if (source !== 'pending-approvals') return undefined;
    return navCounts.pendingApprovalsScopeKind;
  }

  /**
   * Is the badged number the last one CONFIRMED, or merely the last one seen?
   *
   * Approvals only, for the same reason: it is the counter whose store field
   * distinguishes the two (`pendingApprovalsStale`). The other two keep their
   * last known value silently, which is a smaller version of the same problem
   * and is not this change's subject.
   */
  function badgeStale(source?: BadgeSource): boolean {
    if (source === 'project-needs-you') return !!projId && projectCockpit.needsYouFor(projId)?.partial === true;
    return source === 'pending-approvals' && navCounts.pendingApprovalsStale;
  }

  const ACTIVE_CLS =
    'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] font-medium';
  const INACTIVE_CLS =
    'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]';

  let pollTimer: ReturnType<typeof setInterval> | null = null;
  onMount(() => {
    pollTimer = setInterval(() => void navCounts.refresh(), 60_000);
    // Phase labels are the tenant's RM titles (no frontend list).
    void phaseTitles.ensureLoaded();
  });
  onDestroy(() => {
    if (pollTimer !== null) clearInterval(pollTimer);
  });

  // UI review #11: clicking a rail item made the rail's own scroll jump. Keep
  // the nav container's scrollTop across the navigation, and only bring the
  // active item into view when it is actually outside the visible area
  // (`block: 'nearest'` — never re-centre a row the user can already see).
  let navEl: HTMLElement | null = null;
  let savedScrollTop: number | null = null;
  beforeNavigate(() => {
    savedScrollTop = navEl?.scrollTop ?? null;
  });
  afterNavigate(() => {
    const el = navEl;
    if (!el) return;
    if (savedScrollTop !== null) el.scrollTop = savedScrollTop;
    savedScrollTop = null;
    const active = el.querySelector<HTMLElement>('a[aria-current="page"]');
    if (!active) return;
    const box = el.getBoundingClientRect();
    const r = active.getBoundingClientRect();
    if (r.top < box.top || r.bottom > box.bottom) active.scrollIntoView?.({ block: 'nearest' });
  });

  // One line, one owner: refetch the counts whenever the active workspace
  // changes. See `navCounts.refreshForScope` for the measured defect this closes
  // (a bare onMount refresh raced the workspace store and left the Approvals
  // badge reading 0 for the first 60s of every session).
  $effect(() => {
    navCounts.refreshForScope(workspaces.scopeKey);
  });
</script>

<!-- A leaf row: icon + (label, badge) when expanded; icon-only when collapsed.

     ⚠️ `title` is UNCONDITIONAL, on purpose. It used to read
     `title={sidebar.collapsed ? label : null}`, which put the tooltip on
     exactly the state that does not need it and withheld it from the state
     that does: when collapsed there is no text to lose, and when EXPANDED the
     label rendered in a 220px rail under `truncate` — "Workflow improvement"
     showed as "Workflow improvem…" with no way to read the rest. (UI review
     #11: labels now wrap to two lines, `line-clamp-2`; the title stays for
     anything longer.) Both states
     want the full label on hover; only the collapsed state strictly needs it,
     and the expanded state is the one that was broken. -->
{#snippet leaf(href: string, label: string, iconName: string, badge: BadgeSource | undefined, nested: boolean)}
  <a
    {href}
    title={label}
    aria-current={isActive(href) ? 'page' : undefined}
    class={`flex min-h-9 items-center gap-3 rounded-[var(--radius-md)] py-1.5 text-sm transition ${
      sidebar.collapsed ? 'justify-center px-0' : nested ? 'pl-7 pr-3' : 'px-3'
    } ${isActive(href) ? ACTIVE_CLS : INACTIVE_CLS}`}
  >
    <span class="relative flex items-center">
      <Icon icon={iconFor(iconName)} size={16} />
      {#if sidebar.collapsed && badgeFor(badge) > 0}
        <span
          class="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-[var(--color-accent)]"
          aria-hidden="true"
        ></span>
      {/if}
    </span>
    {#if !sidebar.collapsed}
      <span class="flex-1 line-clamp-2 break-words">{label}</span>
      <SidebarBadge
        count={badgeFor(badge)}
        what={badgeWhat(badge)}
        scope={badgeScope(badge)}
        stale={badgeStale(badge)}
      />
    {/if}
  </a>
{/snippet}

<!-- A collapsible sub-group (nav standard 2026-10-03: former tab hubs and the
     project groups). One header <button> (aria-expanded + aria-controls) over
     its rows. Collapsed by default; open on its own while the active route is
     one of its rows. In the icon-only rail the header is its icon with
     title=label, and clicking it expands the rail with the group open. The
     rows container always exists so aria-controls never points at nothing. -->
{#snippet subgroup(id: string, label: string, iconName: string, rows: RailRow[], accent: boolean)}
  {@const containsActive = rows.some((r) => isActive(r.href))}
  {@const open = sidebar.isGroupOpen(id, containsActive)}
  {@const listId = `nav-group-${id.replace(/[^A-Za-z0-9_-]/g, '-')}`}
  <div class="flex flex-col gap-0.5">
    <button
      type="button"
      title={label}
      aria-expanded={open}
      aria-controls={listId}
      data-testid={`nav-group-${id}`}
      onclick={() => onGroupHeader(id, containsActive)}
      class={`flex min-h-9 items-center gap-3 rounded-[var(--radius-md)] py-1.5 text-sm transition ${
        sidebar.collapsed ? 'justify-center px-0' : 'px-3'
      } ${containsActive && !open ? ACTIVE_CLS : INACTIVE_CLS} ${
        accent ? 'font-semibold' : ''
      }`}
    >
      <Icon icon={iconFor(iconName)} size={16} />
      {#if !sidebar.collapsed}
        <span class="flex-1 line-clamp-2 break-words text-left">{label}</span>
        <span
          class={`inline-flex transition-transform ${open ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          <Icon icon={ChevronRight} size={14} />
        </span>
      {/if}
    </button>
    <div id={listId} class="flex flex-col gap-0.5">
      {#if open}
        {#each rows as r (r.key)}
          {@render leaf(r.href, r.label, r.iconName, r.badge, true)}
        {/each}
      {/if}
    </div>
  </div>
{/snippet}

<nav
  bind:this={navEl}
  data-testid="sidebar-nav"
  data-shell={projId ? 'project' : section}
  class={`flex h-full w-full shrink-0 flex-col gap-3 overflow-y-auto border-r border-[var(--color-border)] bg-[var(--color-surface)] py-4 ${
    sidebar.collapsed ? 'px-1.5' : 'px-2'
  }`}
  aria-label="Primary"
>
  <!-- PROJECT SHELL ONLY — "← Workspace" exit + proj-ctx header + the project
       groups. Never rendered in tenant mode (SPEC §7.2: the shells never mix). -->
  {#if projId}
    <a
      href="/"
      data-testid="project-shell-exit"
      title="Back to the workspace"
      class={`mx-1 flex min-h-9 items-center gap-2 rounded-[var(--radius-md)] py-1.5 text-sm font-semibold text-[var(--color-text-muted)] transition hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)] ${
        sidebar.collapsed ? 'justify-center px-0' : 'px-3'
      }`}
    >
      <span aria-hidden="true">←</span>
      {#if !sidebar.collapsed}<span>Workspace</span>{/if}
    </a>
    {#if !sidebar.collapsed}
      <div class="mx-1 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2.5">
        <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
          ▣ Project cockpit
        </div>
        <!-- `line-clamp-2` silently drops everything past two lines, so the
             full name has to be reachable on hover for the same reason the
             truncated leaf labels do. -->
        <div
          class="mt-1 line-clamp-2 text-sm font-bold leading-snug text-[var(--color-text)]"
          title={projName}
        >
          {projName}
        </div>
        <div class="mt-1.5 flex items-center justify-between gap-2">
          <span
            class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] px-2 py-0.5 text-[11px] font-semibold text-[var(--color-accent-strong)]"
          >
            {proj?.kind === 'continuous' ? '♺' : '◐'}
            {phaseTitles.label(projPhase)}
          </span>
          <a
            href={`/projects/${projId}/settings`}
            title="Project settings (andon, provisioning)"
            class="text-[11px] font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent-strong)]"
          >
            ⚙
          </a>
        </div>
      </div>
    {/if}

    <div class="flex flex-col gap-0.5" data-testid="project-nav-main">
      {#each projectNav.main as item (item.id)}
        {@render leaf(projectNavHref(projId, item.sub), item.label, item.iconName, item.badgeSource, false)}
      {/each}
    </div>
    {#each [projectNav.knowledge, projectNav.kag, projectNav.details] as g (g.id)}
      {@render subgroup(
        g.id,
        g.label,
        g.iconName,
        g.items.map((item) => ({
          key: item.id,
          href: projectNavHref(projId, item.sub),
          label: item.label,
          iconName: item.iconName,
          badge: item.badgeSource,
        })),
        false,
      )}
    {/each}
  {/if}

  {#if !projId}
  <!-- New project — hidden where the conveyor is not configured (kag) -->
  {#if section === 'tenant' && !auth.conveyorCreationDisabled}
  <a
    href="/projects/new"
    title={sidebar.collapsed ? 'New project' : null}
    class={`mx-1 flex h-9 items-center justify-center gap-2 rounded-[var(--radius-md)] border border-dashed border-[var(--color-border-strong)] text-sm font-semibold text-[var(--color-text-muted)] transition hover:border-[var(--color-accent)] hover:bg-[var(--color-accent-bg)] hover:text-[var(--color-accent-strong)] ${
      sidebar.collapsed ? 'px-0' : 'px-3'
    }`}
  >
    <Icon icon={Plus} size={16} />
    {#if !sidebar.collapsed}<span>New project</span>{/if}
  </a>
  {/if}

  <!-- GLOBAL ZONED NAV — Work / Knowledge / Engine / Govern. Collapsible zone
       headers (persisted); when the whole rail is icon-collapsed the headers are
       hidden and every leaf shows as an icon (today's collapsed behavior). -->
  {#each zoneSegments as zg (zg.zone)}
    <div class="flex flex-col gap-0.5">
      {#if !sidebar.collapsed}
        <button
          type="button"
          class="flex items-center gap-1 px-3 pb-1 text-left text-[10px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)] transition hover:text-[var(--color-text)]"
          aria-expanded={!sidebar.isZoneCollapsed(zg.zone)}
          onclick={() => sidebar.toggleZone(zg.zone)}
        >
          <span
            class={`inline-block text-[8px] transition-transform ${
              sidebar.isZoneCollapsed(zg.zone) ? '-rotate-90' : ''
            }`}
            aria-hidden="true">▼</span
          >
          {zg.label}
        </button>
      {/if}
      {#if sidebar.collapsed || !sidebar.isZoneCollapsed(zg.zone)}
        {#each zg.segments as seg (seg.kind === 'item' ? seg.item.id : `group:${seg.group.id}`)}
          {#if seg.kind === 'item'}
            {@render leaf(seg.item.href, seg.item.label, seg.item.iconName, seg.item.badgeSource, false)}
          {:else}
            {@render subgroup(seg.group.id, seg.group.label, seg.group.iconName, seg.items.map(rowOf), false)}
          {/if}
        {/each}
      {/if}
    </div>
  {/each}
  {/if}
</nav>
