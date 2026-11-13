<!--
  /library/conveyor/catalogue/priority-levels — the tenant's priority levels (RM
  catalogue, Tier 2), read-only. Names are p0..p3 (titles P0..P3) and the order
  is RM's `rank`, ascending: rank 0 is the highest priority. Always by rank.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import { listCatalogue, type PriorityLevel } from '$lib/api/conveyor-catalogue';
  import { byRank, displayValue } from '$lib/conveyor-catalogue/forms';
  import { listView, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<PriorityLevel>>({ kind: 'loading' });
  const rows = $derived(view.kind === 'ready' ? byRank(view.rows) : []);

  async function load(): Promise<void> {
    view = listView(await listCatalogue<PriorityLevel>('priority-levels'));
  }

  onMount(load);
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Priority levels"
    subtitle="The priorities a card can carry, highest first (rank 0 is the highest)."
    {mode}
    onImported={load}
  />

  {#if view.kind === 'error'}
    <FailureNotice failure={view.failure} title="Couldn't read priority levels" />
  {:else if view.kind === 'ready'}
    <ol class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="flex flex-wrap items-baseline gap-2">
            <span class="font-medium text-[var(--color-text)]">{row.title}</span>
            <span class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</span>
            <span class="text-xs text-[var(--color-text-muted)]">rank {row.rank}</span>
            {#if row.is_default}<span class="text-xs text-[var(--color-text-muted)]">· default for new cards</span>{/if}
          </div>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[10rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Conveyor may set</dt><dd>{displayValue(row.conveyor_may_set)}</dd>
          </dl>
        </li>
      {/each}
    </ol>
  {:else}
    <CatalogueStatus {view} {mode} noun="priority levels" onImported={load} />
  {/if}
</div>
