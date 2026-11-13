<!--
  AssetClrPanel.svelte — the CLR (Categories of Legitimate Reservation) panel
  for a single governance asset (requirement / decision) on its detail page.

  Self-contained: given an asset `kind` + `id`, it fetches the asset from
  `/api/assets/{kind}/{id}` and renders its CLR signal via CLRLensPanel.

  Two signals, in priority order:
   1. Per-statement CLR lenses — when the AA author subroutine has written
      `lens_metadata` (clr_assessment 8 booleans + notes, goal_tree_relevance)
      back to RM (RM PR #41), we render the real 8-category grid
      (`showCategories=true`) + the goal-tree-relevance signal + traces-to.
   2. Aggregate fallback — otherwise the asset's own `quality_score` /
      `quality_issues` / `quality_suggestions` (RM QualityMixin, always
      REST-queryable) render as a summary (`showCategories=false`).

  A deep-link opens the full reasoning view scoped to the asset's project.
-->
<script lang="ts">
  import { assetFetch, AssetError } from '$lib/api/assets';
  import {
    assetClrQuality,
    parseAssetLenses,
    toStringList,
    type AssetLensFields,
  } from '$lib/api/toc';
  import CLRLensPanel from './CLRLensPanel.svelte';

  let {
    kind,
    id,
    title = 'CLR Reasoning (Theory of Constraints)',
  }: {
    kind: 'requirements' | 'decisions';
    id: string;
    title?: string;
  } = $props();

  interface AssetWithLenses extends AssetLensFields {
    project_id?: string | null;
  }

  let asset = $state<AssetWithLenses | null>(null);
  let loading = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    const targetKind = kind;
    const targetId = id;
    if (!targetId) return;
    loading = true;
    error = null;
    assetFetch<AssetWithLenses>(
      `/api/assets/${targetKind}/${encodeURIComponent(targetId)}`,
    )
      .then((a) => {
        asset = a;
      })
      .catch((e) => {
        error =
          e instanceof AssetError ? e.message : 'Failed to load CLR quality';
        asset = null;
      })
      .finally(() => {
        loading = false;
      });
  });

  // Per-statement lenses take priority; aggregate quality is the fallback.
  const lens = $derived(parseAssetLenses(asset));
  const aggregateQuality = $derived(assetClrQuality(asset));
  const quality = $derived(lens.report ?? aggregateQuality);
  const issues = $derived(toStringList(asset?.quality_issues));
  const suggestions = $derived(toStringList(asset?.quality_suggestions));
  const projectId = $derived(asset?.project_id ?? null);
  const reasoningHref = $derived(
    projectId
      ? `/knowledge/toc?project_id=${encodeURIComponent(projectId)}`
      : '/knowledge/toc',
  );
</script>

<div class="mt-4" data-testid="asset-clr-panel">
  <CLRLensPanel
    {title}
    {quality}
    {loading}
    {error}
    {issues}
    {suggestions}
    goalTreeRelevance={lens.goalTreeRelevance}
    showCategories={lens.hasLenses && lens.report != null}
    emptyText="No CLR evaluation yet. The reasoning pipeline writes per-statement CLR lenses (and the structural scorer runs) when this asset is reviewed."
  />

  {#if lens.tracesTo || lens.notes}
    <dl class="mt-2 space-y-1 text-xs" data-testid="asset-clr-lens-detail">
      {#if lens.tracesTo}
        <div class="flex gap-1">
          <dt class="font-medium text-[var(--color-text-muted)]">Traces to:</dt>
          <dd class="text-[var(--color-text)]">{lens.tracesTo}</dd>
        </div>
      {/if}
      {#if lens.notes}
        <div class="flex gap-1">
          <dt class="font-medium text-[var(--color-text-muted)]">CLR notes:</dt>
          <dd class="text-[var(--color-text)]">{lens.notes}</dd>
        </div>
      {/if}
    </dl>
  {/if}

  <div class="mt-2 text-right">
    <a
      href={reasoningHref}
      class="text-xs text-[var(--color-accent)] hover:underline"
      data-testid="asset-clr-open-reasoning"
    >
      Open reasoning view →
    </a>
  </div>
</div>
