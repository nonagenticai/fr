// src/lib/actions/switchTenant.ts
//
// Tenant switch. Driven by WorkspaceSwitcher's <select> and by the command
// palette (Tenants section).
//
// Lives ABOVE the stores it orchestrates (nothing imports it back) so it can
// pull in `$app/navigation` + the kanban/activity/navCounts singletons without
// creating an import cycle. Critically, `auth-fetch.ts` is NOT touched: it
// reads `localStorage('fr.active_tenant')` live on every request, so once
// `workspaces.setActive(id)` has persisted the new id (step 1), every fetch
// fired after that already carries the new X-Active-Tenant.
//
// ⛔ THE DEFECT THIS FILE WAS THE CAUSE OF — read before making the switch
// "reload-free" again. This function used to end, on any route whose pattern
// carries no [param], at `invalidateAll()`. That reaches ONLY routes with a
// SvelteKit `load()` — about two of the app's 168. Every other surface had to
// opt in individually with a `$effect` keyed on `workspaces.scopeKey`
// (/approvals+page.svelte and the five admin assets pages did; nothing else
// did), so the switch was correct only for an ENUMERATED set and silently inert
// everywhere else. That is fail-OPEN: a route added, or refactored off its
// $effect, rejoins the bug with no signal.
//
// Measured on https://fr.nonagentic.ai 2026-09-10 (sweep artifacts
// interact.shard-{2,4}-of-4.json), driving this very <select> to
// `WF · workflow-improvement` as super-admin fr-test:
//   /admin/andon 287→287 · /admin/licenses 258→258 · /decisions 200→200 ·
//   /engagements/deliveries 100→100 · /library/artifacts 50→50 ·
//   /admin/metering 41→41 · /admin/tenant-budgets 26→26 · /admin/budget 8→8 ·
//   /admin/licenses/offerings 4→4 · /inference-quality 9→9 (+5 more at 0 rows)
// — identical rowCount, identical headHash AND identical firstRow, i.e. no
// refetch at all. 15 of the sweep's 22 inert filters were this one control.
// POSITIVE CONTROL, same session, same click: /admin/assets/decisions went
// 200→0 and /admin/assets/requirements 100→0. So the header IS sent and IS
// honoured — the header hop and the super-admin gate are both fine. The only
// broken hop was that nothing re-fetched.
//
// The fix is the `mustLeave` split below. A route CHANGE already worked
// (SvelteKit remounts the page component, so its onMount fetch re-runs with the
// new header — the sweep shows every /projects/[id]/* switch landing on a
// rebuilt '/'). Staying on the SAME route does not remount anything, and that
// is the whole bug — so staying put now rebuilds the document instead.

import { get } from 'svelte/store';
import { page } from '$app/stores';
import { goto, invalidateAll } from '$app/navigation';
import { workspaces } from '$lib/stores/workspaces.svelte';
import { kanbanStore } from '$lib/stores/kanbanStore.svelte';
import { activeProject } from '$lib/stores/activeProject.svelte';
import { activityStore } from '$lib/stores/activityStore.svelte';
import { auth } from '$lib/stores/auth.svelte';
import { agentSession } from '$lib/stores/agentSession.svelte';
import { rebuildDocument } from '$lib/actions/documentRebuild';
import { hasUnsavedWork, confirmDiscardUnsaved } from '$lib/stores/unsavedWork';

// Bound for the workspace-identity refresh in step 7 below. Kept local to
// this ONE call site on purpose: `auth-fetch.ts`'s `authFetch` has no timeout
// of its own, and adding one there would bound every one of its ~114 other
// callers for the sake of this single deliberate, rare action.
const WORKSPACE_REFRESH_TIMEOUT_MS = 5_000;

// A route is "entity-scoped" if its pattern carries a [param] / [...rest]
// segment — its id belongs to the old tenant and 404s in the new one. `/kanban`
// holds a board in component-local state (no [id] in the pattern) so it needs
// leaving too. Everything else (collections, dashboards) we stay put and let
// the keyed $effects refetch in place.
const DYNAMIC_SEGMENT = /\[[^\]]+\]/;

/** Should we navigate to a tenant-neutral base for this route on a switch? */
export function routeNeedsLeave(routeId: string | null): boolean {
  if (!routeId) return false;
  return DYNAMIC_SEGMENT.test(routeId) || routeId === '/kanban';
}

/**
 * Switch the active tenant. Ordering matters:
 *   1. persist the new id FIRST (so all later fetches use the new header);
 *   2. if any surface holds unsaved input, ask before destroying it;
 *   3. decide whether this route can stay put;
 *   4. staying put → rebuild the document, because nothing else re-fetches;
 *   5. leaving → tear down tenant-scoped singletons, re-run load()s, navigate
 *      off the dead entity route (its id won't exist in the new tenant), and
 *      nudge the self-healing pollers so the user doesn't wait out the cadence.
 */
export async function switchTenant(id: string): Promise<void> {
  if (id === workspaces.activeId) return;

  // Captured for the decline path in step 2, BEFORE step 1 overwrites it.
  const previousId = workspaces.activeId;

  // 1. Persist first — authFetch reads localStorage live per request, and the
  //    document rebuild in step 4 boots from this same localStorage key.
  workspaces.setActive(id);
  if (workspaces.activeId !== id) return; // setActive no-ops on an unknown id

  // 2. ⚠️ THE REBUILD IN STEP 4 IS A FULL PAGE LOAD, AND A PAGE LOAD DESTROYS
  //    UNSAVED FORM STATE. Before this file started rebuilding, picking a
  //    workspace on /projects/intake did nothing at all, so a half-written
  //    intake survived it; now it would be gone with no prompt. Ask first.
  //    Surfaces opt in via `registerUnsaved` — with none registered this is a
  //    single empty-Map read and the clean path below is byte-for-byte what it
  //    was. ⛔ Do NOT make the rebuild conditional on anything else: "no unsaved
  //    work ⇒ always rebuild" is the whole fix.
  //
  //    ON DECLINE WE REVERT THE SELECTION, and the third option — leave it
  //    switched but unrefreshed — is forbidden: that IS the defect this file
  //    exists to remove, and it would now be reachable by answering "no" to a
  //    prompt about something else entirely. Reverting is also the only branch
  //    that corrects the <select>, which is bound to `workspaces.activeId`
  //    (WorkspaceSwitcher.svelte) and therefore keeps showing the new workspace
  //    until that id moves back. `confirm` blocks the event loop and the revert
  //    is in the same synchronous task, so nothing can fetch under the
  //    half-applied tenant in between.
  if (hasUnsavedWork() && !confirmDiscardUnsaved()) {
    // `previousId === undefined` means nothing was ever active — unreachable
    // from the switcher, which only renders once `load()` has picked an id. We
    // cannot revert to "no workspace", so fall through and complete the switch
    // rather than park in the switched-but-unrefreshed state.
    if (previousId !== undefined) {
      workspaces.setActive(previousId);
      return;
    }
  }

  // 2b. The Copilot's agent session is bound to the workspace it was issued
  //     under (agentSession WORKSPACE BINDING): drop it now, so the next agent
  //     call issues one for THIS workspace (a switched super-admin's threads and
  //     tools then act where the UI is). Both branches below rely on it — the
  //     rebuild keeps localStorage, the soft path keeps the in-memory session.
  agentSession.onWorkspaceSwitch();

  // 3. Decide navigation off the CURRENT route (invalidateAll doesn't change it).
  const mustLeave = routeNeedsLeave(get(page).route.id);

  // 4. ⛔ STAYING PUT IS THE BUG. Same route ⇒ SvelteKit keeps the page
  //    component mounted ⇒ every surface that fetched in `onMount` never
  //    fetches again, and `invalidateAll()` below is a no-op for it because it
  //    has no `load()`. Rebuild the document instead: it is the only mechanism
  //    that re-runs EVERY surface's fetch — the ones with a keyed $effect, the
  //    ones without, the module-level singletons, and any route added later —
  //    without each of 168 routes having to opt in. It costs one page load on a
  //    deliberate, rare action; the alternative measured on prod is a control
  //    that silently shows another workspace's rows under the new workspace's
  //    name. `false` means there is no document (SSR / non-browser test env):
  //    fall through to the soft path rather than claim a rebuild that never
  //    happened.
  if (!mustLeave && rebuildDocument()) return;

  // 5. Drop old-tenant board/card/WS state synchronously, before new fetches.
  kanbanStore.resetForTenantSwitch();
  // The selected project is per tenant (persisted under the tenant's key).
  activeProject.rehydrate();
  // Re-validate the new tenant's persisted selection against its project list.
  void activeProject.load();

  // 6. Re-run load()-based routes (e.g. /workflows) with the new tenant header.
  await invalidateAll();

  // 7. Leave dead entity routes for the tenant-neutral dashboard; its child
  //    cards refetch via their activeId-keyed $effects. The route CHANGE is
  //    what makes this branch work: SvelteKit remounts the destination's page
  //    component, so its onMount fetch re-runs under the new header.
  //
  //    ⛔ Refresh workspace identity BEFORE navigating, not after. PR #1123
  //    made `GET /api/me/workspace` report the EFFECTIVE (switched) tenant, so
  //    `auth.user.tenant_id` / `tenant_name` can change on this exact switch — but this branch never
  //    reloads the document (the stay-put branch's rebuildDocument() does, via
  //    a fresh `auth.initialize()`), and nothing else on this path re-runs
  //    `fetchWorkspaceInfo()`. SidebarNav, Header, CmdK, and the /library route
  //    guards all read the workspace identity directly, so if `goto` ran first
  //    they would remount the destination showing the OLD tenant's chrome for
  //    at least a frame.
  //
  //    ⭐ `fetchWorkspaceInfo()` is NOT fail-closed on its own — on error, or a
  //    non-ok response, it leaves `this.user` UNCHANGED (see the caller
  //    contract on its definition in auth.svelte.ts). Called here with no
  //    preparation, a failed or slow refresh after a switch would leave
  //    `tenant_id`/`tenant_name` asserting the OLD tenant's values, and nothing else on this path calls
  //    `fetchWorkspaceInfo()` again — so it would stay wrong not just "for a
  //    frame" but until the next login/refresh() call, with the chrome
  //    describing the wrong tenant the whole time. So:
  //      (a) reset workspace identity to safe defaults for `id`
  //          FIRST (`resetIdentityForSwitch`), so whatever
  //          `fetchWorkspaceInfo()` leaves unchanged on a bad response is
  //          already safe;
  //      (b) race the refresh against a bound (`WORKSPACE_REFRESH_TIMEOUT_MS`)
  //          rather than await it unconditionally — `authFetch` has no
  //          timeout of its own (see the constant above), so an unbound await
  //          here would mean a hung `/api/me/workspace` hangs the ENTIRE
  //          switch, `goto` included. `.catch(() => {})` is defense in depth:
  //          the real `fetchWorkspaceInfo()` never rejects (its own
  //          try/catch), but nothing here should depend on that.
  //    A success overwrites the safe defaults with the truth; a rejection, a
  //    non-ok response, or the bound expiring all leave the safe defaults in
  //    place. `goto` always fires either way.
  if (mustLeave) {
    auth.resetIdentityForSwitch(id);
    await Promise.race([
      auth.fetchWorkspaceInfo().catch(() => {}),
      new Promise<void>((resolve) => setTimeout(resolve, WORKSPACE_REFRESH_TIMEOUT_MS)),
    ]);
    await goto('/', { invalidateAll: true });
  }

  // 8. Best-effort: tighten the lag on the 15s self-healing poller.
  //
  // `navCounts` is deliberately NOT nudged here any more: SidebarNav now keys
  // its refresh on `workspaces.scopeKey`, so `setActive` above has already
  // triggered it. Calling it again would fire a second identical request on
  // every switch — and, worse, would leave two places responsible for when the
  // counts refetch, which is how the fresh-login case ended up with no owner at
  // all (the badge read 0 for the first 60s of every session).
  void activityStore.refresh();
}
