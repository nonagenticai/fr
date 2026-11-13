import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Single-draft bridge view was re-homed to /bridge/:id during the /tools
// dissolution (control-plane roadmap Phase 3). 308 preserves both the draft id
// and the `?project=` scope so approval-notification deep links keep resolving.
export const load: PageLoad = ({ params, url }) => {
  throw redirect(308, `/bridge/${params.id}${url.search}`);
};
