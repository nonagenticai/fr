<!--
  TrustBreakdown — a compact, shared readout of an entity's verification signals:
  the Scientific Processor's 5-signal integrity score (+ its components) and,
  when available, the Discovery Engine's 7-signal trust score. Presentational
  only; the parent owns the data + the fetch.
-->
<script lang="ts">
  import type { IntegrityResponse } from '$lib/api/research';

  interface Props {
    integrity?: IntegrityResponse | null;
    trustScore?: number | null;
    trustTitle?: string | null;
  }
  const { integrity = null, trustScore = null, trustTitle = null }: Props =
    $props();

  const components = $derived(integrity?.components ?? []);
</script>

<div class="flex flex-col gap-1 text-xs" data-testid="trust-breakdown">
  <div class="flex flex-wrap items-center gap-2">
    {#if typeof integrity?.integrity_score === 'number'}
      <span
        class="rounded px-1.5 py-0.5 border bg-[var(--color-surface)]"
        data-testid="trust-integrity"
        >integrity {integrity.integrity_score.toFixed(2)}</span
      >
    {/if}
    {#if typeof trustScore === 'number'}
      <span
        class="rounded px-1.5 py-0.5 border bg-[var(--color-surface)]"
        data-testid="trust-score"
        title={trustTitle ?? undefined}>trust {trustScore.toFixed(2)}</span
      >
    {/if}
  </div>
  {#if components.length > 0}
    <ul class="flex flex-wrap gap-x-3 gap-y-0.5 text-[var(--color-text-muted)]">
      {#each components as c, i (c.name ?? i)}
        <li>
          {c.name ?? 'signal'}{#if typeof c.score === 'number'}
            {c.score.toFixed(2)}{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>
