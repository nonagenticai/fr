// Keep-out guard for the nav standard (fr#1331, 2026-10-03): the ONLY menu is
// the sidebar (lib/layout/SidebarNav.svelte, driven by NAV_ITEMS / PROJECT_NAV).
// A route that renders its own menu is a menu inside a page — the tab strips in
// /settings, /admin/licenses and /projects/[id]/library, and the AssetTabs hubs
// (/library/kag, /library/architecture, /govern/architecture,
// /executions, /repositories) that this branch removed were exactly that.
// Owner ruling 2026-10-03: tab hubs are NOT exempt. This fails if one comes back.
//
// Validator round (2026-10-03) widened it after three hubs slipped through:
//  - SCOPE: src/lib/**/*.svelte is scanned too. ArchitectureView (a lib
//    component mounted by /projects/[id]/architecture) carried a <nav> of tab
//    buttons the routes-only glob never saw — "moved into $lib" is not "gone".
//  - SHAPE: a tab hub need not say role="tablist". /projects/[id]/assets was a
//    bare {#each TABS} of <button>s setting `active`. Three more rules catch
//    that family: tab-state names (activeTab/switchTab/selectedTab/…), an
//    {#each} strip whose buttons set a tab/view/lens/mode/panel/active state,
//    and `?tab=` URL handling; plus any use of the <Tabs> primitive.
// Every legitimate single-view toggle the rules hit is allowlisted below with
// its reason; a stale entry fails.
import { describe, it, expect } from 'vitest';

const LAYOUTS = import.meta.glob('./**/+layout.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Every route-level component: the +page.svelte files AND the route-local
// components they mount (e.g. library/research/components/DeliverableTabs,
// library/kag/KagIngestionTab) — a tab strip moved one file down is still on
// the page.
const ROUTE_SVELTE = import.meta.glob('./**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

// Every lib component — a tab strip moved into $lib and mounted by a route is
// still a menu on that page.
const LIB_SVELTE = import.meta.glob('../lib/**/*.svelte', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

const PAGES = Object.keys(ROUTE_SVELTE).filter((f) => f.endsWith('/+page.svelte'));
const ALL_SVELTE: Record<string, string> = { ...ROUTE_SVELTE, ...LIB_SVELTE };

/** Strip HTML comments and // + block comments so prose cannot trip a rule. */
function code(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** The opening tag (attributes included) at `start`, which must point at '<'. */
function openingTag(src: string, start: number): string {
  // Svelte attributes can hold `>` inside {…}; skip braces while scanning.
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === '{') depth++;
    else if (c === '}') depth--;
    else if (c === '>' && depth === 0) return src.slice(start, i + 1);
  }
  return src.slice(start);
}

/** The full element (open tag … matching close tag) starting at `start`. */
function elementAt(src: string, start: number): string {
  const tag = /^<([a-zA-Z][\w-]*)/.exec(src.slice(start))?.[1];
  if (!tag) return '';
  const re = new RegExp(`<${tag}[\\s>/]|</${tag}\\s*>`, 'g');
  re.lastIndex = start + 1;
  let depth = 1;
  for (let m = re.exec(src); m; m = re.exec(src)) {
    depth += m[0].startsWith('</') ? -1 : 1;
    if (depth === 0) return src.slice(start, m.index + m[0].length);
  }
  return src.slice(start);
}

/** Start index of the tag that owns the attribute found at `attrAt`. */
function ownerTagStart(src: string, attrAt: number): number {
  return src.lastIndexOf('<', attrAt);
}

type Kind = 'nav' | 'tablist' | 'tabstate' | 'tabstrip' | 'tabparam' | 'tabs-primitive';

interface Finding {
  file: string;
  kind: Kind;
}

/** `<nav>` elements that are not breadcrumbs. */
function navFindings(file: string, src: string): Finding[] {
  const out: Finding[] = [];
  const c = code(src);
  for (const m of c.matchAll(/<nav[\s>/]/g)) {
    const open = openingTag(c, m.index!);
    // A breadcrumb trail is the one legitimate <nav> in a page: it names where
    // you are, it is not a menu. Matched on the ARIA label, exactly as the
    // page-level trails spell it.
    if (/aria-label=["']Breadcrumb["']/.test(open)) continue;
    out.push({ file, kind: 'nav' });
  }
  return out;
}

/** Every element carrying role="tablist", with its full markup. */
function tablists(src: string): string[] {
  const c = code(src);
  return [...c.matchAll(/role=["']tablist["']/g)].map((m) => elementAt(c, ownerTagStart(c, m.index!)));
}

/** A tablist whose tabs are links is a router — a menu of pages, never allowed. */
function isLinkTablist(el: string): boolean {
  return /<a[\s>]/.test(el) || /\shref=/.test(el);
}

/** State named like a tab switch: the classic hub without role="tablist". */
function hasTabState(src: string): boolean {
  return /\b(activeTab|switchTab|selectedTab|currentTab|setActiveTab|setTab)\b/.test(code(src));
}

/** The `?tab=` URL contract of a hub: reading/writing the param, or a literal `?tab=`/`&tab=` link. */
function hasTabParam(src: string): boolean {
  const c = code(src);
  return /searchParams\.(get|set|has)\(\s*['"`]tab['"`]/.test(c) || /['"`][^'"`\n]*[?&]tab=/.test(c);
}

/** Renders the single-route <Tabs> primitive (fine for filters; each use must be allowlisted). */
function usesTabsPrimitive(file: string, src: string): boolean {
  return !file.endsWith('/asset-workspace/tabs/Tabs.svelte') && /<Tabs[\s>/]/.test(code(src));
}

/** The body of every `{#each LIST as ITEM …}…{/each}` block (nesting-aware). */
function eachBlocks(c: string): { list: string; item: string; body: string }[] {
  const out: { list: string; item: string; body: string }[] = [];
  for (const m of c.matchAll(/\{#each\s+(\S+?)\s+as\s+([A-Za-z_$][\w$]*)/g)) {
    const re = /\{#each\b|\{\/each\}/g;
    re.lastIndex = m.index! + m[0].length;
    let depth = 1;
    for (let n = re.exec(c); n; n = re.exec(c)) {
      depth += n[0] === '{/each}' ? -1 : 1;
      if (depth === 0) {
        out.push({ list: m[1]!, item: m[2]!, body: c.slice(m.index! + m[0].length, n.index) });
        break;
      }
    }
  }
  return out;
}

/** camelCase / snake / dotted identifier → lower-case words: `activeKind` → active, kind. */
function words(ident: string): string[] {
  return ident
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

// Whole WORDS, not substrings: `reviewArtifact` is not a view, `openInRightPane`
// is not a panel, and a population named `active` is not a tab state.
const TAB_WORDS = new Set(['tab', 'tabs', 'view', 'views', 'lens', 'lenses', 'mode', 'modes', 'panel', 'panels']);
const tabbishList = (ident: string): boolean => words(ident).some((w) => TAB_WORDS.has(w));
const tabbishTarget = (ident: string): boolean => words(ident).some((w) => TAB_WORDS.has(w) || w === 'active');

/**
 * A button/link strip: an {#each LIST as ITEM} whose <button>/<a> click either
 * assigns a state from the item — `() => (s = item…)` — or calls a function
 * with it — `() => fn(item…)`. It fires when the LIST is named like tabs /
 * views / lenses / modes / panels, or the assigned state / called function is
 * (active… counts there). Row actions (`decide(r)`, `disconnect(inst)`) and
 * plain pickers (`newColor = c`) are not named that way and do not fire.
 */
function hasTabStrip(src: string): boolean {
  for (const b of eachBlocks(code(src))) {
    const item = b.item.replace(/[^\w$]/g, '');
    const click = new RegExp(
      `<(?:button|a)\\b[^>]*?onclick=\\{\\s*\\(\\)\\s*=>\\s*\\(?\\s*([A-Za-z_$][\\w$.]*)\\s*(=(?!=)|\\(|\\?\\.\\()\\s*${item}\\b`,
      'gs',
    );
    for (const m of b.body.matchAll(click)) {
      if (tabbishList(b.list) || tabbishTarget(m[1]!)) return true;
    }
  }
  return false;
}

function usesAssetTabs(src: string): boolean {
  const c = code(src);
  return /\bimport\b[^;]*\bAssetTabs\b/.test(c) || /<AssetTabs[\s>/]/.test(c);
}

// Single-route VIEW TOGGLES: a button strip that filters or switches a panel
// inside ONE page, never another route — or the shell's own menu. Each needs
// its reason. A stale entry (file gone, or no longer carrying that finding)
// fails below.
const ALLOWLIST: ReadonlyMap<string, { kind: Kind; why: string }> = new Map(
  (
    [
      ['./approvals/+page.svelte', 'nav', 'status filter buttons (pending/approved/…) over the one approvals list'],
      ['./approvals/+page.svelte', 'tabstate', '`activeTab` is that status filter (pending/approved/rejected), one list, refetched per status'],
      ['./approvals/+page.svelte', 'tabstrip', 'KIND_FILTERS chips narrow the same approvals list by kind'],
      ['./notifications/+page.svelte', 'tablist', 'all/unread filter buttons over the one notification feed'],
      ['./library/research/components/DeliverableTabs.svelte', 'tablist', 'deliverable panel switch inside one research session'],
      ['./library/research/components/DeliverableTabs.svelte', 'tabstrip', 'same deliverable panel switch (its TABS each-loop), one session, one route'],
      ['../lib/asset-workspace/tabs/Tabs.svelte', 'tablist', 'the presentational <Tabs> primitive itself; every consumer is a tabs-primitive finding below'],
      ['../lib/layout/SidebarNav.svelte', 'nav', 'the sidebar — THE one menu the standard keeps'],
      ['../lib/layout/TopNav.svelte', 'nav', 'the app bar section tabs (Tenant / Administration / Super-admin): pick which sidebar section renders'],
      ['../lib/layout/KagShell.svelte', 'nav', 'the KAG product shell (kag host, no fr sidebar): its rail IS that product\'s one menu, built from the same NAV_ITEMS KAG rows'],
      ['../lib/workflows/TagTree.svelte', 'nav', 'facet filter tree (domain/purpose/stage/trigger checkboxes) over the one /workflows list'],
      ['../lib/layout/AgentRailHeader.svelte', 'tabstate', 'right agent-rail panel switch (Agent / Detail) in the shell, not a page and not a route'],
      ['../lib/layout/TenantSidePane.svelte', 'tabstate', 'the same right-rail panel switch (Agent / Detail) on tenant pages after the rail retirement (OQ-17 c), not a page and not a route'],
      ['../lib/components/registers/ProjectRegisters.svelte', 'tablist', 'Risks / Criteria / Decisions switch over the one registers read on /projects/[id]/registers (FR-PROJECT-HOME-REDESIGN §7.3, George 2026-10-26)'],
      ['../lib/components/cockpit/LiveExecutionTimeline.svelte', 'tabs-primitive', 'event-kind filter over one live timeline'],
      ['../lib/components/outputs/DocumentReader.svelte', 'nav', "the document's table of contents (R3 / DOC-3): in-page #anchors to the headings of the ONE document shown, never another route"],
    ] as const
  ).map(([file, kind, why]) => [`${file}|${kind}`, { kind, why }] as const),
);

function scan(files: Record<string, string>): { assetTabs: string[]; linkTablists: string[]; unlisted: string[]; seen: Set<string> } {
  const assetTabs: string[] = [];
  const linkTablists: string[] = [];
  const unlisted: string[] = [];
  const seen = new Set<string>();
  const note = (file: string, kind: Kind): void => {
    const key = `${file}|${kind}`;
    seen.add(key);
    if (!ALLOWLIST.has(key)) unlisted.push(key);
  };
  for (const [file, src] of Object.entries(files)) {
    if (usesAssetTabs(src)) assetTabs.push(file);
    if (hasTabState(src)) note(file, 'tabstate');
    if (hasTabStrip(src)) note(file, 'tabstrip');
    if (hasTabParam(src)) note(file, 'tabparam');
    if (usesTabsPrimitive(file, src)) note(file, 'tabs-primitive');
    for (const el of tablists(src)) {
      if (isLinkTablist(el)) linkTablists.push(file);
      const key = `${file}|tablist`;
      seen.add(key);
      if (!ALLOWLIST.has(key)) unlisted.push(key);
    }
    for (const f of navFindings(file, src)) {
      const key = `${f.file}|${f.kind}`;
      seen.add(key);
      if (!ALLOWLIST.has(key)) unlisted.push(key);
    }
  }
  return { assetTabs, linkTablists, unlisted: [...new Set(unlisted)], seen };
}

describe('no route layout renders an in-page <nav>', () => {
  // Layouts that legitimately render a <nav>, each with the ruling that allows
  // it. EMPTY on purpose — none does today.
  const LAYOUT_ALLOWLIST: ReadonlySet<string> = new Set<string>([]);

  it('non-vacuity: the glob sees the route layouts', () => {
    // A glob that matched nothing would make the check below pass vacuously;
    // the named root layout is what proves it did not.
    expect(Object.keys(LAYOUTS)).toContain('./+layout.svelte');
  });

  it('no +layout.svelte contains a <nav element (outside the allowlist)', () => {
    const offenders = Object.entries(LAYOUTS)
      .filter(([file]) => !LAYOUT_ALLOWLIST.has(file))
      .filter(([, src]) => /<nav[\s>/]/i.test(src.replace(/<!--[\s\S]*?-->/g, '')))
      .map(([file]) => file);
    expect(offenders).toEqual([]);
  });

  it('every layout allowlist entry is a real layout (no stale exemptions)', () => {
    for (const file of LAYOUT_ALLOWLIST) expect(Object.keys(LAYOUTS)).toContain(file);
  });
});

describe('no page renders a menu (tab hub, link tab strip, non-breadcrumb <nav>)', () => {
  const result = scan(ALL_SVELTE);

  it('non-vacuity: the scan sees every page, every lib component, and the known breadcrumb trails', () => {
    // No page/lib count floors: a broken glob reads as zero, and the named
    // page + lib entries below fail on exactly that.
    expect(LIB_SVELTE['../lib/components/architecture/ArchitectureView.svelte']).toBeDefined();
    expect(LIB_SVELTE['../lib/layout/SidebarNav.svelte']).toBeDefined();
    expect(PAGES).toContain('./library/kag/documents/+page.svelte');
    // The breadcrumb exemption is exercised, not dormant: these pages carry one.
    const crumbPage = ROUTE_SVELTE['./reports/approval-backlog/+page.svelte']!;
    expect(/<nav aria-label="Breadcrumb"/.test(crumbPage)).toBe(true);
    expect(navFindings('x', crumbPage)).toEqual([]);
  });

  it('no route component imports or renders AssetTabs (tab hubs are not exempt)', () => {
    expect(result.assetTabs).toEqual([]);
  });

  it('no role="tablist" whose tabs are links to other routes (no allowlist)', () => {
    expect(result.linkTablists).toEqual([]);
  });

  it('every non-breadcrumb <nav> and every tablist is an allowlisted single-route view toggle', () => {
    expect(result.unlisted).toEqual([]);
  });

  it('no stale allowlist entries (each still matches a finding in its file)', () => {
    for (const [key, entry] of ALLOWLIST) {
      expect(result.seen.has(key), `stale allowlist entry ${key}`).toBe(true);
      expect(key.endsWith(`|${entry.kind}`)).toBe(true);
      expect(entry.why.length).toBeGreaterThan(10);
    }
  });

  // Mutation checks: the rules must go red on the shapes they exist to stop.
  it('self-check: an AssetTabs import makes the scan red', () => {
    const page = ROUTE_SVELTE['./library/kag/documents/+page.svelte']!;
    const mutated = page.replace(
      '<script lang="ts">',
      "<script lang=\"ts\">\n  import { AssetTabs } from '$lib/asset-workspace/tabs';",
    );
    expect(mutated).not.toBe(page);
    expect(scan({ './library/kag/documents/+page.svelte': mutated }).assetTabs).toEqual([
      './library/kag/documents/+page.svelte',
    ]);
    // …and a mention in a comment does not.
    expect(usesAssetTabs('<!-- formerly an AssetTabs hub -->\n// AssetTabs\n')).toBe(false);
  });

  it('self-check: a link tab strip and a non-breadcrumb <nav> are red; a breadcrumb is not', () => {
    const links = '<div role="tablist">{#each kinds as k}<a href={`/x/${k}`} role="tab">{k}</a>{/each}</div>';
    expect(scan({ './x/+page.svelte': links }).linkTablists).toEqual(['./x/+page.svelte']);
    const buttons = '<div role="tablist"><button role="tab">A</button></div>';
    expect(scan({ './x/+page.svelte': buttons }).linkTablists).toEqual([]);
    expect(scan({ './x/+page.svelte': buttons }).unlisted).toEqual(['./x/+page.svelte|tablist']);
    const chips = '<nav class="mt-3 flex">{#each t as x}<a href={x}>{x}</a>{/each}</nav>';
    expect(scan({ './x/+page.svelte': chips }).unlisted).toEqual(['./x/+page.svelte|nav']);
    const crumb = '<nav aria-label="Breadcrumb" class="text-xs"><a href="/reports">Reports</a> / X</nav>';
    expect(scan({ './x/+page.svelte': crumb }).unlisted).toEqual([]);
  });

  it('self-check (validator A1 shape): a bare {#each TABS} <button> strip with activeTab is red without role="tablist"', () => {
    const strip = [
      '<script lang="ts">',
      "  const TABS = [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }];",
      "  let activeTab = $state('a');",
      '</script>',
      '{#each TABS as t (t.id)}<button type="button" onclick={() => (activeTab = t.id)}>{t.label}</button>{/each}',
    ].join('\n');
    expect(scan({ './x/+page.svelte': strip }).unlisted.sort()).toEqual(['./x/+page.svelte|tabstate', './x/+page.svelte|tabstrip']);
    // The deleted /projects/[id]/assets shape exactly: state named `active`, no tab word in the state.
    const assets = '{#each TABS as t (t.kind)}<button type="button" onclick={() => (active = t.kind)}>{t.label}</button>{/each}';
    expect(scan({ './y/+page.svelte': assets }).unlisted).toEqual(['./y/+page.svelte|tabstrip']);
    // A function-call switch counts too.
    const call = '{#each views as v}<button onclick={() => showView(v.id)}>{v.label}</button>{/each}';
    expect(scan({ './z/+page.svelte': call }).unlisted).toEqual(['./z/+page.svelte|tabstrip']);
  });

  it('self-check (validator A2 shape): the ArchitectureView <nav> tab strip, re-added in $lib, is red', () => {
    const file = '../lib/components/architecture/ArchitectureView.svelte';
    const real = LIB_SVELTE[file]!;
    expect(scan({ [file]: real }).unlisted).toEqual([]);
    const mutated = real.replace(
      '<div class="p-6">',
      `<nav class="flex -mb-px"><button onclick={() => switchTab('architecture')}>Architecture Graph</button><button onclick={() => switchTab('quality')}>Quality Gate</button></nav>\n<div class="p-6">`,
    );
    expect(mutated).not.toBe(real);
    expect(scan({ [file]: mutated }).unlisted.sort()).toEqual([`${file}|nav`, `${file}|tabstate`]);
  });

  it('self-check: `?tab=` handling and a new <Tabs> consumer are red', () => {
    expect(scan({ './p/+page.svelte': "<script>const t = $page.url.searchParams.get('tab');</script>" }).unlisted).toEqual([
      './p/+page.svelte|tabparam',
    ]);
    expect(scan({ './q/+page.svelte': '<a href="/x?tab=graph">x</a>' }).unlisted).toEqual(['./q/+page.svelte|tabparam']);
    expect(scan({ '../lib/X.svelte': '<Tabs {tabs} active={a} onSelect={s} />' }).unlisted).toEqual(['../lib/X.svelte|tabs-primitive']);
  });

  it('self-check: row actions, pickers and list selection do NOT fire (the heuristic is not "any button in a loop")', () => {
    const benign = [
      '{#each reviews as r (r.id)}<button onclick={() => selectReview(r)}>{r.name}</button>{/each}',
      '{#each artifacts as a}<button onclick={() => reviewArtifact(a, "approve")}>ok</button>{/each}',
      '{#each active as inst}<button onclick={() => disconnect(inst)}>x</button>{/each}',
      '{#each PALETTE as c}<button onclick={() => (newColor = c)}>{c}</button>{/each}',
      '{#each executions as ex}<button onclick={() => openInRightPane(ex.id)}>{ex.id}</button>{/each}',
      '{#each transcripts as t}<button onclick={() => (selected = t)}>{t.id}</button>{/each}',
      '<!-- {#each TABS as t}<button onclick={() => (activeTab = t)}>old</button>{/each} -->',
    ].join('\n');
    expect(scan({ './ok/+page.svelte': benign }).unlisted).toEqual([]);
  });
});
