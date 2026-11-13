// /admin/billing — render skeleton; the component loads client-side.
//
// No-op loader, like ../budget/+page.ts: the billing read uses `authFetch`,
// which needs the browser Keycloak token, so it runs after the auth store
// hydrates — never from an SSR `load()`. The workspace-admin / super-admin
// gate is inherited from ../+layout.ts; the backend re-checks it.

import type { PageLoad } from './$types';

export const load: PageLoad = async () => ({});
