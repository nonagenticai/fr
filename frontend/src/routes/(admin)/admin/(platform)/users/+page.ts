// /admin/users — render skeleton; in-component $effect gates.
//
// The previous implementation called `getSuperAdminStatus()` here, which
// raced auth.svelte.ts's `initialize()` — on cold reload, auth.token was
// still undefined when `authFetch` ran, the call 401'd, and the page
// short-circuited to 404 even for genuine super-admins. Gate the render
// in the component instead, after `auth.isLoading` flips false.

import type { PageLoad } from './$types';

export const load: PageLoad = async () => ({});
