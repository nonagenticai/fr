<script lang="ts">
  // MapperEditor.svelte — Spec 2 §2-B
  // Editable list of {key, jsonpath} mapper rows with live preview.
  // Validation mirrors backend compileMapper() rules:
  //   - each path must start with "$"
  //   - filter expressions "[?(…)]" are forbidden
  //   - script expressions "[(…)]" are forbidden
  //
  // jsonpath-plus@11.2.0 is used for live preview — same version as backend.

  import { JSONPath } from 'jsonpath-plus';

  type MapperRow = {
    key: string;
    path: string;
    error?: string;
  };

  type Props = {
    value?: Record<string, string>;
    sample?: unknown;
    onChange?: (v: Record<string, string>) => void;
    disabled?: boolean;
  };

  let {
    value = $bindable<Record<string, string>>({}),
    sample,
    onChange,
    disabled = false,
  }: Props = $props();

  // Convert external Record<string,string> → internal row list.
  function toRows(v: Record<string, string>): MapperRow[] {
    return Object.entries(v).map(([key, path]) => ({ key, path }));
  }

  let rows = $state<MapperRow[]>(toRows(value));

  function emitChange() {
    const next: Record<string, string> = {};
    for (const r of rows) {
      if (r.key) next[r.key] = r.path;
    }
    value = next;
    onChange?.(next);
  }

  function validatePath(path: string): string | undefined {
    if (!path.trim()) return undefined; // empty path — not an error yet
    if (!path.startsWith('$')) return 'Must start with $';
    if (/\[\?\(/.test(path)) return 'Filter expressions [?(...)] are not allowed';
    if (/\[\(/.test(path)) return 'Script expressions [(...)] are not allowed';
    return undefined;
  }

  function addRow() {
    rows = [...rows, { key: '', path: '' }];
  }

  function removeRow(idx: number) {
    rows = rows.filter((_, i) => i !== idx);
    emitChange();
  }

  function onKeyInput(idx: number, e: Event) {
    rows[idx]!.key = (e.target as HTMLInputElement).value;
    emitChange();
  }

  function onPathInput(idx: number, e: Event) {
    rows[idx]!.path = (e.target as HTMLInputElement).value;
    rows[idx]!.error = validatePath(rows[idx]!.path);
    emitChange();
  }

  function onPathBlur(idx: number) {
    rows[idx]!.error = validatePath(rows[idx]!.path);
  }

  // Live preview: apply each path to sample. Returns a map key → result string.
  const preview = $derived.by(() => {
    if (!sample) return {} as Record<string, string>;
    const out: Record<string, string> = {};
    for (const r of rows) {
      if (!r.key || !r.path || r.error) continue;
      try {
        const result = JSONPath({ path: r.path, json: sample, wrap: false });
        const isArrayPath = r.path.includes('[*]') || r.path.startsWith('$..');
        const resolved = isArrayPath
          ? Array.isArray(result) ? result : result === undefined ? [] : [result]
          : result;
        out[r.key] = JSON.stringify(resolved);
      } catch {
        out[r.key] = '(error)';
      }
    }
    return out;
  });

  export function validate(): boolean {
    let ok = true;
    rows = rows.map((r) => {
      const error = validatePath(r.path);
      if (error) ok = false;
      return { ...r, error };
    });
    return ok;
  }
</script>

<div class="flex flex-col gap-4" data-testid="mapper-editor">
  <!-- Header row -->
  <div class="grid grid-cols-[1fr_1fr_auto] gap-2 text-xs font-semibold text-[var(--color-text-muted,#888)]">
    <span>Output key</span>
    <span>JSONPath</span>
    {#if sample}
      <span class="hidden sm:block">Preview</span>
    {/if}
  </div>

  <!-- Rows -->
  {#each rows as row, idx (idx)}
    <div class="grid grid-cols-[1fr_1fr_auto] gap-2 items-start" data-testid="mapper-row-{idx}">
      <!-- Key -->
      <div class="flex flex-col gap-1">
        <input
          type="text"
          {disabled}
          class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50"
          value={row.key}
          placeholder="card_title"
          oninput={(e) => onKeyInput(idx, e)}
          data-testid="mapper-key-{idx}"
          aria-label="Output key {idx}"
        />
      </div>

      <!-- JSONPath -->
      <div class="flex flex-col gap-1">
        <input
          type="text"
          {disabled}
          class="h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 text-sm focus:border-[var(--color-accent)] focus:outline-none disabled:opacity-50 {row.error ? 'border-[var(--color-danger)]' : ''}"
          value={row.path}
          placeholder="$.title"
          oninput={(e) => onPathInput(idx, e)}
          onblur={() => onPathBlur(idx)}
          data-testid="mapper-path-{idx}"
          aria-label="JSONPath {idx}"
        />
        {#if row.error}
          <p class="text-xs text-[var(--color-danger)]" data-testid="mapper-path-error-{idx}">{row.error}</p>
        {/if}
        {#if sample && preview[row.key] !== undefined}
          <p class="text-xs text-[var(--color-text-muted,#888)] truncate" data-testid="mapper-preview-{idx}">
            → {preview[row.key]}
          </p>
        {/if}
      </div>

      <!-- Remove button -->
      <button
        type="button"
        {disabled}
        class="h-9 px-2 rounded-[var(--radius-md)] border border-[var(--color-border)] text-sm text-[var(--color-danger)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50"
        onclick={() => removeRow(idx)}
        aria-label="Remove row {idx}"
        data-testid="mapper-remove-{idx}"
      >
        ×
      </button>
    </div>
  {/each}

  <!-- Add row -->
  <button
    type="button"
    {disabled}
    class="self-start px-3 py-1.5 text-sm rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] text-[var(--color-accent,#3b82f6)] hover:bg-[var(--color-surface)] disabled:opacity-50"
    onclick={addRow}
    data-testid="mapper-add-row"
  >
    + Add field
  </button>

  {#if rows.length === 0}
    <p class="text-sm text-[var(--color-text-muted,#888)]">
      No fields configured. Add a field to map source data to card properties.
    </p>
  {/if}
</div>
