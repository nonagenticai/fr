<!--
  StickyNote.svelte — n8n stickyNote nodes rendered as a colored card
  underlay in the canvas. Width/height come from the node's parameters
  (the adapter pulls them out into data.sticky); content is rendered
  as plain text — no markdown, since the viewer's job is fidelity to
  n8n's source not richer rendering.
-->
<script lang="ts">
  import type { NodeProps } from '@xyflow/svelte';

  interface StickyData extends Record<string, unknown> {
    sticky?: {
      content: string;
      width: number;
      height: number;
    };
    name: string;
    nodeType: string;
  }

  const props: NodeProps & { data: StickyData } = $props();
  const data = $derived(props.data);
  const sticky = $derived(data.sticky ?? { content: '', width: 240, height: 120 });
</script>

<div
  class="sticky"
  style="width: {sticky.width}px; height: {sticky.height}px;"
>
  <pre>{sticky.content}</pre>
</div>

<style>
  .sticky {
    box-sizing: border-box;
    padding: 12px 14px;
    background: var(--color-warning-bg);
    border: 1px solid var(--color-warning-border);
    border-radius: 6px;
    color: var(--color-text);
    font-family: var(--font-sans, system-ui);
    font-size: 12px;
    line-height: 1.4;
    overflow: auto;
    pointer-events: auto;
  }
  .sticky pre {
    margin: 0;
    font-family: inherit;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
