// /library/kag — formerly the KAG AssetTabs hub, now redirect-only (nav
// standard, owner ruling 2026-10-03: each tab is its own route + sidebar row in
// the rail's "KAG" sub-group). 308 to the first kind (KAG documents — uploading
// is the primary task, and it was the hub's default tab), or to the route of
// the legacy `?tab=<id>` a bookmark / deep link carries. Tab ids are the hub's
// verbatim (`ingestion` was the Web sources tab).
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const KAG_TABS: LegacyTabMap = [
  ['documents', '/library/kag/documents'],
  ['ingestion', '/library/kag/web-sources'],
  ['media', '/library/kag/media'],
  ['graph', '/library/kag/graph'],
  ['entities', '/library/kag/entities'],
  ['discover', '/library/kag/discover'],
  ['scientific', '/library/kag/scientific'],
  ['text-analysis', '/library/kag/text-analysis'],
  ['ask', '/library/kag/ask'],
  ['health', '/library/kag/health'],
  ['benchmarks', '/library/kag/benchmarks'],
  ['capabilities', '/library/kag/capabilities'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, KAG_TABS));
};
