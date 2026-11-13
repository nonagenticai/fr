// /admin/assets was a launcher: a tile grid of the six asset kinds, i.e. a
// second menu inside a page. Each kind is now its own Administration row in the
// sidebar (navConfig `administration` zone, super-admin gated — nav standard,
// 2026-10-03), so the bare URL lands on the first of them. Kept for bookmarks.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/admin/assets/principles');
};
