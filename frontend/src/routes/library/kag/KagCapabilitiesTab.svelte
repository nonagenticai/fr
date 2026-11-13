<!--
  KAG "Formats & models" tab — pure capability transparency for the hub. Answers
  the two pre-ingestion questions a customer asks:

    Formats  which file/document formats can I feed the ingestion pipeline?
    Models   which ML/embedding models power my graph — and which are loaded/active?

  Both are read-only GET reads (`kagInfoApi.formats` / `kagInfoApi.mlModels`)
  against already-registered `/api/assets/kag/*` proxies. Upstream list items are
  loose bags, so we render defensively (probe common keys, key/value fallback).
  The two sections load independently — one failing must not blank the other.
  Self-contained: all fetching lives here so the tab composes onto AssetTabs.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import {
    kagInfoApi,
    type KagFormatsResult,
    type KagModelsResult,
    type KagRecord,
  } from '$lib/api/kag';
  import { kagDetailRows, type KagDetailRow } from '$lib/components/kag/graph-normalise';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }
  /** First non-empty string/number value among the given keys. */
  function pick(r: KagRecord, keys: string[]): string {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  }
  /** Displayable rows for everything not already shown as label/subline (objects flagged `raw`). */
  function detailRows(r: KagRecord, shown: string[]): KagDetailRow[] {
    return kagDetailRows(r, shown);
  }
  /** Compact `key: value · …` trail of the scalar rows (objects go behind an opt-in toggle). */
  function scalarTrail(rows: KagDetailRow[]): string {
    return rows
      .filter((x) => !x.raw)
      .map((x) => `${x.key}: ${x.value}`)
      .join(' · ');
  }

  const FMT_LABEL = ['extension', 'ext', 'format', 'name', 'type', 'id'];
  const FMT_SUB = ['description', 'mime_type', 'mime', 'category'];
  const MODEL_LABEL = ['name', 'model', 'model_name', 'id'];
  // Fields already surfaced elsewhere on the model row (label + the "loaded" badge),
  // so they don't repeat in the detail trail.
  const MODEL_SHOWN = [...MODEL_LABEL, 'loaded'];

  const fmtLabel = (r: KagRecord) => pick(r, FMT_LABEL) || '(format)';
  const fmtSub = (r: KagRecord) => pick(r, FMT_SUB);
  const fmtRows = (r: KagRecord) => detailRows(r, [...FMT_LABEL, ...FMT_SUB]);

  const modelLabel = (r: KagRecord) => pick(r, MODEL_LABEL) || '(model)';
  // Show every non-label model field (context_length, quantization, type, framework,
  // …) — same generic treatment as Formats, so nothing upstream reports is silently
  // dropped. Object values render behind an opt-in toggle instead of a naked JSON blob.
  const modelRows = (r: KagRecord): KagDetailRow[] => detailRows(r, MODEL_SHOWN);

  // ---- Formats ----
  let formats = $state<KagFormatsResult | null>(null);
  let formatsLoading = $state(false);
  let formatsError = $state('');

  async function loadFormats(): Promise<void> {
    formatsLoading = true;
    formatsError = '';
    try {
      formats = await kagInfoApi.formats();
    } catch (e) {
      formatsError = errMsg(e);
    } finally {
      formatsLoading = false;
    }
  }

  // ---- Models ----
  let models = $state<KagModelsResult | null>(null);
  let modelsLoading = $state(false);
  let modelsError = $state('');

  async function loadModels(): Promise<void> {
    modelsLoading = true;
    modelsError = '';
    try {
      models = await kagInfoApi.mlModels();
    } catch (e) {
      modelsError = errMsg(e);
    } finally {
      modelsLoading = false;
    }
  }

  const loadedSet = $derived(new Set(models?.loaded_models ?? []));
  function isLoaded(r: KagRecord): boolean {
    if (r.loaded === true) return true;
    const name = modelLabel(r);
    return name !== '(model)' && loadedSet.has(name);
  }
  function isActive(r: KagRecord): boolean {
    const cur = models?.current_model;
    return !!cur && modelLabel(r) === cur;
  }

  onMount(() => {
    void loadFormats();
    void loadModels();
  });
</script>

<!-- Object-valued leftover fields, behind an opt-in disclosure (never a naked dump). -->
{#snippet rawDetails(rows: KagDetailRow[])}
  {#if rows.some((r) => r.raw)}
    <details class="block w-full text-[10px] text-[var(--color-text-muted)]">
      <summary class="cursor-pointer hover:underline">details</summary>
      {#each rows.filter((r) => r.raw) as r (r.key)}
        <div class="mt-1">
          <span class="font-medium">{r.key}</span>
          <pre class="overflow-x-auto whitespace-pre-wrap break-words text-[var(--color-text)]">{r.value}</pre>
        </div>
      {/each}
    </details>
  {/if}
{/snippet}

<div class="flex flex-col gap-5" data-testid="kag-capabilities">
  <p class="text-xs text-[var(--color-text-muted)]">
    What this knowledge platform can ingest and the models that power it. Read-only.
  </p>

  <!-- Formats -->
  <section class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">Supported formats</h2>
      {#if formats?.total_count !== undefined}
        <span
          class="rounded-full border px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
          data-testid="kag-caps-total">{formats.total_count} total</span
        >
      {/if}
      <button
        type="button"
        data-testid="kag-caps-formats-refresh"
        disabled={formatsLoading}
        onclick={() => void loadFormats()}
        class="ml-auto rounded border px-2 py-1 text-xs disabled:opacity-50"
        >{formatsLoading ? 'Loading…' : 'Refresh'}</button
      >
    </div>
    {#if formatsError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-caps-formats-error">
        {formatsError}
      </p>
    {:else if formatsLoading && !formats}
      <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
    {:else if formats}
      {#if formats.formats.length > 0}
        <ul
          class="grid grid-cols-1 gap-1 sm:grid-cols-2 lg:grid-cols-3"
          data-testid="kag-caps-formats"
        >
          {#each formats.formats as f, i (i)}
            {@const rows = fmtRows(f)}
            <li class="rounded border px-2 py-1 text-xs" data-testid="kag-caps-format">
              <span class="font-medium">{fmtLabel(f)}</span>
              {#if fmtSub(f)}
                <span class="text-[var(--color-text-muted)]"> — {fmtSub(f)}</span>
              {/if}
              {#if scalarTrail(rows)}
                <span class="block text-[10px] text-[var(--color-text-muted)]"
                  >{scalarTrail(rows)}</span
                >
              {/if}
              {@render rawDetails(rows)}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-caps-formats-empty">
          No supported formats reported.
        </p>
      {/if}
    {/if}
  </section>

  <!-- Models -->
  <section class="flex flex-col gap-2 border-t pt-3">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">ML models</h2>
      <button
        type="button"
        data-testid="kag-caps-models-refresh"
        disabled={modelsLoading}
        onclick={() => void loadModels()}
        class="ml-auto rounded border px-2 py-1 text-xs disabled:opacity-50"
        >{modelsLoading ? 'Loading…' : 'Refresh'}</button
      >
    </div>
    {#if modelsError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-caps-models-error">
        {modelsError}
      </p>
    {:else if modelsLoading && !models}
      <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
    {:else if models}
      {#if models.models.length > 0}
        <ul class="flex flex-col gap-1" data-testid="kag-caps-models">
          {#each models.models as m, i (i)}
            {@const rows = modelRows(m)}
            <li
              class="flex flex-wrap items-center gap-2 rounded border px-2 py-1 text-xs {isActive(
                m,
              )
                ? 'border-[var(--color-accent)]'
                : ''}"
              data-testid="kag-caps-model"
            >
              <span class="font-medium">{modelLabel(m)}</span>
              {#if isActive(m)}
                <span
                  class="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-[10px] text-[var(--color-accent)]"
                  data-testid="kag-caps-model-active">active</span
                >
              {/if}
              {#if isLoaded(m)}
                <span
                  class="rounded-full border px-2 py-0.5 text-[10px] text-[var(--color-text-muted)]"
                  data-testid="kag-caps-model-loaded">loaded</span
                >
              {/if}
              {#if scalarTrail(rows)}
                <span class="text-[var(--color-text-muted)]">{scalarTrail(rows)}</span>
              {/if}
              {@render rawDetails(rows)}
            </li>
          {/each}
        </ul>
        {#if models.available_models && models.available_models.length > 0}
          <div
            class="flex flex-wrap items-center gap-1 text-[10px] text-[var(--color-text-muted)]"
            data-testid="kag-caps-available"
          >
            <span>Available:</span>
            {#each models.available_models as name, i (i)}
              <span class="rounded-full border px-2 py-0.5">{name}</span>
            {/each}
          </div>
        {/if}
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-caps-models-empty">
          No ML models reported.
        </p>
      {/if}
    {/if}
  </section>
</div>
