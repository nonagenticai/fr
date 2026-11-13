// No second menu built from the rail registry (nav standard, owner ruling
// 2026-10-03; validator B1 on b4065c80). The Home "Line & operate" card used to
// render `{#each launchpad}` chips from `operateLaunchpad()` — every visible
// Engine NAV_ITEMS row, i.e. a copy of the sidebar inside a page. The rule:
// the rail registry's ROW sets may be iterated only by the surfaces whose job
// IS navigation. Anything else that wants rows is re-building a menu.
//
// INSTRUMENT. Every non-test .svelte / .ts under src/ is read raw, comments
// stripped (prose may name the registry), and checked for a code-level use of a
// row-set export of $lib/layout/navConfig. Detecting the IMPORT/use rather than
// the `{#each}` is deliberate: the launchpad iterated a helper's return value
// in the .svelte and touched NAV_ITEMS only in a .ts, so an `{#each NAV_ITEMS}`
// pattern would have missed the very case this exists for.
import { describe, it, expect } from 'vitest';

const SOURCES = import.meta.glob(
  [
    '../../**/*.svelte',
    '../../**/*.ts',
    '!../../**/*.test.ts',
    '!../../**/*.spec.ts',
    '!../../**/tests/**',
  ],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** navConfig exports that yield rail ROWS (or the predicate that filters them). */
const ROW_SETS = [
  'NAV_ITEMS',
  'ALL_ROUTES',
  'navSegments',
  'isItemVisible',
  'visibleNavFor',
  'groupedNavFor',
  'PROJECT_NAV',
  'projectNavGroups',
  'NAV_SUB_GROUPS',
  'sectionNavFor',
] as const;

/** Each surface allowed to iterate rail rows, and why it is not a duplicate menu. */
const ALLOWED: Readonly<Record<string, string>> = {
  'src/lib/layout/navConfig.ts': 'the registry itself',
  'src/lib/layout/SidebarNav.svelte': 'THE project rail',
  'src/lib/layout/TopNav.svelte': 'THE app bar: its section tabs pick which sidebar section renders',
  'src/lib/components/CmdK.svelte':
    'command palette: keyboard search over the same destinations, not a page menu',
  'src/lib/layout/KagShell.svelte':
    'the KAG product (kag.nonagentic.ai) has no fr sidebar; this list IS its rail',
};

function code(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\s\/\/.*$/gm, '');
}

/** Glob keys are relative to this file (`../components/X`, `../../routes/Y`). */
function repoPath(globKey: string): string {
  return new URL(globKey, 'file:///repo/src/lib/nav/').pathname.replace(/^\/repo\//, '');
}

const ROW_RE = new RegExp(`\\b(${ROW_SETS.join('|')})\\b`, 'g');

function users(files: Record<string, string>): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const [file, src] of Object.entries(files)) {
    const hits = [...new Set([...code(src).matchAll(ROW_RE)].map((m) => m[1]!))];
    if (hits.length) out.set(repoPath(file), hits.sort());
  }
  return out;
}

describe('no component re-derives a menu from the rail registry', () => {
  const found = users(SOURCES);

  it('non-vacuity: the scan reads the tree and sees every allowlisted surface', () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(700);
    for (const f of Object.keys(ALLOWED)) expect(found.has(f), f).toBe(true);
  });

  it('only the allowlisted navigation surfaces use rail row sets', () => {
    const offenders = [...found]
      .filter(([f]) => !(f in ALLOWED))
      .map(([f, syms]) => `${f} uses ${syms.join(', ')}`);
    expect(offenders).toEqual([]);
  });

  it('self-check: a launchpad helper is red; prose and non-row imports are not', () => {
    const bad = users({
      '../../x/launch.ts':
        "import { NAV_ITEMS, isItemVisible } from '$lib/layout/navConfig';\nexport const l = NAV_ITEMS.filter((i) => isItemVisible(i, []));",
      '../../x/Card.svelte': '{#each PROJECT_NAV as r}<a href={r.href}>{r.label}</a>{/each}',
    });
    expect([...bad.keys()]).toEqual(['src/x/launch.ts', 'src/x/Card.svelte']);
    const fine = users({
      '../../x/A.svelte':
        "<!-- read from NAV_ITEMS -->\n<script>\n  // like NAV_ITEMS\n  import { navHrefMatches } from '$lib/layout/navConfig';\n</script>",
    });
    expect(fine.size).toBe(0);
  });
});
