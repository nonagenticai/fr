<!-- CardTypeLegend.svelte -->
<!--
  Horizontal legend strip of the card groups ON THIS BOARD. A group is the card
  type's requirements_management capability (per tenant), so the legend lists
  the capabilities the board's cards carry, each with its deterministic token
  colour (lib/utils/cardTypeColors.ts). Wraps on narrow viewports. Renders
  nothing when no card carries a group.
-->
<script lang="ts">
  import { legendGroups } from '$lib/utils/cardTypeColors';

  interface Props {
    cards: ReadonlyArray<{ card_group?: string | null }>;
  }
  let { cards }: Props = $props();

  const groups = $derived(legendGroups(cards));
</script>

{#if groups.length > 0}
  <div
    class="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 mb-2 text-xs text-[var(--color-text-muted)] bg-[var(--color-surface)]/60 border border-[var(--color-border)] rounded"
    data-testid="card-type-legend"
  >
    <span class="font-medium text-[var(--color-text)]">Capabilities:</span>
    {#each groups as group (group.key)}
      <span class="inline-flex items-center gap-1.5" data-testid="card-type-legend-entry" data-group={group.key}>
        <span class="inline-block w-2 h-2 rounded-full {group.bgClass}"></span>
        <span>{group.label}</span>
      </span>
    {/each}
  </div>
{/if}
