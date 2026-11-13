<script lang="ts">
  // SecretPicker.svelte — Spec 2 §2-B
  // Combo-picker for user secrets. On mount fetches /api/me/secrets,
  // optionally filters by kind, and renders a dropdown.
  // When allowCreate=true shows an inline "+ Create new secret" link
  // that opens a Dialog to POST a new secret then auto-selects it.

  import { onMount } from 'svelte';
  import Dialog from '$lib/components/ui/Dialog.svelte';
  import { apiClient } from '$lib/api/unified-client';
  import type { Secret, SecretCreate, SecretType } from '$lib/types/api';

  type Props = {
    value?: string | null;
    kind?: SecretType;
    placeholder?: string;
    onSelect?: (id: string | null) => void;
    allowCreate?: boolean;
    disabled?: boolean;
    'data-testid'?: string;
  };

  let {
    value = $bindable(null),
    kind,
    placeholder = 'Select a secret…',
    onSelect,
    allowCreate = false,
    disabled = false,
    'data-testid': testId = 'secret-picker',
  }: Props = $props();

  let secrets = $state<Secret[]>([]);
  let loading = $state(true);
  let error = $state('');
  let open = $state(false);

  // Create-dialog state
  let dialogOpen = $state(false);
  let newName = $state('');
  let newValue = $state('');
  let newType = $state<SecretType>('api_key');
  let creating = $state(false);
  let createError = $state('');

  const filtered = $derived(
    kind ? secrets.filter((s) => s.secret_type === kind) : secrets,
  );

  const selected = $derived(filtered.find((s) => s.id === value) ?? null);

  onMount(async () => {
    await loadSecrets();
  });

  async function loadSecrets() {
    loading = true;
    error = '';
    try {
      const res = await apiClient.secretsMe.listMine();
      secrets = res.items;
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load secrets';
    } finally {
      loading = false;
    }
  }

  function select(id: string | null) {
    value = id;
    onSelect?.(id);
    open = false;
  }

  async function handleCreate() {
    if (!newName.trim()) {
      createError = 'Name is required';
      return;
    }
    if (!newValue.trim()) {
      createError = 'Value is required';
      return;
    }
    creating = true;
    createError = '';
    try {
      const body: SecretCreate = {
        name: newName.trim(),
        secret_type: newType,
        secret_value: newValue,
      };
      const created = await apiClient.secretsMe.create(body);
      secrets = [...secrets, created];
      select(created.id);
      dialogOpen = false;
      newName = '';
      newValue = '';
      newType = 'api_key';
    } catch (e) {
      createError = e instanceof Error ? e.message : 'Failed to create secret';
    } finally {
      creating = false;
    }
  }

  const SECRET_TYPES: { value: SecretType; label: string }[] = [
    { value: 'api_key', label: 'API Key' },
    { value: 'oauth', label: 'OAuth Token' },
    { value: 'basic_auth', label: 'Basic Auth' },
    { value: 'custom', label: 'Custom' },
  ];
</script>

<div class="relative w-full" data-testid={testId}>
  <!-- Trigger button styled with design tokens -->
  <button
    type="button"
    {disabled}
    class="flex w-full items-center justify-between h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm text-[var(--color-text)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
    onclick={() => { if (!disabled) open = !open; }}
    aria-haspopup="listbox"
    aria-expanded={open}
    data-testid="{testId}-trigger"
  >
    <span class="truncate {selected ? '' : 'text-[var(--color-text-muted,#888)]'}">
      {#if loading}
        Loading…
      {:else if selected}
        {selected.name}
      {:else}
        {placeholder}
      {/if}
    </span>
    <span class="ml-2 text-[var(--color-text-muted,#888)]">▾</span>
  </button>

  {#if open}
    <!-- Click-outside overlay -->
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="fixed inset-0 z-10"
      onclick={() => (open = false)}
    ></div>

    <div
      role="listbox"
      class="absolute left-0 top-full z-20 mt-1 w-full min-w-[240px] rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] shadow-lg"
      data-testid="{testId}-dropdown"
    >
      {#if error}
        <p class="px-3 py-2 text-sm text-[var(--color-danger)]">{error}</p>
      {:else if filtered.length === 0 && !allowCreate}
        <p class="px-3 py-2 text-sm text-[var(--color-text-muted,#888)]">No secrets found</p>
      {:else}
        <ul class="max-h-52 overflow-y-auto py-1">
          <!-- "None" option -->
          <li>
            <button
              type="button"
              role="option"
              aria-selected={value === null}
              class="w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)] {value === null ? 'font-semibold' : ''}"
              onclick={() => select(null)}
            >
              — None —
            </button>
          </li>
          {#each filtered as s (s.id)}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={value === s.id}
                class="w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-surface)] {value === s.id ? 'font-semibold' : ''}"
                onclick={() => select(s.id)}
                data-testid="{testId}-option-{s.id}"
              >
                <span class="block truncate">{s.name}</span>
                <span class="block text-xs text-[var(--color-text-muted,#888)]">{s.secret_type}</span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}

      {#if allowCreate}
        <div class="border-t border-[var(--color-border)] px-3 py-2">
          <button
            type="button"
            class="text-sm text-[var(--color-accent,#3b82f6)] hover:underline"
            onclick={() => { open = false; dialogOpen = true; }}
            data-testid="{testId}-create-link"
          >
            + Create new secret
          </button>
        </div>
      {/if}
    </div>
  {/if}
</div>

<!-- Create-secret dialog -->
<Dialog bind:open={dialogOpen} title="Create new secret">
  <form
    class="flex flex-col gap-4"
    onsubmit={(e) => { e.preventDefault(); handleCreate(); }}
    data-testid="{testId}-create-form"
  >
    <div class="flex flex-col gap-1">
      <label class="text-sm font-medium" for="{testId}-new-name">Name</label>
      <input
        id="{testId}-new-name"
        class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        type="text"
        placeholder="My API Key"
        bind:value={newName}
        data-testid="{testId}-new-name-input"
      />
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-medium" for="{testId}-new-type">Type</label>
      <select
        id="{testId}-new-type"
        class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        bind:value={newType}
        data-testid="{testId}-new-type-select"
      >
        {#each SECRET_TYPES as opt}
          <option value={opt.value}>{opt.label}</option>
        {/each}
      </select>
    </div>

    <div class="flex flex-col gap-1">
      <label class="text-sm font-medium" for="{testId}-new-value">Value</label>
      <input
        id="{testId}-new-value"
        class="h-10 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none"
        type="password"
        placeholder="sk-…"
        bind:value={newValue}
        data-testid="{testId}-new-value-input"
      />
    </div>

    {#if createError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="{testId}-create-error">{createError}</p>
    {/if}

    <div class="flex justify-end gap-2">
      <button
        type="button"
        class="px-4 py-2 text-sm rounded-[var(--radius-md)] border border-[var(--color-border)] hover:bg-[var(--color-surface)]"
        onclick={() => (dialogOpen = false)}
      >
        Cancel
      </button>
      <button
        type="submit"
        disabled={creating}
        class="px-4 py-2 text-sm rounded-[var(--radius-md)] bg-[var(--color-accent,#3b82f6)] text-[var(--color-text)] hover:opacity-90 disabled:opacity-50"
        data-testid="{testId}-submit-btn"
      >
        {creating ? 'Creating…' : 'Create'}
      </button>
    </div>
  </form>
</Dialog>
