<!--
  AssetRelationships.svelte

  Per-asset traceability neighbour panel (control-plane roadmap Phase 8). Given
  an entity's upstream table name + id, fetches its 1-hop neighbourhood from
  `GET /api/traceability/graph?root_type=&root_id=&depth=1` and lists the linked
  assets (each a link into its own detail page) with the relationship type.

  Distinct from RelatedAssets.svelte (which lists a *manifest's* global asset
  list) — this reads the polymorphic architecture_relationships edge set, so it
  shows true cross-domain neighbours. A "View in graph" link deep-links to the
  full traceability surface centred on this entity.
-->
<script lang="ts">
  import {
    fetchTraceabilityGraph,
    deriveNeighbours,
    type Neighbour,
  } from '$lib/api/traceability';
  import { DIMENSION_LABELS } from '$lib/components/traceability/palette';
  import type { TraceDimension } from '$lib/api/traceability';

  let {
    entityType,
    entityId,
    label,
  }: {
    entityType: string;
    entityId: string;
    label?: string;
  } = $props();

  let neighbours = $state<Neighbour[]>([]);
  let loading = $state(true);
  let error = $state<string | null>(null);

  const graphHref = $derived(
    `/knowledge/graph?root_type=${encodeURIComponent(entityType)}&root_id=${encodeURIComponent(entityId)}`,
  );

  $effect(() => {
    const type = entityType;
    const id = entityId;
    const self = `${type}:${id}`;
    loading = true;
    error = null;
    fetchTraceabilityGraph({ rootType: type, rootId: id, depth: 1 })
      .then((g) => {
        neighbours = deriveNeighbours(g.nodes, g.links, self);
      })
      .catch((e) => {
        error = e instanceof Error ? e.message : String(e);
      })
      .finally(() => {
        loading = false;
      });
  });

  function dimLabel(d: string): string {
    return DIMENSION_LABELS[d as TraceDimension] ?? d;
  }
</script>

<section class="bg-[var(--color-bg)] rounded-lg border border-[var(--color-border)] p-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]" data-testid="asset-relationships">
  <div class="flex items-center justify-between mb-2">
    <h3 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
      {label ?? 'Traceability'}
    </h3>
    {#if neighbours.length > 0}
      <a class="text-xs text-[var(--color-accent)] hover:underline" href={graphHref} data-testid="asset-relationships-graph-link">
        View in graph →
      </a>
    {/if}
  </div>

  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-danger)]">Error: {error}</p>
  {:else if neighbours.length === 0}
    <p class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      No linked assets yet.
    </p>
  {:else}
    <ul class="space-y-1.5 text-sm">
      {#each neighbours as n (n.node.id + '|' + n.relType + '|' + n.direction)}
        <li class="flex items-center gap-2">
          <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)] shrink-0">
            {n.direction === 'outgoing' ? n.relType : `${n.relType} (in)`}
          </span>
          {#if n.node.route}
            <a class="text-[var(--color-accent)] hover:underline truncate" href={n.node.route}>
              {n.node.label}
            </a>
          {:else}
            <span class="text-[var(--color-text)] dark:text-[var(--color-text)] truncate">{n.node.label}</span>
          {/if}
          <span class="ml-auto text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)] shrink-0">
            {dimLabel(n.node.dimension)}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
