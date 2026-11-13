import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

// Coding-analysis job detail was re-homed to /repositories/jobs/:id during the
// /tools dissolution (control-plane roadmap Phase 3). 308 preserves the job id
// so approval/notification deep links keep resolving.
export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/repositories/jobs/${params.id}`);
};
