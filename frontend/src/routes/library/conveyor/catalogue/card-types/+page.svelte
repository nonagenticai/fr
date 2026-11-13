<!--
  /library/conveyor/catalogue/card-types — the tenant's card types (RM catalogue),
  each under a conveyor capability. Tier 1 attributes (inputs, outputs,
  acceptance, rules, human task, definition of done) are NULL until set and
  read "not set"; [] means deliberately cleared. An edit sends only the changed
  fields (RM PUT is partial), so an untouched null is never sent as [].
  Admins create/edit/delete; members read.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Input, Select } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import NullableList from '$lib/components/conveyor-catalogue/NullableList.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import {
    createCatalogueItem,
    deleteCatalogueItem,
    getCatalogueEnums,
    listCatalogue,
    updateCatalogueItem,
    type CardType,
    type CatalogueFailure,
    type ConveyorCapability,
    type DefinitionOfDone,
  } from '$lib/api/conveyor-catalogue';
  import {
    cardTypeBody,
    cardTypeForm,
    changedFields,
    displayValue,
    dodOptionsFor,
    type CardTypeForm,
    type TriState,
  } from '$lib/conveyor-catalogue/forms';
  import { listView, rowsOr, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<CardType>>({ kind: 'loading' });
  let capabilities = $state<ConveyorCapability[]>([]);
  let capFailure = $state<CatalogueFailure | null>(null);
  let editing = $state<string | null>(null);
  let form = $state<CardTypeForm>(cardTypeForm());
  /** The form as opened, so an update sends only what changed. */
  let initial = $state<CardTypeForm>(cardTypeForm());
  let saving = $state(false);
  let failure = $state<CatalogueFailure | null>(null);

  const capTitle = $derived(new Map(capabilities.map((c) => [c.id, c.title || c.name])));
  const capOptions = $derived([
    { value: '', label: 'Choose a conveyor capability' },
    ...capabilities.map((c) => ({ value: c.id, label: c.title || c.name })),
  ]);
  /** RM's definition-of-done values, read at runtime; null until/unless the read succeeds. */
  let dodValues = $state<DefinitionOfDone[] | null>(null);
  let enumFailure = $state<CatalogueFailure | null>(null);
  const dodOptions = $derived(dodOptionsFor(dodValues, initial.definition_of_done));
  const humanTaskOptions: { value: TriState; label: string }[] = [
    { value: '', label: 'not set' },
    { value: 'yes', label: 'yes: a person performs or decides this card' },
    { value: 'no', label: 'no' },
  ];

  async function load(): Promise<void> {
    const [ct, caps, enums] = await Promise.all([
      listCatalogue<CardType>('card-types'),
      listCatalogue<ConveyorCapability>('capabilities'),
      getCatalogueEnums(),
    ]);
    view = listView(ct);
    dodValues = enums.ok ? enums.data.definition_of_done : null;
    enumFailure = enums.ok ? null : enums;
    const c = rowsOr(caps);
    capabilities = c.rows;
    capFailure = c.failure;
  }

  onMount(load);

  function open(row?: CardType): void {
    editing = row ? row.id : '';
    form = cardTypeForm(row);
    initial = cardTypeForm(row);
    failure = null;
  }

  async function save(): Promise<void> {
    if (editing === null) return;
    saving = true;
    const r = editing === ''
      ? await createCatalogueItem<CardType>('card-types', cardTypeBody(form))
      : await updateCatalogueItem<CardType>('card-types', editing, changedFields(cardTypeBody(initial), cardTypeBody(form)));
    saving = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    editing = null;
    await load();
  }

  async function remove(row: CardType): Promise<void> {
    if (!confirm(`Delete the card type "${row.title || row.name}"?`)) return;
    const r = await deleteCatalogueItem('card-types', row.id);
    if (!r.ok) {
      failure = r;
      return;
    }
    await load();
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Card types"
    subtitle="The kinds of card the conveyor creates, each under a conveyor capability."
    {mode}
    onImported={load}
  />

  {#if enumFailure}
    <FailureNotice failure={enumFailure} title="Couldn't read the definition-of-done values" />
  {/if}
  {#if capFailure}
    <FailureNotice failure={capFailure} title="Couldn't read conveyor capabilities" />
  {/if}
  {#if failure && editing === null}
    <FailureNotice {failure} />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="flex flex-wrap items-baseline justify-between gap-2">
            <div class="min-w-0">
              <p class="font-medium text-[var(--color-text)]">{row.title}</p>
              <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
            </div>
            {#if mode === 'edit'}
              <div class="flex gap-2">
                <Button size="sm" variant="secondary" onclick={() => open(row)}>Edit</Button>
                <Button size="sm" variant="danger" onclick={() => remove(row)}>Delete</Button>
              </div>
            {/if}
          </div>
          <dl class="mt-2 grid grid-cols-1 gap-1 text-sm md:grid-cols-[10rem_1fr]">
            <dt class="text-[var(--color-text-muted)]">Conveyor capability</dt>
            <dd>{capTitle.get(row.capability_id) ?? row.capability_id}</dd>
            <dt class="text-[var(--color-text-muted)]">Description</dt><dd>{displayValue(row.description)}</dd>
            <dt class="text-[var(--color-text-muted)]">Inputs</dt><dd>{displayValue(row.inputs)}</dd>
            <dt class="text-[var(--color-text-muted)]">Outputs</dt><dd>{displayValue(row.outputs)}</dd>
            <dt class="text-[var(--color-text-muted)]">Acceptance</dt><dd>{displayValue(row.acceptance)}</dd>
            <dt class="text-[var(--color-text-muted)]">Rules</dt><dd>{displayValue(row.rules)}</dd>
            <dt class="text-[var(--color-text-muted)]">Human task</dt><dd>{displayValue(row.human_task)}</dd>
            <dt class="text-[var(--color-text-muted)]">Definition of done</dt><dd>{displayValue(row.definition_of_done)}</dd>
          </dl>
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="card types" onImported={load} />
  {/if}

  {#if mode === 'edit' && view.kind !== 'unavailable' && view.kind !== 'loading'}
    {#if editing === null}
      <div><Button onclick={() => open()}>New card type</Button></div>
    {:else}
      <form
        class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="catalogue-form"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 class="text-sm font-semibold">{editing === '' ? 'New card type' : 'Edit card type'}</h2>
        <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
        <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
        <TextField label="Description" bind:value={form.description} />
        <label class="flex flex-col gap-1 text-sm">Conveyor capability<Select bind:value={form.capability_id} options={capOptions} /></label>
        <NullableList label="Inputs" bind:values={form.inputs} />
        <NullableList label="Outputs" bind:values={form.outputs} />
        <NullableList label="Acceptance" bind:values={form.acceptance} />
        <NullableList label="Rules" bind:values={form.rules} />
        <label class="flex flex-col gap-1 text-sm">Human task<Select bind:value={form.human_task} options={humanTaskOptions} /></label>
        <label class="flex flex-col gap-1 text-sm">Definition of done<Select bind:value={form.definition_of_done} options={dodOptions} /></label>
        {#if dodValues === null}
          <p class="text-xs text-[var(--color-danger-text)]" data-testid="dod-enum-unavailable">
            The definition-of-done values could not be read from the catalogue, so only "not set" and the card type's current value can be chosen.
          </p>
        {/if}
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
