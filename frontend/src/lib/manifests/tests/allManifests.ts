// tests/allManifests.ts (test-only census helper)
//
// THE MANIFEST SET, DERIVED FROM THE FILESYSTEM — not copied into a list.
//
// ## The hole this closes
//
// `asset-workspace/relationDirectory.registry.test.ts` is a census over
// "every manifest in the tree", and said so in a docstring while keeping a
// HAND-COPIED 15-entry array. The ratchet's own comment named the defect it was
// committing — *"a ratchet over a subset of the manifests would be a ratchet a
// new manifest can be added OUTSIDE of, which is the hole it exists to close"* —
// and then closed it with a subset that a 16th file is simply absent from.
//
// Measured before this module existed: `grep -rl "import.meta.glob\|readdirSync"`
// over `src/lib/manifests` and `src/lib/asset-workspace` returned **0**. So a new
// manifest declaring `relationTo: 'projects'` over the `pm_projects` id space
// (which resolves 0 of 216 against fr's `projects` table) passed BOTH tests: the
// key is registered, so the registry sweep is happy, and the file is not in
// either array, so the ratchet never sees it.
//
// `backend/tests/unit/routes/assets/project-scope-caller-census.test.ts` already
// does its census mechanically. This is the same pattern on the frontend side.
//
// ## Why `import.meta.glob` and not `readdirSync`
//
// In-repo precedent: `lib/layout/pageTitle.test.ts` globs `routes/**/+page.svelte`
// to prove TITLES covers every route. `readdirSync` would need a real cwd and
// would not give the module objects; the glob is resolved by Vite at transform
// time and works in the `node` environment both censuses run under.
//
// ⚠️ THE PATTERN MUST STAY A LITERAL. Vite statically analyses the argument to
// `import.meta.glob`; hoisting it into a `const` makes it un-analysable and the
// glob silently returns `{}` — which reads as a clean pass over zero subjects,
// the exact vacuous-gate shape these censuses exist to avoid. Measured while
// building this: a pattern written relative to the wrong directory returned `[]`
// and the probe's `toBeGreaterThan(0)` was the only thing that caught it. Hence
// `MANIFEST_MODULE_COUNT` below, and the non-vacuity floor each consumer asserts.
//
// ⚠️ The three exclusions are load-bearing, not tidiness:
//   - `!./**/*.test.ts` — an eager glob IMPORTS what it matches. Pulling a test
//     module in here would register its `describe` blocks inside whatever suite
//     imported this file.
//   - `!./**/_*.ts` — `_fmt.ts` is a helper, not a manifest,
//     and `!../tests/**` excludes this file ITSELF (no recursive import).

import type { AssetManifest } from '$lib/asset-workspace/manifest';

export type AnyManifest = AssetManifest<never>;

// Globbed from the manifests dir (this file lives in its `tests/` subdir, which
// is excluded), then re-keyed to `./<path>` so names match the manifests root.
const MODULES: Record<string, Record<string, unknown>> = Object.fromEntries(
  Object.entries(
    import.meta.glob<Record<string, unknown>>(
      ['../**/*.ts', '!../**/*.test.ts', '!../**/_*.ts', '!../tests/**'],
      { eager: true },
    ),
  ).map(([k, v]) => [k.replace(/^\.\.\//, './'), v]),
);

/**
 * How many manifest MODULES the glob matched.
 *
 * Exported so a consumer can floor it independently of how many manifests were
 * recognised inside them: a glob that found nothing and a duck-type that
 * recognised nothing are different failures and must not share one number.
 */
export const MANIFEST_MODULE_COUNT = Object.keys(MODULES).length;

/**
 * Structural test for a manifest, rather than trusting the export NAME.
 *
 * Keying on `/Manifest$/` alone would let a renamed export vanish from every
 * census silently — the same class of hole as the hand-copied list. These are
 * the fields `AssetManifest` declares as required, so a real manifest cannot
 * fail this and a helper cannot pass it.
 */
function isManifest(v: unknown): v is AnyManifest {
  if (typeof v !== 'object' || v === null) return false;
  const m = v as Record<string, unknown>;
  return (
    typeof m.name === 'string' &&
    typeof m.singular === 'string' &&
    typeof m.plural === 'string' &&
    typeof m.group === 'string' &&
    typeof m.api === 'object' &&
    m.api !== null &&
    typeof m.list === 'object' &&
    m.list !== null &&
    typeof (m.list as Record<string, unknown>).titleField === 'string'
  );
}

/**
 * `'./architecture/views.ts'` → `'architecture/views'`.
 *
 * Chosen to reproduce the names the two hand-written lists used, so the census
 * output — and therefore the ratchet's allowlist — is unchanged by the switch to
 * a mechanical source. A rename here is a silent allowlist rewrite.
 */
function nameFromPath(path: string): string {
  return path.replace(/^\.\//, '').replace(/\.ts$/, '');
}

export interface DiscoveredManifest {
  /** Path-derived identity, e.g. `architecture/elements`. */
  name: string;
  /** The glob key, e.g. `./architecture/elements.ts`. */
  module: string;
  /** The export the manifest was found under, e.g. `architectureElementsManifest`. */
  exportName: string;
  manifest: AnyManifest;
}

export const DISCOVERED_MANIFESTS: DiscoveredManifest[] = Object.entries(MODULES)
  .flatMap(([module, mod]) =>
    Object.entries(mod)
      .filter(([, v]) => isManifest(v))
      .map(([exportName, v]) => ({
        name: nameFromPath(module),
        module,
        exportName,
        manifest: v as AnyManifest,
      })),
  )
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

/**
 * The shape both censuses consume: `[name, manifest]`, identical to the arrays
 * they used to hand-maintain.
 */
export const ALL_MANIFEST_ENTRIES: Array<[string, AnyManifest]> =
  DISCOVERED_MANIFESTS.map((d) => [d.name, d.manifest]);

/**
 * The floor every consumer asserts.
 *
 * 9 is MEASURED on this branch: kag, requirements, decisions, principles,
 * secrets, architecture/{elements,relationships,views,standards}
 * (the five pm/* manifests were retired with fr's PM library pages, and the
 * procedures manifest with the procedures asset type). A floor, not an
 * equality — a new manifest must RAISE the census, never red this line, or the
 * mechanical source would be as obstructive as the hand list it replaces.
 */
export const MANIFEST_FLOOR = 9;
