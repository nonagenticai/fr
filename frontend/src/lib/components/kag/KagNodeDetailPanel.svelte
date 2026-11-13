<!--
  KagNodeDetailPanel — the right-hand drawer for a selected graph node.

  This is where "explore" meets "trust": a node's identity + metadata, the
  actions that drive the graph (expand, similar, set path endpoints), and —
  the headline — its source provenance: the passages across the tenant's
  documents that mention this concept, each traceable to the original source.

  It owns only the lazy provenance/similar fetches; graph mutations
  (expand, select-neighbour, path endpoints) are delegated up via callbacks.
-->
<script lang="ts">
  import { kagGraphApi, type KagRecord } from '$lib/api/kag';
  import { AssetError } from '$lib/api/assets';
  import { nodeLabelOf, nodeTypeOf, nodeIdOf, kagDetailRows } from './graph-normalise';
  import KagChunkCard from './KagChunkCard.svelte';

  interface Props {
    node: KagRecord;
    pathStartId?: string | null;
    pathEndId?: string | null;
    onexpand?: (node: KagRecord) => void;
    onselectNode?: (node: KagRecord) => void;
    onsetpathstart?: (node: KagRecord) => void;
    onsetpathend?: (node: KagRecord) => void;
    onclose?: () => void;
  }

  const {
    node,
    pathStartId = null,
    pathEndId = null,
    onexpand,
    onselectNode,
    onsetpathstart,
    onsetpathend,
    onclose,
  }: Props = $props();

  const id = $derived(nodeIdOf(node));
  const label = $derived(nodeLabelOf(node));
  const type = $derived(nodeTypeOf(node));

  // Property rows: prefer an explicit `properties` bag, else the top-level keys
  // minus the structural ones we already render as identity. Object values are
  // carried as `raw` rows so the table renders them behind an opt-in disclosure
  // instead of dumping naked JSON into a `<dd>`.
  const STRUCTURAL = new Set([
    'id', 'entity_id', 'node_id', 'element_id', 'uuid', 'name', 'title',
    'label', 'labels', 'type', 'node_type', 'entity_type', 'properties',
  ]);
  const properties = $derived.by(() => {
    const bag =
      node.properties && typeof node.properties === 'object'
        ? (node.properties as KagRecord)
        : node;
    return kagDetailRows(bag, bag === node ? STRUCTURAL : []);
  });

  const isDocument = $derived(/document/i.test(type));

  // --- Lazy provenance ------------------------------------------------------
  let provLoading = $state(false);
  let provError = $state('');
  let provAnswer = $state<string | undefined>(undefined);
  let provChunks = $state<KagRecord[]>([]);
  let provLoaded = $state(false);

  async function loadSources() {
    const startId = id;
    provLoading = true;
    provError = '';
    provLoaded = true;
    try {
      const { answer, chunks } = await kagGraphApi.provenance(label);
      // Drop a stale response if the selection changed while this was in flight.
      if (id !== startId) return;
      provAnswer = answer;
      provChunks = chunks;
    } catch (e) {
      if (id === startId)
        provError = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === startId) provLoading = false;
    }
  }

  // --- Lazy similar ---------------------------------------------------------
  let simLoading = $state(false);
  let simError = $state('');
  let similar = $state<KagRecord[]>([]);
  let simLoaded = $state(false);

  async function loadSimilar() {
    const startId = id;
    simLoading = true;
    simError = '';
    simLoaded = true;
    try {
      const res = await kagGraphApi.similar(id, 10);
      if (id !== startId) return;
      similar = res;
    } catch (e) {
      if (id === startId)
        simError = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === startId) simLoading = false;
    }
  }

  // --- Lazy precise (hierarchical) passages ---------------------------------
  // Sentence/paragraph-level retrieval — tighter than the document-level /ask
  // provenance above. Same lazy-load pattern; renders through KagChunkCard.
  let precLoading = $state(false);
  let precError = $state('');
  let precChunks = $state<KagRecord[]>([]);
  let precLoaded = $state(false);

  async function loadPrecise() {
    const startId = id;
    precLoading = true;
    precError = '';
    precLoaded = true;
    try {
      const res = await kagGraphApi.hierarchicalRetrieval({ query: label, topK: 10 });
      if (id !== startId) return;
      precChunks = res.results;
    } catch (e) {
      if (id === startId)
        precError = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      if (id === startId) precLoading = false;
    }
  }

  // Reset lazy sections when the selected node changes.
  let lastId = '';
  $effect(() => {
    if (id !== lastId) {
      lastId = id;
      provLoaded = false;
      provLoading = false;
      provAnswer = undefined;
      provChunks = [];
      provError = '';
      simLoaded = false;
      simLoading = false;
      similar = [];
      simError = '';
      precLoaded = false;
      precLoading = false;
      precChunks = [];
      precError = '';
    }
  });
</script>

<aside
  class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
  data-testid="kag-node-detail"
>
  <!-- Identity header -->
  <header class="border-b border-[var(--color-border)] p-4">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <span
          class="inline-block rounded-full bg-[var(--color-accent-bg,var(--color-surface-strong))] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
          >{type}</span
        >
        <h3 class="mt-1.5 break-words text-lg font-semibold text-[var(--color-text)]">{label}</h3>
        <p class="mt-0.5 truncate font-mono text-xs text-[var(--color-text-muted)]" title={id}>{id}</p>
      </div>
      <button
        onclick={() => onclose?.()}
        class="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]"
        title="Close"
        aria-label="Close details">✕</button
      >
    </div>

    <!--
      Action buttons. The graph-drive actions (expand, set path endpoints) only
      make sense when a parent wires their callbacks — the graph-explore tab does,
      but list contexts (e.g. the entity directory) reuse this panel with only
      `onselectNode`. Gate each on its callback so inert buttons never render.
      "Find similar" is a self-contained read (internal `loadSimilar`), so it
      stays available everywhere the panel is shown.
    -->
    <div class="mt-3 flex flex-wrap gap-2">
      {#if onexpand}
        <button
          onclick={() => onexpand?.(node)}
          data-testid="kag-detail-expand"
          class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
          >Expand neighbours</button
        >
      {/if}
      <button
        onclick={loadSimilar}
        class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
        >Find similar</button
      >
      {#if onsetpathstart}
        {#if pathStartId === id}
          <span class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-on-primary)]">Path start ✓</span>
        {:else}
          <button
            onclick={() => onsetpathstart?.(node)}
            data-testid="kag-detail-setpathstart"
            class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
            >Set path start</button
          >
        {/if}
      {/if}
      {#if onsetpathend}
        {#if pathEndId === id}
          <span class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-on-primary)]">Path end ✓</span>
        {:else}
          <button
            onclick={() => onsetpathend?.(node)}
            data-testid="kag-detail-setpathend"
            class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
            >Set path end</button
          >
        {/if}
      {/if}
    </div>
  </header>

  <!-- Scrollable body -->
  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
    <!-- Sources / provenance (the trust surface) -->
    <section>
      <div class="mb-2 flex items-center justify-between gap-2">
        <h4 class="text-sm font-semibold text-[var(--color-text)]">Sources</h4>
        <div class="flex items-center gap-1.5">
          {#if !precLoaded}
            <button
              onclick={loadPrecise}
              data-testid="kag-detail-precise"
              class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
              title="Sentence/paragraph-level retrieval — the tightest passages"
              >Precise passages</button
            >
          {/if}
          {#if !provLoaded}
            <button
              onclick={loadSources}
              data-testid="kag-detail-sources"
              class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-on-primary)] hover:opacity-90"
              >What do my sources say?</button
            >
          {/if}
        </div>
      </div>

      {#if precLoaded}
        <div class="mb-3">
          {#if precLoading}
            <div class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
              <span class="inline-block h-4 w-4 animate-spin rounded-full border-b-2 border-[var(--color-accent)]"></span>
              Retrieving precise passages…
            </div>
          {:else if precError}
            <p class="text-sm text-[var(--color-danger-text)]">{precError}</p>
          {:else if precChunks.length > 0}
            <p class="mb-1.5 text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Precise passages</p>
            <div class="space-y-2">
              <!-- No `mode` ON PURPOSE → the card withholds its score badge.
                   These come from /hierarchical-retrieval, not /ask: there is no
                   AskMode for them and no cross-encoder hop to attest to, so the
                   score is not a match confidence. -->
              {#each precChunks as c, i (i)}
                <KagChunkCard chunk={c} compact />
              {/each}
            </div>
          {:else}
            <p class="text-sm text-[var(--color-text-muted)]">No precise passages returned for this concept.</p>
          {/if}
        </div>
      {/if}

      {#if provLoading}
        <div class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span class="inline-block h-4 w-4 animate-spin rounded-full border-b-2 border-[var(--color-accent)]"></span>
          Tracing passages to their sources…
        </div>
      {:else if provError}
        <p class="text-sm text-[var(--color-danger-text)]">{provError}</p>
      {:else if provLoaded}
        {#if provAnswer}
          <p class="mb-3 border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-text)]">{provAnswer}</p>
        {/if}
        {#if provChunks.length > 0}
          <div class="space-y-2">
            <!-- No `mode`/`diagnostics` ON PURPOSE → the card withholds its score
                 badge. `kagGraphApi.provenance()` asks /ask with
                 `mode: 'hybrid_rerank'` but DISCARDS the diagnostics, so
                 `rerank_degraded` is unknowable and a degraded hop would be
                 serving the RRF fusion order under the same field. -->
            {#each provChunks as c, i (i)}
              <KagChunkCard chunk={c} compact />
            {/each}
          </div>
        {:else}
          <p class="text-sm text-[var(--color-text-muted)]">No source passages found for this concept in your library.</p>
        {/if}
      {/if}
    </section>

    <!-- Similar concepts -->
    {#if simLoaded}
      <section>
        <h4 class="mb-2 text-sm font-semibold text-[var(--color-text)]">Similar concepts</h4>
        {#if simLoading}
          <p class="text-sm text-[var(--color-text-muted)]">Finding similar…</p>
        {:else if simError}
          <p class="text-sm text-[var(--color-danger-text)]">{simError}</p>
        {:else if similar.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]">No similar concepts found.</p>
        {:else}
          <ul class="flex flex-wrap gap-1.5">
            {#each similar as s, i (i)}
              <li>
                <button
                  onclick={() => onselectNode?.(s)}
                  class="rounded-full border border-[var(--color-border-strong)] px-2.5 py-1 text-xs text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
                  >{nodeLabelOf(s)}</button
                >
              </li>
            {/each}
          </ul>
        {/if}
      </section>
    {/if}

    <!-- Metadata -->
    <section>
      <h4 class="mb-2 text-sm font-semibold text-[var(--color-text)]">Metadata</h4>
      {#if properties.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No additional properties.</p>
      {:else}
        <dl class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] text-sm">
          {#each properties as row (row.key)}
            <div class="flex gap-3 px-3 py-2">
              <dt class="w-1/3 shrink-0 font-medium text-[var(--color-text-muted)]">{row.key}</dt>
              {#if row.raw}
                <dd class="min-w-0">
                  <details>
                    <summary class="cursor-pointer text-[var(--color-text-muted)] hover:underline">object</summary>
                    <pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-words text-xs text-[var(--color-text)]">{row.value}</pre>
                  </details>
                </dd>
              {:else}
                <dd class="min-w-0 break-words text-[var(--color-text)]">{row.value}</dd>
              {/if}
            </div>
          {/each}
        </dl>
      {/if}
      {#if isDocument}
        <a
          href="/library/kag/documents"
          class="mt-2 inline-block text-xs font-medium text-[var(--color-accent)] hover:underline"
          >Open in Documents →</a
        >
      {/if}
    </section>
  </div>
</aside>
