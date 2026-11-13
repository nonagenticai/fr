// Admin shell gate — tier 1 of 3.
//
// Admits anyone with EITHER tier; the nested `(platform)` and `(tenant)`
// layouts narrow from here. Client-only, because the auth store and the
// workspace list are browser state: on the server there is no token to read,
// and returning early lets the page render its shell rather than 500.
//
// Ordering matters. `workspaces.load()` must have resolved before the tenant
// tier can be judged at all — the caller's workspace-admin role arrives from
// `GET /api/me/workspaces`, not from the JWT (there is no `workspace-admin`
// realm role; see stores/auth.svelte.ts). Gating before that resolves would
// bounce every workspace admin on a cold load.
import { browser } from '$app/environment';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/stores/auth.svelte';
import { workspaces } from '$lib/stores/workspaces.svelte';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ url }) => {
  if (!browser) return {};

  // Wait for auth BEFORE judging it. `initialize()` is kicked off by the root
  // +layout's onMount, which SvelteKit runs AFTER every load — so on a cold
  // load (bookmark, refresh, pasted URL) `isAuthenticated` is still its initial
  // `false` here and this guard bounced a legitimate admin to /login, which
  // then dropped `?next` and dumped them on /dashboard. Clicking in-app worked,
  // which is exactly why it read as "half the admin pages don't load".
  await auth.ensureInitialized();

  if (!auth.isAuthenticated) {
    redirect(302, `/login?next=${encodeURIComponent(url.pathname + url.search)}`);
  }

  if (!workspaces.loaded) {
    await workspaces.load();
  }

  if (!auth.isSuperAdmin && !auth.hasTenantRole('workspace-admin')) {
    redirect(302, '/');
  }

  return {};
};
