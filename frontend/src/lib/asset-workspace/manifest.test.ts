// asset-workspace/manifest.test.ts
//
// Pure helpers of the AssetManifest contract: route building and the shared
// row-title chain. (The former type-fixture block built manifests with fake
// api/related fetchers; removed under the no-test-doubles ruling 2026-10-29 —
// `svelte-check` validates the manifest shape against every real manifest.)

import { describe, it, expect } from 'vitest';
import type { AssetManifest } from './manifest';

// Validator N3 (2026-10-03): item links were `/${manifest.name}/<id>`, which for
// KAG entities built /kag/<id> — no such route. The manifest now names its
// item base and its list page; the defaults keep every other manifest unchanged.
describe('asset route helpers', () => {
  it('default: /<name>/<id> and /<name> (unchanged for ordinary manifests)', async () => {
    const { assetItemHref, assetListHref, assetRouteBase } = await import('./manifest');
    expect(assetRouteBase({ name: 'workers' })).toBe('/workers');
    expect(assetItemHref({ name: 'workers' }, 'a b')).toBe('/workers/a%20b');
    expect(assetListHref({ name: 'workers' })).toBe('/workers');
  });

  it('KAG entities: items at /kag/entities/<id>, list at the KAG entities row (never a redirect stub)', async () => {
    const { assetItemHref, assetListHref } = await import('./manifest');
    const { kagManifest } = await import('$lib/manifests/kag');
    expect(assetItemHref(kagManifest, 'e1')).toBe('/kag/entities/e1');
    expect(assetListHref(kagManifest)).toBe('/library/kag/entities');
  });
});

describe('resolveRowTitle (the shared title chain)', () => {
  // The only direct unit test of this helper. MUTATION KILLED: reordering the
  // rungs, or dropping the trim so that a whitespace title counts as present.
  const m = {
    idField: 'id',
    list: { titleField: 'title', titleFallbackField: 'slug', columns: [] },
  } as unknown as Pick<AssetManifest<never>, 'list' | 'idField'>;

  it('degrades title -> slug -> id, and only then to blank', async () => {
    const { resolveRowTitle } = await import('./manifest');
    expect(resolveRowTitle({ title: 'Cutover', slug: 's', id: 'i' } as never, m)).toBe('Cutover');
    expect(resolveRowTitle({ title: '   ', slug: 's', id: 'i' } as never, m)).toBe('s');
    expect(resolveRowTitle({ title: null, slug: '  ', id: 'i' } as never, m)).toBe('i');
    expect(resolveRowTitle({ title: null, slug: null, id: null } as never, m)).toBe('');
  });
});
