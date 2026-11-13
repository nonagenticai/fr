<script module lang="ts">
  export interface ComboOption {
    value: string;
    /** Primary line. */
    label: string;
    /** Secondary line (email, app key, plan limits…) shown under the label. */
    sublabel?: string;
    disabled?: boolean;
  }
</script>

<script lang="ts">
  // Combobox.svelte — a searchable single-select picker.
  //
  // Why this exists: the super-admin console must never make an operator type a
  // raw value (a Keycloak `sub` UUID, an app id). Every field is a picker over
  // KNOWN values. The native `Select` can't search and can't load options
  // async, so the person-picker (search Keycloak users as you type) and the
  // long lists (48 apps, 21 tenants) both need this.
  //
  // Two modes, one component:
  //   • static  — pass `options`; typing filters them client-side.
  //   • async   — pass `loadOptions(query)`; typing debounces + fetches (the
  //               person-picker: Keycloak has no client-side list to filter).
  //
  // Structure (listbox + click-outside overlay + search Input) follows the
  // existing SecretPicker; this adds the filter box and the async path.

  import { tick } from 'svelte';

  type Props = {
    value?: string | null;
    /** Static options — typing filters these. Ignored when loadOptions is set. */
    options?: ComboOption[];
    /** Async source — typing (debounced) calls this. Takes precedence. */
    loadOptions?: (query: string) => Promise<ComboOption[]>;
    placeholder?: string;
    /** Text when nothing is selected and the box is closed. */
    emptyLabel?: string;
    disabled?: boolean;
    /** Minimum chars before an async search fires (default 2). */
    minChars?: number;
    onSelect?: (value: string | null, option: ComboOption | null) => void;
    'data-testid'?: string;
  };

  let {
    value = $bindable(null),
    options,
    loadOptions,
    placeholder = 'Search…',
    emptyLabel = 'Select…',
    disabled = false,
    minChars = 2,
    onSelect,
    'data-testid': testId = 'combobox',
  }: Props = $props();

  let open = $state(false);
  let queryText = $state('');
  let loading = $state(false);
  let loadError = $state<string | null>(null);
  let asyncResults = $state<ComboOption[]>([]);
  let activeIndex = $state(-1);
  let inputEl = $state<HTMLInputElement | null>(null);
  // The option currently selected, remembered so the closed box can show its
  // label even when it isn't in the (possibly async, possibly filtered) list.
  let selectedOption = $state<ComboOption | null>(null);

  const isAsync = $derived(typeof loadOptions === 'function');

  const filteredStatic = $derived.by(() => {
    const src = options ?? [];
    const q = queryText.trim().toLowerCase();
    if (!q) return src;
    return src.filter(
      (o) =>
        o.label.toLowerCase().includes(q) ||
        (o.sublabel?.toLowerCase().includes(q) ?? false) ||
        o.value.toLowerCase().includes(q),
    );
  });

  const shown = $derived(isAsync ? asyncResults : filteredStatic);

  // Keep the closed-box label in sync when `value` is set from outside or the
  // static option list arrives after the value.
  $effect(() => {
    if (value == null) {
      selectedOption = null;
      return;
    }
    if (selectedOption?.value === value) return;
    const found = (options ?? []).find((o) => o.value === value);
    if (found) selectedOption = found;
  });

  let debounceTimer: ReturnType<typeof setTimeout> | null = null;
  function onQueryInput() {
    activeIndex = -1;
    if (!isAsync) return;
    if (debounceTimer) clearTimeout(debounceTimer);
    const q = queryText.trim();
    if (q.length < minChars) {
      asyncResults = [];
      loading = false;
      return;
    }
    loading = true;
    loadError = null;
    debounceTimer = setTimeout(async () => {
      const forQuery = q;
      try {
        const res = await loadOptions!(forQuery);
        // Ignore a stale response if the query moved on while awaiting.
        if (queryText.trim() === forQuery) asyncResults = res;
      } catch (e) {
        loadError = e instanceof Error ? e.message : String(e);
        asyncResults = [];
      } finally {
        if (queryText.trim() === forQuery) loading = false;
      }
    }, 220);
  }

  async function openList() {
    if (disabled) return;
    open = true;
    await tick();
    inputEl?.focus();
  }

  function choose(opt: ComboOption) {
    if (opt.disabled) return;
    value = opt.value;
    selectedOption = opt;
    open = false;
    queryText = '';
    asyncResults = [];
    onSelect?.(opt.value, opt);
  }

  function clear() {
    value = null;
    selectedOption = null;
    onSelect?.(null, null);
  }

  function onKeydown(e: KeyboardEvent) {
    if (!open) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      activeIndex = Math.min(activeIndex + 1, shown.length - 1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      activeIndex = Math.max(activeIndex - 1, 0);
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const opt = shown[activeIndex];
      if (opt) choose(opt);
    } else if (e.key === 'Escape') {
      open = false;
    }
  }

  const closedLabel = $derived(selectedOption?.label ?? (value ?? emptyLabel));
</script>

<svelte:window
  onclick={(e) => {
    // Close on any click outside this component.
    if (open && e.target instanceof Node) {
      const root = document.querySelector(`[data-combobox="${testId}"]`);
      if (root && !root.contains(e.target)) open = false;
    }
  }}
/>

<div class="relative" data-combobox={testId} data-testid={testId}>
  <button
    type="button"
    {disabled}
    onclick={() => (open ? (open = false) : openList())}
    class="flex h-10 w-full items-center justify-between gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-left text-sm text-[var(--color-text)] hover:border-[var(--color-border-strong)] focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
    aria-haspopup="listbox"
    aria-expanded={open}
  >
    <span class="truncate {selectedOption ? '' : 'text-[var(--color-text-muted)]'}">
      {closedLabel}
    </span>
    <span class="flex items-center gap-1">
      {#if value != null && !disabled}
        <!-- svelte-ignore node_invalid_placement_ssr -->
        <span
          role="button"
          tabindex="0"
          aria-label="Clear selection"
          data-testid={`${testId}-clear`}
          class="text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
          onclick={(e) => {
            e.stopPropagation();
            clear();
          }}
          onkeydown={(e) => {
            if (e.key === 'Enter') {
              e.stopPropagation();
              clear();
            }
          }}>✕</span
        >
      {/if}
      <span class="text-[var(--color-text-muted)]">▾</span>
    </span>
  </button>

  {#if open}
    <div
      role="listbox"
      class="absolute z-50 mt-1 max-h-72 w-full overflow-auto rounded-[var(--radius-md)] border border-[var(--color-border-strong)] bg-[var(--color-surface)] shadow-lg"
    >
      <div class="sticky top-0 border-b border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        <input
          bind:this={inputEl}
          bind:value={queryText}
          oninput={onQueryInput}
          onkeydown={onKeydown}
          type="search"
          {placeholder}
          data-testid={`${testId}-search`}
          class="h-8 w-full rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
        />
      </div>

      {#if loading}
        <p class="px-3 py-3 text-sm text-[var(--color-text-muted)]">Searching…</p>
      {:else if loadError}
        <p class="px-3 py-3 text-sm text-[var(--color-danger-text)]">{loadError}</p>
      {:else if isAsync && queryText.trim().length < minChars}
        <p class="px-3 py-3 text-sm text-[var(--color-text-muted)]">
          Type at least {minChars} characters…
        </p>
      {:else if shown.length === 0}
        <p class="px-3 py-3 text-sm text-[var(--color-text-muted)]" data-testid={`${testId}-empty`}>
          No matches
        </p>
      {:else}
        <ul>
          {#each shown as opt, i (opt.value)}
            <li>
              <button
                type="button"
                role="option"
                aria-selected={opt.value === value}
                disabled={opt.disabled}
                onclick={() => choose(opt)}
                onmouseenter={() => (activeIndex = i)}
                data-testid={`${testId}-option`}
                class="flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left text-sm disabled:opacity-40
                  {i === activeIndex ? 'bg-[var(--color-surface-strong)]' : ''}
                  {opt.value === value ? 'text-[var(--color-accent-text)]' : 'text-[var(--color-text)]'}
                  hover:bg-[var(--color-surface-strong)]"
              >
                <span class="truncate">{opt.label}</span>
                {#if opt.sublabel}
                  <span class="truncate text-xs text-[var(--color-text-muted)]">{opt.sublabel}</span>
                {/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</div>
