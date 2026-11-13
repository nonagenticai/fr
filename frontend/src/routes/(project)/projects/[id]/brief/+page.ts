// /projects/[id]/brief — merged into Plan & scope (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 / §5 R6):
// the brief's current text, its version list and the diff between versions are the first section of
// /projects/[id]/plan, beside the acceptance criteria, capabilities, milestones and risks.
// Redirect-only now.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/projects/${encodeURIComponent(params.id)}/plan`);
};
