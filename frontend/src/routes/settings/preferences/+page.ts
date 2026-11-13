// /settings/preferences held only the theme toggle, which /settings/account
// already renders. Kept as a redirect so old links still land somewhere useful.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/settings/account');
};
