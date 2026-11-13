<!--
  AssetMultiPicker

  Multi-select picker for a single asset kind. Fetches the tenant-wide
  list for `kind` once on mount, renders a typeahead-filter input + a
  scroll list with checkboxes, and emits selected ids via `bind:selectedIds`.

  Used by:
    - /projects/new/+page.svelte (Library scope section — one picker per kind)
    - ProjectBindMore.svelte (Phase 4 — add-more flow on each project tab)
    - /library/<kind> filter chip "bound_to" project picker (single-select
      variant ProjectPicker reuses this typeahead pattern).

  Empty / not-yet-implemented kinds (e.g. KAG docs when no upstream service)
  return an empty list — the picker renders an empty state with no chrome.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { assetFetch, assetErrorCause, type AssetErrorCause } from '$lib/api/assets';
  import type { AssetKind } from '$lib/api/bindings';

  interface Props {
    kind: AssetKind;
    selectedIds: string[];
    label?: string;
    excludeIds?: string[];
    /** When true, render in compact form (no surrounding card chrome). */
    compact?: boolean;
    /**
     * Called after every load attempt with the failure, or `null` on success.
     *
     * ⚠️ The picker used to keep its failure entirely to itself, and the
     * consequence was not cosmetic: a project could be created with ZERO
     * bound assets because the list never loaded, and the submit path had no
     * way to know. A parent that gates on completeness needs this signal.
     * Fires on every attempt, including retries, so the parent can clear a
     * banner it raised.
     */
    onerror?: (cause: AssetErrorCause | null) => void;
  }

  let {
    kind,
    selectedIds = $bindable<string[]>([]),
    label,
    excludeIds = [],
    compact = false,
    onerror,
  }: Props = $props();

  interface Row {
    id: string;
    title: string;
    description?: string;
  }

  // Plural slug map — matches the URL paths the fr-backend routes
  // mount at (see backend/src/server.ts). kag_document uses a hyphen.
  const PLURAL: Record<AssetKind, string> = {
    requirement: 'requirements',
    principle: 'principles',
    decision: 'decisions',
    kag_document: 'kag-documents',
    workflow: 'workflows',
    trigger: 'triggers',
    channel: 'channels',
    artifact: 'artifacts',
  };

  const KIND_LABEL: Record<AssetKind, string> = {
    requirement: 'Requirements',
    principle: 'Principles',
    decision: 'Decisions',
    kag_document: 'KAG documents',
    workflow: 'Workflows',
    trigger: 'Triggers',
    channel: 'Channels',
    artifact: 'Artifacts',
  };

  let rows = $state<Row[]>([]);
  let loading = $state(true);
  let error = $state<AssetErrorCause | null>(null);
  let filter = $state('');

  function shape(row: Record<string, unknown>): Row {
    const id = String(row.id ?? '');
    // Different upstream services use different display fields — title,
    // name, slug, filename. Coalesce to a sensible label.
    const title =
      (typeof row.title === 'string' && row.title) ||
      (typeof row.name === 'string' && row.name) ||
      (typeof row.slug === 'string' && row.slug) ||
      (typeof row.filename === 'string' && row.filename) ||
      id;
    const description =
      typeof row.description === 'string' ? row.description : undefined;
    return { id, title, description };
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const data = await assetFetch<unknown>(`/api/assets/${PLURAL[kind]}`);
      const list: unknown[] = Array.isArray(data)
        ? data
        : Array.isArray((data as { items?: unknown[] })?.items)
          ? ((data as { items: unknown[] }).items)
          : [];
      rows = list
        .filter((r): r is Record<string, unknown> => typeof r === 'object' && r !== null)
        .map(shape)
        .filter((r) => r.id.length > 0 && !excludeIds.includes(r.id));
    } catch (err) {
      error = assetErrorCause(err);
    } finally {
      loading = false;
      onerror?.(error);
    }
  }

  onMount(() => {
    void load();
  });

  let filtered = $derived(
    filter.trim().length === 0
      ? rows
      : rows.filter((r) =>
          r.title.toLowerCase().includes(filter.trim().toLowerCase()),
        ),
  );

  function toggle(id: string): void {
    if (selectedIds.includes(id)) {
      selectedIds = selectedIds.filter((x) => x !== id);
    } else {
      selectedIds = [...selectedIds, id];
    }
  }

  function clearAll(): void {
    selectedIds = [];
  }
</script>

<div
  class={compact
    ? 'space-y-2'
    : 'border border-[var(--color-border)] rounded-lg p-3 dark:border-[var(--color-border)]'}
  data-testid="asset-multi-picker-{kind}"
>
  <div class="flex items-center justify-between gap-3">
    <h4 class="text-sm font-medium text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
      {label ?? KIND_LABEL[kind]}
      {#if selectedIds.length > 0}
        <span class="text-xs text-[var(--color-text-muted)]">({selectedIds.length} selected)</span>
      {/if}
    </h4>
    {#if selectedIds.length > 0}
      <button
        type="button"
        onclick={clearAll}
        class="text-xs text-[var(--color-text-muted)] hover:underline"
      >Clear</button>
    {/if}
  </div>

  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <!--
      ⛔ THE RETRY BUTTON IS CONDITIONAL, AND THAT IS THE POINT.

      `assetErrorCause` decides whether retrying could possibly succeed. An
      `UPSTREAM_UNAUTHORIZED` is fr's credential being refused: the next
      attempt reproduces it byte for byte. Offering "Retry" there is a control
      that promises something it cannot deliver — the user clicks, watches the
      same red text reappear, and learns nothing. Worse, it buries the one
      thing that IS true: nobody without cluster access can fix this.

      So `retryable` gates the button and `operatorFault` picks the guidance.
      If you add a field to `AssetErrorCause`, wire it into something here —
      a computed field no view reads is the exact defect this component was
      changed to stop producing.
    -->
    <div class="space-y-1" data-testid="picker-error">
      <p class="text-xs text-[var(--color-danger)]">{error.headline}</p>
      {#if error.detail}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="picker-error-detail">
          {error.detail}
        </p>
      {/if}
      {#if error.retryable}
        <button
          type="button"
          onclick={() => void load()}
          class="text-xs text-[var(--color-accent)] hover:underline"
          data-testid="picker-retry"
        >Retry</button>
      {:else if error.operatorFault}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="picker-needs-operator">
          Retrying will not help — this needs an operator. You can still submit;
          nothing from this kind will be bound.
        </p>
      {/if}
    </div>
  {:else if rows.length === 0}
    <p class="text-xs text-[var(--color-text-muted)] italic" data-testid="picker-empty">
      None available yet.
    </p>
  {:else}
    <input
      type="text"
      bind:value={filter}
      placeholder="Filter {KIND_LABEL[kind].toLowerCase()}…"
      class="w-full px-2 py-1 text-sm border border-[var(--color-border-strong)] rounded focus:outline-none focus:ring-1 focus:ring-[var(--color-accent)] dark:border-[var(--color-border-strong)]"
    />
    <div
      class="mt-2 max-h-40 overflow-y-auto space-y-1 border border-[var(--color-border)] rounded p-1 dark:border-[var(--color-border)]"
    >
      {#each filtered as r (r.id)}
        <label
          class="flex items-start gap-2 px-2 py-1 hover:bg-[var(--color-surface)] rounded cursor-pointer text-sm dark:hover:bg-[var(--color-surface-strong)]"
        >
          <input
            type="checkbox"
            checked={selectedIds.includes(r.id)}
            onchange={() => toggle(r.id)}
            class="mt-0.5 rounded text-[var(--color-accent)]"
          />
          <span class="flex-1 min-w-0">
            <span class="block text-[var(--color-text)] dark:text-[var(--color-text)] truncate">{r.title}</span>
            {#if r.description}
              <span class="block text-xs text-[var(--color-text-muted)] truncate">{r.description}</span>
            {/if}
          </span>
        </label>
      {/each}
      {#if filtered.length === 0}
        <p class="px-2 py-1 text-xs text-[var(--color-text-muted)] italic">No matches.</p>
      {/if}
    </div>
  {/if}
</div>
