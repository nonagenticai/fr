// /admin has no content of its own — it is the shell's entry point. 308, not
// 302: the target is permanent (nav standard, 2026-10-03, same as /settings,
// /library, /admin/assets).
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  redirect(308, '/admin/home');
};
