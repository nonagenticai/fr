// In-app links never target a redirect (nav standard, owner ruling
// 2026-10-03; validator B1). The rail rule lives in navConfig.test.ts; this is
// the same rule for every OTHER link in the app: a page that links a 308 stub
// (a former launcher or tab hub) sends the user through the menu that was
// removed, one hop later, and a KAG-host root visit that lands on a stub is two
// redirects deep.
//
// INSTRUMENT. Every non-test .svelte / .ts under src/ is read raw; comments are
// stripped; then STRING-LITERAL link targets are extracted from five shapes:
//   href="/x"  ·  href={'/x'} / href={`/x?…${…}`}  ·  goto('/x')  ·
//   href: '/x' (object literals: nav registries, link cards)  ·
//   redirect(3xx, '/x') (a redirect onto a redirect is a chain)  ·
//   projectNavHref(id, 'sub') (the project-scoped link builder; resolved with a
//   placeholder project id, since `/projects/${id}/x` templates are skipped).
// A template literal counts only when its PATH is complete before the first
// `${` (i.e. a `?` or `#` came first); `/projects/${id}` is a prefix, not a
// target, and is skipped rather than guessed. Each target is resolved against
// the route tree from $lib/nav/tests/routeTree (the SAME detector the rail
// test uses) and fails if it is redirect-only or its route's load() redirects
// those params. The stub files themselves are skipped — naming their old path
// is their job.
import { describe, it, expect } from 'vitest';
import { STUB_FILES, redirectReason } from './tests/routeTree';
import { KAG_HUB_PATH } from '$lib/product';

const SOURCES = import.meta.glob(
  ['../../**/*.svelte', '../../**/*.ts', '!../../**/*.test.ts', '!../../**/*.spec.ts', '!../../**/tests/**'],
  { query: '?raw', import: 'default', eager: true },
) as Record<string, string>;

/** Same stripping as the no-in-page-nav guard: prose cannot trip the rule. */
function code(src: string): string {
  return src
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

const PATTERNS: readonly RegExp[] = [
  /\bhref\s*=\s*"([^"{]*)"/g,
  /\bhref\s*=\s*'([^'{]*)'/g,
  /\bhref\s*=\s*\{\s*['"`]([^'"`]*)/g,
  /\bgoto\(\s*['"`]([^'"`]*)/g,
  /\bhref:\s*['"`]([^'"`]*)/g,
  /\bredirect\(\s*\d{3}\s*,\s*['"`]([^'"`]*)/g,
];

/** The internal path a captured literal names, or null when it is not a complete one. */
function targetOf(raw: string): string | null {
  if (!raw.startsWith('/') || raw.startsWith('//')) return null;
  const dollar = raw.indexOf('${');
  const cut = raw.search(/[?#]/);
  if (dollar >= 0 && (cut < 0 || dollar < cut)) return null; // a prefix, not a target
  const path = cut >= 0 ? raw.slice(0, cut) : raw;
  if (path.startsWith('/api/')) return null;
  return path === '' ? null : path;
}

interface Hit {
  file: string;
  target: string;
}

const PROJECT = '00000000-0000-4000-8000-000000000000';
const PROJECT_SUB = /\bprojectNavHref\([^,()]+,\s*['"`]([^'"`$]*)['"`]\s*\)/g;

function extract(files: Record<string, string>): Hit[] {
  const out: Hit[] = [];
  for (const [file, src] of Object.entries(files)) {
    // STUB_FILES is keyed relative to nav/tests/ ('../../../routes/…'); SOURCES to nav/.
    if (STUB_FILES.has(file.replace(/^\.\.\/\.\.\//, '../../../'))) continue;
    const c = code(src);
    for (const m of c.matchAll(PROJECT_SUB)) {
      out.push({ file, target: m[1] ? `/projects/${PROJECT}/${m[1]}` : `/projects/${PROJECT}` });
    }
    for (const re of PATTERNS) {
      for (const m of c.matchAll(re)) {
        const t = targetOf(m[1]!);
        if (t) out.push({ file, target: t });
      }
    }
  }
  return out;
}

function offenders(hits: Hit[]): string[] {
  return hits.flatMap(({ file, target }) => {
    const why = redirectReason(target);
    return why ? [`${file.replace(/^\.\.\/\.\.\//, 'src/')} → ${target} (${why})`] : [];
  });
}

describe('no in-app link targets a redirect', () => {
  const hits = extract(SOURCES);

  it('non-vacuity: the scan reads the tree and extracts real links', () => {
    // No numeric floors: a broken glob or regex reads as zero, and the named
    // targets + stub checks below fail on exactly that. The old `>700` / `>150`
    // / `>180` floors pinned how big the tree is today, not that it was read.
    const targets = new Set(hits.map((h) => h.target));
    for (const known of [
      '/executions/n8n',
      '/library/kag/documents',
      '/repositories/registry',
      '/approvals',
      // projectNavHref subs are seen too (approve page's "↗ architecture" deeplink).
      `/projects/${PROJECT}/architecture/graph`,
    ]) {
      expect(targets.has(known), known).toBe(true);
    }
    // The stub files are recognised (and so skipped): every former hub root.
    expect(STUB_FILES.has('../../../routes/library/kag/+page.ts')).toBe(true);
    expect(STUB_FILES.has('../../../routes/operate/verification/+page.ts')).toBe(true);
  });

  it('every string-literal href / goto / redirect target is a final page', () => {
    expect(offenders(hits)).toEqual([]);
  });

  it('the KAG-host root redirect lands on a real page (one hop, not two)', () => {
    expect(redirectReason(KAG_HUB_PATH)).toBeNull();
  });

  it('self-check: each link shape onto a stub is red; prose, prefixes and real pages are not', () => {
    const bad = extract({
      './x/A.svelte': [
        '<a href="/library/kag">KAG</a>',
        "<a href={'/executions'}>n8n</a>",
        '<a href={`/tools/n8n?execution=${id}`}>run</a>',
        "<script>goto('/library/architecture');</script>",
        "const card = { href: '/repositories' };",
        "throw redirect(308, '/operate/verification');",
        "goto(projectNavHref(projectId, 'assets'));",
      ].join('\n'),
    });
    // (Order = extraction order: pattern by pattern.)
    expect(offenders(bad).map((o) => o.split(' → ')[1]!.split(' ')[0])).toEqual([
      `/projects/${PROJECT}/assets`,
      '/library/kag',
      '/executions',
      '/tools/n8n',
      '/library/architecture',
      '/repositories',
      '/operate/verification',
    ]);
    const fine = extract({
      './x/B.svelte': [
        '<!-- <a href="/library/kag">old hub</a> -->',
        '// goto("/executions")',
        '<a href={`/projects/${id}/assets`}>prefix only</a>',
        '<a href="/library/kag/documents">ok</a>',
        "goto(projectNavHref(projectId, 'architecture/graph'));",
        '<a href="https://example.com/library/kag">external</a>',
      ].join('\n'),
    });
    expect(fine.map((h) => h.target)).toEqual([`/projects/${PROJECT}/architecture/graph`, '/library/kag/documents']);
    expect(offenders(fine)).toEqual([]);
    // A conditionally-redirecting route is checked through its real load().
    expect(redirectReason('/library/requirements')).not.toBeNull();
    expect(redirectReason('/library/triggers')).toBeNull();
    // The project Architecture hub is a final page (2026-10-28), not the old 308.
    expect(redirectReason(`/projects/${PROJECT}/architecture`)).toBeNull();
  });
});
