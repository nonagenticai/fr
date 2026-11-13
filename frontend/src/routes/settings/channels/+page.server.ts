// /settings/channels was the old user-prefs page. Plan 2 Task 17 split this:
//   - /channels             → workspace/department channel registry
//   - /settings/communication → Communication settings (notification routing + channel commands)
//
// Server-side redirect keeps any old links (and SSR loads) pointing at the
// new prefs page. The +page.svelte sibling does the same on the client in
// case a route is reached without an SSR pass.
import { redirect } from '@sveltejs/kit';
export const load = () => {
  throw redirect(308, '/settings/communication');
};
