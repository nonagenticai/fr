<!--
  KagNodeCard — a single semantic-search graph node rendered as a result card.

  The read-only Search surface used to dump `JSON.stringify(node)` per hit (a
  customer-facing raw-JSON blob). This renders the same loosely-typed node record
  as structured chrome: a human label, a type pill, the retrieval score labeled
  with the field it came from, the domain properties as labeled rows, a link back
  to the document when the node is document-scoped, and an opt-in "Raw" disclosure
  for the underlying JSON. Field tolerance lives in `nodeDetailOf`
  (graph-normalise), so one card renders graph-adapter and kag-graph shapes without
  knowing which it got.

  ⛔ The score is NOT a percentage and this card must never print one. `nodeScoreOf`
  returns the first numeric hit among `score`/`similarity`/`relevance`/`_score`, and
  the producer documents those as different, mostly unbounded units —
  `kag_graph_service/src/repositories/chunks_repo.py:561` "`score` is
  `1 - cosine_distance` (higher is better, in [0, 2])" and `:627` "`score` is
  `ts_rank_cd` (higher is better, unbounded)". Rendering `Math.round(score * 100)%`
  therefore produced "200%" (and higher) with a bar overflowing its own track.
  Clamping would be no better: it would print a confident "100%" for a number whose
  scale nobody knows. So: show the raw value next to its field name, and draw the
  meter ONLY when `nodeScoreIsBounded` vouches for both the name and the range.
-->
<script lang="ts">
  import { nodeDetailOf, nodeScoreIsBounded, formatNodeScore } from './graph-normalise';

  interface Props {
    node: Record<string, unknown>;
    /** Compact mode trims padding for dense lists. */
    compact?: boolean;
  }

  const { node, compact = false }: Props = $props();

  const detail = $derived(nodeDetailOf(node));
  // The raw number, formatted — never scaled, never suffixed with `%`.
  const scoreText = $derived(
    detail.score === null ? null : formatNodeScore(detail.score),
  );
  // A meter asserts "this fraction of a known maximum". Only a vouched field name
  // whose value really is in [0, 1] earns one; everything else renders the value
  // alone. See the header comment for the producer docstrings.
  const meterValue = $derived(
    nodeScoreIsBounded(detail.score, detail.scoreField) ? (detail.score as number) : null,
  );

  // Document-scoped nodes can link back to the Documents tab (same affordance as
  // KagChunkCard). Only the id — nodeDetailOf already resolved it.
  function pickDocId(n: Record<string, unknown>): string | undefined {
    for (const k of ['doc_id', 'document_id', 'source_id']) {
      const v = n[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    const props = n.properties;
    if (props && typeof props === 'object') {
      return pickDocId(props as Record<string, unknown>);
    }
    return undefined;
  }
  const docId = $derived(pickDocId(node));
</script>

<article
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] {compact
    ? 'p-3'
    : 'p-4'}"
  data-testid="kag-node-card"
>
  <!-- Label + type + raw retrieval score (labeled with its field, never a %) -->
  <header class="flex items-start justify-between gap-3 mb-2">
    <div class="min-w-0">
      <div class="truncate text-sm font-medium text-[var(--color-text)]" title={detail.label}>
        {detail.label}
      </div>
      <div class="mt-0.5">
        <span
          class="inline-block rounded-full bg-[var(--color-surface-strong)] px-2 py-0.5 text-xs text-[var(--color-text-muted)]"
          data-testid="kag-node-card-type"
        >
          {detail.type}
        </span>
      </div>
    </div>

    {#if scoreText !== null}
      <div
        class="shrink-0 text-right"
        title={`Raw retrieval score from the upstream "${detail.scoreField}" field — scale is upstream-defined, not a percentage`}
        data-testid="kag-node-card-score"
      >
        <div class="text-xs text-[var(--color-text)]">
          <span class="text-[var(--color-text-muted)]" data-testid="kag-node-card-score-field"
            >{detail.scoreField}</span
          >
          <span class="font-semibold font-mono" data-testid="kag-node-card-score-value"
            >{scoreText}</span
          >
        </div>
        {#if meterValue !== null}
          <div
            class="mt-1 h-1.5 w-16 overflow-hidden rounded-full bg-[var(--color-surface-strong)]"
            role="meter"
            aria-valuenow={meterValue}
            aria-valuemin={0}
            aria-valuemax={1}
            aria-label={`${detail.scoreField} (0–1)`}
          >
            <div
              class="h-full rounded-full bg-[var(--color-accent)]"
              style={`width:${meterValue * 100}%`}
            ></div>
          </div>
        {/if}
      </div>
    {/if}
  </header>

  <!-- Domain properties as labeled rows (never a stringified blob) -->
  {#if detail.properties.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">No additional properties.</p>
  {:else}
    <dl class="grid grid-cols-[minmax(6rem,auto)_1fr] gap-x-3 gap-y-1 text-sm">
      {#each detail.properties as row (row.key)}
        <dt class="truncate text-[var(--color-text-muted)]" title={row.key}>{row.key}</dt>
        {#if row.raw}
          <dd class="min-w-0">
            <details>
              <summary class="cursor-pointer font-mono text-[var(--color-text-muted)] hover:underline">object</summary>
              <pre class="mt-1 overflow-x-auto whitespace-pre-wrap break-words font-mono text-xs text-[var(--color-text)]">{row.value}</pre>
            </details>
          </dd>
        {:else}
          <dd class="min-w-0 truncate font-mono text-[var(--color-text)]" title={row.value}>{row.value}</dd>
        {/if}
      {/each}
    </dl>
  {/if}

  <!-- Link back to the document this node belongs to -->
  {#if docId}
    <a
      href="/library/kag/documents"
      class="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
      data-testid="kag-node-card-doc-link"
    >
      View in documents →
    </a>
  {/if}

  <!-- Opt-in raw JSON — the only place the full record is stringified. -->
  <details class="mt-3 text-xs" data-testid="kag-node-card-raw">
    <summary class="cursor-pointer text-[var(--color-text-muted)] hover:underline">Raw</summary>
    <pre class="mt-1 overflow-x-auto whitespace-pre-wrap text-[var(--color-text-muted)]">{JSON.stringify(node, null, 2)}</pre>
  </details>
</article>
