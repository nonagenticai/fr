<!--
  /library/conveyor/catalogue/phases/[id] — one project phase: its fields, RM's
  derived `has_gate`, and the gates (/pm/gates?phase_id=) guarding its exit.
  Admins create / edit / delete gates; members read. RM validates every save
  (its 422 is rendered as-is); an edit sends only the changed fields.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { Button, Input, Select, Skeleton } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import {
    APPROVER_ROLES,
    createCatalogueItem,
    deleteCatalogueItem,
    getCatalogueItem,
    listCatalogue,
    updateCatalogueItem,
    type CatalogueFailure,
    type Gate,
    type ProjectPhase,
  } from '$lib/api/conveyor-catalogue';
  import { changedFields, displayValue, gateBody, gateForm, gateSummary, type GateForm } from '$lib/conveyor-catalogue/forms';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';
  import { CATALOGUE_PREFIX } from '$lib/conveyor-catalogue/sections';

  const id = $derived(page.params.id ?? '');
  const mode = $derived(currentCatalogueMode());

  let loading = $state(true);
  let loadFailure = $state<CatalogueFailure | null>(null);
  let phase = $state<ProjectPhase | null>(null);
  let gates = $state<Gate[]>([]);
  let gatesFailure = $state<CatalogueFailure | null>(null);

  /** null = no form open; '' = creating; an id = editing that gate. */
  let editing = $state<string | null>(null);
  let form = $state<GateForm>(gateForm());
  let initial = $state<GateForm>(gateForm());
  let saving = $state(false);
  let failure = $state<CatalogueFailure | null>(null);

  const roleOptions = APPROVER_ROLES.map((r) => ({ value: r, label: r }));

  async function loadGates(): Promise<void> {
    const g = await listCatalogue<Gate>('gates', { phase_id: id });
    if (g.ok) {
      gates = g.data;
      gatesFailure = null;
    } else {
      gates = [];
      gatesFailure = g;
    }
  }

  async function load(): Promise<void> {
    loading = true;
    const p = await getCatalogueItem<ProjectPhase>('project-phases', id);
    if (!p.ok) {
      loadFailure = p;
      loading = false;
      return;
    }
    loadFailure = null;
    phase = p.data;
    await loadGates();
    loading = false;
  }

  onMount(load);

  function open(row?: Gate): void {
    editing = row ? row.id : '';
    form = gateForm(row, id);
    initial = gateForm(row, id);
    failure = null;
  }

  async function save(): Promise<void> {
    if (editing === null) return;
    saving = true;
    const r = editing === ''
      ? await createCatalogueItem<Gate>('gates', gateBody(form))
      : await updateCatalogueItem<Gate>('gates', editing, changedFields(gateBody(initial), gateBody(form)));
    saving = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    editing = null;
    await load();
  }

  async function remove(row: Gate): Promise<void> {
    if (!confirm(`Delete the gate "${row.title || row.name}"?`)) return;
    const r = await deleteCatalogueItem('gates', row.id);
    if (!r.ok) {
      failure = r;
      return;
    }
    await load();
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <a class="text-sm text-[var(--color-link)] hover:underline" href={`${CATALOGUE_PREFIX}/phases`}>← Project phases</a>
  <CatalogueHeader
    title={phase ? `Project phase: ${phase.title}` : 'Project phase'}
    subtitle="The phase and the gates that guard its exit. Read from the requirements_management catalogue."
    {mode}
    onImported={load}
  />

  {#if failure && editing === null}
    <FailureNotice {failure} />
  {/if}

  {#if loading}
    <Skeleton height="8rem" />
  {:else if loadFailure}
    <FailureNotice failure={loadFailure} title="Couldn't read this phase" />
  {:else if phase}
    <section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
      <p class="font-mono text-xs text-[var(--color-text-muted)]">{phase.name}</p>
      <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[8rem_1fr]">
        <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(phase.description)}</dd>
        <dt class="text-[var(--color-text-muted)]">Output</dt><dd>{displayValue(phase.output)}</dd>
        <dt class="text-[var(--color-text-muted)]">Exit rule</dt><dd>{displayValue(phase.exit_rule)}</dd>
        <dt class="text-[var(--color-text-muted)]">Gate</dt><dd data-testid="phase-has-gate">{phase.has_gate ? 'gated' : 'no gate'}</dd>
      </dl>
    </section>

    <section class="flex flex-col gap-2" data-testid="phase-gates">
      <h2 class="text-sm font-semibold">Gates</h2>
      {#if gatesFailure}
        <FailureNotice failure={gatesFailure} title="Couldn't read gates" />
      {:else if gates.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No gate guards this phase.</p>
      {:else}
        <ul class="flex flex-col gap-2">
          {#each gates as g (g.id)}
            <li class="flex flex-wrap items-baseline justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm">
              <div class="min-w-0">
                <p>{gateSummary(g)}</p>
                <p class="font-mono text-xs text-[var(--color-text-muted)]">{g.name}</p>
                <p class="text-xs text-[var(--color-text-muted)]">{displayValue(g.description)}</p>
              </div>
              {#if mode === 'edit'}
                <div class="flex gap-2">
                  <Button size="sm" variant="secondary" onclick={() => open(g)}>Edit</Button>
                  <Button size="sm" variant="danger" onclick={() => remove(g)}>Delete</Button>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    {#if mode === 'edit'}
      {#if editing === null}
        <div><Button onclick={() => open()}>New gate</Button></div>
      {:else}
        <form
          class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
          data-testid="catalogue-form"
          onsubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <h2 class="text-sm font-semibold">{editing === '' ? 'New gate' : 'Edit gate'}</h2>
          <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
          <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
          <TextField label="Description" bind:value={form.description} />
          <label class="flex flex-col gap-1 text-sm">Approver<Select bind:value={form.approver_role} options={roleOptions} /></label>
          <label class="flex w-40 flex-col gap-1 text-sm">Quorum<Input type="number" bind:value={form.quorum} /></label>
          <label class="flex w-56 flex-col gap-1 text-sm">Expires after hours (empty = never)<Input type="number" bind:value={form.expires_after_hours} /></label>
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
  {/if}
</div>
