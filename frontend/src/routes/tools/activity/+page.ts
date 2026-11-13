import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The activity feed was re-homed during the /tools dissolution (control-plane
// roadmap Phase 3) and is now its own route, /executions/activity (nav
// standard 2026-10-03). 308 keeps old deep links working.
export const load: PageLoad = () => {
  throw redirect(308, '/executions/activity');
};
