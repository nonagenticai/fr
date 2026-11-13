<!--
  DepartmentPicker.svelte

  Typeahead picker over the caller's workspace departments. Replaces
  the free-text UUID input on stream-create / stream-edit forms.

  Returns the selected department's UUID via two-way `value` binding so
  it drops into existing forms that expected a string field.

  Empty state: when the workspace has no departments yet, surface a
  Create-one link. Loading errors leave the input blank with a
  one-line error message; the bound `value` is left untouched so
  parent state doesn't get clobbered on transient failures.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { displayName } from '$lib/utils/displayName';
  import { listDepartments, type Department } from '$lib/api/tenancy';

  type Props = {
    value?: string;
    disabled?: boolean;
    placeholder?: string;
    /** Optional id for the rendered <select>, lets parent <label for=...> work. */
    id?: string;
  };

  let {
    value = $bindable<string>(''),
    disabled = false,
    placeholder = 'Select a department…',
    id,
  }: Props = $props();

  let depts = $state<Department[]>([]);
  let loading = $state(true);
  let err = $state<string | null>(null);

  onMount(async () => {
    try {
      depts = await listDepartments();
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  });
</script>

{#if loading}
  <select {id} disabled class="dept-picker">
    <option>Loading departments…</option>
  </select>
{:else if err}
  <div class="text-sm text-[var(--color-danger)]" role="alert">
    Failed to load departments: {err}
  </div>
{:else if depts.length === 0}
  <div class="text-sm text-[var(--color-text-muted)]">
    No departments yet — <a class="underline" href="/admin/departments/new">create one</a>.
  </div>
{:else}
  <select
    {id}
    {disabled}
    bind:value
    data-testid="department-picker"
    class="w-full px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
  >
    <option value="">{placeholder}</option>
    {#each depts as d (d.id)}
      <option value={d.id}>{displayName(d.name, d.id)}</option>
    {/each}
  </select>
{/if}
