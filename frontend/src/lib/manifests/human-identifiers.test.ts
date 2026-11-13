// @vitest-environment node
//
// human-identifiers.test.ts
//
// STREAM B3, the census half. "Humans never type or select a uuid — they select
// an identifier that is in HUMAN language like a title" is a PATTERN, not a
// field: 50 of 368 manifest field declarations are id-keyed across 13 of 15
// manifests. This pins the ranked HEAD that was converted, so a later edit
// cannot quietly put a uuid back into a heading or a subtitle.
//
// ⚠️ Scope is deliberately the converted manifests, not all of them. (The
// fifth, pm/dependencies, was retired with fr's PM library pages.) The
// tail was filed, not fixed; asserting over all of them would be a red gate
// describing work nobody agreed to do, which is how a gate gets disabled.

import { describe, it, expect } from 'vitest';
import type { AssetManifest } from '$lib/asset-workspace';
import { kagManifest } from './kag';
import { requirementsManifest } from './requirements';
import { decisionsManifest } from './decisions';
import { secretsManifest } from './secrets';

/**
 * Is this field key an opaque identifier rather than something a human reads?
 *
 * `*_title` / `*_label` are excluded explicitly: `link_label` and
 * `predecessor_title` END in nothing id-shaped, but a naive `includes('id')`
 * would also match `valid`, `width` and — the one that matters —
 * `predecessor_id`'s human twin if it were ever named `predecessor_id_title`.
 */
function isIdKeyed(key: string | undefined): boolean {
  if (!key) return false;
  return key === 'id' || key.endsWith('_id') || key.endsWith('_ids');
}

const CONVERTED: Array<[string, AssetManifest<never>]> = [
  ['kag', kagManifest as unknown as AssetManifest<never>],
  ['requirements', requirementsManifest as unknown as AssetManifest<never>],
  ['decisions', decisionsManifest as unknown as AssetManifest<never>],
  ['secrets', secretsManifest as unknown as AssetManifest<never>],
];

describe('the converted manifests never put an id in a heading or subtitle', () => {
  it.each(CONVERTED)('%s: titleField is human-language', (_name, m) => {
    // MUTATION KILLED: `titleField: 'id'` (kag's original) at any of these.
    expect(isIdKeyed(m.list.titleField)).toBe(false);
  });

  it.each(CONVERTED)('%s: subtitleField is human-language or absent', (_name, m) => {
    // MUTATION KILLED: restoring `subtitleField: 'id'` on requirements /
    // decisions, `'secret_id'` on secrets.
    // ⚠️ kag is the ONE manifest that keeps an id subtitle, deliberately: its
    // title is now the nullable human label, so the uuid is demoted rather than
    // deleted and the page still says which graph node you are on.
    if (_name === 'kag') {
      expect(m.list.subtitleField).toBe('id');
      return;
    }
    expect(isIdKeyed(m.list.subtitleField)).toBe(false);
  });

  it('a nullable titleField is always paired with a fallback', () => {
    // The half that stops the swap trading a uuid for a blank <h1>.
    expect(kagManifest.list.titleField).toBe('label');
    expect(kagManifest.list.titleFallbackField).toBe('id');
  });

  it('POSITIVE CONTROL: the predicate DOES flag id-shaped keys', () => {
    // Without this, `isIdKeyed` returning a constant `false` would make every
    // case above pass while measuring nothing — the vacuous-gate shape.
    expect(isIdKeyed('id')).toBe(true);
    expect(isIdKeyed('secret_id')).toBe(true);
    expect(isIdKeyed('successor_id')).toBe(true);
    expect(isIdKeyed('project_id')).toBe(true);
    expect(isIdKeyed('resource_ids')).toBe(true);
    // …and does NOT flag the human twins the fix introduced.
    expect(isIdKeyed('title')).toBe(false);
    expect(isIdKeyed('label')).toBe(false);
    expect(isIdKeyed('link_label')).toBe(false);
    expect(isIdKeyed('predecessor_title')).toBe(false);
    expect(isIdKeyed('identifier')).toBe(false);
  });

  it('POSITIVE CONTROL: the gate fails on a manifest that regresses', () => {
    // Proves the two `it.each` blocks above can actually go red.
    const regressed = {
      list: { titleField: 'id', subtitleField: 'project_id' },
    } as unknown as AssetManifest<never>;
    expect(isIdKeyed(regressed.list.titleField)).toBe(true);
    expect(isIdKeyed(regressed.list.subtitleField)).toBe(true);
  });
});

describe('the four project_id declaration sites are relations, all four or none', () => {
  it('requirements + decisions declare project_id as a relation on BOTH detail and editor', () => {
    // MUTATION KILLED: flipping three of four back to `type: 'text'`. A partial
    // revert is the dangerous one — the form looks converted on one route and
    // asks for a uuid on the other.
    const sites: Array<[string, AssetManifest<never>]> = [
      ['requirements', requirementsManifest as unknown as AssetManifest<never>],
      ['decisions', decisionsManifest as unknown as AssetManifest<never>],
    ];
    let found = 0;
    for (const [, m] of sites) {
      const groups = [...m.detail.sections, ...(m.editor?.sections ?? [])];
      for (const s of groups) {
        for (const f of s.fields) {
          if (f.key !== 'project_id') continue;
          found += 1;
          expect(f.type).toBe('relation');
          // NOT the `library/pm/projects` manifest — a different upstream store
          // whose ids do not resolve against `project_id`.
          expect(f.relationTo).toBe('projects');
        }
      }
    }
    expect(found).toBe(4);
  });
});
