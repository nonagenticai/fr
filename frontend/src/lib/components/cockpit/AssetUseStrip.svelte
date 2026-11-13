<script lang="ts">
  // The 5D asset-use strip. KAG carries per-card entity links (cardSeekerLinks);
  // Principles / Requirements / Decisions carry the count of assets
  // of that kind BOUND to this project (asset_bindings). Each tile names exactly
  // what it measures — a 0 is a real "none bound" answer, not a data gap.
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { AssetUsage } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  //
  // UI review 2026-10-07: these tiles read 0 on almost every project, because
  // they count EXPLICIT bindings only — assets a project gets through its
  // workspace are not bindings. The strip is labelled as such and points at the
  // Effective assets page, which lists what is actually available.
  interface Props {
    assetUsage: Panel<AssetUsage>;
    /** When set, the note links to `/projects/<id>/knowledge`. */
    projectId?: string;
  }
  let { assetUsage, projectId }: Props = $props();

  const bound = $derived(
    hasData(assetUsage)
      ? ([
          { label: 'Principles', count: assetUsage.data.bound_by_kind.principle },
          { label: 'Requirements', count: assetUsage.data.bound_by_kind.requirement },
          { label: 'Decisions', count: assetUsage.data.bound_by_kind.decision },
        ] as const)
      : [],
  );
</script>

{#if hasData(assetUsage)}
  <p class="mb-1 text-xs font-semibold text-[var(--color-text)]" data-testid="asset-use-strip-label">
    Explicitly bound assets
  </p>
  <div class="grid grid-cols-2 gap-2 sm:grid-cols-5" data-testid="asset-use-strip">
    <div class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
      <div class="text-xs font-semibold text-[var(--color-text)]">KAG</div>
      <div class="mt-0.5 text-sm text-[var(--color-text-muted)]">
        {assetUsage.data.kag_memory_links} linked
      </div>
      <div class="text-[11px] text-[var(--color-text-muted)]">
        {assetUsage.data.cards_with_links} cards
      </div>
    </div>
    {#each bound as dim (dim.label)}
      <div class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2">
        <div class="text-xs font-semibold text-[var(--color-text)]">{dim.label}</div>
        <div class="mt-0.5 text-sm text-[var(--color-text-muted)]">{dim.count} bound</div>
      </div>
    {/each}
  </div>
  <p class="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="asset-use-strip-note">
    {#if projectId}
      Assets available through the workspace are listed under
      <a class="underline hover:text-[var(--color-accent)]" href={`/projects/${projectId}/knowledge`}
        >Effective assets</a
      >.
    {:else}
      Assets available through the workspace are listed under Effective assets.
    {/if}
  </p>
{:else}
  <PanelNote panel={assetUsage} title="5D asset use" />
{/if}
