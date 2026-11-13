<!--
  N8nNode.svelte — custom Svelte Flow node renderer for n8n nodes.

  Displays the bundled icon (or fallback), the node name, and the n8n
  type as a small badge. Source/target Handles default to id `main-0`,
  matching the adapter's edge `sourceHandle` / `targetHandle` strings
  for single-output nodes. For multi-output nodes (IF / Switch) the
  adapter emits `main-1`, `main-2`, … — to keep things simple we emit
  up to 4 source handles vertically stacked; extra branches fall back
  to invisible handles that still route correctly because the handle
  *id* is what edges reference.
-->
<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';
  import { Handle, Position } from '@xyflow/svelte';
  import { iconFor, ICON_FALLBACK } from './iconManifest';

  import type { NodeDiffStatus } from './adapter';

  interface NodeData extends Record<string, unknown> {
    name: string;
    nodeType: string;
    typeVersion?: number;
    parameters: Record<string, unknown>;
    /** Diff annotation (graph-diff view only); unset in the plain viewer. */
    diffStatus?: NodeDiffStatus;
  }

  const props: NodeProps & { data: NodeData } = $props();
  const data = $derived(props.data);
  const selected = $derived(props.selected);
  const diffStatus = $derived(data.diffStatus);

  // Multi-output handles — n8n IF and Switch nodes produce up to 4
  // outputs in practice. The adapter emits one edge per handle id.
  const SOURCE_HANDLE_COUNT = 4;
  const sourceHandles = Array.from({ length: SOURCE_HANDLE_COUNT }, (_, i) => `main-${i}`);

  const iconSrc = $derived(iconFor(data.nodeType));
  const shortType = $derived(data.nodeType.split('.').pop() ?? data.nodeType);
</script>

<div
  class="n8n-node"
  class:selected
  class:diff-added={diffStatus === 'added'}
  class:diff-changed={diffStatus === 'changed'}
  class:diff-removed={diffStatus === 'removed'}
  class:diff-failing={diffStatus === 'failing'}
  class:diff-guard={diffStatus === 'guard'}
  data-node-type={data.nodeType}
  data-diff-status={diffStatus}
>
  <Handle type="target" position={Position.Left} id="main-0" />
  <div class="n8n-node-body">
    <img
      src={iconSrc}
      alt=""
      class="n8n-node-icon"
      onerror={(e) => ((e.currentTarget as HTMLImageElement).src = ICON_FALLBACK)}
    />
    <div class="n8n-node-text">
      <div class="n8n-node-name" title={data.name}>{data.name}</div>
      <div class="n8n-node-type" title={data.nodeType}>{shortType}</div>
    </div>
  </div>
  {#each sourceHandles as id, i (id)}
    <Handle
      type="source"
      position={Position.Right}
      {id}
      style="top: {((i + 1) * 100) / (SOURCE_HANDLE_COUNT + 1)}%;"
    />
  {/each}
</div>

<style>
  .n8n-node {
    box-sizing: border-box;
    width: 200px;
    min-height: 56px;
    padding: 10px 12px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
    color: var(--color-text);
    font-size: 13px;
    line-height: 1.2;
    cursor: pointer;
    transition: border-color 120ms ease, box-shadow 120ms ease;
  }
  .n8n-node:hover {
    border-color: var(--color-accent);
  }
  .n8n-node.selected {
    border-color: var(--color-accent);
    box-shadow: 0 0 0 2px var(--color-accent-bg);
  }
  /* Graph-diff annotation — token families shared with ui/Tag tones. A trailing
     `.selected` still wins the ring; the diff border stays underneath. */
  .n8n-node.diff-added {
    border-color: var(--color-success-border);
    background: var(--color-success-bg);
  }
  .n8n-node.diff-changed {
    border-color: var(--color-warning-border);
    background: var(--color-warning-bg);
  }
  .n8n-node.diff-failing {
    border-color: var(--color-danger-border);
    background: var(--color-danger-bg);
  }
  .n8n-node.diff-guard {
    border-color: var(--color-info-border);
    background: var(--color-info-bg);
  }
  .n8n-node.diff-removed {
    border-style: dashed;
    opacity: 0.55;
  }
  .n8n-node-body {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .n8n-node-icon {
    flex: 0 0 auto;
    width: 28px;
    height: 28px;
    object-fit: contain;
  }
  .n8n-node-text {
    flex: 1 1 auto;
    min-width: 0;
  }
  .n8n-node-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .n8n-node-type {
    margin-top: 2px;
    font-size: 11px;
    color: var(--color-text-muted);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
