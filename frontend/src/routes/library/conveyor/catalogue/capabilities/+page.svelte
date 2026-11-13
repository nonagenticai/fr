<!--
  /library/conveyor/catalogue/capabilities — the tenant's CONVEYOR capabilities
  (RM catalogue): the groups card types belong to. Not architecture's business
  capability. Admins create/edit/delete; members read.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { Button, Input } from '$lib/components/ui';
  import CatalogueHeader from '$lib/components/conveyor-catalogue/CatalogueHeader.svelte';
  import CatalogueStatus from '$lib/components/conveyor-catalogue/CatalogueStatus.svelte';
  import FailureNotice from '$lib/components/conveyor-catalogue/FailureNotice.svelte';
  import TextField from '$lib/components/conveyor-catalogue/TextField.svelte';
  import {
    createCatalogueItem,
    deleteCatalogueItem,
    listCatalogue,
    updateCatalogueItem,
    type CatalogueFailure,
    type ConveyorCapability,
  } from '$lib/api/conveyor-catalogue';
  import { baseForm, capabilityBody, changedFields, displayValue, type BaseForm } from '$lib/conveyor-catalogue/forms';
  import { listView, type ListView } from '$lib/conveyor-catalogue/state';
  import { currentCatalogueMode } from '$lib/conveyor-catalogue/mode.svelte';

  const mode = $derived(currentCatalogueMode());

  let view = $state<ListView<ConveyorCapability>>({ kind: 'loading' });
  let editing = $state<string | null>(null);
  let form = $state<BaseForm>(baseForm());
  /** The form as opened, so an update sends only what changed (RM PUT is partial). */
  let initial = $state<BaseForm>(baseForm());
  let saving = $state(false);
  let failure = $state<CatalogueFailure | null>(null);

  async function load(): Promise<void> {
    view = listView(await listCatalogue<ConveyorCapability>('capabilities'));
  }

  onMount(load);

  function open(row?: ConveyorCapability): void {
    editing = row ? row.id : '';
    form = baseForm(row);
    initial = baseForm(row);
    failure = null;
  }

  async function save(): Promise<void> {
    if (editing === null) return;
    saving = true;
    const r = editing === ''
      ? await createCatalogueItem<ConveyorCapability>('capabilities', capabilityBody(form))
      : await updateCatalogueItem<ConveyorCapability>('capabilities', editing, changedFields(capabilityBody(initial), capabilityBody(form)));
    saving = false;
    if (!r.ok) {
      failure = r;
      return;
    }
    editing = null;
    await load();
  }

  async function remove(row: ConveyorCapability): Promise<void> {
    if (!confirm(`Delete the conveyor capability "${row.title || row.name}"?`)) return;
    const r = await deleteCatalogueItem('capabilities', row.id);
    if (!r.ok) {
      failure = r;
      return;
    }
    await load();
  }
</script>

<div class="flex flex-col gap-4 p-4 md:p-6">
  <CatalogueHeader
    title="Conveyor capabilities"
    subtitle="The capability groups card types belong to on the conveyor (not architecture's business capabilities)."
    {mode}
    onImported={load}
  />

  {#if failure && editing === null}
    <FailureNotice {failure} />
  {/if}

  {#if view.kind === 'ready'}
    <ul class="flex flex-col gap-2" data-testid="catalogue-rows">
      {#each view.rows as row (row.id)}
        <li class="flex flex-wrap items-start justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="min-w-0">
            <p class="font-medium text-[var(--color-text)]">{row.title}</p>
            <p class="font-mono text-xs text-[var(--color-text-muted)]">{row.name}</p>
            <p class="mt-1 text-sm">{displayValue(row.description)}</p>
          </div>
          {#if mode === 'edit'}
            <div class="flex gap-2">
              <Button size="sm" variant="secondary" onclick={() => open(row)}>Edit</Button>
              <Button size="sm" variant="danger" onclick={() => remove(row)}>Delete</Button>
            </div>
          {/if}
        </li>
      {/each}
    </ul>
  {:else}
    <CatalogueStatus {view} {mode} noun="conveyor capabilities" onImported={load} />
  {/if}

  {#if mode === 'edit' && view.kind !== 'unavailable' && view.kind !== 'loading'}
    {#if editing === null}
      <div><Button onclick={() => open()}>New conveyor capability</Button></div>
    {:else}
      <form
        class="flex flex-col gap-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="catalogue-form"
        onsubmit={(e) => {
          e.preventDefault();
          void save();
        }}
      >
        <h2 class="text-sm font-semibold">{editing === '' ? 'New conveyor capability' : 'Edit conveyor capability'}</h2>
        <label class="flex flex-col gap-1 text-sm">Name (lower snake_case)<Input bind:value={form.name} /></label>
        <label class="flex flex-col gap-1 text-sm">Title<Input bind:value={form.title} /></label>
        <TextField label="Description" bind:value={form.description} />
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
