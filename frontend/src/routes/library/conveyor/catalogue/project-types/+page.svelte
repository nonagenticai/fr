<!--
  /library/conveyor/catalogue/project-types — the tenant's project types (RM
  catalogue) with their ordered phases. Each opens its detail page (phase
  picker + card-type matrix). Admins create/delete here; members read.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Input } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import PhasePicker from '$lib/components/conveyor-catalogue/PhasePicker.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import {
    createCatalogueItem,
    deleteCatalogueItem,
    listCatalogue,
    type CatalogueFailure,
    type ProjectPhase,
    type ProjectType,
  } from '$lib/api/conveyor-catalogue';
  import { displayValue, projectTypeBody, projectTypeForm, type ProjectTypeForm } from '$lib/conveyor-catalogue/forms';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';
  import { CATALOGUE_PREFIX } from '$lib/conveyor-catalogue/sections';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<ProjectType>>({ kind: 'loading' });
  let phases = $state<ProjectPhase[]>([]);
  let phasesFailure = $state<CatalogueFailure | null>(null);
  let creating = $state(false);
  let form = $state<ProjectTypeForm>(projectTypeForm());
  let saving = $state(false);
  let failure = $state<CatalogueFailure | null>(null);

  async function load(): Promise<void> {
    const [pt, ph] = await Promise.all([
      listCatalogue<ProjectType>('project-types'),
      listCatalogue<ProjectPhase>('project-phases'),
    ]);
    view = listView(pt);
    const p = rowsOr(ph);
    phases = p.rows;
    phasesFailure = p.failure;
  }

  onMount(load);

  function open(): void {
    creating = true;
    form = projectTypeForm();
    failure = null;
  }

  async function save(): Promise<void> {
    saving = true;
    const r = await createCatalogueItem<ProjectType>('project-types', projectTypeBody(form));
    saving = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    creating = false;
    await load();
  }

  async function remove(row: ProjectType): Promise<void> {
    if (!confirm(`Delete the project type "${row.title || row.name}" with its matrix?`)) return;
    const r = await deleteCatalogueItem('project-types', row.id);
    if (!r.ok) {
      failure = r;
      return;
    }
    await load();
  }

  function phaseLine(row: ProjectType): string {
    const list = [...(row.phases ?? [])].sort((a, b) => a.position - b.position);
    return list.length === 0 ? 'no phases' : list.map((p) => p.title || p.name).join(' → ');
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Project types"
    subtitle="Each project type runs an ordered set of phases; its matrix says which card types each phase uses."
    {mode}
    onImported={load}
  />

  {#if phasesFailure}
    <FailureNotice failure={phasesFailure} title="Couldn't read project phases" />
  {/if}
  {#if failure && !creating}
    <FailureNotice {failure} />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="min-w-0">
            <a class="font-medium text-[var(--color-link)] hover:underline" href={`${CATALOGUE_PREFIX}/project-types/${encodeURIComponent(row.id)}`}>{row.title}</a>
            <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
            <p class="mt-1 text-sm">{displayValue(row.description)}</p>
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">{phaseLine(row)}</p>
          </div>
          {#if mode === 'edit'}
            <Button size="sm" variant="danger" onclick={() => remove(row)}>Delete</Button>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="project types" onImported={load} />
  {/if}

  {#if mode === 'edit' && view.kind !== 'unavailable' && view.kind !== 'loading'}
    {#if !creating}
      <div><Button onclick={open}>New project type</Button></div>
    {:else}
      <form
        class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="catalogue-form"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 class="text-sm font-semibold">New project type</h2>
        <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
        <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
        <TextField label="Description" bind:value={form.description} />
        <PhasePicker {phases} bind:phaseIds={form.phase_ids} />
        {#if failure}
          <FailureNotice {failure} />
        {/if}
        <div class="flex gap-2">
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Create'}</Button>
          <Button variant="ghost" onclick={() => (creating = false)}>Cancel</Button>
        </div>
      </form>
    {/if}
  {/if}
</div>
