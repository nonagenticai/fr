<!--
  Traceability graph (control-plane roadmap Phase 8). Rendered by
  /knowledge/graph (whole tenant) and /projects/[id]/traceability (`projectId`
  set: only relationships requirements_management stamped with that project).

  Renders requirements_management's cross-domain architecture_relationships as a
  force-directed graph spanning the 5D asset space (principles → requirements →
  decisions → architecture → PM). Nodes are coloured by dimension
  and click through to their asset detail page; edges are relationship rows.

  Whole-graph by default; `?root_type=<table>&root_id=<uuid>[&depth=N]` centres
  on one entity (the per-asset neighbour panels deep-link here with a root).
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    fetchTraceabilityGraph,
    type TraceGraph,
    type TraceNode,
  } from '$lib/api/traceability';
  import TraceabilityGraph from '$lib/components/traceability/TraceabilityGraph.svelte';
  import { DIMENSION_COLORS, DIMENSION_LABELS, DIMENSION_ORDER } from '$lib/components/traceability/palette';
  import type { TraceDimension } from '$lib/api/traceability';

  let { projectId, basePath = '/knowledge/graph' }: { projectId?: string; basePath?: string } = $props();

  let graph = $state<TraceGraph | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const rootType = $derived($page.url.searchParams.get('root_type') ?? undefined);
  const rootId = $derived($page.url.searchParams.get('root_id') ?? undefined);
  const rooted = $derived(Boolean(rootType && rootId));

  async function load() {
    loading = true;
    error = null;
    try {
      graph = await fetchTraceabilityGraph(
        rooted ? { rootType, rootId, depth: 2, projectId } : { projectId },
      );
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      graph = null;
    } finally {
      loading = false;
    }
  }

  // Load on mount and whenever the root query changes (deep-link from a
  // neighbour panel). Guarded so unrelated reactive reads don't re-fetch.
  let lastKey: string | null = null;
  $effect(() => {
    const key = `${projectId ?? ''}|${rootType ?? ''}|${rootId ?? ''}`;
    if (key !== lastKey) {
      lastKey = key;
      load();
    }
  });

  function onNodeClick(node: TraceNode) {
    if (node.route) goto(node.route);
  }

  // Which dimensions actually appear (drives the legend / filter).
  const presentDimensions = $derived(
    DIMENSION_ORDER.filter((d) => graph?.nodes.some((n) => n.dimension === d)),
  );

  // Dimension filter. We track which dimensions are toggled OFF so the default
  // (empty) shows everything and survives a refresh without re-seeding. Each
  // toggle reassigns a new Set so the derived `visibleDimensions` (and the
  // prop passed to the graph) changes by reference and the graph re-renders.
  let hiddenDimensions = $state<Set<TraceDimension>>(new Set());
  const visibleDimensions = $derived(
    new Set(presentDimensions.filter((d) => !hiddenDimensions.has(d))),
  );

  function toggleDimension(dim: TraceDimension) {
    const next = new Set(hiddenDimensions);
    if (next.has(dim)) next.delete(dim);
    else next.add(dim);
    hiddenDimensions = next;
  }
</script>

<div class="flex flex-col h-full" data-testid="traceability-page">
  <header class="flex flex-wrap items-center gap-3 mb-4">
    <div>
      <h1 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
        Traceability
      </h1>
      <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Cross-domain links across the 5D asset space — architecture, requirements,
        decisions, principles and project management.
      </p>
    </div>

    {#if rooted}
      <a
        href={basePath}
        class="px-3 py-1 bg-[var(--color-surface)] text-[var(--color-text)] text-sm rounded hover:bg-[var(--color-surface-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]"
        data-testid="traceability-whole-graph"
      >
        View whole graph
      </a>
    {/if}

    <span class="ml-auto text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      {#if graph}
        {graph.meta.node_count} nodes · {graph.meta.link_count} links
        {#if graph.meta.truncated}
          <span class="ml-2 px-2 py-0.5 bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] rounded font-medium">
            truncated
          </span>
        {/if}
      {/if}
    </span>

    <button
      type="button"
      onclick={load}
      disabled={loading}
      class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      data-testid="traceability-refresh"
    >
      {loading ? '…' : 'Refresh'}
    </button>
  </header>

  {#if presentDimensions.length > 0}
    <div class="flex flex-wrap items-center gap-2 mb-3 text-xs" data-testid="traceability-legend">
      {#each presentDimensions as dim (dim)}
        {@const hidden = hiddenDimensions.has(dim)}
        <button
          type="button"
          onclick={() => toggleDimension(dim)}
          class="inline-flex items-center gap-1.5 px-2 py-1 rounded-full border border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] dark:border-[var(--color-border)] dark:text-[var(--color-text-muted)]"
          class:opacity-40={hidden}
          aria-pressed={!hidden}
          title={hidden ? `Show ${DIMENSION_LABELS[dim]}` : `Hide ${DIMENSION_LABELS[dim]}`}
          data-testid="traceability-legend-toggle-{dim}"
        >
          <span
            class="inline-block w-3 h-3 rounded-full"
            style="background-color: {DIMENSION_COLORS[dim]}"
          ></span>
          <span class:line-through={hidden}>{DIMENSION_LABELS[dim]}</span>
        </button>
      {/each}
    </div>
  {/if}

  {#if error}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4" data-testid="traceability-error">
      {error}
    </div>
  {/if}

  {#if loading && !graph}
    <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center dark:text-[var(--color-text-muted)]">
      Loading traceability graph…
    </p>
  {:else if graph && graph.nodes.length === 0}
    <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center dark:text-[var(--color-text-muted)]" data-testid="traceability-empty">
      No traceability links yet. Relationships authored between
      <a href="/library/architecture/elements" class="text-[var(--color-accent)] underline">architecture</a>,
      <a href="/requirements" class="text-[var(--color-accent)] underline">requirements</a> and
      <a href="/decisions" class="text-[var(--color-accent)] underline">decisions</a>
      assets will appear here as a connected graph.
    </p>
  {:else if graph}
    <div class="flex-1 min-h-[600px] border border-[var(--color-border)] rounded-lg overflow-hidden dark:border-[var(--color-border)]" data-testid="traceability-canvas">
      <TraceabilityGraph
        data={{ nodes: graph.nodes, links: graph.links }}
        {visibleDimensions}
        onnodeclick={onNodeClick}
      />
    </div>
  {/if}
</div>
