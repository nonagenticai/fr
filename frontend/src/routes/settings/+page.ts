// /settings used to be an index page: a second menu (tab strip + "Plan N" card
// list) inside the page, duplicating sidebar entries. Every settings page is
// now a top-level row in the sidebar's Account group (navConfig `account`
// zone), so the bare URL just lands on the first of them. Kept for bookmarks.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/settings/account');
};
