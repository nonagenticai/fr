// /govern/architecture — formerly the Architecture Governance AssetTabs page,
// now redirect-only (nav standard, owner ruling 2026-10-03: its Dashboard /
// Graph tabs are routes + rows in the rail's "Conformance" sub-group). 308 to
// the dashboard, or to the view a legacy `?tab=` names. `queue` was the
// Proposals tab, removed with requirements_management's proposals route
// (RM #238): it lands on the dashboard. ?projectId= rides along.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TABS: LegacyTabMap = [
  ['dashboard', '/govern/architecture/dashboard'],
  ['graph', '/govern/architecture/graph'],
  ['queue', '/govern/architecture/dashboard'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TABS));
};
