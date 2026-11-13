<!--
  TocToolResult.svelte — renders the result of a `toc.*` agent action inside a
  chat ToolCallCard's `children` slot. Maps the action name + its output
  envelope to the matching TOC visualisation:

    toc.get_graph     → { graph } → TocTreeView (compact)
    toc.get_quality   → { quality } → CLRLensPanel (8-CLR grid)
    toc.list_trees    → { items } → compact tree list
    toc.build_* / evaporate_* / evaluate_* (writes) → execution-id note

  Decoupled + defensive: the output may arrive as an object OR a JSON string
  (the chat store keeps `output: unknown`); both are handled. Anything it can't
  render returns nothing (`shouldRender=false`), so MessageList falls back to
  the plain summary text. Pure presentation — no fetching. Every field is
  rendered from `redactForDisplay(output)` (lib/api/agent-redact.ts).
-->
<script lang="ts">
  import type { TocGraph, ClrQuality, TocTree } from '$lib/api/toc';
  import TocTreeView from './TocTreeView.svelte';
  import CLRLensPanel from './CLRLensPanel.svelte';
  import { treeTypeLabel } from './palette';
  import { redactForDisplay } from '$lib/api/agent-redact';

  let {
    action,
    output,
  }: {
    action: string;
    output: unknown;
  } = $props();

  // Normalise the output into a plain object envelope.
  const env = $derived.by<Record<string, unknown> | null>(() => {
    let v: unknown = output;
    if (typeof v === 'string') {
      try {
        v = JSON.parse(v);
      } catch {
        return null;
      }
    }
    // ⛔ fr-agui SPEC §10.1: this renders AGENT tool output, so every field is
    // painted from the agent-redact view (secret-named keys, PII keys,
    // secret-shaped strings), never from the raw envelope.
    return v && typeof v === 'object' ? redactForDisplay(v as Record<string, unknown>) : null;
  });

  const graph = $derived(
    action === 'toc.get_graph' && env?.graph && typeof env.graph === 'object'
      ? (env.graph as TocGraph)
      : null,
  );
  const quality = $derived(
    action === 'toc.get_quality' &&
      env?.quality &&
      typeof env.quality === 'object'
      ? (env.quality as ClrQuality)
      : null,
  );
  const items = $derived(
    action === 'toc.list_trees' && Array.isArray(env?.items)
      ? (env!.items as TocTree[])
      : null,
  );
  const executionId = $derived(
    typeof env?.executionId === 'string' ? (env.executionId as string) : null,
  );
  const isWrite = $derived(
    action === 'toc.build_io_map' ||
      action === 'toc.evaporate_conflict' ||
      action === 'toc.evaluate_lenses',
  );
</script>

{#if graph}
  <div class="h-72 overflow-auto" data-testid="toc-tool-graph">
    <TocTreeView {graph} />
  </div>
{:else if quality}
  <div data-testid="toc-tool-quality">
    <CLRLensPanel {quality} title="CLR Quality (8 categories)" />
  </div>
{:else if items}
  {#if items.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="toc-tool-empty">
      No reasoning trees found.
    </p>
  {:else}
    <ul class="space-y-1" data-testid="toc-tool-list">
      {#each items as tree (tree.id)}
        <li class="flex items-center gap-2 text-xs">
          <span class="text-[10px] uppercase text-[var(--color-text-muted)] w-28 shrink-0 truncate">
            {treeTypeLabel(tree.tree_type)}
          </span>
          <a
            href={`/knowledge/toc?tree_id=${encodeURIComponent(tree.id)}`}
            class="text-[var(--color-text)] hover:underline truncate"
            title={tree.title}
          >
            {tree.title}
          </a>
        </li>
      {/each}
    </ul>
  {/if}
{:else if isWrite && executionId}
  <p class="text-xs text-[var(--color-text-muted)]" data-testid="toc-tool-exec">
    Reasoning workflow triggered — execution
    <span class="font-mono text-[var(--color-text)]">{executionId}</span>.
    <a
      href="/knowledge/toc"
      class="text-[var(--color-accent)] hover:underline">View results →</a
    >
  </p>
{/if}
