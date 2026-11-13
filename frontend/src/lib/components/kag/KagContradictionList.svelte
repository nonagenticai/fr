<script lang="ts">
  import type { ContradictionPair } from '$lib/api/research';
  import { nodeLabelOf } from './graph-normalise';

  interface Props {
    pairs: ContradictionPair[];
  }
  const { pairs }: Props = $props();

  function labelOf(n: string | Record<string, unknown>): string {
    return typeof n === 'string' ? n : nodeLabelOf(n);
  }

  function scoreClass(s: number | undefined): string {
    if (s === undefined || s === 0) return 'text-[var(--color-text-muted)]';
    return s > 0 ? 'text-[var(--color-success-text)]' : 'text-[var(--color-danger-text)]';
  }
</script>

<ul
  data-testid="kag-contradiction-list"
  class="mt-2 divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded"
>
  {#each pairs as p, i (p.target_id ?? i)}
    <li data-testid="kag-contradiction-item" class="px-3 py-2 text-sm">
      <div class="flex items-center justify-between gap-2">
        <span class="font-medium text-[var(--color-text)]"
          >{p.target_label ?? p.target_id ?? '(unknown)'}</span
        >
        {#if typeof p.net_support_score === 'number'}
          <span class="font-mono {scoreClass(p.net_support_score)}"
            >{p.net_support_score.toFixed(2)}</span
          >
        {/if}
      </div>
      {#if (p.supporting_nodes ?? []).length > 0}
        <div class="mt-1 text-xs text-[var(--color-text-muted)]">
          Supporting: {(p.supporting_nodes ?? []).map(labelOf).join(', ')}
        </div>
      {/if}
      {#if (p.refuting_nodes ?? []).length > 0}
        <div class="mt-1 text-xs text-[var(--color-text-muted)]">
          Refuting: {(p.refuting_nodes ?? []).map(labelOf).join(', ')}
        </div>
      {/if}
    </li>
  {/each}
</ul>
