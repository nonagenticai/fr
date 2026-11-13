// Tenant scope — tier 2. Workspace admins, and super-admins above them.
//
// Everything here is scoped to the ACTIVE workspace, and so is the authority:
// `auth.hasTenantRole('workspace-admin')` resolves from that workspace's row
// in `user_roles`, the same row the backend gates on. Switching workspace can
// therefore revoke access to this group, which is correct — the same person is
// routinely an admin in one workspace and a plain member in the next.
//
// Super-admins need no role row: George 2026-10-27, a super-admin is
// tenant-admin of every workspace they switch into, and `/api/me/workspaces`
// stamps each row it offers them `workspace-admin` — the same answer the
// backend's tenant-admin gates give. So ONE predicate decides, for everybody,
// and this tier never opens on a workspace whose data calls would 403.
import { browser } from '$app/env';
import { redirect } from '@sveltejs/kit';
import { auth } from '$lib/stores/auth.svelte';
import type { LayoutLoad } from './$types';

export const load: LayoutLoad = async ({ parent }) => {
  if (!browser) return {};

  // `await parent()` is load-bearing, not ceremony. SvelteKit runs layout loads
  // in PARALLEL — a child does NOT wait for its parent unless it asks. The
  // shell guard (../+layout.ts) says outright that "`workspaces.load()` must
  // have resolved before the tenant tier can be judged at all", because
  // `hasTenantRole` reads the workspace row rather than the JWT — but until
  // this await existed, nothing made that ordering true.
  //
  // So on a cold load this tier judged BOTH inputs early: `isSuperAdmin` while
  // `auth.initialize()` was still in flight, and `hasTenantRole` against an
  // unloaded workspace list. Both read false, and every workspace admin
  // bounced to `/admin` → `/admin/home` (measured live 2026-08-28).
  //
  // Awaiting the parent fixes the ordering and reuses its work rather than
  // repeating the init and the fetch.
  await parent();

  if (!auth.hasTenantRole('workspace-admin')) {
    // Straight to /admin/home: /admin is a 308 stub, so '/admin' bounced twice.
    redirect(302, '/admin/home');
  }
  return {};
};
