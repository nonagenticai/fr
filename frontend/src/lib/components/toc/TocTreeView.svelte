<!--
  TocTreeView.svelte — dispatcher that renders the right TOC visualisation for
  a tree's `tree_type`, plus a shared edge-semantics legend:
   - evaporating_cloud → EvaporatingCloud (fixed 5-box)
   - io_map / prt / trt → IOMapTree (tidy hierarchy)
   - crt / frt / other  → CRTTree (force, cause-effect)
  Decoupled from the API — takes a TocGraph.
-->
<script lang="ts">
  import type { TocGraph, TocNode } from '$lib/api/toc';
  import EvaporatingCloud from './EvaporatingCloud.svelte';
  import IOMapTree from './IOMapTree.svelte';
  import CRTTree from './CRTTree.svelte';
  import { EDGE_KIND_COLORS, treeTypeLabel } from './palette';

  let {
    graph,
    onnodeclick,
  }: {
    graph: TocGraph;
    onnodeclick?: (node: TocNode) => void;
  } = $props();

  const kind = $derived(graph.tree.tree_type);
  const isCloud = $derived(kind === 'evaporating_cloud');
  const isHierarchy = $derived(kind === 'io_map' || kind === 'prt' || kind === 'trt');

  // Edge kinds actually present (drives the legend).
  const presentEdgeKinds = $derived(
    Object.keys(EDGE_KIND_COLORS).filter((k) =>
      graph.edges.some((e) => e.relationship_type === k),
    ),
  );
</script>

<div class="flex flex-col h-full" data-testid="toc-tree-view">
  <div class="flex flex-wrap items-center gap-3 mb-2 text-xs">
    <span class="font-medium text-[var(--color-text)]">{treeTypeLabel(kind)}</span>
    {#each presentEdgeKinds as ek (ek)}
      <span class="inline-flex items-center gap-1.5 text-[var(--color-text-muted)]">
        <span class="inline-block w-4 h-0.5" style={`background-color: ${EDGE_KIND_COLORS[ek]}`}></span>
        {ek}
      </span>
    {/each}
  </div>

  {#if graph.nodes.length === 0}
    <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center" data-testid="toc-tree-empty">
      This reasoning tree has no nodes yet.
    </p>
  {:else if isCloud}
    <div class="flex-1 border border-[var(--color-border)] rounded-lg p-4 overflow-auto">
      <EvaporatingCloud {graph} />
    </div>
  {:else if isHierarchy}
    <div class="flex-1 min-h-[600px] border border-[var(--color-border)] rounded-lg overflow-hidden">
      <IOMapTree {graph} {onnodeclick} />
    </div>
  {:else}
    <div class="flex-1 min-h-[600px] border border-[var(--color-border)] rounded-lg overflow-hidden">
      <CRTTree {graph} {onnodeclick} />
    </div>
  {/if}
</div>
