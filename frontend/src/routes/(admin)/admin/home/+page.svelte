<script lang="ts">
  // Admin overview.
  //
  // Deliberately NOT a grid of tiles duplicating the sidebar — that is what the
  // old `/admin` landing was, and with a persistent nav it is pure
  // duplication. What a landing page can say that a nav cannot is SCOPE: which
  // workspace these pages act on, and which tier the viewer holds. Both were
  // previously invisible, and both change what the pages below actually do.
  //
  // It also used to end with an "Available to you" link list of every admin
  // page — the same menu again, inside the page. Every one of those is a
  // sidebar row (Workspace / Administration zones), so the list is gone (nav
  // standard, 2026-10-03).
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';

  const isSuperAdmin = $derived(auth.isSuperAdmin);
  const isWorkspaceAdmin = $derived(auth.hasTenantRole('workspace-admin'));
  const active = $derived(workspaces.active);
</script>

<div class="flex flex-col gap-6">
  <header class="flex flex-col gap-1">
    <h1 class="text-xl font-semibold text-[var(--color-text)]">Administration</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      {#if isSuperAdmin}
        You hold <strong class="font-medium text-[var(--color-text)]">platform</strong>
        access: the fleet-wide pages, and workspace-admin in every workspace you
        switch into. Every change you make in another workspace is audited.
      {:else if isWorkspaceAdmin}
        You hold <strong class="font-medium text-[var(--color-text)]">workspace</strong>
        access. Platform pages are not shown.
      {:else}
        You have no administrative access.
      {/if}
    </p>
  </header>

  <section
    class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    data-testid="admin-scope-card"
  >
    <h2 class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]">
      Workspace-scoped pages act on
    </h2>
    {#if active}
      <p class="mt-1 text-sm text-[var(--color-text)]">{active.name}</p>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Your role here is <code>{active.role}</code>. Switching workspace can change what
        this section offers — the role is granted per workspace, not once for the fleet.
      </p>
    {:else}
      <!-- Never claim a workspace we cannot name: the list may still be loading,
           and inventing one would mislead about what a write would touch. -->
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        No active workspace resolved yet.
      </p>
    {/if}
  </section>
</div>
