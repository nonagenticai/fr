// Test-only instrument: the SvelteKit route tree read off disk, and the
// redirect-stub detector that tells a real page from a 308 stub.
//
// Shared by navConfig.test.ts ("no rail row targets a redirect") and
// no-links-to-redirects.test.ts ("no in-app link targets a redirect") so the
// two rules cannot drift onto different definitions of "redirect-only". NOT
// imported by app code — the eager raw globs below would ship every route's
// source in the bundle.
import { load as libraryTypeLoad } from '../../../routes/library/[type]/+page';
import { load as rootLoad } from '../../../routes/+page';
import { load as projectArchitectureLoad } from '../../../routes/(project)/projects/[id]/architecture/+page';

export const SVELTE_PAGES: readonly string[] = Object.keys(import.meta.glob('../../../routes/**/+page.svelte'));
export const TS_PAGES = import.meta.glob('../../../routes/**/+page.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;
export const SERVER_PAGES = import.meta.glob('../../../routes/**/+page.server.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** '../../../routes/(admin)/admin/(platform)/assets/+page.ts' → '/admin/assets' */
export function routeIdOf(file: string): string {
  const rel = file.replace(/^(?:\.\.\/)+routes/, '').replace(/\/\+page(\.server)?\.(svelte|ts)$/, '');
  const segs = rel.split('/').filter((s) => s.length > 0 && !/^\(.*\)$/.test(s));
  return '/' + segs.join('/');
}

export interface Route {
  id: string;
  hasSvelte: boolean;
  /** +page.ts contains `redirect(`. */
  universalRedirects: boolean;
  /** +page.server.ts contains `redirect(`. */
  serverRedirects: boolean;
}

export const ROUTES: Map<string, Route> = new Map();
const upsert = (id: string, patch: Partial<Route>): void => {
  const prev = ROUTES.get(id) ?? { id, hasSvelte: false, universalRedirects: false, serverRedirects: false };
  ROUTES.set(id, { ...prev, ...patch });
};
for (const f of SVELTE_PAGES) upsert(routeIdOf(f), { hasSvelte: true });
for (const [f, src] of Object.entries(TS_PAGES)) upsert(routeIdOf(f), { universalRedirects: /\bredirect\(/.test(src) });
for (const [f, src] of Object.entries(SERVER_PAGES)) upsert(routeIdOf(f), { serverRedirects: /\bredirect\(/.test(src) });

/** The source files that ARE redirect stubs (their own maps name old paths on purpose). */
export const STUB_FILES: ReadonlySet<string> = new Set(
  [...Object.keys(TS_PAGES), ...Object.keys(SERVER_PAGES)].filter((f) => {
    const r = ROUTES.get(routeIdOf(f));
    return r !== undefined && isRedirectOnly(r);
  }),
);

/**
 * Redirect-only: no page component and a redirecting load, OR a redirecting
 * SERVER load (it runs on every navigation, so a component beside it — e.g.
 * /settings/channels' client-side fallback — never gets to be the page).
 * ⚠️ Heuristic: a `redirect(` anywhere in the file counts. Every +page.server.ts
 * in the tree today redirects unconditionally; a future conditional one would
 * read as redirect-only here — the safe direction for a "never link a
 * redirect" rule.
 */
export function isRedirectOnly(r: Route): boolean {
  return (!r.hasSvelte && r.universalRedirects) || r.serverRedirects;
}

/** Segment matcher: `[x]` matches one segment, `[[x]]` zero or one, `[...x]` one or more. */
export function matches(routeId: string, path: string): boolean {
  const r = routeId.split('/').filter(Boolean);
  const p = path.split('?')[0]!.split('#')[0]!.split('/').filter(Boolean);
  const walk = (i: number, j: number): boolean => {
    if (i === r.length) return j === p.length;
    const seg = r[i]!;
    if (/^\[\.\.\..+\]$/.test(seg)) {
      for (let k = j + 1; k <= p.length; k++) if (walk(i + 1, k)) return true;
      return false;
    }
    if (/^\[\[.+\]\]$/.test(seg)) return walk(i + 1, j) || (j < p.length && walk(i + 1, j + 1));
    if (j >= p.length) return false;
    if (/^\[.+\]$/.test(seg)) return walk(i + 1, j + 1);
    return seg === p[j] && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

const paramCount = (id: string): number => (id.match(/\[/g) ?? []).length;

/** The route SvelteKit would pick: a match with the fewest params (static beats dynamic). */
export function resolve(path: string): Route | null {
  const hits = [...ROUTES.values()].filter((r) => matches(r.id, path));
  hits.sort((a, b) => paramCount(a.id) - paramCount(b.id));
  return hits[0] ?? null;
}

export function paramsOf(routeId: string, path: string): Record<string, string> {
  const r = routeId.split('/').filter(Boolean);
  const p = path.split('?')[0]!.split('/').filter(Boolean);
  const out: Record<string, string> = {};
  r.forEach((seg, i) => {
    const m = /^\[([^\].]+)\]$/.exec(seg);
    if (m) out[m[1]!] = p[i]!;
  });
  return out;
}

// ⛔ A route with a page component AND a redirecting +page.ts is not
// redirect-only — but its load may still 308 SOME params away (/library/[type]
// sends the governance slugs to /{plural}). Callers run the route's REAL load()
// with the link's params and require that it does not redirect.
export const CONDITIONAL_LOADS: Record<string, (params: Record<string, string>) => unknown> = {
  '/library/[type]': (params) => libraryTypeLoad({ params } as never),
  // `/` 307s only on the KAG product host; the fr app is served on fr hosts.
  '/': () => rootLoad({ url: new URL('https://fr.nonagentic.ai/') } as never),
  // The project Architecture hub 308s only a legacy `?tab=` (in-app links never carry one).
  '/projects/[id]/architecture': (params) =>
    projectArchitectureLoad({ params, url: new URL(`https://fr.nonagentic.ai/projects/${params.id}/architecture`) } as never),
};

/**
 * Why `path` lands on a redirect, or null when it is a final page (or no route
 * at all — a dead link is a different rule's business). Throws when a route
 * redirects conditionally and has no CONDITIONAL_LOADS entry, so a new one
 * cannot be silently waved through.
 */
export function redirectReason(path: string): string | null {
  const r = resolve(path);
  if (r === null) return null;
  if (isRedirectOnly(r)) return `redirect-only route ${r.id}`;
  if (r.hasSvelte && r.universalRedirects) {
    const load = CONDITIONAL_LOADS[r.id];
    if (!load) throw new Error(`${path}: ${r.id} redirects conditionally — add its load() to CONDITIONAL_LOADS`);
    try {
      load(paramsOf(r.id, path));
    } catch (e) {
      const st = (e as { status?: number }).status;
      if (st && st >= 300 && st < 400) return `load() ${st} → ${(e as { location?: string }).location}`;
      throw e;
    }
  }
  return null;
}
