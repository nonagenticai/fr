<!--
  /projects/[id]/reasoning — the Logical Thinking Process evidence (INSPECT).
  Lists this project's TOC trees and renders the right structure per tree_type:
  CRT/FRT/PRT/TRT → CRTTree, io_map / necessity / sufficiency → IOMapTree,
  evaporating_cloud → EvaporatingCloud.

  ⚠️ TWO ERROR LANES, DELIBERATELY. One shared `error` was written by BOTH the
  tree LIST load and every per-tree GRAPH load, and the template checked it
  ABOVE the list branch — so a single failed `fetchTocGraph` (one tree, possibly
  the auto-selected first one) replaced the whole page with an error banner and
  deleted the navigation to every OTHER tree, which had loaded fine. `listError`
  is the only one that may take the page; `treeError` renders inside the graph
  pane, beside the list that still works.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import {
    fetchTocTrees,
    fetchTocGraph,
    type TocTree,
    type TocGraph,
  } from '$lib/api/toc';
  import CRTTree from '$lib/components/toc/CRTTree.svelte';
  import IOMapTree from '$lib/components/toc/IOMapTree.svelte';
  import EvaporatingCloud from '$lib/components/toc/EvaporatingCloud.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';

  const projectId = $derived(page.params.id ?? '');

  let trees = $state<TocTree[]>([]);
  let selectedId = $state<string | null>(null);
  let graph = $state<TocGraph | null>(null);
  let loading = $state(true);
  let graphLoading = $state(false);
  /** The LIST read failed — there is nothing to navigate, so this owns the page. */
  let listError = $state<string | null>(null);
  /** The selected tree's GRAPH read failed — scoped to the graph pane. */
  let treeError = $state<string | null>(null);

  onMount(async () => {
    if (!projectId) {
      loading = false;
      return;
    }
    try {
      trees = await fetchTocTrees({ projectId });
    } catch (e) {
      listError = e instanceof Error ? e.message : 'Failed to load reasoning trees';
      loading = false;
      return;
    }
    loading = false;
    // OUTSIDE the try above, on purpose: `select` owns its own failure now, and
    // letting it throw into the list's catch is what conflated the two lanes.
    if (trees.length > 0) await select(trees[0].id);
  });

  async function select(treeId: string) {
    selectedId = treeId;
    graphLoading = true;
    graph = null;
    treeError = null;
    try {
      graph = await fetchTocGraph(treeId);
    } catch (e) {
      treeError = e instanceof Error ? e.message : 'Failed to load tree';
    } finally {
      graphLoading = false;
    }
  }

  const selectedTree = $derived(trees.find((t) => t.id === selectedId) ?? null);
  // EvaporatingCloud + CRT family vs the tidy-tree IO-map family.
  const isCloud = $derived(selectedTree?.tree_type === 'evaporating_cloud');
  const isCrt = $derived(
    ['crt', 'frt', 'prt', 'trt'].includes(String(selectedTree?.tree_type)),
  );
</script>

<ProjectInspectHeader
  {projectId}
  title="Reasoning (LTP)"
  subtitle="The Logical Thinking Process behind this project — objective IO-maps, cause-effect trees, and conflict clouds. Evidence for how the work was reasoned out."
/>

<div class="p-6">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading reasoning trees…</p>
  {:else if listError}
    <div
      data-testid="reasoning-list-error"
      class="rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {listError}
    </div>
  {:else if trees.length === 0}
    <div
      class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
    >
      No reasoning trees for this project yet. The system authors these as it analyses the work.
    </div>
  {:else}
    <div class="grid grid-cols-1 gap-4 lg:grid-cols-[240px_minmax(0,1fr)]">
      <aside class="flex flex-col gap-1" data-testid="reasoning-tree-list">
        {#each trees as t (t.id)}
          <button
            type="button"
            data-testid="reasoning-tree-item"
            onclick={() => select(t.id)}
            class="rounded-[var(--radius-md)] px-3 py-2 text-left text-sm {selectedId === t.id
              ? 'bg-[var(--color-accent-bg)] font-semibold text-[var(--color-accent-strong)]'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'}"
          >
            <span class="block truncate">{t.title}</span>
            <span class="text-[11px] uppercase tracking-wider opacity-70">{t.tree_type}</span>
          </button>
        {/each}
      </aside>

      <div class="min-h-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
        {#if graphLoading}
          <p class="p-4 text-sm text-[var(--color-text-muted)]">Loading tree…</p>
        {:else if treeError}
          <!-- Scoped to THIS tree. The list beside it is still navigable —
               picking another tree clears this and fetches that one. -->
          <div
            data-testid="reasoning-tree-error"
            role="alert"
            class="m-2 rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
          >
            {treeError}
          </div>
        {:else if graph}
          {#if isCloud}
            <EvaporatingCloud {graph} />
          {:else if isCrt}
            <CRTTree {graph} />
          {:else}
            <IOMapTree {graph} />
          {/if}
        {/if}
      </div>
    </div>
  {/if}
</div>
