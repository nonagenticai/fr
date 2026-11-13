<!--
  /admin/assets/decisions — list view for decisions.

  Pattern-clone of /principles + /requirements.
  Plan ref: ~/.claude/plans/in-fr-there-are-jazzy-pine.md §Frontend
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { listAdminDecisions, type AdminDecision } from '$lib/api/admin-assets';
  import AssetFormDrawer from '$lib/components/AssetFormDrawer.svelte';

  let rows = $state<AdminDecision[]>([]);
  let loading = $state(true);
  let error = $state<string | undefined>(undefined);
  let drawerMode = $state<'create' | 'edit' | 'view' | undefined>(undefined);
  let drawerRow = $state<AdminDecision | undefined>(undefined);

  async function refresh(): Promise<void> {
    loading = true;
    error = undefined;
    try {
      rows = await listAdminDecisions();
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    if (!workspaces.loaded) await workspaces.load();
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

  function pickField(d: AdminDecision, ...keys: string[]): string {
    for (const k of keys) {
      const v = d[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '';
  }
  function rowKey(d: AdminDecision): string {
    return pickField(d, 'id', 'decision_id', 'did');
  }
  function openCreate(): void {
    drawerRow = undefined;
    drawerMode = 'create';
  }
  function openRow(d: AdminDecision): void {
    drawerRow = d;
    drawerMode = d.is_system ? 'view' : 'edit';
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
        <span>Platform decisions</span>
      </nav>
      <h1 class="mt-1 text-2xl font-semibold text-[var(--color-text)]">Platform decisions</h1>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Active workspace:
        <span class="font-medium text-[var(--color-text)]">{workspaces.active?.name ?? '—'}</span>
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
    <p class="text-sm text-[var(--color-text-muted)]">No decisions in this workspace.</p>
  {:else}
    <table class="w-full table-auto border-collapse text-sm">
      <thead>
        <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase tracking-wide text-[var(--color-text-muted)]">
          <th class="py-2 pr-4">Scope</th>
          <th class="py-2 pr-4">Title</th>
          <th class="py-2 pr-4">Statement</th>
          <th class="py-2 pr-4">Status</th>
          <th class="py-2 pr-4"></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as d (rowKey(d))}
          <tr class="border-b border-[var(--color-border)] align-top">
            <td class="py-2 pr-4">
              {#if d.is_system}
                <span
                  class="rounded-[var(--radius-sm)] bg-[var(--color-surface-strong)] px-1.5 py-0.5 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
                  >SYSTEM</span
                >
              {:else}
                <span class="text-xs text-[var(--color-text-muted)]">local</span>
              {/if}
            </td>
            <td class="py-2 pr-4 font-medium text-[var(--color-text)]">
              {pickField(d, 'title', 'name')}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">
              {pickField(d, 'statement', 'description', 'rationale')}
            </td>
            <td class="py-2 pr-4 text-[var(--color-text-muted)]">{pickField(d, 'status')}</td>
            <td class="py-2 pr-4">
              <button
                type="button"
                onclick={() => openRow(d)}
                class="text-xs text-[var(--color-accent)] hover:underline"
              >
                {d.is_system ? 'View' : 'Edit'}
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
    kind="decisions"
    mode={drawerMode}
    record={drawerRow}
    onClose={closeDrawer}
    onSaved={onSaved}
  />
{/if}
