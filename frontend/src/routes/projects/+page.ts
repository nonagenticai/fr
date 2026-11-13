// The project portfolio lives on the tenant home (`/`). This keeps old links working.
import { redirect } from '@sveltejs/kit';
import type { PageLoad } from './$types';

export const load: PageLoad = () => {
  throw redirect(308, '/');
};
