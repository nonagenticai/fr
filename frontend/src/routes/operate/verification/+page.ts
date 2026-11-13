// /operate/verification — redirect-only (validator A3, nav standard
// 2026-10-03). 308 to the Verification view (the alerts strip; the determinism
// benchmark tab was deleted 2026-11-01 with asset-evaluator), whatever a legacy
// `?tab=` names (the Computed verification view was deleted 2026-11-01 with the
// retired improvement-loop-service; `oracle`/`judge`/`candidates` fall back like
// any unknown id). No gate here on purpose: the view gates in
// VerificationPage.svelte (a private "Not found" for non-super-admins), and a
// 308 to a page that then says "Not found" leaks nothing.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';
import { legacyTabTarget, type LegacyTabMap } from '$lib/nav/legacyTab';

const TABS: LegacyTabMap = [
  ['determinism', '/operate/verification/determinism'],
];

export const load: PageLoad = ({ url }) => {
  throw redirect(308, legacyTabTarget(url, TABS));
};
