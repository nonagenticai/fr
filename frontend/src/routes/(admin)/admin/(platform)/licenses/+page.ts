// /admin/licenses — render skeleton; the section +layout.svelte gates.
//
// Deliberately a no-op, matching /admin/users/+page.ts: gating
// in `load()` races auth.svelte.ts's `initialize()` — on a cold reload
// `auth.token` is still undefined when `authFetch` runs, the call 401s, and the
// page short-circuits to 404 for genuine super-admins. The gate lives in the
// section layout's `$effect`, after `auth.isLoading` flips false.

import type { PageLoad } from './$types';

export const load: PageLoad = async () => ({});
