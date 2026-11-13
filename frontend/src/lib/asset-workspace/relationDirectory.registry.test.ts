// @vitest-environment node
//
// relationDirectory.registry.test.ts
//
// The gate that the ORIGINAL defect needed and nobody had.
//
// `type: 'relation'` sat in the `FieldDef` union from Wave 6 with `relationTo`
// beside it and ZERO registered directories, and nothing anywhere said so: a
// field naming a directory that does not exist renders the free-text input
// ALONE — the same uuid box as before, silently. That is the whole reason the
// type was unusable for six waves. `relationDirectoryFor` returning `null` is
// deliberately not an error at runtime (a manifest must not be able to break a
// form), so the only place that "declared but not built" can be caught is here.
//
// Every case names the mutation it kills.

import { describe, it, expect } from 'vitest';
import type { FieldDef } from './manifest';
import { relationDirectoryFor } from './relationDirectory';
import {
  ALL_MANIFEST_ENTRIES,
  DISCOVERED_MANIFESTS,
  MANIFEST_FLOOR,
  MANIFEST_MODULE_COUNT,
  type AnyManifest,
} from '$lib/manifests/tests/allManifests';

/**
 * Every manifest in the tree — DERIVED FROM THE FILESYSTEM, not copied.
 *
 * ⚠️ This was a hand-written 15-entry array, in a file whose whole subject is
 * "every DECLARED relation directory is actually registered". A manifest the
 * array did not name was not declared, as far as this test could tell — so the
 * census's completeness rested on someone remembering to append a line. It now
 * comes from `manifests/tests/allManifests.ts`, the single list of every manifest module.
 *
 * The non-vacuity control below is mandatory with a glob: `import.meta.glob`
 * returns `{}` rather than failing when its pattern goes wrong, and
 * `[].every(...)` is `true`.
 */
const ALL: Array<[string, AnyManifest]> = ALL_MANIFEST_ENTRIES;

/** Every field declared on a manifest's editor AND detail surfaces. */
function fieldsOf(m: AnyManifest): FieldDef<never>[] {
  const out: FieldDef<never>[] = [];
  for (const s of m.editor?.sections ?? []) out.push(...s.fields);
  for (const s of m.detail?.sections ?? []) out.push(...s.fields);
  return out;
}

/** `[manifest, fieldKey, relationTo]` for every `type: 'relation'` declaration. */
const declarations: Array<[string, string, string | undefined]> = ALL.flatMap(
  ([name, m]) =>
    fieldsOf(m)
      .filter((f) => f.type === 'relation')
      .map((f) => [name, String(f.key), f.relationTo] as [string, string, string | undefined]),
);

describe('every declared relation directory is actually registered', () => {
  it('NON-VACUITY CONTROL: the manifest set is mechanically discovered, and it is not empty', () => {
    // The floor that has to exist BEFORE the glob can be trusted more than the
    // hand list it replaced. `import.meta.glob` answers `{}` — no error, no
    // warning — for a pattern it cannot statically analyse, and `declarations`
    // would then be `[]`: `it.each([])` registers NO cases at all, so this file
    // would report a green census having checked nothing. That is strictly worse
    // than a stale list, because a stale list at least still asserts something.
    expect(MANIFEST_MODULE_COUNT).toBeGreaterThanOrEqual(MANIFEST_FLOOR);
    expect(ALL.length).toBeGreaterThanOrEqual(MANIFEST_FLOOR);
    expect(new Set(ALL.map(([n]) => n)).size).toBe(ALL.length);

    // The glob descends into `architecture/`; a pattern that lost its
    // `**` clears a count floor on the top-level files alone.
    const names = ALL.map(([n]) => n);
    for (const expected of ['architecture/views', 'architecture/relationships', 'kag']) {
      expect(names, `${expected} missing from the discovered set`).toContain(expected);
    }

    // Manifest modules only — no test file (an eager glob IMPORTS what it
    // matches, which would graft another suite's `describe`s into this one) and
    // no `_`-prefixed helper.
    expect(
      DISCOVERED_MANIFESTS.filter(
        (d) => /\.test\.ts$/.test(d.module) || /(^|\/)_/.test(d.module.replace(/^\.\//, '')),
      ).map((d) => d.module),
    ).toEqual([]);

    // The census must see the SAME set as `manifests/tests/allManifests.ts`.
    expect(names).toEqual([...names].sort());
  });

  it('the scan finds the relation declarations that exist', () => {
    // POSITIVE CONTROL. Without it the assertion below is vacuous the moment
    // the traversal breaks — `[].every(...)` is `true`, so a `fieldsOf` that
    // returned nothing would report a clean gate over zero subjects. 6 is the
    // count measured on this branch (requirements ×2, decisions ×2,
    // architecture/elements, architecture/relationships); a NEW conversion
    // raises it, which is why this is a floor and not an equality.
    expect(declarations.length).toBeGreaterThanOrEqual(6);
  });

  it('an unregistered key really does resolve to null', () => {
    // POSITIVE CONTROL for the instrument itself: proves the assertion below
    // CAN fail. Without this, `relationDirectoryFor` always returning a loader
    // (e.g. a mutation making it fall back to `loadProjectDirectory` for any
    // key) would make the gate unfailable — and that mutation is exactly the
    // one that would offer fr project names for an activity field.
    expect(relationDirectoryFor('definitely-not-a-registered-directory')).toBeNull();
    expect(relationDirectoryFor(undefined)).toBeNull();
    // ...while the one that IS registered resolves. A negative control alone
    // would also pass against a function that returned null unconditionally.
    expect(relationDirectoryFor('projects')).not.toBeNull();
  });

  it.each(declarations)(
    '%s.%s names a registered directory (%s)',
    (manifestName, fieldKey, relationTo) => {
      // MUTATION KILLED: declaring `type: 'relation', relationTo: 'pmActivities'`
      // (or any other unbuilt key) on a field — including the conversion of
      // `pm/dependencies`' `predecessor_id` / `successor_id` that this PR
      // deliberately did NOT make. The form would render the same uuid text box
      // as before, with no error anywhere: the exact failure mode that kept
      // `relation` unusable for six waves.
      expect(
        relationDirectoryFor(relationTo),
        `${manifestName}.${fieldKey} declares relationTo=${String(relationTo)}, ` +
          'which is not registered in relationDirectory.ts — RelationPicker ' +
          'would silently degrade to a raw uuid input.',
      ).not.toBeNull();
    },
  );
});
