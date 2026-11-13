// /executions — formerly an AssetTabs page (n8n · Activity), now redirect-only
// (nav standard, owner ruling 2026-10-03: each tab is a route + a row in the
// rail's "Executions" sub-group). 308 to n8n executions, or to the view a legacy
// `?tab=` names; other params (e.g. a /tools/n8n deep link's) ride along.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TABS: LegacyTabMap = [
  ['n8n', '/executions/n8n'],
  ['activity', '/executions/activity'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TABS));
};
