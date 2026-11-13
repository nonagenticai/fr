// /library was a launcher: a card grid of every asset type plus an
// operator-tools grid — a second menu inside a page, duplicating the sidebar.
// Every destination it listed is now a top-level sidebar row (Knowledge zone),
// so the bare
// URL lands on the first Library row. Kept for bookmarks.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/principles');
};
