import { redirect } from '@sveltejs/kit';

// Future-canonical IA places the andon-cord control under /operate/. The
// existing super-admin page lives at /admin/andon; alias here so
// CmdK and bookmarks anchored on the new IA resolve.
export const load = () => {
  throw redirect(307, '/admin/andon');
};
