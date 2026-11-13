// /govern/architecture/proposals — formerly the Proposals view (the LLM-mapped
// architecture proposals queue), removed with requirements_management's
// proposals route (RM #238, fr #1649). Kept as a 308 stub so bookmarks and old
// deep links land on the Conformance dashboard instead of a 404 — the same
// destination as the legacy `/govern/architecture?tab=queue`. ?projectId= rides
// along (legacyTabTarget, so the two legacy entry points cannot drift apart).
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TO_DASHBOARD: LegacyTabMap = [['dashboard', '/govern/architecture/dashboard']];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TO_DASHBOARD));
};
