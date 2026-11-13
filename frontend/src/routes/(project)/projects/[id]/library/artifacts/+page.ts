// /projects/[id]/library/artifacts rendered the same bound-artifact list
// (ProjectLibraryTab kind="artifact") as /projects/[id]/artifacts, the
// project sidebar's Inspect `artifacts` row. Two URLs for one page is a
// duplicate row waiting to happen, so this one is a 308 to the canonical row.
// Kept for bookmarks.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = ({ params }) => {
  throw redirect(308, `/projects/${encodeURIComponent(params.id)}/artifacts`);
};
