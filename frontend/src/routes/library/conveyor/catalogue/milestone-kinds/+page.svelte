<!--
  /library/conveyor/catalogue/milestone-kinds — the tenant's milestone kinds (RM
  catalogue, Tier 2), read-only, each optionally tied to a phase (none = any).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import { listCatalogue, type CatalogueFailure, type MilestoneKind, type ProjectPhase } from '$lib/api/conveyor-catalogue';
  import { displayValue } from '$lib/conveyor-catalogue/forms';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<MilestoneKind>>({ kind: 'loading' });
  let phaseTitle = $state<Map<string, string>>(new Map());
  let phasesFailure = $state<CatalogueFailure | null>(null);

  async function load(): Promise<void> {
    const [m, ph] = await Promise.all([
      listCatalogue<MilestoneKind>('milestone-kinds'),
      listCatalogue<ProjectPhase>('project-phases'),
    ]);
    view = listView(m);
    const p = rowsOr(ph);
    phaseTitle = new Map(p.rows.map((r) => [r.id, r.title || r.name]));
    phasesFailure = p.failure;
  }

  onMount(load);
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Milestone kinds"
    subtitle="The kinds of milestone a project plan can mark, optionally per phase."
    {mode}
    onImported={load}
  />

  {#if phasesFailure}
    <FailureNotice failure={phasesFailure} title="Couldn't read project phases" />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <p class="font-medium text-[var(--color-text)]">{row.title}</p>
          <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[8rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Phase</dt>
            <dd>{row.phase_id == null ? 'any' : (phaseTitle.get(row.phase_id) ?? row.phase_id)}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="milestone kinds" onImported={load} />
  {/if}
</div>
