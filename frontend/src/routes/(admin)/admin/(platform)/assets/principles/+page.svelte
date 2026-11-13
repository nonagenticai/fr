<!--
  /admin/assets/principles — list view for principles.

  v2: drawer-backed read+write. Each row opens AssetFormDrawer; system
  rows open in view mode (writes require switching to the system
  workspace, where the drawer flips to editable).

  Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import {
    listAdminPrinciples,
    type AdminPrinciple,
  } from '$lib/api/admin-assets';
  import AssetFormDrawer from '$lib/components/AssetFormDrawer.svelte';

  let rows = $state<AdminPrinciple[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);
  let drawerMode = $state<'create' | 'edit' | 'view' | undefined>(undefined);
  let drawerRow = $state<AdminPrinciple | undefined>(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      rows = await listAdminPrinciples();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    if (!workspaces.loaded) {
      await workspaces.load();
    }
    await refresh();
  });

  let lastActiveId = $state<string | undefined>(undefined);
  $effect(() => {
    const cur = workspaces.activeId;
    if (cur && cur !== lastActiveId) {
      lastActiveId = cur;
      void refresh();
    }
  });

  function pickField(p: AdminPrinciple, ...keys: string[]): string {
    for (const k of keys) {
      const v = p[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }
  function rowKey(p: AdminPrinciple): string {
    return pickField(p, 'id', 'principle_id');
  }
  function openCreate(): void {
    drawerRow = undefined;
    drawerMode = 'create';
  }
  function openRow(p: AdminPrinciple): void {
    drawerRow = p;
    drawerMode = p.is_system ? 'view' : 'edit';
  }
  function closeDrawer(): void {
    drawerMode = undefined;
    drawerRow = undefined;
  }
  async function onSaved(): Promise<void> {
    closeDrawer();
    await refresh();
  }
</script>

<div class="mx-auto max-w-6xl py-2">
  <header class="mb-4 flex items-start justify-between gap-4">
    <div>
      <nav aria-label="Breadcrumb" class="text-xs text-[var(--color-text-muted)]">
        <span>Administration</span>
        <span class="mx-1">/</span>
        <span>Platform principles</span>
      </nav>
      <h1 class="mt-1 text-2xl font-semibold text-[var(--color-text)]">Platform principles</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Active workspace:
        <span class="font-medium text-[var(--color-text)]"
          >{workspaces.active?.name ?? '—'}</span
        >
        <span
          class="ml-2 rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs uppercase tracking-wide text-[var(--color-text-muted)]"
          >{workspaces.active?.kind ?? '—'}</span
        >
      </p>
    </div>
    <div class="flex gap-2">
      <button
        type="button"
        onclick={() => void refresh()}
        class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
      >
        Refresh
      </button>
      <button
        type="button"
        onclick={openCreate}
        class="h-9 rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 text-sm font-medium text-[var(--color-accent-fg)] hover:opacity-90"
      >
        + New
      </button>
    </div>
  </header>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-sm text-[var(--color-danger)]">Error: {error}</p>
  {:else if rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">No principles in this workspace.</p>
  {:else}
    <table class="w-full table-auto border-collapse text-sm">
      <thead>
        <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <th class="py-2 pr-4">Scope</th>
          <th class="py-2 pr-4">Title</th>
          <th class="py-2 pr-4">Statement</th>
          <th class="py-2 pr-4">Active</th>
          <th class="py-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as p (rowKey(p))}
          <tr class="border-b border-[var(--color-border)] align-top">
            <td class="py-2 pr-4">
              {#if p.is_system}
                <span
                  class="rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                  title="Inherited from the system workspace; switch to system to edit."
                >
                  SYSTEM
                </span>
              {:else}
                <span class="text-xs text-[var(--color-text-muted)]">local</span>
              {/if}
            </td>
            <td class="py-2 pr-4 font-medium text-[var(--color-text)]">
              {pickField(p, 'title', 'name')}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">
              {pickField(p, 'statement', 'description')}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">
              {p.active === false ? 'no' : 'yes'}
            </td>
            <td class="py-2 pr-4">
              <button
                type="button"
                onclick={() => openRow(p)}
                class="text-xs text-[var(--color-accent)] hover:underline"
              >
                {p.is_system ? 'View' : 'Edit'}
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>

{#if drawerMode}
  <AssetFormDrawer
    kind="principles"
    mode={drawerMode}
    record={drawerRow}
    onClose={closeDrawer}
    onSaved={onSaved}
  />
{/if}
