// Shape + CRUD contract for the architecture manifests (control-plane
// roadmap Phase 4 read + Phase 5 editor). Phase 5 wired create/update/remove +
// an editor surface on all four, with one upstream-driven exception:
// architecture *relationships* are immutable (no update builder upstream), so
// that manifest exposes create + remove only (no `api.update`, no edit route).
// The names are multi-segment slugs so AssetWorkspace's `/<name>/<id>` detail
// link lands on the per-family route under /library/<domain>/<family>.

import { describe, it, expect } from 'vitest';
import type { AssetManifest } from '$lib/asset-workspace';
import { architectureElementsManifest } from './architecture/elements';
import { architectureRelationshipsManifest } from './architecture/relationships';
import { architectureViewsManifest } from './architecture/views';
import { architectureStandardsManifest } from './architecture/standards';

// [label, manifest, expectedName, supportsUpdate]
const manifests: Array<[string, AssetManifest<{ id: string }>, string, boolean]> = [
  ['architecture/elements', architectureElementsManifest, 'library/architecture/elements', true],
  [
    'architecture/relationships',
    architectureRelationshipsManifest,
    'library/architecture/relationships',
    false,
  ],
  ['architecture/views', architectureViewsManifest, 'library/architecture/views', true],
  ['architecture/standards', architectureStandardsManifest, 'library/architecture/standards', true],
] as unknown as Array<[string, AssetManifest<{ id: string }>, string, boolean]>;

describe('architecture manifests (Phase 5, CRUD)', () => {
  for (const [label, m, expectedName, supportsUpdate] of manifests) {
    describe(label, () => {
      it('uses the canonical multi-segment library name', () => {
        expect(m.name).toBe(expectedName);
      });

      it('is a Knowledge-zone asset', () => {
        expect(m.group).toBe('knowledge');
      });

      it('exposes the read + create + remove verbs', () => {
        expect(typeof m.api.list).toBe('function');
        expect(typeof m.api.get).toBe('function');
        expect(typeof m.api.create).toBe('function');
        expect(typeof m.api.remove).toBe('function');
      });

      it(`${supportsUpdate ? 'exposes' : 'omits'} the update verb`, () => {
        if (supportsUpdate) {
          expect(typeof m.api.update).toBe('function');
        } else {
          // Relationships are immutable upstream — no update verb / edit route.
          expect(m.api.update).toBeUndefined();
        }
      });

      it('declares list columns + a title field and detail sections', () => {
        expect(m.list.columns.length).toBeGreaterThan(0);
        expect(m.list.titleField).toBeTruthy();
        expect(m.detail.sections.length).toBeGreaterThan(0);
        for (const s of m.detail.sections) {
          expect(s.fields.length).toBeGreaterThan(0);
        }
      });

      it('declares an editor surface with at least one required field', () => {
        expect(m.editor?.sections?.length ?? 0).toBeGreaterThan(0);
        const allFields = (m.editor?.sections ?? []).flatMap((s) => s.fields);
        expect(allFields.length).toBeGreaterThan(0);
        expect(allFields.some((f) => f.required)).toBe(true);
      });

      it('does not use a scope picker (architecture is tenant-scoped)', () => {
        expect(m.editor?.scopePicker).toBeUndefined();
      });
    });
  }
});
