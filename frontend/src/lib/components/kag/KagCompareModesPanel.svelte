<!--
  KagCompareModesPanel — side-by-side comparison of the same question run through
  each retrieval mode (dense / hybrid / hybrid_rerank / full). One column per
  mode; each column reuses KagAskAnswerBody so its answer, abstention branch,
  diagnostics and passages render identically to the standalone Ask tab.

  Latency shown per column is CLIENT wall-clock (col.latencyMs). Cost is measured
  server-side and deliberately NOT exposed here.

  Each resolved column also gets a "Copy as API / n8n" inspector (P3-D4) for its
  own mode's exact gateway call — the single-Ask surface has one, so a developer
  comparing modes can reproduce/automate any individual column too. Verify-answer
  is deliberately NOT offered per column (4 columns = 4 billable LLM-judge calls;
  Compare is for retrieval-mode diffing, not per-answer faithfulness).
-->
<script lang="ts">
  import KagAskAnswerBody from './KagAskAnswerBody.svelte';
  import KagCallInspector from './KagCallInspector.svelte';
  import { fmtMs, type CompareColumn, type AskMode } from './kagAsk';
  import type { GatewayCall } from './kagInspect';
  import { withOpenProject } from '$lib/api/kagProjectScope';

  interface Props {
    columns: CompareColumn[];
    /** The shared question all columns ran, used to build each column's request
        inspector. When omitted, the per-column inspector is not shown. */
    question?: string;
  }
  const { columns, question }: Props = $props();

  // The exact BFF call this column's answer came from — same path/body shape the
  // fan-out posts in runCompare (`/api/assets/kag/ask` with { query, mode }).
  function callFor(mode: AskMode): GatewayCall {
    return { method: 'POST', path: '/api/assets/kag/ask', body: withOpenProject({ query: question ?? '', mode }) };
  }
</script>

<div data-testid="kag-compare-grid" class="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
  {#each columns as col (col.mode)}
    <div
      data-testid={`kag-compare-col-${col.mode}`}
      class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] p-3"
    >
      <header class="mb-2 flex items-baseline justify-between gap-2">
        <span class="text-xs font-semibold uppercase tracking-wide text-[var(--color-text-muted)]">{col.mode}</span>
        <span data-testid="kag-compare-latency" class="text-xs font-semibold text-[var(--color-text)]">{fmtMs(col.latencyMs)}</span>
      </header>

      {#if col.status === 'pending'}
        <div class="mt-4 flex items-center gap-2 text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">
          <span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"></span>
          Composing answer with citations…
        </div>
      {:else if col.status === 'error'}
        <p data-testid="kag-compare-error" class="text-sm text-[var(--color-danger-text)]">{col.error}</p>
      {:else if col.result}
        <!-- `col.mode` is what actually produced this column, so each column
             states its own score scale: the dense/hybrid columns withhold the
             percentage the reranking columns show. -->
        <KagAskAnswerBody result={col.result} mode={col.mode} />
        {#if question}
          <KagCallInspector call={callFor(col.mode)} />
        {/if}
      {/if}

      <p class="mt-2 text-xs text-[var(--color-text-muted)]">Latency is client wall-clock; cost is measured server-side.</p>
    </div>
  {/each}
</div>
