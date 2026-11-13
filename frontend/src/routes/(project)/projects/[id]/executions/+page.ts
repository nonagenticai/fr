// /projects/[id]/executions — merged into Flow runs (FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 Details / §5 R5):
// the Execution hub's and Project executions' run lists are one list at /projects/[id]/flow-runs, with
// the hub's conveyor failures (start retry) and agent activity below it. Blocked cards and WIP are on
// the Board; the phase rail on the Overview. Redirect-only now.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/projects/${encodeURIComponent(params.id)}/flow-runs`);
};
