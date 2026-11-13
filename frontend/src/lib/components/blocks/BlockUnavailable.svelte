<script lang="ts">
  // Muted inline card for a read-model block that resolved `available:false`.
  // Names the source + freshness so the customer sees "this source isn't
  // reporting" rather than a broken region or a fabricated value.
  import type { BlockMeta } from '$lib/types/read-model';
  import { deriveBlockLabel } from './unavailable';

  interface Props {
    meta: BlockMeta;
    /** Optional short context, e.g. "Live timeline". */
    title?: string;
    class?: string;
  }
  let { meta, title, class: className = '' }: Props = $props();

  const label = $derived(deriveBlockLabel(meta));
  const fetched = $derived(new Date(meta.fetched_at));
  const fetchedLabel = $derived(
    Number.isNaN(fetched.getTime()) ? '' : fetched.toLocaleTimeString(),
  );
</script>

<div
  class={`rounded-lg border border-dashed border-[var(--color-border)] bg-[var(--color-surface-muted,var(--color-surface))] p-3 ${className}`}
  data-testid="block-unavailable"
>
  {#if title}
    <p class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
      {title}
    </p>
  {/if}
  <p class="mt-0.5 text-sm text-[var(--color-text-muted)]">{label}</p>
  {#if fetchedLabel}
    <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Last checked {fetchedLabel}</p>
  {/if}
</div>
