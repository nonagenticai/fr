<!--
  WorkflowCanvas.svelte — wraps Svelte Flow with a read-only n8n look.

  Pass an n8n workflow JSON; the adapter converts to Svelte Flow's
  {nodes, edges} shape and the canvas renders. Selection is reactive
  via the `onNodeClick` prop so a parent page can pop a side panel.
-->
<script lang="ts">
  import {
    SvelteFlow,
    Background,
    Controls,
    type Node as FlowNodeRaw,
    type Edge as FlowEdgeRaw,
  } from '@xyflow/svelte';
  import '@xyflow/svelte/dist/style.css';

  import { toFlow, type N8nWorkflow, type FlowNode, type NodeDiffStatus } from './adapter';
  import { dagreLayout, detectOverlap } from './autoLayout';
  import N8nNode from './N8nNode.svelte';
  import StickyNote from './StickyNote.svelte';

  /**
   * Layout strategy:
   *   - 'n8n'   → honor positions baked into the n8n JSON.
   *   - 'dagre' → re-layout non-sticky nodes via dagre (left-to-right).
   *   - 'auto'  → run dagre if any non-sticky nodes overlap, else 'n8n'.
   */
  export type LayoutMode = 'auto' | 'n8n' | 'dagre';

  interface Props {
    workflow: N8nWorkflow;
    layout?: LayoutMode;
    onNodeSelect?: (node: FlowNode | null) => void;
    /**
     * Optional per-node diff status (node name → status), painted onto nodes for
     * the workflow-improvement graph-diff view. Omitted ⇒ plain read-only viewer.
     */
    diffByNode?: Record<string, NodeDiffStatus>;
  }
  const { workflow, layout = 'auto', onNodeSelect, diffByNode }: Props = $props();

  const flow = $derived(toFlow(workflow, diffByNode));

  // Apply auto-layout when requested. Sticky notes always keep their
  // original positions; only flow nodes are re-laid-out.
  const laidOutNodes = $derived.by(() => {
    const useDagre =
      layout === 'dagre' ||
      (layout === 'auto' && detectOverlap(flow.nodes));
    if (!useDagre) return flow.nodes;
    const positions = dagreLayout(flow.nodes, flow.edges);
    return flow.nodes.map((n) => {
      const p = positions.get(n.id);
      return p ? { ...n, position: p } : n;
    });
  });

  // SvelteFlow expects a $state-bound array. We rebuild from `flow` as a
  // derivation but Svelte Flow mutates these in place for selection /
  // viewport tracking, so we keep an explicit reactive copy.
  let nodes = $state<FlowNodeRaw[]>([]);
  let edges = $state<FlowEdgeRaw[]>([]);

  $effect(() => {
    nodes = laidOutNodes.map((n) => ({
      id: n.id,
      type: n.type,
      position: n.position,
      data: n.data,
    })) as FlowNodeRaw[];
    edges = flow.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle,
      targetHandle: e.targetHandle,
      type: 'smoothstep',
      animated: false,
    })) as FlowEdgeRaw[];
  });

  // Cast: our custom node components require a tighter `data` shape than
  // Svelte Flow's `Record<string, unknown>` index signature. The adapter
  // guarantees the data shape so this assertion is safe at runtime.
  const nodeTypes = { n8n: N8nNode, sticky: StickyNote } as unknown as Record<
    string,
    typeof N8nNode
  >;

  function handleNodeClick(event: { node: FlowNodeRaw }) {
    const match = laidOutNodes.find((n) => n.id === event.node.id) ?? null;
    onNodeSelect?.(match);
  }

  function handlePaneClick() {
    onNodeSelect?.(null);
  }
</script>

<div class="canvas-wrap">
  <SvelteFlow
    bind:nodes
    bind:edges
    {nodeTypes}
    fitView
    nodesDraggable={false}
    nodesConnectable={false}
    elementsSelectable
    minZoom={0.2}
    maxZoom={2}
    onnodeclick={handleNodeClick}
    onpaneclick={handlePaneClick}
  >
    <Background />
    <Controls showLock={false} />
  </SvelteFlow>
</div>

<style>
  .canvas-wrap {
    position: relative;
    width: 100%;
    height: 100%;
    min-height: 480px;
    background: var(--color-surface);
  }
  .canvas-wrap :global(.svelte-flow__attribution) {
    display: none;
  }
</style>
