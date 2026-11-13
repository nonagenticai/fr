// /projects/[id]/threads — merged into Needs you (FR-PROJECT-HOME-REDESIGN §3 / §5 R4): every open ask,
// sign-off and review on the project, oldest first and answerable inline, with the decided history
// below and the caller's project conversations in their own section.
// Redirect-only now. /projects/[id]/threads/[threadId] (one conversation) is unchanged.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/projects/${encodeURIComponent(params.id)}/needs-you`);
};
