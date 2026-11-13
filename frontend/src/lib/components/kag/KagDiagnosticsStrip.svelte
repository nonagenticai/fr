<!--
  KagDiagnosticsStrip — the retrieval-pipeline diagnostics <dl> extracted from the
  Ask tab so both the single-result renderer and each Compare-modes column render
  it identically. Renders nothing when the diagnostics carry no numeric stats
  (e.g. precise-passage mode).
-->
<script lang="ts">
  import { askStatsFrom, type AskMode, type RetrievalDiagnostics } from './kagAsk';

  interface Props {
    diagnostics?: RetrievalDiagnostics;
    /** The mode that PRODUCED these diagnostics. Required, with no default: the
        "Best match" percentage is only meaningful for the reranking modes, and a
        default would silently assume the one scale we must not assume. */
    mode: AskMode;
  }
  const { diagnostics, mode }: Props = $props();

  const stats = $derived(askStatsFrom(mode, diagnostics));
</script>

{#if stats.length > 0}
  <dl
    data-testid="kag-ask-diagnostics"
    title="Hybrid retrieval pipeline: dense + lexical arms → fused → survived rerank → best match"
    class="flex flex-wrap gap-x-4 gap-y-1 text-xs"
  >
    {#each stats as s (s.label)}
      <div class="flex items-baseline gap-1">
        <dt class="text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">{s.label}</dt>
        <dd class="font-semibold text-[var(--color-text)]">{s.value}</dd>
      </div>
    {/each}
  </dl>
{/if}
