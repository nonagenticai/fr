<!--
  /library/conveyor/catalogue/phases — the tenant's project phases (RM catalogue).
  Each row shows RM's derived `has_gate` and the gates guarding it; the phase
  detail page lists and (for admins) edits them. Output and exit rule are NULL
  until set ("not set"); an edit sends only the changed fields (RM PUT is
  partial). Admins create/edit/delete; members read.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Input } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import NullableText from '$lib/components/conveyor-catalogue/NullableText.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import { CATALOGUE_PREFIX } from '$lib/conveyor-catalogue/sections';
  import {
    createCatalogueItem,
    deleteCatalogueItem,
    listCatalogue,
    updateCatalogueItem,
    type CatalogueFailure,
    type Gate,
    type ProjectPhase,
  } from '$lib/api/conveyor-catalogue';
  import {
    changedFields,
    displayValue,
    gateSummary,
    gatesByPhase,
    phaseBody,
    phaseForm,
    type PhaseForm,
  } from '$lib/conveyor-catalogue/forms';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<ProjectPhase>>({ kind: 'loading' });
  let gates = $state<Map<string, Gate[]>>(new Map());
  let gatesFailure = $state<CatalogueFailure | null>(null);

  /** null = no form open; '' = creating; an id = editing that row. */
  let editing = $state<string | null>(null);
  let form = $state<PhaseForm>(phaseForm());
  /** The form as opened, so an update sends only what changed. */
  let initial = $state<PhaseForm>(phaseForm());
  let saving = $state(false);
  let failure = $state<CatalogueFailure | null>(null);

  async function load(): Promise<void> {
    const [p, g] = await Promise.all([
      listCatalogue<ProjectPhase>('project-phases'),
      listCatalogue<Gate>('gates'),
    ]);
    view = listView(p);
    const gr = rowsOr(g);
    gates = gatesByPhase(gr.rows);
    gatesFailure = gr.failure;
  }

  onMount(load);

  function open(row?: ProjectPhase): void {
    editing = row ? row.id : '';
    form = phaseForm(row);
    initial = phaseForm(row);
    failure = null;
  }

  async function save(): Promise<void> {
    if (editing === null) return;
    saving = true;
    const r = editing === ''
      ? await createCatalogueItem<ProjectPhase>('project-phases', phaseBody(form))
      : await updateCatalogueItem<ProjectPhase>('project-phases', editing, changedFields(phaseBody(initial), phaseBody(form)));
    saving = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    editing = null;
    await load();
  }

  async function remove(row: ProjectPhase): Promise<void> {
    if (!confirm(`Delete the phase "${row.title || row.name}"?`)) return;
    const r = await deleteCatalogueItem('project-phases', row.id);
    if (!r.ok) {
      failure = r;
      return;
    }
    await load();
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Project phases"
    subtitle="The phases a project type can run through. Read from the requirements_management catalogue."
    {mode}
    onImported={load}
  />

  {#if gatesFailure && gatesFailure.status !== 404}
    <FailureNotice failure={gatesFailure} title="Couldn't read gates" />
  {/if}
  {#if failure && editing === null}
    <FailureNotice {failure} />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        {@const phaseGates = gates.get(row.id) ?? []}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="min-w-0">
              <a class="font-medium text-[var(--color-link)] hover:underline" href={`${CATALOGUE_PREFIX}/phases/${encodeURIComponent(row.id)}`}>{row.title}</a>
              <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
            </div>
            {#if mode === 'edit'}
              <div class="flex gap-2">
                <Button size="sm" variant="secondary" onclick={() => open(row)}>Edit</Button>
                <Button size="sm" variant="danger" onclick={() => remove(row)}>Delete</Button>
              </div>
            {/if}
          </div>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[8rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Output</dt><dd>{displayValue(row.output)}</dd>
            <dt class="text-[var(--color-text-muted)]">Exit rule</dt><dd>{displayValue(row.exit_rule)}</dd>
            <dt class="text-[var(--color-text-muted)]">Gate</dt>
            <dd data-testid="phase-has-gate">
              {#if row.has_gate}gated{:else}no gate{/if}
              {#if phaseGates.length > 0}
                <ul>{#each phaseGates as g (g.id)}<li>{gateSummary(g)}</li>{/each}</ul>
              {/if}
            </dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="project phases" onImported={load} />
  {/if}

  {#if mode === 'edit' && view.kind !== 'unavailable' && view.kind !== 'loading'}
    {#if editing === null}
      <div><Button onclick={() => open()}>New phase</Button></div>
    {:else}
      <form
        class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="catalogue-form"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 class="text-sm font-semibold">{editing === '' ? 'New phase' : 'Edit phase'}</h2>
        <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
        <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
        <TextField label="Description" bind:value={form.description} />
        <NullableText label="Output" bind:value={form.output} />
        <NullableText label="Exit rule" bind:value={form.exit_rule} />
        {#if failure}
          <FailureNotice {failure} />
        {/if}
        <div class="flex gap-2">
          <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
          <Button variant="ghost" onclick={() => (editing = null)}>Cancel</Button>
        </div>
      </form>
    {/if}
  {/if}
</div>
