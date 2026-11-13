// /repositories — formerly an AssetTabs page (Repositories · Analysis), now
// redirect-only (nav standard, owner ruling 2026-10-03: each tab is a route + a
// row in the rail's "Repositories" sub-group). 308 to the repository registry,
// or to the view a legacy `?tab=` names (/tools/coding used ?tab=analysis).
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TABS: LegacyTabMap = [
  ['repositories', '/repositories/registry'],
  ['analysis', '/repositories/analysis'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TABS));
};
