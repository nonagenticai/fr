// /kag/entities was a manifest-driven AssetWorkspace LIST over
// `GET /api/assets/kag/entities` (list + get only; kagManifest declares no
// create/update/remove). It had no sidebar row and no in-app link. /library/kag/entities
// (KAG entities, KagEntitiesTab.svelte — formerly a KAG hub tab) lists the
// SAME endpoint, adds a server-side type facet, and opens the richer
// KagNodeDetailPanel — so this route is superseded and 308s there (nav standard,
// fr#1331, 2026-10-03). /kag/entities/[id] (the per-entity detail) is untouched.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/library/kag/entities');
};
