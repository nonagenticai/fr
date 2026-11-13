import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// The analysis→kanban bridge was re-homed to /bridge during the /tools
// dissolution (control-plane roadmap Phase 3). 308 preserves the `?project=`
// scope so PromoteButton + notification deep links keep working.
export const load: PageLoad = ({ url }) => {
  throw redirect(308, `/bridge${url.search}`);
};
