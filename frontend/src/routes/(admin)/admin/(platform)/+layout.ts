// Platform scope — tier 2. Super-admin only.
//
// Fleet-wide surfaces: the licence registry, pricing, cross-tenant metering,
// user provisioning, the andon cord and the shared asset library. A workspace
// admin reaching one of these is sent to the admin home rather than to `/`, so
// the tier they DO have stays one click away.
//
// This is UI shell only. Every endpoint behind these pages re-gates on the
// server (`gated()` in routes/admin/licenses-admin.ts is super-admin-or-403),
// so a forged claim buys a rendered page and nothing else.
import { browser } from '$app/env';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/stores/auth.svelte';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent }) => {
  if (!browser) return {};

  // `await parent()` is load-bearing, not ceremony. SvelteKit runs layout loads
  // in PARALLEL — a child does NOT wait for its parent unless it asks. Without
  // this, the tier ran concurrently with the shell guard and judged
  // `isSuperAdmin` while `auth.initialize()` was still in flight, i.e. while it
  // was still its initial `false`. Every cold load of a platform page — a
  // bookmark, a refresh, a pasted URL — therefore bounced to `/admin`, which
  // redirects to `/admin/home`.
  //
  // Measured live 2026-08-28 on `/admin/andon`, `/admin/licenses` and
  // `/admin/tenants`: all three produced
  //   /admin/<path> → /admin → /admin/home
  // and, when signed out, that second navigation ABORTED the correct Keycloak
  // redirect and replaced its `redirect_uri` with `/admin/home`.
  //
  // The shell guard (../+layout.ts) already awaits `auth.ensureInitialized()`
  // and `workspaces.load()`, so awaiting the parent both fixes the ordering and
  // reuses that work rather than repeating it.
  await parent();

  // Straight to /admin/home: /admin is a 308 stub, so '/admin' bounced twice.
  if (!auth.isSuperAdmin) redirect(302, '/admin/home');
  return {};
};
