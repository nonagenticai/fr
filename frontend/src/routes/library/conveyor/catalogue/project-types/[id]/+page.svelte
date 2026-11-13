<!--
  /library/conveyor/catalogue/project-types/[id] — one project type: its ordered
  phases and its MATRIX (phase × conveyor capability → card types). With RM
  Tier 1 the matrix also carries entry card types and per-phase output /
  exit-rule overrides. Admins edit; members read. RM validates every save.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Button, Input, Skeleton } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import PhasePicker from '$lib/components/conveyor-catalogue/PhasePicker.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import {
    getCatalogueItem,
    getProjectTypeMatrix,
    listCatalogue,
    setProjectTypeMatrix,
    updateCatalogueItem,
    type CardType,
    type CatalogueFailure,
    type ConveyorCapability,
    type Gate,
    type ProjectPhase,
    type ProjectType,
  } from '$lib/api/conveyor-catalogue';
  import {
    changedFields,
    displayValue,
    gateSummary,
    gatesByPhase,
    projectTypeBody,
    projectTypeForm,
    type ProjectTypeForm,
  } from '$lib/conveyor-catalogue/forms';
  import {
    capabilityGroups,
    matrixPutBody,
    matrixState,
    toggleCardType,
    toggleEntry,
    type MatrixPhaseState,
    type MatrixState,
  } from '$lib/conveyor-catalogue/matrix';
  import { rowsOr } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';
  import { CATALOGUE_PREFIX } from '$lib/conveyor-catalogue/sections';

  const id = $derived(page.params.id ?? '');
  const mode = $derived(currentCatalogueMode());
  const editable = $derived(mode === 'edit');

  let loading = $state(true);
  let loadFailure = $state<CatalogueFailure | null>(null);
  let projectType = $state<ProjectType | null>(null);
  let phases = $state<ProjectPhase[]>([]);
  let capabilities = $state<ConveyorCapability[]>([]);
  let cardTypes = $state<CardType[]>([]);
  let gates = $state<Map<string, Gate[]>>(new Map());
  let sideFailures = $state<CatalogueFailure[]>([]);

  let matrix = $state<MatrixState | null>(null);
  let matrixFailure = $state<CatalogueFailure | null>(null);
  let matrixSaving = $state(false);
  let matrixSaved = $state(false);

  let form = $state<ProjectTypeForm>(projectTypeForm());
  /** The form as loaded, so an update sends only what changed (RM PUT is partial). */
  let initial = $state<ProjectTypeForm>(projectTypeForm());
  let typeSaving = $state(false);
  let typeFailure = $state<CatalogueFailure | null>(null);

  const groups = $derived(capabilityGroups(capabilities, cardTypes));

  async function loadMatrix(): Promise<void> {
    const m = await getProjectTypeMatrix(id);
    if (m.ok) {
      matrix = matrixState(m.data);
      matrixFailure = null;
    } else {
      matrix = null;
      matrixFailure = m;
    }
  }

  async function load(): Promise<void> {
    loading = true;
    const [pt, ph, caps, cts, gt] = await Promise.all([
      getCatalogueItem<ProjectType>('project-types', id),
      listCatalogue<ProjectPhase>('project-phases'),
      listCatalogue<ConveyorCapability>('capabilities'),
      listCatalogue<CardType>('card-types'),
      listCatalogue<Gate>('gates'),
    ]);
    if (!pt.ok) {
      loadFailure = pt;
      loading = false;
      return;
    }
    loadFailure = null;
    projectType = pt.data;
    form = projectTypeForm(pt.data);
    initial = projectTypeForm(pt.data);
    const p = rowsOr(ph);
    const c = rowsOr(caps);
    const t = rowsOr(cts);
    const g = rowsOr(gt);
    phases = p.rows;
    capabilities = c.rows;
    cardTypes = t.rows;
    gates = gatesByPhase(g.rows);
    sideFailures = [p.failure, c.failure, t.failure, g.failure?.status === 404 ? null : g.failure].filter(
      (f): f is CatalogueFailure => f !== null,
    );
    await loadMatrix();
    loading = false;
  }

  onMount(load);

  async function saveType(): Promise<void> {
    typeSaving = true;
    const r = await updateCatalogueItem<ProjectType>(
      'project-types',
      id,
      changedFields(projectTypeBody(initial), projectTypeBody(form)),
    );
    typeSaving = false;
    if (!r.ok) {
      typeFailure = r;
      return;
    }
    typeFailure = null;
    projectType = r.data;
    form = projectTypeForm(r.data);
    initial = projectTypeForm(r.data);
    await loadMatrix();
  }

  function setPhase(i: number, next: MatrixPhaseState): void {
    if (!matrix) return;
    matrix.phases[i] = next;
    matrixSaved = false;
  }

  async function saveMatrix(): Promise<void> {
    if (!matrix) return;
    matrixSaving = true;
    const r = await setProjectTypeMatrix(id, matrixPutBody(matrix));
    matrixSaving = false;
    if (!r.ok) {
      matrixFailure = r;
      return;
    }
    matrixFailure = null;
    matrix = matrixState(r.data);
    matrixSaved = true;
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <a class="text-sm text-[var(--color-link)] hover:underline" href={`${CATALOGUE_PREFIX}/project-types`}>← Project types</a>
  <CatalogueHeader
    title={projectType ? `Project type: ${projectType.title}` : 'Project type'}
    subtitle="Ordered phases and the card-type matrix. Read from the requirements_management catalogue."
    {mode}
    onImported={load}
  />

  {#each sideFailures as f, i (i)}
    <FailureNotice failure={f} title="Couldn't read part of the catalogue" />
  {/each}

  {#if loading}
    <Skeleton height="8rem" />
  {:else if loadFailure}
    <FailureNotice failure={loadFailure} title="Couldn't read this project type" />
  {:else if projectType}
    <section class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <h2 class="text-sm font-semibold">Details and phases</h2>
      {#if editable}
        <form
          class="flex flex-col gap-3"
          data-testid="catalogue-form"
          onsubmit={(e) => {
            e.preventDefault();
            void saveType();
          }}
        >
          <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
          <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
          <TextField label="Description" bind:value={form.description} />
          <PhasePicker {phases} bind:phaseIds={form.phase_ids} />
          <p class="text-xs text-[var(--color-text-muted)]">
            Dropping a phase also drops its card-type placements (a sent selection replaces the previous one).
          </p>
          {#if typeFailure}
            <FailureNotice failure={typeFailure} />
          {/if}
          <div><Button type="submit" disabled={typeSaving}>{typeSaving ? 'Saving…' : 'Save details'}</Button></div>
        </form>
      {:else}
        <p class="font-mono text-xs text-[var(--color-text-muted)]">{projectType.name}</p>
        <p class="text-sm">{displayValue(projectType.description)}</p>
        <ol class="list-decimal pl-6 text-sm">
          {#each [...(projectType.phases ?? [])].sort((a, b) => a.position - b.position) as p (p.phase_id)}
            <li>{p.title || p.name}</li>
          {:else}
            <li class="list-none text-[var(--color-text-muted)]">No phases selected.</li>
          {/each}
        </ol>
      {/if}
    </section>

    <section class="flex flex-col gap-3" data-testid="matrix-editor">
      <h2 class="text-sm font-semibold">Matrix: card types per phase</h2>
      {#if matrixFailure}
        <FailureNotice failure={matrixFailure} title="The matrix was refused or could not be read" />
      {/if}
      {#if matrix}
        {#if matrix.phases.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]">This project type has no phases yet, so its matrix is empty.</p>
        {/if}
        {#each matrix.phases as p, i (p.phase_id)}
          {@const phaseGates = gates.get(p.phase_id) ?? []}
          <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="matrix-phase">
            <div class="flex flex-wrap items-baseline gap-2">
              <span class="text-xs text-[var(--color-text-muted)]">{p.position + 1}.</span>
              <span class="font-medium">{p.title}</span>
              <span class="font-mono text-xs text-[var(--color-text-muted)]">{p.name}</span>
              {#if phaseGates.length > 0}
                <span class="text-xs text-[var(--color-text-muted)]">· {phaseGates.map(gateSummary).join('; ')}</span>
              {:else if p.has_gate}
                <span class="text-xs text-[var(--color-text-muted)]">· gated</span>
              {/if}
            </div>

            {#if matrix.tier1}
              <div class="mt-2 grid grid-cols-1 gap-2 md:grid-cols-2">
                <div class="flex flex-col gap-1 text-sm">
                  <span class="text-[var(--color-text-muted)]">
                    Output: {displayValue(p.effectiveOutput)}{p.outputOverridden ? ' (overridden here)' : ''}
                  </span>
                  {#if editable}
                    <TextField label="Output override for this project type (empty = no override: the phase's applies)" bind:value={p.outputOverride} />
                  {/if}
                </div>
                <div class="flex flex-col gap-1 text-sm">
                  <span class="text-[var(--color-text-muted)]">
                    Exit rule: {displayValue(p.effectiveExitRule)}{p.exitRuleOverridden ? ' (overridden here)' : ''}
                  </span>
                  {#if editable}
                    <TextField label="Exit rule override for this project type (empty = no override: the phase's applies)" bind:value={p.exitRuleOverride} />
                  {/if}
                </div>
              </div>
            {/if}

            <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
              {#each groups as g (g.capability.id)}
                <fieldset class="flex flex-col gap-1">
                  <legend class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
                    {g.capability.title || g.capability.name}
                  </legend>
                  {#each g.cardTypes as ct (ct.id)}
                    {@const on = p.selected.includes(ct.id)}
                    <div class="flex flex-wrap items-center gap-2 text-sm">
                      <label class="flex items-center gap-2">
                        <input
                          type="checkbox"
                          checked={on}
                          disabled={!editable}
                          onchange={() => setPhase(i, toggleCardType(p, ct.id))}
                        />
                        {ct.title || ct.name}
                      </label>
                      {#if matrix.tier1 && on}
                        <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
                          <input
                            type="checkbox"
                            checked={p.entry.includes(ct.id)}
                            disabled={!editable}
                            onchange={() => setPhase(i, toggleEntry(p, ct.id))}
                          />
                          entry
                        </label>
                      {/if}
                    </div>
                  {:else}
                    <p class="text-xs text-[var(--color-text-muted)]">No card types.</p>
                  {/each}
                </fieldset>
              {/each}
            </div>
          </div>
        {/each}
        {#if editable && matrix.phases.length > 0}
          <div class="flex items-center gap-3">
            <Button disabled={matrixSaving} onclick={saveMatrix}>{matrixSaving ? 'Saving…' : 'Save matrix'}</Button>
            {#if matrixSaved}<span class="text-sm text-[var(--color-success-text)]">Saved.</span>{/if}
          </div>
        {/if}
      {/if}
    </section>
  {/if}
</div>
