<!--
  /channels — workspace-admin or dept-admin gated section.

  Access is decided by `channelsGate` (./access.ts), which mirrors the backend's
  `isWorkspaceAdminVia` arms and — critically — stays 'pending' until the
  active workspace role from `/api/me/workspaces` has settled. The old guard
  judged once in onMount right after `auth.isLoading` flipped, BEFORE that role
  arrived, and bounced legitimate tenant admins Home (prod, 2026-09-30).

  Plan: docs/superpowers/plans/2026-04-27-plan-2-org-and-scoping.md Task 17.
-->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { channelsGate } from './access';

  let { children } = $props();

  const gate = $derived(
    channelsGate({
      authLoading: auth.isLoading,
      workspaceAdmin: auth.hasTenantRole('workspace-admin'),
      deptAdmin: auth.hasAnyDeptAdminRole(),
      realmRoles: auth.user?.roles ?? [],
      tenantClaim: auth.user?.tenant_id,
      activeTenantId: workspaces.scopeKey,
      workspacesLoaded: workspaces.loaded,
      workspacesError: workspaces.error,
    }),
  );

  // Nothing else guarantees the workspace list is fetched on a cold load of
  // /channels (the switcher loads it only where it is mounted), so kick it
  // once here. `loaded` stays false on failure by design (see the store), and
  // `error` then settles the gate to 'deny'.
  let loadKicked = false;
  $effect(() => {
    if (auth.isLoading || !auth.isAuthenticated) return;
    if (workspaces.loaded || loadKicked) return;
    loadKicked = true;
    void workspaces.load();
  });

  let redirected = false;
  $effect(() => {
    if (gate !== 'deny' || redirected) return;
    redirected = true;
    toast.error('Workspace or department admin required.');
    void goto('/');
  });
</script>

{#if gate === 'allow'}
  <div data-testid="channels-shell">
    {@render children()}
  </div>
{:else if gate === 'deny'}
  <div data-testid="channels-denied" class="p-6 text-sm text-[var(--color-text-muted)]">
    Workspace or department admin required. Redirecting…
  </div>
{:else}
  <div data-testid="channels-pending" class="p-6 text-sm text-[var(--color-text-muted)]">
    Loading…
  </div>
{/if}
