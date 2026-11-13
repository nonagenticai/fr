<!--
  /library/conveyor/catalogue/deliverable-kinds — the tenant's deliverable kinds
  (RM catalogue, Tier 2), read-only, with whether each counts towards a phase's
  exit.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import { listCatalogue, type DeliverableKind } from '$lib/api/conveyor-catalogue';
  import { displayValue } from '$lib/conveyor-catalogue/forms';
  import { listView, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<DeliverableKind>>({ kind: 'loading' });

  async function load(): Promise<void> {
    view = listView(await listCatalogue<DeliverableKind>('deliverable-kinds'));
  }

  onMount(load);
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Deliverable kinds"
    subtitle="The kinds of deliverable a project produces, and which count towards a phase's exit."
    {mode}
    onImported={load}
  />

  {#if view.kind === 'error'}
    <FailureNotice failure={view.failure} title="Couldn't read deliverable kinds" />
  {:else if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p class="font-medium text-[var(--color-text)]">{row.title}</p>
          <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[12rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Counts for phase exit</dt><dd>{displayValue(row.counts_for_phase_exit)}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="deliverable kinds" onImported={load} />
  {/if}
</div>
