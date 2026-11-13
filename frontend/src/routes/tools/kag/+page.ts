import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The KAG ingestion surface was re-homed into the KAG knowledge hub during the
// /tools dissolution (control-plane roadmap Phase 2) and is now its own route,
// /library/kag/web-sources (nav standard 2026-10-03). 308 keeps old deep links.
export const load: PageLoad = () => {
  throw redirect(308, '/library/kag/web-sources');
};
