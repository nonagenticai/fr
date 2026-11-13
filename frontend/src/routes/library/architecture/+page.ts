// /library/architecture — formerly the Architecture AssetTabs hub, now redirect-only (nav
// standard, owner ruling 2026-10-03: tab hubs are not exempt — each kind is its
// own list route and a row in the rail's "Architecture" sub-group). 308 to the first
// kind, or to the kind a legacy `?tab=<id>` names (tab ids == route slugs).
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TABS: LegacyTabMap = [
  ['elements', '/library/architecture/elements'],
  ['relationships', '/library/architecture/relationships'],
  ['views', '/library/architecture/views'],
  ['standards', '/library/architecture/standards'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TABS));
};
