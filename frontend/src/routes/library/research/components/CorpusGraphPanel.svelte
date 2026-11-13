<!--
  CorpusGraphPanel — Stage 6's "Knowledge graph" deliverable: the freshly-built
  KAG corpus made interactive IN-PAGE, so research → graph → answer closes
  without leaving the studio.

  Three affordances over the pushed corpus, all reusing proven pieces:
    1. a force-graph view (`KagGraph`) of a semantic search seeded by the
       research question — click a node to inspect/verify it;
    2. verify-on-select — runs the Scientific Processor integrity check on the
       selected node (or any pushed entity) and renders the shared
       `TrustBreakdown`;
    3. a corpus-scoped Ask box (`researchApi.askCorpus`, scoped to a pushed
       `document_id` or the whole graph).

  Self-contained: the host passes only the pushed entity/doc ids + the question;
  all fetching lives here so the component is unit-testable in isolation.
-->
<script lang="ts">
  import { withOpenProject } from '$lib/api/kagProjectScope';
  import { assetFetch, AssetError } from '$lib/api/assets';
  import {
    researchApi,
    type IntegrityResponse,
    type AskResponse,
    type GraphQueryType,
    type GraphQueryResponse,
  } from '$lib/api/research';
  import { Select } from '$lib/components/ui';
  import KagGraph from '$lib/components/kag/KagGraph.svelte';
  import TrustBreakdown from './TrustBreakdown.svelte';

  interface Props {
    /** Neo4j node ids produced by the Stage-4 push — the pushed corpus. */
    entityIds: string[];
    /** Pushed documents, for scoping the Ask box. */
    docs: Array<{ docId: string; title: string }>;
    /** The research question — seeds the graph search and the Ask box. */
    defaultQuery?: string;
  }
  const { entityIds, docs, defaultQuery = '' }: Props = $props();

  type SemanticSearchResponse = {
    query_text?: string;
    nodes?: Array<Record<string, unknown>>;
    relationships?: Array<Record<string, unknown>>;
    total_results?: number;
  };

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // ---- Graph (semantic search over the tenant graph the push landed in) ----
  let query = $state(defaultQuery);
  let searching = $state(false);
  let searchError = $state('');
  let graph = $state<SemanticSearchResponse | null>(null);
  let selectedNode = $state<Record<string, unknown> | null>(null);

  function nodeId(n: Record<string, unknown> | null): string | null {
    const v = n?.id;
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  function nodeLabel(n: Record<string, unknown> | null): string {
    for (const k of ['name', 'title', 'label', 'id']) {
      const v = n?.[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '(unnamed)';
  }

  async function runSearch(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (!query.trim()) {
      searchError = 'Enter a query to explore the graph.';
      return;
    }
    searching = true;
    searchError = '';
    graph = null;
    selectedNode = null;
    try {
      graph = await assetFetch<SemanticSearchResponse>('/api/assets/kag/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withOpenProject({ query_text: query.trim(), limit: 25 })),
      });
    } catch (err) {
      searchError = errMsg(err);
    } finally {
      searching = false;
    }
  }

  // ---- Verify (integrity on the selected node or a pushed entity) ----
  interface VerifyState {
    integrity?: IntegrityResponse;
    running: boolean;
    error?: string;
  }
  let verifyByEntity = $state<Record<string, VerifyState>>({});

  async function verify(entityId: string): Promise<void> {
    if (!entityId || verifyByEntity[entityId]?.running) return;
    verifyByEntity = { ...verifyByEntity, [entityId]: { running: true } };
    try {
      const integrity = await researchApi.verifyIntegrity({ entity_id: entityId });
      verifyByEntity = {
        ...verifyByEntity,
        [entityId]: { running: false, integrity },
      };
    } catch (err) {
      verifyByEntity = {
        ...verifyByEntity,
        [entityId]: { running: false, error: errMsg(err) },
      };
    }
  }

  // ---- Ask (scoped to a pushed document or the whole graph) ----
  let askQuery = $state(defaultQuery);
  let askDocId = $state('');
  let asking = $state(false);
  let askError = $state('');
  let askResult = $state<AskResponse | null>(null);

  async function runAsk(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (!askQuery.trim()) {
      askError = 'Enter a question.';
      return;
    }
    asking = true;
    askError = '';
    askResult = null;
    try {
      askResult = await researchApi.askCorpus({
        query: askQuery.trim(),
        ...(askDocId ? { doc_id: askDocId } : {}),
      });
    } catch (err) {
      askError = errMsg(err);
    } finally {
      asking = false;
    }
  }

  const askCitations = $derived(askResult?.citations ?? []);
  const selectedId = $derived(nodeId(selectedNode));

  // ---- Structured query (tenant-safe; each type dispatches to a graph-adapter endpoint) ----
  const GRAPH_QUERY_TYPES: { value: GraphQueryType; label: string }[] = [
    { value: 'entity_search', label: 'Entity search' },
    { value: 'full_text_search', label: 'Full-text search' },
    { value: 'similarity_search', label: 'Similarity search' },
    { value: 'graph_traversal', label: 'Graph traversal (from a node)' },
    { value: 'relationship_query', label: 'Relationships (from a node)' },
    { value: 'aggregation', label: 'Aggregation (graph stats)' },
  ];
  let gqType = $state<GraphQueryType>('entity_search');
  let gqQuery = $state('');
  let gqRunning = $state(false);
  // Optimized (cost-based) plan — routes to the graph-adapter's optimizer alias
  // (same query types + result shape), with its query cache. Read-only.
  let gqOptimized = $state(false);
  let gqError = $state('');
  let gqResult = $state<GraphQueryResponse | null>(null);

  const gqNeedsQuery = $derived(gqType !== 'aggregation');
  const gqNodeSeeded = $derived(gqType === 'graph_traversal' || gqType === 'relationship_query');

  function gqRowLabel(row: Record<string, unknown>): string {
    for (const k of ['name', 'title', 'label', 'id', 'source_id', 'target_id']) {
      const v = row?.[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    try {
      return JSON.stringify(row).slice(0, 160);
    } catch {
      return '(row)';
    }
  }

  async function runGraphQuery(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const q = gqQuery.trim();
    if (gqNeedsQuery && !q) {
      gqError = gqNodeSeeded
        ? 'Enter a node id — tip: select a node in the graph above, then "Use selected node".'
        : 'Enter a query.';
      return;
    }
    gqRunning = true;
    gqError = '';
    gqResult = null;
    try {
      const body = { query_type: gqType, ...(gqNeedsQuery ? { query: q } : {}) };
      gqResult = gqOptimized
        ? await researchApi.graphQueryOptimized({ ...body, use_cache: true })
        : await researchApi.graphQuery(body);
    } catch (err) {
      gqError = errMsg(err);
    } finally {
      gqRunning = false;
    }
  }
</script>

<div class="flex flex-col gap-4" data-testid="research-corpus-graph">
  <div>
    <h2 class="text-sm font-semibold">Knowledge graph</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      {#if entityIds.length > 0}
        {entityIds.length}
        {entityIds.length === 1 ? 'entity' : 'entities'} from your push are in this
        tenant's KAG graph. Explore them, then verify or ask — all without leaving
        the studio.
      {:else}
        Push papers in the Build stage to populate your graph, then explore it
        here.
      {/if}
    </p>
  </div>

  {#if entityIds.length === 0}
    <p
      class="rounded border border-dashed p-4 text-sm text-[var(--color-text-muted)]"
      data-testid="research-corpus-graph-empty"
    >
      No corpus yet. Once you push selected papers in Stage 4 — Build, their
      extracted entities appear here as an interactive graph you can verify and
      query.
    </p>
  {:else}
    <!-- Graph view -->
    <section class="flex flex-col gap-2">
      <form class="flex flex-wrap gap-2" onsubmit={runSearch}>
        <input
          data-testid="research-corpus-graph-query"
          bind:value={query}
          placeholder="Explore the graph — e.g. your research question…"
          class="flex-1 min-w-60 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
        <button
          type="submit"
          data-testid="research-corpus-graph-search"
          disabled={searching || !query.trim()}
          class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
        >
          {searching ? 'Exploring…' : 'Explore'}
        </button>
      </form>

      {#if searchError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="research-corpus-graph-error">
          {searchError}
        </p>
      {/if}

      {#if graph}
        <KagGraph
          nodes={graph.nodes ?? []}
          relationships={graph.relationships ?? []}
          onSelect={(n) => (selectedNode = n)}
        />

        {#if selectedNode}
          <div
            class="rounded border p-3 bg-[var(--color-surface)]"
            data-testid="research-corpus-graph-selected"
          >
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="text-sm font-medium">{nodeLabel(selectedNode)}</span>
              {#if selectedId}
                <button
                  type="button"
                  data-testid="research-corpus-graph-verify"
                  disabled={verifyByEntity[selectedId]?.running}
                  onclick={() => void verify(selectedId)}
                  class="rounded border px-2 py-1 text-xs disabled:opacity-50"
                >
                  {verifyByEntity[selectedId]?.running ? 'Verifying…' : 'Verify this entity'}
                </button>
              {/if}
            </div>
            {#if selectedId && verifyByEntity[selectedId]?.integrity}
              <div class="mt-2">
                <TrustBreakdown integrity={verifyByEntity[selectedId].integrity} />
              </div>
            {/if}
            {#if selectedId && verifyByEntity[selectedId]?.error}
              <p class="mt-1 text-xs text-[var(--color-danger)]" data-testid="research-corpus-graph-verify-error">
                {verifyByEntity[selectedId].error}
              </p>
            {/if}
          </div>
        {/if}
      {/if}
    </section>

    <!-- Structured query (tenant-safe graph query surface) -->
    <section class="flex flex-col gap-2 border-t pt-3" data-testid="research-corpus-gq">
      <h3 class="text-sm font-semibold">Structured query</h3>
      <p class="text-xs text-[var(--color-text-muted)]">
        Run a precise, tenant-scoped query over your graph. Each type maps to a
        safe graph endpoint — no raw Cypher.
      </p>
      <form class="flex flex-wrap gap-2" onsubmit={runGraphQuery}>
        <Select
          bind:value={gqType}
          options={GRAPH_QUERY_TYPES}
          class="min-w-52"
        />
        {#if gqNeedsQuery}
          <input
            data-testid="research-corpus-gq-query"
            bind:value={gqQuery}
            placeholder={gqNodeSeeded ? 'Node id…' : 'Query…'}
            class="flex-1 min-w-52 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          />
        {/if}
        {#if gqNodeSeeded && selectedId}
          <button
            type="button"
            data-testid="research-corpus-gq-use-node"
            onclick={() => (gqQuery = selectedId)}
            class="rounded border px-2 py-2 text-xs"
          >
            Use selected node
          </button>
        {/if}
        <label
          class="flex items-center gap-1.5 text-xs text-[var(--color-text)]"
          title="Use the graph-adapter's cost-based optimizer + query cache (same result, read-only)"
        >
          <input
            type="checkbox"
            data-testid="research-corpus-gq-optimized"
            bind:checked={gqOptimized}
            class="accent-[var(--color-accent)]"
          />
          Optimized
        </label>
        <button
          type="submit"
          data-testid="research-corpus-gq-run"
          disabled={gqRunning || (gqNeedsQuery && !gqQuery.trim())}
          class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
        >
          {gqRunning ? 'Running…' : gqOptimized ? 'Run (optimized)' : 'Run'}
        </button>
      </form>

      {#if gqError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="research-corpus-gq-error">
          {gqError}
        </p>
      {/if}

      {#if gqResult}
        <div
          class="rounded border p-3 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          data-testid="research-corpus-gq-result"
        >
          <p class="text-xs text-[var(--color-text-muted)]">
            {gqResult.result_count} result{gqResult.result_count === 1 ? '' : 's'} ·
            {gqResult.execution_time_ms}ms
          </p>
          {#if gqResult.results.length > 0}
            <ul class="mt-2 flex flex-col gap-1">
              {#each gqResult.results as row, i (i)}
                <li class="rounded border px-2 py-1 text-xs break-all">{gqRowLabel(row)}</li>
              {/each}
            </ul>
          {:else}
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">No matches.</p>
          {/if}
        </div>
      {/if}
    </section>

    <!-- Ask this corpus -->
    <section class="flex flex-col gap-2 border-t pt-3">
      <h3 class="text-sm font-semibold">Ask this corpus</h3>
      <form class="flex flex-wrap gap-2" onsubmit={runAsk}>
        <input
          data-testid="research-corpus-ask-query"
          bind:value={askQuery}
          placeholder="Ask a question grounded in your pushed papers…"
          class="flex-1 min-w-60 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
        {#if docs.length > 0}
          <select
            data-testid="research-corpus-ask-scope"
            bind:value={askDocId}
            class="rounded border px-2 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          >
            <option value="">Whole graph</option>
            {#each docs as d (d.docId)}
              <option value={d.docId}>{d.title}</option>
            {/each}
          </select>
        {/if}
        <button
          type="submit"
          data-testid="research-corpus-ask-btn"
          disabled={asking || !askQuery.trim()}
          class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
        >
          {asking ? 'Asking…' : 'Ask'}
        </button>
      </form>

      {#if askError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="research-corpus-ask-error">
          {askError}
        </p>
      {/if}

      {#if askResult?.answer}
        <div
          class="rounded border p-3 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          data-testid="research-corpus-ask-answer"
        >
          <p class="whitespace-pre-line">{askResult.answer}</p>
          {#if askCitations.length > 0}
            <div class="mt-2 text-xs text-[var(--color-text-muted)]">
              <span class="font-medium">Citations</span>
              <ul class="list-disc pl-5">
                {#each askCitations as c, i (i)}
                  <li>{c.title ?? c.doc_id ?? 'source'}</li>
                {/each}
              </ul>
            </div>
          {/if}
        </div>
      {/if}
    </section>
  {/if}
</div>
