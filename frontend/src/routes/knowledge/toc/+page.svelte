<!--
  /knowledge/toc — Reasoning (TOC) surface for the Dettmer Logical Thinking
  Process. Lists requirements_management's `/toc` reasoning trees (io_map /
  evaporating_cloud / crt / frt / prt / trt), and for a selected tree renders
  its structure (TocTreeView) + the structural 8-CLR quality report
  (CLRLensPanel). Modelled on /knowledge/graph.

  Query params: ?tree_id=<id> selects a tree; ?tree_type=<type> filters the
  list; ?project_id=<id> scopes the list to a project.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { goto } from '$app/navigation';
  import {
    fetchTocTrees,
    fetchTocGraph,
    fetchTocQuality,
    type TocTree,
    type TocGraph,
    type ClrQuality,
    type TocTreeType,
  } from '$lib/api/toc';
  import TocTreeView from '$lib/components/toc/TocTreeView.svelte';
  import CLRLensPanel from '$lib/components/toc/CLRLensPanel.svelte';
  import CLRScoreBadge from '$lib/components/toc/CLRScoreBadge.svelte';
  import { TREE_TYPE_ORDER, treeTypeLabel, treeTypeColor } from '$lib/components/toc/palette';

  let trees = $state<TocTree[]>([]);
  let graph = $state<TocGraph | null>(null);
  let quality = $state<ClrQuality | null>(null);
  /**
   * The 8-CLR scorer read FAILED — distinct from a tree nobody has scored.
   *
   * ⚠️ `quality = null` fed two surfaces that both assert absence: `CLRLensPanel`
   * renders "No CLR evaluation yet…" and `CLRScoreBadge` renders "—" with the
   * title "Not yet evaluated". So a dead scorer told the reader their tree was
   * unscored, which is a statement about their WORK, not about the service. The
   * panel already takes an `error` prop for exactly this; it was simply never
   * given one. Enrichment for a tree that still renders (`graph` is a separate
   * read) — per-input flag, never a blank.
   */
  let qualityError = $state<string | null>(null);
  let loadingList = $state(true);
  let loadingTree = $state(false);
  let error = $state<string | null>(null);

  const treeTypeFilter = $derived(
    ($page.url.searchParams.get('tree_type') ?? '') as TocTreeType | '',
  );
  const projectId = $derived($page.url.searchParams.get('project_id') ?? undefined);
  const selectedId = $derived($page.url.searchParams.get('tree_id') ?? undefined);

  async function loadList() {
    loadingList = true;
    error = null;
    try {
      trees = await fetchTocTrees({
        treeType: treeTypeFilter || undefined,
        projectId,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      trees = [];
    } finally {
      loadingList = false;
    }
  }

  async function loadTree(id: string) {
    loadingTree = true;
    error = null;
    qualityError = null;
    try {
      // Graph first (the visualisation); quality is best-effort so a scorer
      // hiccup never blanks the tree.
      graph = await fetchTocGraph(id);
      try {
        quality = await fetchTocQuality(id);
        qualityError = null;
      } catch (e) {
        // Still best-effort — a scorer hiccup must not blank the tree. But the
        // reason now reaches the panel's existing `error` prop instead of
        // becoming an unscored-looking null.
        quality = null;
        qualityError = e instanceof Error ? e.message : String(e);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      graph = null;
      quality = null;
      qualityError = null;
    } finally {
      loadingTree = false;
    }
  }

  function setParam(key: string, value: string | undefined) {
    const url = new URL($page.url);
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
    goto(`${url.pathname}${url.search}`, { keepFocus: true, noScroll: true });
  }

  function selectTree(id: string) {
    setParam('tree_id', id);
  }

  // Reload the list when the filter/project changes.
  let lastListKey: string | null = null;
  $effect(() => {
    const key = `${treeTypeFilter}|${projectId ?? ''}`;
    if (key !== lastListKey) {
      lastListKey = key;
      loadList();
    }
  });

  // Load the selected tree (or default to the first one) when selection changes.
  let lastTreeId: string | null = null;
  $effect(() => {
    const id = selectedId ?? trees[0]?.id;
    if (id && id !== lastTreeId) {
      lastTreeId = id;
      loadTree(id);
    }
  });

  const selectedTree = $derived(
    trees.find((t) => t.id === (selectedId ?? trees[0]?.id)) ?? null,
  );
</script>

<div class="flex flex-col h-full" data-testid="toc-page">
  <header class="flex flex-wrap items-center gap-3 mb-4">
    <div>
      <h1 class="text-lg font-semibold text-[var(--color-text)]">Reasoning (TOC)</h1>
      <p class="text-xs text-[var(--color-text-muted)]">
        Theory-of-Constraints logical-thinking trees — objective IO-Maps, CLR
        reasoning lenses, Evaporating-Cloud conflicts and the structural 8-CLR
        quality scorer.
      </p>
    </div>
    <span class="ml-auto text-xs text-[var(--color-text-muted)]">
      {trees.length} tree{trees.length === 1 ? '' : 's'}
    </span>
  </header>

  <!-- tree-type segmented toggle -->
  <div class="flex flex-wrap items-center gap-1 mb-4" data-testid="toc-type-filter">
    <button
      type="button"
      onclick={() => setParam('tree_type', undefined)}
      class={`px-2.5 py-1 text-xs rounded border ${treeTypeFilter === '' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)] border-[var(--color-accent)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'}`}
    >
      All
    </button>
    {#each TREE_TYPE_ORDER as t (t)}
      <button
        type="button"
        onclick={() => setParam('tree_type', t)}
        class={`px-2.5 py-1 text-xs rounded border ${treeTypeFilter === t ? 'text-[var(--color-on-primary)]' : 'border-[var(--color-border)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)]'}`}
        style={treeTypeFilter === t ? `background-color: ${treeTypeColor(t)}; border-color: ${treeTypeColor(t)};` : ''}
      >
        {treeTypeLabel(t)}
      </button>
    {/each}
  </div>

  {#if error}
    <div class="bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4" data-testid="toc-error">
      {error}
    </div>
  {/if}

  <div class="flex flex-1 gap-4 min-h-0">
    <!-- tree list -->
    <aside class="w-64 shrink-0 overflow-y-auto border border-[var(--color-border)] rounded-lg p-2" data-testid="toc-list">
      {#if loadingList}
        <p class="text-xs text-[var(--color-text-muted)] p-2">Loading trees…</p>
      {:else if trees.length === 0}
        <p class="text-xs text-[var(--color-text-muted)] p-2">
          No TOC trees yet. The AA workflows author IO-Maps on project start and
          Evaporating Clouds on QA conflicts.
        </p>
      {:else}
        <ul class="space-y-1">
          {#each trees as t (t.id)}
            {@const active = t.id === (selectedId ?? trees[0]?.id)}
            <li>
              <button
                type="button"
                onclick={() => selectTree(t.id)}
                class={`w-full text-left px-2 py-1.5 rounded text-sm ${active ? 'bg-[var(--color-surface-strong)]' : 'hover:bg-[var(--color-surface)]'}`}
              >
                <span class="flex items-center gap-1.5">
                  <span class="inline-block w-2 h-2 rounded-full shrink-0" style={`background-color: ${treeTypeColor(t.tree_type)}`}></span>
                  <span class="truncate text-[var(--color-text)]">{t.title}</span>
                </span>
                <span class="block text-[10px] text-[var(--color-text-muted)] mt-0.5 ml-3.5">
                  {treeTypeLabel(t.tree_type)}
                </span>
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    </aside>

    <!-- selected tree -->
    <div class="flex-1 flex flex-col min-w-0 gap-4">
      {#if selectedTree}
        <div class="flex items-center gap-3 flex-wrap">
          <h2 class="text-base font-semibold text-[var(--color-text)] truncate">{selectedTree.title}</h2>
          {#if qualityError !== null && selectedTree.quality_score == null}
            <span
              class="text-xs text-[var(--color-warning-text)]"
              data-testid="toc-quality-unreadable"
            >
              CLR score unreadable — this tree is NOT known to be unscored.
            </span>
          {:else}
            <CLRScoreBadge score={selectedTree.quality_score ?? quality?.score ?? null} />
          {/if}
        </div>
      {/if}

      {#if loadingTree && !graph}
        <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center">Loading reasoning tree…</p>
      {:else if graph}
        <div class="flex-1 min-h-0">
          <TocTreeView {graph} />
        </div>
        <CLRLensPanel {quality} error={qualityError} />
      {:else if !loadingList && trees.length > 0}
        <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center">Select a reasoning tree.</p>
      {/if}
    </div>
  </div>
</div>
