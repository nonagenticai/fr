<!--
  /library/conveyor/catalogue/wip-limits — the tenant's WIP limits (RM catalogue,
  Tier 2), read-only. One limit per scope; a dimension left empty means "any".
  RM resolves the most specific limit (GET /pm/wip-limits/resolve).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import {
    listCatalogue,
    type CardType,
    type CatalogueBase,
    type CatalogueFailure,
    type ConveyorCapability,
    type ProjectPhase,
    type ProjectType,
    type WipLimit,
  } from '$lib/api/conveyor-catalogue';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<WipLimit>>({ kind: 'loading' });
  let titles = $state<Map<string, string>>(new Map());
  let sideFailures = $state<CatalogueFailure[]>([]);

  function titleMap(...lists: CatalogueBase[][]): Map<string, string> {
    return new Map(lists.flat().map((r) => [r.id, r.title || r.name]));
  }

  async function load(): Promise<void> {
    const [w, pt, ph, caps, cts] = await Promise.all([
      listCatalogue<WipLimit>('wip-limits'),
      listCatalogue<ProjectType>('project-types'),
      listCatalogue<ProjectPhase>('project-phases'),
      listCatalogue<ConveyorCapability>('capabilities'),
      listCatalogue<CardType>('card-types'),
    ]);
    view = listView(w);
    const side = [rowsOr(pt), rowsOr(ph), rowsOr(caps), rowsOr(cts)];
    titles = titleMap(...side.map((x) => x.rows as CatalogueBase[]));
    sideFailures = side.map((x) => x.failure).filter((f): f is CatalogueFailure => f !== null);
  }

  onMount(load);

  const dim = (id: string | null | undefined): string => (id == null ? 'any' : (titles.get(id) ?? id));
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="WIP limits"
    subtitle="How many cards may be in progress at once, per scope. An empty dimension means any."
    {mode}
    onImported={load}
  />

  {#each sideFailures as f, i (i)}
    <FailureNotice failure={f} title="Couldn't read part of the catalogue" />
  {/each}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p class="font-medium text-[var(--color-text)]">{row.wip_limit} in progress at once</p>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[10rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Project type</dt><dd>{dim(row.project_type_id)}</dd>
            <dt class="text-[var(--color-text-muted)]">Phase</dt><dd>{dim(row.phase_id)}</dd>
            <dt class="text-[var(--color-text-muted)]">Conveyor capability</dt><dd>{dim(row.capability_id)}</dd>
            <dt class="text-[var(--color-text-muted)]">Card type</dt><dd>{dim(row.card_type_id)}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="WIP limits" onImported={load} />
  {/if}
</div>
