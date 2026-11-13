<!--
  KagAuthorityRanking — renders KAG's `top_entities[]` as a ranked authority list.

  These entities are already fetched by the analytics call but were previously
  unshown. Each item is a loosely-typed node record `{id,label,score,properties}`;
  the human caption is resolved via `nodeLabelOf` (same field tolerance the graph
  canvas uses) and the list is sorted by score descending. Entities without a
  numeric score still render (label only, no meter) and sink to the bottom.
-->
<script lang="ts">
  import { nodeLabelOf } from './graph-normalise';

  interface Props {
    entities: Array<Record<string, unknown>>;
  }

  const { entities }: Props = $props();

  const ranked = $derived(
    entities
      .map((e) => ({ label: nodeLabelOf(e), score: typeof e.score === 'number' ? e.score : null }))
      .sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity)),
  );
</script>

<ol
  data-testid="kag-authority-ranking"
  class="mt-2 divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded"
>
  {#each ranked as r, i (i)}
    <li
      data-testid="kag-authority-item"
      class="flex items-center justify-between gap-2 px-3 py-1.5 text-sm"
    >
      <span class="text-[var(--color-text)]">
        <span class="text-[var(--color-text-muted)]">{i + 1}.</span>
        {r.label}
      </span>
      {#if r.score !== null}
        <span class="font-mono text-[var(--color-text-muted)]">{r.score.toFixed(3)}</span>
      {/if}
    </li>
  {/each}
</ol>
