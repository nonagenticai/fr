// /admin/budget — render skeleton; the component loads client-side.
//
// No-op loader: the budget/topup calls use `authFetch` which needs the browser
// Keycloak token, so they must run after the auth store hydrates — never from
// an SSR `load()` on the Node side.

import type { PageLoad } from './$types';

export const load: PageLoad = async () => ({});
