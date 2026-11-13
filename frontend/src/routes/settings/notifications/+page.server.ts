// /settings/notifications was renamed to /settings/communication (2026-10-30).
// Server-side redirect keeps old links and bookmarks working; the +page.svelte
// sibling does the same on the client in case a route is reached without SSR.
import { redirect } from '@sveltejs/kit';
export const load = () => {
  throw redirect(308, '/settings/communication');
};
