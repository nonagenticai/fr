<!--
  KAG "Explore graph" tab — the flagship, customer-facing view of a tenant's
  knowledge graph. Three jobs, all on proven read endpoints:

    See      an overview loads on open (never blank), coloured by concept type.
    Explore  seed from a question, click to select, double-click to expand
             (k-hop traversal), colour by community, size by centrality, and
             ask "how are X and Y related?" (path finding).
    Trust    select any concept → its source passages, each traceable to the
             original document.

  This component owns the working node/edge set and the analytics overlays; the
  canvas (KagGraphExplorer) is presentational and the drawer (KagNodeDetailPanel)
  delegates graph mutations back here.
-->
<script lang="ts">
  import { kagGraphApi, type KagRecord, type KagGraphSlice } from '$lib/api/kag';
  import { AssetError } from '$lib/api/assets';
  import { nodeIdOf, nodeLabelOf, nodeTypeOf, relEndpoints } from '$lib/components/kag/graph-normalise';
  import { colorForType } from '$lib/components/kag/graph-colors';
  import {
    readStats,
    readCommunities,
    readCentrality,
    readPath,
  } from '$lib/components/kag/kag-graph-helpers';
  import {
    fetchVerification,
    type VerificationMap,
  } from '$lib/components/kag/kag-verification';
  import { createPeekDebouncer, type PeekResult } from '$lib/components/kag/kag-peek-cache';
  import { exportJSON, exportPNG } from '$lib/components/kag/graph-export';
  import KagGraphExplorer from '$lib/components/kag/KagGraphExplorer.svelte';
  import KagCanvasPeek from '$lib/components/kag/KagCanvasPeek.svelte';
  import KagNodeDetailPanel from '$lib/components/kag/KagNodeDetailPanel.svelte';
  import KagEdgeDetailPanel from '$lib/components/kag/KagEdgeDetailPanel.svelte';

  // --- Working graph set ------------------------------------------------------
  let nodes = $state<KagRecord[]>([]);
  let relationships = $state<KagRecord[]>([]);

  // Monotonic load token: every replace-loader (overview / search / document
  // subgraph) captures the next value before its fetch and only applies the
  // result if it's still the latest. Guards against a slow earlier response
  // landing after a newer one and painting the wrong graph (e.g. switching
  // documents fast). Plain `let` — it's a race token, not reactive UI state.
  let loadSeq = 0;

  let loading = $state(false);
  let error = $state('');
  let seedQuery = $state('');
  let hasSeeded = $state(false);

  // --- View mode --------------------------------------------------------------
  let mode = $state<'explore' | 'document'>('explore');
  let documents = $state<KagRecord[]>([]);
  let selectedDocId = $state<string>('');
  // A fetch error must read differently from a genuinely-empty result, so an
  // ingested-but-unreachable graph doesn't masquerade as "nothing here yet".
  let documentsError = $state('');
  let statsError = $state('');

  // --- Overlays ---------------------------------------------------------------
  let colorMode = $state<'type' | 'community'>('type');
  let communityOf = $state<Record<string, number>>({});
  let centralityOf = $state<Record<string, number>>({});
  let verificationOf = $state<VerificationMap>({});
  let communityCount = $state<number | null>(null);
  let showHulls = $state(true);
  let analyticsBusy = $state<'' | 'community' | 'centrality' | 'path' | 'verify'>('');
  let analyticsNote = $state('');
  /**
   * The document subgraph's passage read failed. Separate from `error` because
   * the graph slice still rendered — this names the one input that was lost so
   * the note is visually distinct from "0 passages", which is a measurement.
   */
  let chunksUnreadable = $state(false);
  /**
   * The overview's seed neighbourhood expand FAILED for at least one seed —
   * separate from `error` because the graph still rendered (the other seeds'
   * edges are real). Distinct from `chunksUnreadable` (document-mode passages);
   * this is explore-mode's connectivity read.
   */
  let expansionsUnreadable = $state(false);
  let bulkExporting = $state(false);

  // --- Algorithm choices (all forwarded verbatim to already-wired reads) ------
  let centralityAlgo = $state('pagerank');
  let communityAlgo = $state('louvain');
  let pathType = $state('shortest');

  // --- Expand origin (new neighbours grow out of the expanded node) -----------
  let expandOriginId = $state<string | null>(null);

  // --- Legend / filter --------------------------------------------------------
  let allTypes = $state<string[]>([]);
  let activeTypes = $state<Set<string> | null>(null); // null = all on

  // --- Selection + path -------------------------------------------------------
  // Node XOR edge: selecting one clears the other so the drawer shows a single
  // subject at a time.
  let selectedNode = $state<KagRecord | null>(null);
  const selectedId = $derived(selectedNode ? nodeIdOf(selectedNode) : null);
  let selectedEdge = $state<KagRecord | null>(null);
  const selectedEdgeKey = $derived.by(() => {
    if (!selectedEdge) return null;
    const { source, target, type } = relEndpoints(selectedEdge);
    return `${source}__${type}__${target}`;
  });
  let pathStartNode = $state<KagRecord | null>(null);
  let pathEndNode = $state<KagRecord | null>(null);
  let pathIds = $state<string[]>([]);
  const pathStartId = $derived(pathStartNode ? nodeIdOf(pathStartNode) : null);
  const pathEndId = $derived(pathEndNode ? nodeIdOf(pathEndNode) : null);

  // --- Stats ------------------------------------------------------------------
  let stats = $state<{ entities?: number; relationships?: number; documents?: number }>({});

  // --- Legend colour: shared with the canvas via graph-colors so a swatch and
  // its node always agree (both key off the same sorted type list). -----------
  function legendColor(type: string): string {
    return colorForType(type, allTypes);
  }

  // --- Peek (hover source preview) --------------------------------------------
  const peekDebouncer = createPeekDebouncer(350);
  let peek = $state<{
    label: string;
    x: number;
    y: number;
    loading: boolean;
    answer?: string;
    chunks: KagRecord[];
  } | null>(null);

  function handlePeek(node: KagRecord, x: number, y: number) {
    const label = nodeLabelOf(node);
    if (peek && peek.label === label) {
      // Same node — just follow the cursor.
      peek = { ...peek, x, y };
      return;
    }
    // Moved to a different node: hide the stale card until the new one rests.
    peek = null;
    peekDebouncer.schedule(label, {
      onStart: () => {
        peek = { label, x, y, loading: true, chunks: [] };
      },
      onDone: (r: PeekResult) => {
        peek = { label, x, y, loading: false, answer: r.answer, chunks: r.chunks };
      },
      onError: () => {
        peek = null;
      },
    });
  }
  function hidePeek() {
    peekDebouncer.cancel();
    peek = null;
  }

  // --- Merge helpers ----------------------------------------------------------
  function mergeSlice(slice: KagGraphSlice, replace = false) {
    if (replace) {
      nodes = slice.nodes;
      relationships = slice.relationships;
      return;
    }
    const seenN = new Set(nodes.map((n, i) => nodeIdOf(n, i)));
    const addN = slice.nodes.filter((n, i) => {
      const id = nodeIdOf(n, i + nodes.length);
      if (seenN.has(id)) return false;
      seenN.add(id);
      return true;
    });
    const relKey = (r: KagRecord) => {
      const { source, target, type } = relEndpoints(r);
      return `${source}__${type}__${target}`;
    };
    const seenR = new Set(relationships.map(relKey));
    const addR = slice.relationships.filter((r) => {
      const k = relKey(r);
      if (seenR.has(k)) return false;
      seenR.add(k);
      return true;
    });
    nodes = [...nodes, ...addN];
    relationships = [...relationships, ...addR];
  }

  function resetOverlays() {
    colorMode = 'type';
    communityOf = {};
    centralityOf = {};
    verificationOf = {};
    communityCount = null;
    pathIds = [];
    expandOriginId = null;
    analyticsNote = '';
    chunksUnreadable = false;
    expansionsUnreadable = false;
  }

  // --- Loaders ----------------------------------------------------------------
  async function loadStats() {
    statsError = '';
    try {
      stats = readStats(await kagGraphApi.stats());
    } catch (e) {
      // Non-fatal to the graph, but surface it so blank tiles aren't read as "0".
      statsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function loadOverview() {
    const seq = ++loadSeq;
    loading = true;
    error = '';
    resetOverlays();
    selectedNode = null;
    selectedEdge = null;
    try {
      const slice = await kagGraphApi.overview();
      if (seq !== loadSeq) return; // a newer load started — drop this stale result
      mergeSlice(slice, true);
      hasSeeded = true;
      // ⚠️ A failed seed expand used to be silently swallowed into an empty
      // slice (rendering as "these documents have no connections") and then,
      // when that was fixed, made the WHOLE overview reject on one bad seed
      // (rendering the other seeds' real connectivity as a total outage). Report
      // it instead: the graph above is real for whichever seeds succeeded, and
      // this names the ones that didn't rather than asserting either extreme.
      // ⚠️ `=== false`, NOT `!slice.expansions_available`. An ABSENT flag is not
      // a failure claim — a slice that never reported availability must not be
      // announced as unreadable. The negation form declared every such slice a
      // failure, which is this file's own defect pointed the other way: it
      // asserts an outage it did not measure. `false` is the only value that
      // means "a seed expand actually failed".
      expansionsUnreadable = slice.expansions_available === false;
      analyticsNote = expansionsUnreadable
        ? `Neighbourhood expansion failed for ${slice.expansions_failed}/${slice.expansions_attempted} source document(s) — this graph is incomplete, not "no connections found".`
        : '';
    } catch (e) {
      if (seq !== loadSeq) return;
      error = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  async function runSearch(e: SubmitEvent) {
    e.preventDefault();
    if (!seedQuery.trim()) return;
    const seq = ++loadSeq;
    loading = true;
    error = '';
    resetOverlays();
    selectedNode = null;
    selectedEdge = null;
    try {
      const slice = await kagGraphApi.search(seedQuery.trim(), 30);
      if (seq !== loadSeq) return; // a newer load started — drop this stale result
      mergeSlice(slice, true);
      hasSeeded = true;
      if (slice.nodes.length === 0) analyticsNote = 'No concepts matched that query.';
    } catch (e2) {
      if (seq !== loadSeq) return;
      error = e2 instanceof AssetError ? e2.message : (e2 instanceof Error ? e2.message : String(e2));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  async function handleExpand(node: KagRecord) {
    const id = nodeIdOf(node);
    analyticsNote = '';
    chunksUnreadable = false;
    expansionsUnreadable = false;
    // Tell the canvas where new neighbours should grow from (expand-in-place).
    expandOriginId = id;
    try {
      const slice = await kagGraphApi.expand(id, { maxHops: 1, maxNodes: 25 });
      const before = nodes.length;
      mergeSlice(slice);
      const added = nodes.length - before;
      analyticsNote = added > 0 ? `Added ${added} connected concept(s).` : 'No new neighbours found.';
    } catch (e) {
      analyticsNote = e instanceof AssetError ? e.message : 'Could not expand this concept.';
    }
  }

  async function runCommunities() {
    analyticsBusy = 'community';
    analyticsNote = '';
    chunksUnreadable = false;
    try {
      const { map, count } = readCommunities(await kagGraphApi.communities(communityAlgo));
      communityOf = map;
      communityCount = count;
      colorMode = 'community';
      analyticsNote = count > 0 ? `Detected ${count} theme(s).` : 'No communities detected.';
    } catch (e) {
      analyticsNote = e instanceof AssetError ? e.message : 'Community detection failed.';
    } finally {
      analyticsBusy = '';
    }
  }

  async function runCentrality() {
    analyticsBusy = 'centrality';
    analyticsNote = '';
    chunksUnreadable = false;
    expansionsUnreadable = false;
    try {
      centralityOf = readCentrality(await kagGraphApi.centrality(centralityAlgo));
      const n = Object.keys(centralityOf).length;
      analyticsNote = n > 0 ? `Ranked ${n} concept(s) by importance.` : 'No centrality scores returned.';
    } catch (e) {
      analyticsNote = e instanceof AssetError ? e.message : 'Centrality failed.';
    } finally {
      analyticsBusy = '';
    }
  }

  // Verification overlay: anomalies (fast) + per-visible-node integrity (deep).
  async function runVerify() {
    analyticsBusy = 'verify';
    analyticsNote = 'Checking verification…';
    try {
      const ids = nodes.map((n, i) => nodeIdOf(n, i)).filter(Boolean);
      // Re-verify from source: drop any memoised deep result for these ids so a
      // re-run reflects the fresh score, not the badge captured on the last run.
      verificationOf = await fetchVerification(ids, {
        deep: true,
        force: true,
        onProgress: (done, total) => {
          analyticsNote = `Checking verification… ${done}/${total}`;
        },
      });
      const scored = Object.values(verificationOf).filter((v) => typeof v.score === 'number').length;
      const flagged = Object.values(verificationOf).filter((v) => v.flags.length > 0).length;
      analyticsNote =
        scored > 0 || flagged > 0
          ? `Verified ${scored} concept(s)${flagged > 0 ? `, ${flagged} flagged` : ''}.`
          : 'No verification data for these concepts yet.';
    } catch (e) {
      analyticsNote = e instanceof AssetError ? e.message : 'Verification check failed.';
    } finally {
      analyticsBusy = '';
    }
  }

  async function runPath() {
    if (!pathStartId || !pathEndId) return;
    analyticsBusy = 'path';
    analyticsNote = '';
    chunksUnreadable = false;
    expansionsUnreadable = false;
    pathIds = [];
    try {
      const { ids, nodes: pathNodes, relationships: pathRels } = readPath(
        await kagGraphApi.path(pathStartId, pathEndId, pathType),
      );
      // Merge any intermediate path hops the response carries so the highlighted
      // path is actually drawn (the canvas only highlights nodes/edges present in
      // the working set). No-op when the response is ids-only.
      if (pathNodes.length > 0) {
        mergeSlice({ nodes: pathNodes, relationships: pathRels });
      }
      pathIds = ids;
      analyticsNote =
        ids.length > 0
          ? `Path found through ${ids.length} concept(s).`
          : 'No path found between these two concepts.';
    } catch (e) {
      analyticsNote = e instanceof AssetError ? e.message : 'Path finding failed.';
    } finally {
      analyticsBusy = '';
    }
  }

  function clearPath() {
    pathStartNode = null;
    pathEndNode = null;
    pathIds = [];
  }

  function toggleType(t: string) {
    const base = activeTypes ?? new Set(allTypes);
    const next = new Set(base);
    if (next.has(t)) next.delete(t);
    else next.add(t);
    activeTypes = next.size === allTypes.length ? null : next;
  }

  function selectNode(record: KagRecord | null) {
    selectedNode = record;
    if (record) selectedEdge = null; // node XOR edge
  }

  function selectEdge(record: KagRecord | null) {
    selectedEdge = record;
    if (record) selectedNode = null; // node XOR edge
  }

  // --- Document-centric mode --------------------------------------------------
  async function loadDocuments() {
    documentsError = '';
    try {
      documents = await kagGraphApi.documents();
    } catch (e) {
      // Distinguish a fetch failure from a genuinely-empty document set — the
      // picker previously showed "No documents ingested yet" for both.
      documents = [];
      documentsError = e instanceof Error ? e.message : String(e);
    }
  }

  async function switchMode(next: 'explore' | 'document') {
    if (mode === next) return;
    mode = next;
    hidePeek();
    if (next === 'document') {
      if (documents.length === 0) await loadDocuments();
      // Auto-load the first document so the mode is never blank.
      if (!selectedDocId && documents.length > 0) {
        selectedDocId = nodeIdOf(documents[0]!, 0);
      }
      if (selectedDocId) await loadDocumentSubgraph();
    } else {
      await loadOverview();
    }
  }

  async function loadDocumentSubgraph() {
    if (!selectedDocId) return;
    const seq = ++loadSeq;
    loading = true;
    error = '';
    resetOverlays();
    selectedNode = null;
    selectedEdge = null;
    try {
      const sub = await kagGraphApi.documentSubgraph(selectedDocId);
      if (seq !== loadSeq) return; // a newer load started — drop this stale result
      mergeSlice({ nodes: sub.nodes, relationships: sub.relationships }, true);
      hasSeeded = true;
      // Focus the document node so its neighbourhood reads as "its" subgraph.
      selectNode(
        nodes.find((n, i) => nodeIdOf(n, i) === selectedDocId) ?? null,
      );
      // ⚠️ `chunks: []` used to mean BOTH "this document has no passages" and
      // "hierarchical retrieval failed", and both rendered as no note at all —
      // so a retriever outage read as a complete document subgraph. The graph
      // slice above comes from a different upstream and is still good, so name
      // the input that was lost rather than blanking the tab.
      chunksUnreadable = !sub.chunks_available;
      analyticsNote = !sub.chunks_available
        ? 'Source passages could not be read — this document is NOT known to have none. The concept graph below is unaffected.'
        : sub.chunks.length > 0
          ? `${sub.chunks.length} source passage(s) in this document.`
          : '';
    } catch (e) {
      if (seq !== loadSeq) return;
      error = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      if (seq === loadSeq) loading = false;
    }
  }

  function docLabel(d: KagRecord, i: number): string {
    return nodeLabelOf(d) || `Document ${i + 1}`;
  }

  // --- Export current view (pure client) --------------------------------------
  function liveSvg(): SVGSVGElement | null {
    // The main canvas is the FIRST svg inside the explorer (minimap is appended
    // after it); scope the query to this tab to avoid other pages' svgs.
    return document.querySelector<SVGSVGElement>('[data-testid="kag-graph-explorer"] svg');
  }
  function doExportJSON() {
    exportJSON({ nodes, relationships });
  }
  async function doExportPNG() {
    const svg = liveSvg();
    if (!svg) return;
    try {
      await exportPNG(svg);
    } catch (e) {
      analyticsNote = e instanceof Error ? `Export failed: ${e.message}` : 'Export failed.';
    }
  }
  // Backend-mediated export of the WHOLE tenant graph (read-only bulk export),
  // not just the on-screen slice. Streams the snapshot through the fr BFF.
  async function doBulkExport() {
    bulkExporting = true;
    analyticsNote = '';
    chunksUnreadable = false;
    try {
      const snapshot = await kagGraphApi.bulkExport({ include_relationships: true });
      exportJSON(
        { nodes: snapshot.nodes ?? [], relationships: snapshot.relationships ?? [] },
        'kag-graph-full.json',
      );
      analyticsNote = `Exported ${snapshot.node_count ?? snapshot.nodes?.length ?? 0} node(s) and ${snapshot.relationship_count ?? snapshot.relationships?.length ?? 0} relationship(s).`;
    } catch (e) {
      analyticsNote =
        e instanceof AssetError
          ? `Export failed: ${e.message}`
          : e instanceof Error
            ? `Export failed: ${e.message}`
            : 'Export failed.';
    } finally {
      bulkExporting = false;
    }
  }

  // --- Initial load -----------------------------------------------------------
  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void loadStats();
    void loadOverview();
  });

  const statTiles = $derived([
    { label: 'Concepts', value: stats.entities },
    { label: 'Relationships', value: stats.relationships },
    { label: 'Documents', value: stats.documents },
    { label: 'Themes', value: communityCount ?? undefined },
  ]);
</script>

<div class="flex flex-col gap-4" data-testid="kag-graph-explore-tab">
  <!-- Intro -->
  <div>
    <h2 class="text-lg font-semibold text-[var(--color-text)]">Explore your knowledge graph</h2>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
      Every document you add becomes a living graph of concepts and the
      relationships between them. Search to focus, double-click any concept to
      expand it, and select one to see the exact passages — and sources — it came from.
    </p>
  </div>

  <!-- Stat tiles -->
  <div class="grid grid-cols-2 gap-3 sm:grid-cols-4">
    {#each statTiles as tile (tile.label)}
      <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]">
        <div class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{tile.label}</div>
        <div class="mt-1 text-2xl font-semibold text-[var(--color-text)]">
          {tile.value ?? '—'}
        </div>
      </div>
    {/each}
  </div>
  {#if statsError}
    <p data-testid="kag-graph-stats-error" class="-mt-2 text-xs text-[var(--color-danger)]">
      Couldn't load graph stats (the tiles above may be stale) — {statsError}
    </p>
  {/if}

  <!-- Toolbar -->
  <div class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]">
    <!-- Mode: whole-graph explore vs a single document's subgraph -->
    <div class="flex flex-wrap items-center gap-2">
      <div class="inline-flex w-fit overflow-hidden rounded border border-[var(--color-border-strong)] text-xs" data-testid="kag-graph-mode">
        <button
          class="px-3 py-1.5 font-medium {mode === 'explore' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'text-[var(--color-text)]'}"
          onclick={() => switchMode('explore')}>Explore graph</button
        >
        <button
          class="px-3 py-1.5 font-medium {mode === 'document' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'text-[var(--color-text)]'}"
          onclick={() => switchMode('document')}>By document</button
        >
      </div>

      <!-- Export current view (client-side, no data leaves the graph you see) -->
      <div class="ml-auto inline-flex items-center gap-1.5">
        <button
          onclick={doExportPNG}
          disabled={nodes.length === 0}
          class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          title="Download the current graph as a PNG image"
          >Export PNG</button
        >
        <button
          onclick={doExportJSON}
          disabled={nodes.length === 0}
          class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          title="Download the current nodes + relationships as JSON"
          >Export JSON</button
        >
        <button
          onclick={doBulkExport}
          disabled={bulkExporting}
          data-testid="kag-bulk-export-btn"
          class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          title="Download the full tenant graph as JSON via the backend"
          >{bulkExporting ? 'Exporting…' : 'Export graph (JSON via backend)'}</button
        >
      </div>
    </div>

    {#if mode === 'explore'}
      <div class="flex flex-wrap items-center gap-2">
        <form class="flex min-w-[16rem] flex-1 items-center gap-2" onsubmit={runSearch}>
          <input
            type="search"
            bind:value={seedQuery}
            placeholder="Focus the graph on a topic, e.g. “data retention”…"
            data-testid="kag-graph-seed"
            class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm dark:bg-[var(--color-surface)]"
          />
          <button
            type="submit"
            disabled={loading}
            class="shrink-0 rounded bg-[var(--color-accent)] px-3 py-2 text-sm font-medium text-[var(--color-on-primary)] disabled:opacity-60"
            >Search</button
          >
        </form>
        <button
          onclick={loadOverview}
          disabled={loading}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-60"
          >Overview</button
        >
      </div>
    {:else}
      <div class="flex flex-wrap items-center gap-2">
        <label class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]" for="kag-doc-picker">Document</label>
        <select
          id="kag-doc-picker"
          bind:value={selectedDocId}
          onchange={loadDocumentSubgraph}
          disabled={loading || documents.length === 0}
          data-testid="kag-graph-doc-picker"
          class="min-w-[16rem] flex-1 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm dark:bg-[var(--color-surface)]"
        >
          {#if documents.length === 0}
            <option value="">{documentsError ? 'Could not load documents' : 'No documents ingested yet'}</option>
          {:else}
            {#each documents as d, i (nodeIdOf(d, i))}
              <option value={nodeIdOf(d, i)}>{docLabel(d, i)}</option>
            {/each}
          {/if}
        </select>
        {#if documentsError}
          <p data-testid="kag-graph-docs-error" class="w-full text-xs text-[var(--color-danger)]">
            Couldn't load documents — {documentsError}
          </p>
        {:else}
          <p class="w-full text-xs text-[var(--color-text-muted)]">
            A single document's chunks and the concepts it mentions — each traceable to its source passage.
          </p>
        {/if}
      </div>
    {/if}

    <!-- Analytics strip -->
    <div class="flex flex-wrap items-center gap-2 border-t border-[var(--color-border)] pt-3">
      <span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">Analyse</span>

      <!-- Themes: algorithm select + run -->
      <div class="inline-flex items-center overflow-hidden rounded border border-[var(--color-border-strong)]">
        <select
          bind:value={communityAlgo}
          disabled={analyticsBusy !== ''}
          aria-label="Community algorithm"
          class="border-r border-[var(--color-border-strong)] bg-[var(--color-bg)] px-1.5 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        >
          <option value="louvain">Louvain</option>
          <option value="leiden">Leiden</option>
          <option value="label_propagation">Label prop.</option>
        </select>
        <button
          onclick={runCommunities}
          disabled={analyticsBusy !== '' || nodes.length === 0}
          class="px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          title="Colour concepts by cluster / theme"
          >{analyticsBusy === 'community' ? 'Detecting…' : 'Detect themes'}</button
        >
      </div>

      <!-- Importance: centrality algorithm select + run -->
      <div class="inline-flex items-center overflow-hidden rounded border border-[var(--color-border-strong)]">
        <select
          bind:value={centralityAlgo}
          disabled={analyticsBusy !== ''}
          aria-label="Centrality algorithm"
          class="border-r border-[var(--color-border-strong)] bg-[var(--color-bg)] px-1.5 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        >
          <option value="pagerank">PageRank</option>
          <option value="betweenness">Betweenness</option>
          <option value="eigenvector">Eigenvector</option>
          <option value="degree">Degree</option>
        </select>
        <button
          onclick={runCentrality}
          disabled={analyticsBusy !== '' || nodes.length === 0}
          class="px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          title="Size concepts by importance"
          >{analyticsBusy === 'centrality' ? 'Ranking…' : 'Rank importance'}</button
        >
      </div>

      <!-- Verification overlay -->
      <button
        onclick={runVerify}
        disabled={analyticsBusy !== '' || nodes.length === 0}
        class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        title="Badge concepts by verification score + contradiction flags"
        >{analyticsBusy === 'verify' ? 'Verifying…' : 'Verify visible'}</button
      >

      <!-- Colour mode + hulls -->
      {#if Object.keys(communityOf).length > 0}
        <div class="ml-1 inline-flex overflow-hidden rounded border border-[var(--color-border-strong)] text-xs">
          <button
            class="px-2 py-1 {colorMode === 'type' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'text-[var(--color-text)]'}"
            onclick={() => (colorMode = 'type')}>By type</button
          >
          <button
            class="px-2 py-1 {colorMode === 'community' ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]' : 'text-[var(--color-text)]'}"
            onclick={() => (colorMode = 'community')}>By theme</button
          >
        </div>
        {#if colorMode === 'community'}
          <label class="inline-flex items-center gap-1 text-xs text-[var(--color-text)]">
            <input type="checkbox" bind:checked={showHulls} class="accent-[var(--color-accent)]" />
            Theme regions
          </label>
        {/if}
      {/if}

      <!-- Path controls -->
      <div class="ml-auto flex flex-wrap items-center gap-2">
        <span class="text-xs text-[var(--color-text-muted)]">
          Path:
          <span class="font-medium text-[var(--color-text)]">{pathStartNode ? nodeLabelOf(pathStartNode) : '—'}</span>
          →
          <span class="font-medium text-[var(--color-text)]">{pathEndNode ? nodeLabelOf(pathEndNode) : '—'}</span>
        </span>
        <select
          bind:value={pathType}
          disabled={analyticsBusy !== ''}
          aria-label="Path type"
          class="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-1.5 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        >
          <option value="shortest">Shortest</option>
          <option value="all_simple">All simple</option>
          <option value="node_disjoint">Node-disjoint</option>
        </select>
        <button
          onclick={runPath}
          disabled={!pathStartId || !pathEndId || analyticsBusy !== ''}
          class="rounded border border-[var(--color-border-strong)] px-2.5 py-1 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{analyticsBusy === 'path' ? 'Finding…' : 'Find path'}</button
        >
        {#if pathStartNode || pathEndNode || pathIds.length > 0}
          <button
            onclick={clearPath}
            class="rounded px-2 py-1 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
            >Clear</button
          >
        {/if}
      </div>
    </div>

    {#if analyticsNote}
      <p
        class="text-xs {chunksUnreadable || expansionsUnreadable
          ? 'text-[var(--color-warning-text)]'
          : 'text-[var(--color-text-muted)]'}"
        data-testid={chunksUnreadable
          ? 'kag-chunks-unreadable'
          : expansionsUnreadable
            ? 'kag-expansions-unreadable'
            : 'kag-graph-note'}
      >{analyticsNote}</p>
    {/if}
  </div>

  <!-- Legend / type filter -->
  {#if allTypes.length > 0}
    <div class="flex flex-wrap items-center gap-2" data-testid="kag-graph-legend">
      <span class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]">
        {colorMode === 'community' ? 'Coloured by theme' : 'Filter by type'}
      </span>
      {#if colorMode === 'type'}
        {#each allTypes as t (t)}
          {@const on = !activeTypes || activeTypes.has(t)}
          <button
            onclick={() => toggleType(t)}
            class="inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-medium transition-opacity {on
              ? 'border-[var(--color-border-strong)] text-[var(--color-text)]'
              : 'border-[var(--color-border)] text-[var(--color-text-muted)] opacity-50'}"
          >
            <span class="h-2.5 w-2.5 rounded-full" style={`background:${legendColor(t)}`}></span>
            {t}
          </button>
        {/each}
      {/if}
    </div>
  {/if}

  <!-- Verification legend (only when the overlay is active) -->
  {#if Object.keys(verificationOf).length > 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-verif-legend">
      <span class="font-medium">Verification:</span> ring colour = score (green good → red poor) ·
      red dot = contradiction / anomaly
    </p>
  {/if}

  <!-- Error -->
  {#if error}
    <div class="rounded border border-[var(--color-danger-bg)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger-text)]">{error}</div>
  {/if}

  <!-- Canvas + detail -->
  <div class="flex flex-col gap-4 lg:flex-row">
    <div class="relative min-w-0 flex-1">
      {#if loading}
        <div class="absolute inset-0 z-10 flex items-center justify-center rounded-lg bg-[var(--color-bg)]/60">
          <span class="inline-flex items-center gap-2 text-sm text-[var(--color-text-muted)]">
            <span class="inline-block h-4 w-4 animate-spin rounded-full border-b-2 border-[var(--color-accent)]"></span>
            Building graph…
          </span>
        </div>
      {/if}
      {#if !loading && hasSeeded && nodes.length === 0}
        <div class="flex h-[560px] flex-col items-center justify-center rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-center dark:bg-[var(--color-bg)]">
          <p class="text-sm font-medium text-[var(--color-text)]">Nothing to show yet</p>
          <p class="mt-1 max-w-sm text-sm text-[var(--color-text-muted)]">
            Add documents in <a href="/library/kag/documents" class="font-medium text-[var(--color-accent)] hover:underline">KAG documents</a>, or try a different search — your
            graph is built from what you've ingested.
          </p>
        </div>
      {:else}
        <KagGraphExplorer
          {nodes}
          {relationships}
          {colorMode}
          {communityOf}
          {centralityOf}
          {verificationOf}
          {activeTypes}
          {pathIds}
          {selectedId}
          {selectedEdgeKey}
          {showHulls}
          {expandOriginId}
          onselect={selectNode}
          onedgeselect={selectEdge}
          onexpand={handleExpand}
          ontypes={(t) => (allTypes = t)}
          onpeek={handlePeek}
          onpeekhide={hidePeek}
        />
        {#if peek}
          <KagCanvasPeek
            label={peek.label}
            x={peek.x}
            y={peek.y}
            loading={peek.loading}
            answer={peek.answer}
            chunks={peek.chunks}
          />
        {/if}
      {/if}
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Hover a concept to peek its sources · click a concept for full details · click an edge to inspect the relationship · double-click to expand · drag to reposition · scroll to zoom
      </p>
    </div>

    {#if selectedEdge}
      <div class="w-full shrink-0 lg:w-96">
        <div class="lg:sticky lg:top-4 lg:h-[600px]">
          <KagEdgeDetailPanel
            edge={selectedEdge}
            {nodes}
            onselectNode={(n) => selectNode(n)}
            onclose={() => (selectedEdge = null)}
          />
        </div>
      </div>
    {:else if selectedNode}
      <div class="w-full shrink-0 lg:w-96">
        <div class="lg:sticky lg:top-4 lg:h-[600px]">
          <KagNodeDetailPanel
            node={selectedNode}
            {pathStartId}
            {pathEndId}
            onexpand={handleExpand}
            onselectNode={(n) => selectNode(n)}
            onsetpathstart={(n) => (pathStartNode = n)}
            onsetpathend={(n) => (pathEndNode = n)}
            onclose={() => (selectedNode = null)}
          />
        </div>
      </div>
    {/if}
  </div>
</div>
