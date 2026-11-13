// /projects/[id]/approvals — merged into Needs you (FR-PROJECT-HOME-REDESIGN §3 / §5 R4): every open ask,
// sign-off and review on the project, oldest first and answerable inline, with the decided history
// below.
// Redirect-only now. The decide pages (/projects/[id]/approve/[approvalId], /approvals/[id]) are unchanged.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/projects/${encodeURIComponent(params.id)}/needs-you`);
};
