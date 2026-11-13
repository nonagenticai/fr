<!--
  KagCanvasPeek — the on-canvas "peek" popover.

  Shown while the cursor rests on a graph node: a lightweight, non-interactive
  quick-look at the concept's top source passages so provenance is one hover
  away, without committing to opening the full detail drawer (single-click still
  does that). Positioned near the cursor in the canvas's own pixel space and
  `pointer-events-none` so it never eats the hover — the parent owns the debounced
  fetch (see kag-peek-cache) and simply renders this when it has something to show.
-->
<script lang="ts">
  import type { KagRecord } from '$lib/api/kag';
  import KagChunkCard from './KagChunkCard.svelte';

  interface Props {
    label: string;
    x: number;
    y: number;
    loading?: boolean;
    answer?: string;
    chunks?: KagRecord[];
    /** Max chunks to preview (the full set lives in the drawer). */
    max?: number;
  }

  const { label, x, y, loading = false, answer, chunks = [], max = 2 }: Props = $props();

  const preview = $derived(chunks.slice(0, max));
  // Keep the card off the right/bottom edges of a ~settled cursor position.
  const style = $derived(`left:${x + 16}px;top:${y + 16}px`);
</script>

<div
  class="pointer-events-none absolute z-30 w-72 max-w-xs rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3 shadow-xl dark:bg-[var(--color-surface)]"
  style={style}
  data-testid="kag-canvas-peek"
>
  <div class="mb-2 flex items-center gap-2">
    <span class="inline-block h-2 w-2 shrink-0 rounded-full bg-[var(--color-accent)]"></span>
    <span class="truncate text-sm font-semibold text-[var(--color-text)]" title={label}>{label}</span>
  </div>

  {#if loading}
    <div class="flex items-center gap-2 text-xs text-[var(--color-text-muted)]">
      <span class="inline-block h-3.5 w-3.5 animate-spin rounded-full border-b-2 border-[var(--color-accent)]"></span>
      Finding sources…
    </div>
  {:else}
    {#if answer}
      <p class="mb-2 border-l-2 border-[var(--color-accent)] pl-2 text-xs leading-relaxed text-[var(--color-text)]">{answer}</p>
    {/if}
    {#if preview.length > 0}
      <div class="space-y-2">
        <!-- No `mode`/`diagnostics` ON PURPOSE → the card withholds its score
             badge. `chunks` arrives as a plain prop with no retrieval context
             attached, so the peek cannot attest to which scale the score is on. -->
        {#each preview as c, i (i)}
          <KagChunkCard chunk={c} compact />
        {/each}
      </div>
      {#if chunks.length > preview.length}
        <p class="mt-2 text-xs text-[var(--color-text-muted)]">
          +{chunks.length - preview.length} more · click for full details
        </p>
      {:else}
        <p class="mt-2 text-xs text-[var(--color-text-muted)]">Click for full details</p>
      {/if}
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]">No source passages for this concept.</p>
    {/if}
  {/if}
</div>
