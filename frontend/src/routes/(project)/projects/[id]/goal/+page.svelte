<!--
  /projects/[id]/goal — Goal integrity (STEER): the decompose↔recompose trust
  surface. Your request → epics/enablers/features/cards → roll-up to the
  deliverable. Fed from the project's IO-map TOC graph, flattened into the
  IntegrityTree nesting via stratifyTree (source = parent, target = child).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/stores';
  import {
    fetchTocTrees,
    fetchTocGraph,
    selectCurrentTree,
    type TocTree,
    type TocGraph,
    type TocTreeSelection,
  } from '$lib/api/toc';
  import IntegrityTree, {
    buildIntegrityNodes,
    type IntegrityNode,
  } from '$lib/components/goal/IntegrityTree.svelte';
  import IOMapTree from '$lib/components/toc/IOMapTree.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import ApprovedScopeSection from '$lib/components/cockpit/ApprovedScopeSection.svelte';
  import { fetchProjectCockpit } from '$lib/api/cockpit';
  import { ApiError } from '$lib/api/unified-client';
  import type { Panel } from '$lib/types/panel';
  import type { ApprovedScope } from '$lib/types/cockpit';

  const projectId = $derived($page.params.id ?? '');

  let tree = $state<TocTree | null>(null);
  /** How `tree` was chosen out of the set this project owns. See the banner. */
  let selection = $state<TocTreeSelection | null>(null);
  let graph = $state<TocGraph | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let view = $state<'integrity' | 'iomap'>('integrity');

  // ⭐ THE SUBSTITUTION, and why this page reads the cockpit at all.
  //
  // The IntegrityTree renders an EMPTY tree whenever the TOC graph is empty —
  // which is every project still parked on `request`, i.e. every project that
  // was never decomposed. An empty decomposition tree looks like "your goal
  // broke down into nothing", when the truth is that decomposition has not
  // happened yet and something WAS in fact agreed: the approved scope.
  //
  // So when the graph is empty we show the approved scope INSTEAD. That needs
  // the cockpit read-model's `deliverables` block — ONE read-model call, the
  // same contract the cockpit page holds, not a per-widget fetch.
  let scope = $state<Panel<ApprovedScope> | null>(null);
  let projectUnreadable = $state(false);

  // ⛔ THE BADGE USED TO BE DERIVED FROM DEPTH. `KIND_BY_DEPTH` mapped a node's
  // level in the tree onto ['goal','epic','enabler','feature','card'], and four
  // of those five words are not values the upstream has ever written: measured
  // over `requirements_api.toc_nodes` (11,926 rows) the vocabulary is
  // necessary_condition 5,811 · csf 4,171 · goal 1,912, then 32 rows across
  // requirement / prerequisite / assumption / injection / objective. So the
  // badge asserted a taxonomy that does not exist, and a node's "kind" MOVED
  // whenever an edge changed. `node_kind` was on `TocNode` the whole time and
  // the sibling views (IOMapTree, CRTTree, EvaporatingCloud) already read it.
  //
  // `buildIntegrityNodes` lives in the component's module rather than here
  // precisely so it can be unit-tested — as a closure in this file the defect
  // was unreachable from any test.
  const integrity = $derived<IntegrityNode[]>(graph ? buildIntegrityNodes(graph) : []);

  onMount(async () => {
    if (!projectId) {
      loading = false;
      return;
    }
    try {
      // Prefer an IO-map (the objective decomposition); fall back to any tree.
      let trees = await fetchTocTrees({ projectId, treeType: 'io_map' });
      if (trees.length === 0) trees = await fetchTocTrees({ projectId });
      // ⛔ NOT `trees[0]`. That is upstream row order, not a rule — and 84 of
      // 135 project-scoped projects own more than one tree while 109 of 135 own
      // only DEPRECATED ones, so this page could show a deprecated
      // decomposition as the project's current goal, silently. The rule, and
      // what it costs to change it, are stated in `selectCurrentTree`.
      selection = selectCurrentTree(trees);
      tree = selection.tree;
      if (tree) graph = await fetchTocGraph(tree.id);
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load goal integrity';
    } finally {
      loading = false;
    }

    // Separate try: a cockpit failure must not blank the tree this page is
    // primarily about, and a failed cockpit read must not render as "no scope
    // approved" — a `down` panel routes it to the unavailable branch.
    //
    // PROJECT-READ-WAIVER: primary-load — `loadProject` cannot serve this. It calls
    // `apiClient.projects.get`, which returns the project ROW; the approved scope
    // lives on the cockpit read-model's `deliverables` block and is reachable only
    // through `fetchProjectCockpit`. This is nonetheless the ONLY project-entity
    // read on this page, so it is the primary load and owes the honest-failure
    // state below — which is what the guard was right about: before this, a 5xx
    // rendered a tree plus an "unavailable scope" block and never said the project
    // read had failed at all.
    try {
      const cockpit = await fetchProjectCockpit(projectId);
      scope = cockpit.deliverables;
    } catch (err) {
      // Same discrimination as `loadProject`: a 404 is an ANSWER (no such project),
      // anything else is a failed request and must not be shown as an answer.
      projectUnreadable = !(err instanceof ApiError && err.status === 404);
      scope = { data: null, as_of: null, health: 'down', detail_code: 'fr_db_error' };
    }
  });

</script>

<ProjectInspectHeader
  {projectId}
  title="Goal integrity"
  subtitle="The decompose ↔ recompose view — your request shattered into epics, enablers, features and cards, and how they roll back up into your deliverable. The one thing to supervise: is it still adding up to what you asked for?"
>
  {#snippet actions()}
    {#if graph}
      <div class="flex overflow-hidden rounded-[var(--radius-md)] border border-[var(--color-border)]">
        <button
          type="button"
          onclick={() => (view = 'integrity')}
          class="px-3 py-1.5 text-sm font-semibold {view === 'integrity'
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'}">Tree</button
        >
        <button
          type="button"
          onclick={() => (view = 'iomap')}
          class="px-3 py-1.5 text-sm font-semibold {view === 'iomap'
            ? 'bg-[var(--color-accent)] text-white'
            : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'}">IO-map</button
        >
      </div>
    {/if}
  {/snippet}
</ProjectInspectHeader>

<div class="p-6">
  <!-- ⛔ A BANNER, NOT A BRANCH — and that distinction is the whole point.
       This is the honest-failure state a WAIVED primary load owes
       (src/lib/projects/project-read-path.test.ts). My first attempt put it in the
       {#if} chain as an {:else if}, which made a COCKPIT failure blank the entire
       page — including the TOC tree, which loads from a different source and may
       have succeeded. That contradicted this file's own stated intent ("a cockpit
       failure must not blank the tree this page is primarily about") and a test
       caught it: the scope section's `block-unavailable` was never reached.
       Two independent reads, two independent verdicts, rendered side by side.
       It must NOT say the project is missing: a 5xx or a network blip has not shown
       that, and rendering a failed read as an answer is the defect `loadProject`
       exists to end. A 404 leaves this false. -->
  {#if projectUnreadable}
    <p
      class="mb-3 text-sm text-[var(--color-warning-text)]"
      data-testid="project-unreadable"
    >
      The project could not be read. It has NOT been shown to be missing — this is a failed
      request. Retry, and report it if it persists.
    </p>
  {/if}
  <!-- ⛔ A BANNER, NOT A BRANCH — same reason as the one above it. WHICH tree is
       on screen is a fact ABOUT the tree, not a replacement for it: folding it
       into the {#if} chain would let a provenance detail blank a decomposition
       that loaded fine. A page that renders ONE of a project's trees without
       naming it is asserting there is only one, and 84 of 135 projects own
       more. The DEPRECATED case is the one that must never be silent: 109 of
       135 projects have nothing else to show, so we show it AND say so. -->
  {#if tree && selection}
    <div
      class="mb-3 flex flex-wrap items-center gap-2 text-xs text-[var(--color-text-muted)]"
      data-testid="toc-tree-provenance"
    >
      <span class="font-semibold text-[var(--color-text)]">{tree.title || tree.slug}</span>
      {#if selection.deprecatedFallback}
        <span
          class="rounded-full border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-2 py-0.5 font-bold text-[var(--color-danger-text)]"
          data-testid="toc-tree-deprecated"
        >
          DEPRECATED
        </span>
        <span>
          every decomposition recorded for this project is deprecated — this is the most recent
          one, not a current one
        </span>
      {:else if tree.version_status}
        <span
          class="rounded-full border border-[var(--color-border)] px-2 py-0.5 font-semibold uppercase"
          data-testid="toc-tree-status"
        >
          {tree.version_status}
        </span>
      {/if}
      {#if selection.candidates > 1}
        <span data-testid="toc-tree-ambiguity">
          · most recent of {selection.candidates} trees for this project{#if selection.eligible > 1}, {selection.eligible} of them not deprecated{/if}
        </span>
      {/if}
    </div>
  {/if}
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading goal integrity…</p>
  {:else if error}
    <div
      class="rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
    >
      {error}
    </div>
  {:else if !graph || graph.nodes.length === 0}
    <!-- ⚠️ Written INLINE, not via a `$derived` predicate, on purpose: Svelte's
         compiler narrows `graph` to non-null in the LATER branches only when the
         null check is in the branch condition itself. A `graphIsEmpty` derived
         reads better and costs `<IOMapTree {graph} />` its narrowing (ts2322).
         ⛔ An absent graph and a graph with ZERO NODES are the same thing to a
         reader — dropping the `.nodes.length === 0` half puts the empty tree back
         for every un-decomposed project. -->
    <!-- ⛔ Do NOT render the IntegrityTree here. With an empty graph it draws an
         empty tree, which reads as "your goal decomposed into nothing". Show what
         WAS approved instead. -->
    <div class="space-y-4" data-testid="goal-scope-substitution">
      <div
        class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
      >
        No decomposition is mapped for this project yet. The system builds it during analysis — once
        epics and enablers exist, the goal tree appears here.
      </div>
      {#if scope}
        <ApprovedScopeSection
          {scope}
          note="Nothing has been decomposed yet, so there is no tree to check against. This is the scope that was approved — the thing the decomposition will have to add up to."
        />
      {/if}
    </div>
  {:else if view === 'integrity'}
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-5">
      <IntegrityTree nodes={integrity} />
    </div>
  {:else}
    <div class="min-h-[420px] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-2">
      <IOMapTree {graph} />
    </div>
  {/if}
</div>
