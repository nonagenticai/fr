<!--
  KagEdgeDetailPanel — the right-hand drawer for a selected graph EDGE.

  The node panel answers "what is this concept, and what do my sources say about
  it?"; this is its relationship-shaped sibling: what the relationship is (type +
  direction), its properties, and — the trust surface — the passages across the
  tenant's documents that *evidence* the claim "A —TYPE→ B".

  Endpoint chips delegate selection back up (onselectNode) so a click on either
  end of the relationship switches the drawer to that node. Evidence is fetched
  lazily, reusing the same `/ask` provenance the node panel uses.
-->
<script lang="ts">
  import { kagGraphApi, type KagRecord } from '$lib/api/kag';
  import { AssetError } from '$lib/api/assets';
  import { edgeDetailOf, nodeIdOf, nodeLabelOf, type KagDetailRow } from './graph-normalise';
  import KagChunkCard from './KagChunkCard.svelte';

  interface Props {
    /** The raw relationship record for the selected edge. */
    edge: KagRecord;
    /** The current working node set, to resolve endpoint ids → labels + records. */
    nodes: KagRecord[];
    /** Select an endpoint node (switches the drawer to the node panel). */
    onselectNode?: (node: KagRecord) => void;
    onclose?: () => void;
  }

  const { edge, nodes, onselectNode, onclose }: Props = $props();

  const detail = $derived(edgeDetailOf(edge));

  // Resolve endpoints to their working-set records so the chips can (a) show a
  // human label and (b) re-select the node. Unknown endpoints (not in the loaded
  // slice) render as plain, non-clickable ids.
  const sourceNode = $derived(nodes.find((n) => nodeIdOf(n) === detail.source));
  const targetNode = $derived(nodes.find((n) => nodeIdOf(n) === detail.target));
  const sourceLabel = $derived(sourceNode ? nodeLabelOf(sourceNode) : detail.source || '?');
  const targetLabel = $derived(targetNode ? nodeLabelOf(targetNode) : detail.target || '?');

  // `ACQUIRED` / `WORKS_FOR` → "acquired" / "works for" for readable prose.
  const typeLabel = $derived(
    detail.type ? detail.type.replace(/[_-]+/g, ' ').toLowerCase() : 'related to',
  );
  const evidenceQuery = $derived(`${sourceLabel} ${typeLabel} ${targetLabel}`);

  // Identity key for the currently-selected edge — used to drop stale async
  // responses when the selection changes while a lazy load is in flight.
  const edgeKey = $derived(`${detail.source}__${detail.type}__${detail.target}`);

  // Enriched properties (fetched below) supersede the canvas record when it was
  // too thin to carry them. Declared here so `displayProps` can see it.
  let enrichedProps = $state<KagDetailRow[] | null>(null);
  const displayProps = $derived(enrichedProps ?? detail.properties);

  // --- Lazy evidence ("what evidences this relationship?") ------------------
  let evLoading = $state(false);
  let evError = $state('');
  let evAnswer = $state<string | undefined>(undefined);
  let evChunks = $state<KagRecord[]>([]);
  let evLoaded = $state(false);

  async function loadEvidence() {
    const startKey = edgeKey;
    evLoading = true;
    evError = '';
    evLoaded = true;
    try {
      const { answer, chunks } = await kagGraphApi.provenance(evidenceQuery);
      // Drop a stale response if the selected edge changed while this was in flight.
      if (edgeKey !== startKey) return;
      evAnswer = answer;
      evChunks = chunks;
    } catch (e) {
      if (edgeKey === startKey)
        evError = e instanceof AssetError ? e.message : e instanceof Error ? e.message : String(e);
    } finally {
      if (edgeKey === startKey) evLoading = false;
    }
  }

  // --- Optional property enrichment -----------------------------------------
  // When the loaded edge carried no properties (graph-traversal edges often
  // don't), fetch the authoritative EdgeResponse. Best-effort + non-fatal — the
  // panel already renders its identity from the loaded record. (`enrichedProps`
  // is declared above so `displayProps` can reference it.)
  async function enrichProps() {
    const startKey = edgeKey;
    try {
      let record: KagRecord | undefined;
      if (detail.id) {
        record = await kagGraphApi.edge(detail.id);
      } else if (detail.source && detail.target) {
        const matches = await kagGraphApi.edges({
          sourceId: detail.source,
          targetId: detail.target,
          edgeType: detail.type || undefined,
          limit: 1,
        });
        record = matches[0];
      }
      // Drop a stale response so we never show one edge's props for another.
      if (edgeKey !== startKey) return;
      if (record) {
        const rows = edgeDetailOf(record).properties;
        if (rows.length > 0) enrichedProps = rows;
      }
    } catch {
      // Swallow — enrichment is a best-effort nicety (the panel already renders
      // its identity from the loaded record), not a data-integrity failure.
    }
  }

  // Reset lazy state when the selected edge changes; kick off enrichment only
  // when the loaded record has no properties of its own.
  let lastKey = '';
  $effect(() => {
    const key = `${detail.source}__${detail.type}__${detail.target}`;
    if (key !== lastKey) {
      lastKey = key;
      evLoaded = false;
      evLoading = false;
      evAnswer = undefined;
      evChunks = [];
      evError = '';
      enrichedProps = null;
      if (detail.properties.length === 0) void enrichProps();
    }
  });
</script>

<aside
  class="flex h-full min-h-0 flex-col overflow-hidden rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
  data-testid="kag-edge-detail"
>
  <!-- Identity header -->
  <header class="border-b border-[var(--color-border)] p-4">
    <div class="flex items-start justify-between gap-2">
      <div class="min-w-0">
        <span
          class="inline-block rounded-full bg-[var(--color-accent-bg,var(--color-surface-strong))] px-2 py-0.5 text-xs font-medium text-[var(--color-accent)]"
          >{detail.type || 'RELATED'}</span
        >
        <h3 class="mt-1.5 text-sm font-semibold text-[var(--color-text)]">Relationship</h3>
      </div>
      <button
        onclick={() => onclose?.()}
        class="shrink-0 rounded p-1 text-[var(--color-text-muted)] hover:bg-[var(--color-surface-strong)] hover:text-[var(--color-text)]"
        title="Close"
        aria-label="Close details">✕</button
      >
    </div>

    <!-- Direction: source —TYPE→ target, endpoints clickable when in the slice -->
    <div class="mt-3 flex flex-wrap items-center gap-1.5 text-sm">
      {#if sourceNode}
        <button
          onclick={() => onselectNode?.(sourceNode)}
          data-testid="kag-edge-source"
          class="max-w-[10rem] truncate rounded-full border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
          title={sourceLabel}>{sourceLabel}</button
        >
      {:else}
        <span class="max-w-[10rem] truncate rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)]" title={sourceLabel}>{sourceLabel}</span>
      {/if}
      <span class="font-mono text-xs text-[var(--color-text-muted)]">—{typeLabel}→</span>
      {#if targetNode}
        <button
          onclick={() => onselectNode?.(targetNode)}
          data-testid="kag-edge-target"
          class="max-w-[10rem] truncate rounded-full border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]"
          title={targetLabel}>{targetLabel}</button
        >
      {:else}
        <span class="max-w-[10rem] truncate rounded-full border border-[var(--color-border)] px-2.5 py-1 text-xs text-[var(--color-text-muted)]" title={targetLabel}>{targetLabel}</span>
      {/if}
    </div>
  </header>

  <!-- Scrollable body -->
  <div class="min-h-0 flex-1 space-y-5 overflow-y-auto p-4">
    <!-- Evidence (the trust surface) -->
    <section>
      <div class="mb-2 flex items-center justify-between gap-2">
        <h4 class="text-sm font-semibold text-[var(--color-text)]">Evidence</h4>
        {#if !evLoaded}
          <button
            onclick={loadEvidence}
            data-testid="kag-edge-evidence"
            class="rounded bg-[var(--color-accent)] px-2.5 py-1 text-xs font-medium text-[var(--color-on-primary)] hover:opacity-90"
            title="Trace this relationship to the passages that support it"
            >What evidences this relationship?</button
          >
        {/if}
      </div>

      {#if evLoading}
        <div class="flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
          <span class="inline-block h-4 w-4 animate-spin rounded-full border-b-2 border-[var(--color-accent)]"></span>
          Tracing this relationship to its sources…
        </div>
      {:else if evError}
        <p class="text-sm text-[var(--color-danger-text)]">{evError}</p>
      {:else if evLoaded}
        {#if evAnswer}
          <p class="mb-3 border-l-2 border-[var(--color-accent)] pl-3 text-sm text-[var(--color-text)]">{evAnswer}</p>
        {/if}
        {#if evChunks.length > 0}
          <div class="space-y-2">
            <!-- No `mode`/`diagnostics` ON PURPOSE → the card withholds its score
                 badge. `kagGraphApi.provenance()` does ask /ask with
                 `mode: 'hybrid_rerank'`, but it DISCARDS the diagnostics, so
                 `rerank_degraded` is unknowable here — and a degraded hop serves
                 the RRF fusion order under the same field. Declaring the mode
                 without the evidence that the cross-encoder actually ran is the
                 fabrication this prop exists to prevent. -->
            {#each evChunks as c, i (i)}
              <KagChunkCard chunk={c} compact />
            {/each}
          </div>
        {:else}
          <p class="text-sm text-[var(--color-text-muted)]">No supporting passages found for this relationship in your library.</p>
        {/if}
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]">Trace this relationship to the passages that support it.</p>
      {/if}
    </section>

    <!-- Properties -->
    <section>
      <h4 class="mb-2 text-sm font-semibold text-[var(--color-text)]">Properties</h4>
      {#if displayProps.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">No additional properties on this relationship.</p>
      {:else}
        <dl class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] text-sm">
          {#each displayProps as row (row.key)}
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
    </section>
  </div>
</aside>
