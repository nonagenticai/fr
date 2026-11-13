<!--
  KagSubgraphView — presentational wrapper that renders a KAG subgraph payload.

  The subgraph API returns edges keyed `{source_id, target_id, type, properties}`,
  a shape `KagGraph`'s internal edge picker silently drops. This wrapper pre-maps the
  edges through `mapSubgraphEdges` (graph-normalise) before handing them to `KagGraph`
  as `relationships`, and shows a friendly empty state when there are no nodes.
-->
<script lang="ts">
  import KagGraph from './KagGraph.svelte';
  import { mapSubgraphEdges } from './graph-normalise';

  interface Props {
    nodes: Array<Record<string, unknown>>;
    edges: Array<Record<string, unknown>>;
    height?: number;
  }

  const { nodes, edges, height = 360 }: Props = $props();

  const mapped = $derived(mapSubgraphEdges(edges));
</script>

<div data-testid="kag-subgraph-view">
  {#if nodes.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">No subgraph nodes to display.</p>
  {:else}
    <KagGraph {nodes} relationships={mapped} {height} />
  {/if}
</div>
