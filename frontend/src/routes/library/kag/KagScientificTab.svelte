<!--
  KAG "Scientific" tab — surfaces the Scientific Processor's verification engine
  directly on the KAG hub (the engine is fully proxied by fr-backend (#416) and
  exposed by researchApi, but until now only reachable inside the research
  stepper). Pick a graph entity (via semantic search), then run the full suite:

    Per-entity   integrity · contradictions · authority · subgraph ·
                 CoVe (on a claim) · SubgraphX explainability (async)
    Graph-wide   communities · formal verification
    Statistics   meta-analysis · confidence interval (via EvidenceSynthesisPanel)
                 · Mann-Kendall / regression trend detection
    RAGAS        faithfulness / answer-relevancy / context-precision scoring

  Read-only. Self-contained: all fetching lives here so the tab composes onto
  the existing AssetTabs without touching the research route.
-->
<script lang="ts">
  import { withOpenProject } from '$lib/api/kagProjectScope';
  import { onDestroy } from 'svelte';
  import { assetFetch, AssetError } from '$lib/api/assets';
  import { usePoll, type PollHandle } from '$lib/net/poll';
  import {
    researchApi,
    isExplainTerminal,
    type IntegrityResponse,
    type CoveResponse,
    type ContradictionResponse,
    type AuthorityResponse,
    type SubgraphResponse,
    type CommunityResponse,
    type FormalResponse,
    type ExplainJob,
    type TrendResponse,
    type RagasResponse,
  } from '$lib/api/research';
  import EvidenceSynthesisPanel from '../research/components/EvidenceSynthesisPanel.svelte';
  import KagContradictionList from '$lib/components/kag/KagContradictionList.svelte';
  import KagAuthorityRanking from '$lib/components/kag/KagAuthorityRanking.svelte';
  import KagSubgraphView from '$lib/components/kag/KagSubgraphView.svelte';
  import KagCommunityList from '$lib/components/kag/KagCommunityList.svelte';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }
  function fmt(n: unknown, d = 3): string {
    return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
  }
  /** Prettify a RAGAS metric key for display (`answer_relevancy` → "answer relevancy"). */
  function metricLabel(k: string): string {
    return k.replace(/_/g, ' ');
  }

  // ---- Find an entity to analyse (semantic search over the tenant graph) ----
  type SearchResponse = {
    nodes?: Array<Record<string, unknown>>;
    total_results?: number;
  };
  let query = $state('');
  let searching = $state(false);
  let searchError = $state('');
  let nodes = $state<Array<Record<string, unknown>>>([]);
  let selectedEntityId = $state('');
  let selectedLabel = $state('');

  function nodeId(n: Record<string, unknown>): string | null {
    const v = n.id;
    return typeof v === 'string' && v.length > 0 ? v : null;
  }
  function nodeLabel(n: Record<string, unknown>): string {
    for (const k of ['name', 'title', 'label', 'id']) {
      const v = n[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '(unnamed)';
  }

  async function runSearch(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (!query.trim()) {
      searchError = 'Enter a query to find an entity.';
      return;
    }
    searching = true;
    searchError = '';
    nodes = [];
    try {
      const res = await assetFetch<SearchResponse>('/api/assets/kag/search', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(withOpenProject({ query_text: query.trim(), limit: 25 })),
      });
      nodes = res.nodes ?? [];
    } catch (err) {
      searchError = errMsg(err);
    } finally {
      searching = false;
    }
  }

  function selectEntity(n: Record<string, unknown>): void {
    const id = nodeId(n);
    if (!id) return;
    selectedEntityId = id;
    selectedLabel = nodeLabel(n);
    // Reset per-entity analyses for the new selection.
    integrity = null;
    contradictions = null;
    authority = null;
    subgraph = null;
    cove = null;
    explain = null;
    clearExplainPoll();
    entityError = '';
  }

  // ---- Per-entity analyses ----
  let integrity = $state<IntegrityResponse | null>(null);
  let contradictions = $state<ContradictionResponse | null>(null);
  let authority = $state<AuthorityResponse | null>(null);
  let subgraph = $state<SubgraphResponse | null>(null);
  let cove = $state<CoveResponse | null>(null);
  let claimText = $state('');
  let entityRunning = $state(false);
  let entityError = $state('');

  // ---- Typed accessors: distinguish a true-empty result (0) from a shape miss (undefined).
  //      Each returns `number`/value on a readable result, or `undefined` when NONE of the
  //      expected upstream keys are present (→ render an explicit "unreadable" tile, not a fake 0).
  const contradictionCount = $derived.by<number | undefined>(() => {
    if (!contradictions) return undefined;
    if (typeof contradictions.total_contradictions === 'number')
      return contradictions.total_contradictions;
    if (Array.isArray(contradictions.contradiction_pairs))
      return contradictions.contradiction_pairs.length;
    return undefined;
  });
  /** Authority score of the *selected* entity within its ego network, if the map carries it. */
  const authorityScore = $derived.by<number | undefined>(() => {
    const scores = authority?.scores;
    if (scores && typeof scores[selectedEntityId] === 'number') return scores[selectedEntityId];
    return undefined;
  });
  /** True once we have any readable authority signal (score map, ranked list, or a count). */
  const authorityReadable = $derived(
    !!authority &&
      (authorityScore !== undefined ||
        (Array.isArray(authority.top_entities) && authority.top_entities.length > 0) ||
        typeof authority.entity_count === 'number'),
  );
  const communityCount = $derived.by<number | undefined>(() => {
    if (!communities) return undefined;
    if (typeof communities.number_of_communities === 'number')
      return communities.number_of_communities;
    if (communities.entity_communities && typeof communities.entity_communities === 'object')
      return new Set(Object.values(communities.entity_communities)).size;
    return undefined;
  });
  // Subgraph gains a readable/unreadable distinction like the others (it lacked one): readable ==
  // response present AND `nodes` is an array. `nodes`/`edges` feed KagSubgraphView (which pre-maps
  // source_id/target_id endpoints so KagGraph doesn't drop them).
  const subgraphReadable = $derived(!!subgraph && Array.isArray(subgraph.nodes));
  const subgraphNodes = $derived<Array<Record<string, unknown>>>(subgraph?.nodes ?? []);
  const subgraphEdges = $derived<Array<Record<string, unknown>>>(subgraph?.edges ?? []);
  /** CoVe verdict, preferring the real upstream `overall_verdict`; legacy fields as fallback. */
  const coveVerdict = $derived.by<string | undefined>(() => {
    if (!cove) return undefined;
    if (typeof cove.overall_verdict === 'string' && cove.overall_verdict.length > 0)
      return cove.overall_verdict;
    if (typeof cove.verdict === 'string' && cove.verdict.length > 0) return cove.verdict;
    if (typeof cove.supported === 'boolean') return cove.supported ? 'supported' : 'unsupported';
    return undefined;
  });

  async function runEntityAnalyses(): Promise<void> {
    if (!selectedEntityId || entityRunning) return;
    entityRunning = true;
    entityError = '';
    // Reset per-entity results so a re-run for the same entity can't leave stale values on a task
    // that now fails (selectEntity only resets on a *new* selection).
    integrity = null;
    contradictions = null;
    authority = null;
    subgraph = null;
    cove = null;
    const id = selectedEntityId;
    const tasks: Array<Promise<void>> = [
      researchApi.verifyIntegrity({ entity_id: id }).then((r) => void (integrity = r)),
      researchApi
        .topologyContradictions({ entity_id: id })
        .then((r) => void (contradictions = r)),
      researchApi.topologyAuthority({ entity_id: id }).then((r) => void (authority = r)),
      researchApi.topologySubgraph({ entity_id: id }).then((r) => void (subgraph = r)),
    ];
    if (claimText.trim()) {
      tasks.push(
        researchApi
          .verifyCove({ claim_text: claimText.trim() })
          .then((r) => void (cove = r)),
      );
    }
    const settled = await Promise.allSettled(tasks);
    // Surface every failed analytic, not just the first — otherwise a second/third
    // rejection is silently swallowed and its tile just reads empty.
    const failures = settled
      .filter((s): s is PromiseRejectedResult => s.status === 'rejected')
      .map((s) => errMsg(s.reason));
    entityError = failures.length > 0 ? Array.from(new Set(failures)).join(' · ') : '';
    entityRunning = false;
  }

  // ---- SubgraphX explainability (async job + poll) ----
  let explain = $state<ExplainJob | null>(null);
  let explainPoll: PollHandle | null = null;
  function clearExplainPoll(): void {
    explainPoll?.stop();
    explainPoll = null;
  }
  async function runExplain(): Promise<void> {
    if (!selectedEntityId) return;
    clearExplainPoll();
    try {
      const job = await researchApi.explainSubgraphx({ node_id: selectedEntityId });
      explain = job;
      const jobId = job.job_id;
      if (jobId && !isExplainTerminal(job.status)) {
        explainPoll = usePoll(
          async () => {
            try {
              const d = await researchApi.getExplainJob(jobId);
              explain = d;
              if (isExplainTerminal(d.status)) clearExplainPoll();
            } catch (e) {
              explain = { status: 'failed', error: errMsg(e) };
              clearExplainPoll();
            }
          },
          { intervalMs: 3000 },
        );
        explainPoll.start();
      }
    } catch (e) {
      explain = { status: 'failed', error: errMsg(e) };
    }
  }

  // ---- Graph-wide analyses ----
  let communities = $state<CommunityResponse | null>(null);
  let communitiesRunning = $state(false);
  let communitiesError = $state('');
  async function runCommunities(): Promise<void> {
    communitiesRunning = true;
    communitiesError = '';
    try {
      communities = await researchApi.topologyCommunities({});
    } catch (e) {
      communitiesError = errMsg(e);
    } finally {
      communitiesRunning = false;
    }
  }

  let formalExpression = $state('');
  let formal = $state<FormalResponse | null>(null);
  let formalRunning = $state(false);
  let formalError = $state('');
  async function runFormal(): Promise<void> {
    if (!formalExpression.trim()) {
      formalError = 'Enter a formal expression to verify.';
      return;
    }
    formalRunning = true;
    formalError = '';
    try {
      // The Scientific Processor's formal verifier wants a `formal_expression`
      // (e.g. a logic / z3 expression), not a free-text claim.
      formal = await researchApi.formalVerify({
        formal_expression: formalExpression.trim(),
      });
    } catch (e) {
      formalError = errMsg(e);
    } finally {
      formalRunning = false;
    }
  }

  // ---- Statistics: trend detection over a numeric time-series ----
  // The Scientific Processor's TrendRequest wants `data: [{timestamp, value}]`
  // (≥3 points). Parse a forgiving text grid: one point per non-empty line —
  // "timestamp, value" (two numbers) or a bare "value" (index becomes the
  // timestamp). Meta-analysis + confidence-interval reuse EvidenceSynthesisPanel.
  let trendInput = $state('');
  let trendTest = $state<'mann_kendall' | 'linear_regression'>('mann_kendall');
  let trend = $state<TrendResponse | null>(null);
  let trendRunning = $state(false);
  let trendError = $state('');

  const trendPoints = $derived.by<Array<{ timestamp: number; value: number }>>(() => {
    const pts: Array<{ timestamp: number; value: number }> = [];
    let idx = 0;
    for (const line of trendInput.split(/\n/)) {
      const nums = line
        .split(/[\s,]+/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
        .map(Number)
        .filter((n) => Number.isFinite(n));
      if (nums.length === 0) continue;
      idx += 1;
      if (nums.length === 1) pts.push({ timestamp: idx, value: nums[0] });
      else pts.push({ timestamp: nums[0], value: nums[1] });
    }
    return pts;
  });

  async function runTrend(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const data = trendPoints;
    if (data.length < 3) {
      trendError = 'Enter at least 3 points (one per line — "timestamp, value" or a bare value).';
      trend = null;
      return;
    }
    trendRunning = true;
    trendError = '';
    trend = null;
    try {
      trend = await researchApi.statsTrend({ data, test: trendTest });
    } catch (err) {
      trendError = errMsg(err);
    } finally {
      trendRunning = false;
    }
  }

  // ---- RAGAS: faithfulness / answer-relevancy / context-precision scoring ----
  // RagasRequest = { question, answer, contexts: string[] (≥1) }. The response is
  // a loose metrics bag — rendered defensively (every numeric metric it returns).
  let ragasQuestion = $state('');
  let ragasAnswer = $state('');
  let ragasContexts = $state('');
  let ragas = $state<RagasResponse | null>(null);
  let ragasRunning = $state(false);
  let ragasError = $state('');

  const ragasMetrics = $derived.by<Array<[string, number]>>(() => {
    if (!ragas) return [];
    return Object.entries(ragas).filter(
      ([k, v]) => typeof v === 'number' && Number.isFinite(v) && !k.endsWith('_ms'),
    ) as Array<[string, number]>;
  });

  async function runRagas(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const contexts = ragasContexts
      .split(/\n/)
      .map((c) => c.trim())
      .filter((c) => c.length > 0);
    if (!ragasQuestion.trim() || !ragasAnswer.trim() || contexts.length === 0) {
      ragasError = 'Enter a question, an answer, and at least one context (one per line).';
      ragas = null;
      return;
    }
    ragasRunning = true;
    ragasError = '';
    ragas = null;
    try {
      ragas = await researchApi.verifyRagas({
        question: ragasQuestion.trim(),
        answer: ragasAnswer.trim(),
        contexts,
      });
    } catch (err) {
      ragasError = errMsg(err);
    } finally {
      ragasRunning = false;
    }
  }

  onDestroy(() => clearExplainPoll());
</script>

<div class="max-w-4xl flex flex-col gap-6" data-testid="kag-scientific-tab">
  <div>
    <h2 class="text-lg font-semibold mb-1">Scientific verification</h2>
    <p class="text-sm text-[var(--color-text-muted)]">
      Run the Scientific Processor's verification engine over your knowledge
      graph — integrity, contradictions, authority, explainability, and formal
      checks. Read-only.
    </p>
  </div>

  <!-- 1. Find an entity -->
  <section class="flex flex-col gap-2">
    <h3 class="text-sm font-semibold">1 · Find an entity</h3>
    <form class="flex flex-wrap gap-2" onsubmit={runSearch}>
      <input
        data-testid="kag-sci-query"
        bind:value={query}
        placeholder="Search the graph for an entity…"
        class="flex-1 min-w-60 rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      />
      <button
        type="submit"
        data-testid="kag-sci-search"
        disabled={searching || !query.trim()}
        class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
      >
        {searching ? 'Searching…' : 'Search'}
      </button>
    </form>
    {#if searchError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-search-error">{searchError}</p>
    {/if}
    {#if nodes.length > 0}
      <ul class="divide-y divide-[var(--color-border)] border rounded" data-testid="kag-sci-nodes">
        {#each nodes as n, i (nodeId(n) ?? i)}
          {@const id = nodeId(n)}
          <li class="flex items-center justify-between gap-2 px-3 py-2">
            <span class="text-sm">{nodeLabel(n)}</span>
            {#if id}
              <button
                type="button"
                data-testid="kag-sci-select"
                onclick={() => selectEntity(n)}
                class="rounded border px-2 py-1 text-xs {selectedEntityId === id
                  ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]'
                  : ''}"
              >
                {selectedEntityId === id ? 'Selected' : 'Select'}
              </button>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <!-- 2. Per-entity analyses -->
  <section class="flex flex-col gap-2 border-t pt-4">
    <h3 class="text-sm font-semibold">2 · Analyse the selected entity</h3>
    {#if !selectedEntityId}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="kag-sci-noentity">
        Select an entity above to enable per-entity analyses.
      </p>
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]">
        Selected: <span class="font-medium">{selectedLabel}</span>
        <span class="font-mono">({selectedEntityId})</span>
      </p>
      <div>
        <label for="kag-sci-claim" class="block text-xs font-semibold uppercase mb-1">Claim (optional — for CoVe)</label>
        <input
          id="kag-sci-claim"
          data-testid="kag-sci-claim"
          bind:value={claimText}
          placeholder="A factual claim to chain-of-verify…"
          class="w-full rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </div>
      <div class="flex flex-wrap gap-2">
        <button
          type="button"
          data-testid="kag-sci-run-entity"
          disabled={entityRunning}
          onclick={() => void runEntityAnalyses()}
          class="rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
        >
          {entityRunning ? 'Analysing…' : 'Run integrity · contradictions · authority · subgraph · CoVe'}
        </button>
        <button
          type="button"
          data-testid="kag-sci-run-explain"
          onclick={() => void runExplain()}
          class="rounded border px-3 py-2 text-sm"
        >
          Explain (SubgraphX)
        </button>
      </div>
      {#if entityError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-entity-error">{entityError}</p>
      {/if}

      <div class="flex flex-col gap-1 text-sm" data-testid="kag-sci-entity-results">
        {#if integrity}
          <div data-testid="kag-sci-integrity">
            Integrity:
            <span class="font-medium">
              {typeof integrity.integrity_score === 'number'
                ? integrity.integrity_score.toFixed(2)
                : 'n/a'}</span
            >
            {#if integrity.components?.length}
              <span class="text-xs text-[var(--color-text-muted)]">
                ({integrity.components
                  .map((c) => `${c.name ?? 'signal'} ${typeof c.score === 'number' ? c.score.toFixed(2) : '–'}`)
                  .join(', ')})</span
              >
            {/if}
          </div>
        {/if}
        {#if contradictions}
          {#if contradictionCount === undefined}
            <div class="text-[var(--color-warning-text)]" data-testid="kag-sci-contradictions-unreadable">
              Contradictions: couldn't read result — unexpected shape
            </div>
          {:else}
            <details class="text-sm" open={contradictionCount > 0}>
              <summary class="cursor-pointer font-semibold" data-testid="kag-sci-contradictions">
                Contradictions: {contradictionCount}
              </summary>
              {#if contradictionCount > 0}
                <div class="mt-2">
                  <KagContradictionList pairs={contradictions.contradiction_pairs ?? []} />
                </div>
              {/if}
            </details>
          {/if}
        {/if}
        {#if authority}
          {#if !authorityReadable}
            <div class="text-[var(--color-warning-text)]" data-testid="kag-sci-authority-unreadable">
              Authority: couldn't read result — unexpected shape
            </div>
          {:else}
            <details
              class="text-sm"
              open={Array.isArray(authority.top_entities) && authority.top_entities.length > 0}
            >
              <summary class="cursor-pointer font-semibold" data-testid="kag-sci-authority">
                Authority score:
                {authorityScore !== undefined ? authorityScore.toFixed(3) : 'n/a'}
                {#if typeof authority.entity_count === 'number'}
                  <span class="text-xs text-[var(--color-text-muted)]"
                    >({authority.entity_count} entities ranked)</span
                  >
                {/if}
              </summary>
              {#if Array.isArray(authority.top_entities) && authority.top_entities.length > 0}
                <div class="mt-2">
                  <KagAuthorityRanking entities={authority.top_entities} />
                </div>
              {/if}
            </details>
          {/if}
        {/if}
        {#if subgraph}
          {#if !subgraphReadable}
            <div class="text-[var(--color-warning-text)]" data-testid="kag-sci-subgraph-unreadable">
              Subgraph: couldn't read result — unexpected shape
            </div>
          {:else}
            <details class="text-sm" open={subgraphNodes.length > 0}>
              <summary class="cursor-pointer font-semibold" data-testid="kag-sci-subgraph">
                Subgraph: {subgraphNodes.length} nodes · {subgraphEdges.length} edges
              </summary>
              {#if subgraphNodes.length > 0}
                <div class="mt-2">
                  <KagSubgraphView nodes={subgraphNodes} edges={subgraphEdges} />
                </div>
              {/if}
            </details>
          {/if}
        {/if}
        {#if cove}
          {#if coveVerdict === undefined}
            <div class="text-[var(--color-warning-text)]" data-testid="kag-sci-cove-unreadable">
              CoVe: couldn't read result — unexpected shape
            </div>
          {:else}
            <div data-testid="kag-sci-cove">
              CoVe: {coveVerdict}
              {#if typeof cove.confidence === 'number'} · confidence {cove.confidence.toFixed(2)}{/if}
            </div>
          {/if}
        {/if}
        {#if explain}
          <div data-testid="kag-sci-explain">
            SubgraphX: {explain.status ?? 'pending'}{#if explain.error} — {explain.error}{/if}
          </div>
        {/if}
      </div>
    {/if}
  </section>

  <!-- 3. Graph-wide analyses -->
  <section class="flex flex-col gap-2 border-t pt-4">
    <h3 class="text-sm font-semibold">3 · Graph-wide analyses</h3>
    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="kag-sci-run-communities"
        disabled={communitiesRunning}
        onclick={() => void runCommunities()}
        class="rounded border px-3 py-2 text-sm disabled:opacity-50"
      >{communitiesRunning ? 'Detecting…' : 'Detect communities'}</button>
      {#if communities && communityCount === undefined}
        <span class="text-sm text-[var(--color-warning-text)]" data-testid="kag-sci-communities-unreadable"
          >couldn't read result — unexpected shape</span
        >
      {/if}
      {#if communitiesError}
        <span class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-communities-error">{communitiesError}</span>
      {/if}
    </div>
    {#if communities && communityCount !== undefined}
      <details class="text-sm" open={communityCount > 0}>
        <summary class="cursor-pointer font-semibold" data-testid="kag-sci-communities">
          {communityCount} communities
        </summary>
        {#if communityCount > 0}
          <div class="mt-2">
            <KagCommunityList
              entityCommunities={communities.entity_communities ?? {}}
              communitySizes={communities.community_sizes}
            />
          </div>
        {/if}
      </details>
    {/if}
    <div class="flex flex-wrap items-end gap-2">
      <div class="flex-1 min-w-60">
        <label for="kag-sci-formal-claim" class="block text-xs font-semibold uppercase mb-1">Formal expression</label>
        <input
          id="kag-sci-formal-claim"
          data-testid="kag-sci-formal-claim"
          bind:value={formalExpression}
          placeholder="A formal/logic expression to verify, e.g. p -> q…"
          class="w-full rounded border px-3 py-2 bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </div>
      <button
        type="button"
        data-testid="kag-sci-run-formal"
        disabled={formalRunning}
        onclick={() => void runFormal()}
        class="rounded border px-3 py-2 text-sm disabled:opacity-50"
      >{formalRunning ? 'Verifying…' : 'Verify'}</button>
    </div>
    {#if formal}
      <p class="text-sm" data-testid="kag-sci-formal">
        Formal: {formal.is_valid === true
          ? 'valid'
          : formal.is_valid === false
            ? 'invalid'
            : 'undecidable'}{#if formal.proof} — {formal.proof}{/if}
      </p>
    {/if}
    {#if formalError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-formal-error">{formalError}</p>
    {/if}
  </section>

  <!-- 4. Statistics (evidence synthesis + trend) -->
  <section class="flex flex-col gap-3 border-t pt-4" data-testid="kag-sci-stats">
    <div>
      <h3 class="text-sm font-semibold">4 · Statistics</h3>
      <p class="text-xs text-[var(--color-text-muted)]">
        Pool extracted study results across the corpus (meta-analysis + forest plot,
        confidence intervals), and detect temporal trends in a numeric series. Pure
        stats — no graph entity required.
      </p>
    </div>

    <!-- Meta-analysis + confidence interval, reused verbatim from the research hub. -->
    <EvidenceSynthesisPanel />

    <!-- Trend detection -->
    <form class="flex flex-col gap-2 border-t pt-3" onsubmit={runTrend}>
      <label class="text-xs font-semibold uppercase" for="kag-sci-trend-input">
        Trend over a time-series
      </label>
      <p class="text-xs text-[var(--color-text-muted)]">
        One point per line — "timestamp, value" (e.g. <span class="font-mono">2019, 0.42</span>)
        or a bare value (line number becomes the timestamp). At least 3 points.
      </p>
      <textarea
        id="kag-sci-trend-input"
        data-testid="kag-sci-trend-input"
        bind:value={trendInput}
        rows="3"
        placeholder={"2019, 0.42\n2020, 0.51\n2021, 0.63"}
        class="w-full rounded border px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
      ></textarea>
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1 text-xs">
          <span class="text-[var(--color-text-muted)]">Test</span>
          <select
            data-testid="kag-sci-trend-test"
            bind:value={trendTest}
            class="rounded border bg-[var(--color-bg)] dark:bg-[var(--color-surface)] px-2 py-1"
          >
            <option value="mann_kendall">Mann-Kendall</option>
            <option value="linear_regression">Linear regression</option>
          </select>
        </label>
        <button
          type="submit"
          data-testid="kag-sci-run-trend"
          disabled={trendRunning || trendPoints.length < 3}
          class="rounded border px-3 py-2 text-sm disabled:opacity-50"
        >{trendRunning ? 'Analysing…' : 'Detect trend'}</button>
        <span class="text-xs text-[var(--color-text-muted)]">{trendPoints.length} points</span>
      </div>
      {#if trendError}
        <p class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-trend-error">{trendError}</p>
      {/if}
      {#if trend}
        <div class="flex flex-wrap items-baseline gap-x-4 text-sm" data-testid="kag-sci-trend">
          <span>
            <span class="text-[var(--color-text-muted)]">Trend</span>
            <strong>{trend.trend ?? 'n/a'}</strong>
          </span>
          <span class="text-xs text-[var(--color-text-muted)]">
            slope {fmt(trend.slope)} · p {fmt(trend.p_value)} · statistic {fmt(trend.statistic)}
          </span>
        </div>
      {/if}
    </form>
  </section>

  <!-- 5. RAGAS verification -->
  <section class="flex flex-col gap-2 border-t pt-4" data-testid="kag-sci-ragas-section">
    <div>
      <h3 class="text-sm font-semibold">5 · RAGAS answer verification</h3>
      <p class="text-xs text-[var(--color-text-muted)]">
        Score a generated answer against its retrieved contexts — faithfulness,
        answer-relevancy and context-precision. Paste one context per line.
      </p>
    </div>
    <form class="flex flex-col gap-2" onsubmit={runRagas}>
      <div>
        <label for="kag-sci-ragas-question" class="block text-xs font-semibold uppercase mb-1">Question</label>
        <input
          id="kag-sci-ragas-question"
          data-testid="kag-sci-ragas-question"
          bind:value={ragasQuestion}
          placeholder="The question the answer responds to…"
          class="w-full rounded border px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        />
      </div>
      <div>
        <label for="kag-sci-ragas-answer" class="block text-xs font-semibold uppercase mb-1">Answer</label>
        <textarea
          id="kag-sci-ragas-answer"
          data-testid="kag-sci-ragas-answer"
          bind:value={ragasAnswer}
          rows="2"
          placeholder="The generated answer to score…"
          class="w-full rounded border px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        ></textarea>
      </div>
      <div>
        <label for="kag-sci-ragas-contexts" class="block text-xs font-semibold uppercase mb-1">Contexts (one per line)</label>
        <textarea
          id="kag-sci-ragas-contexts"
          data-testid="kag-sci-ragas-contexts"
          bind:value={ragasContexts}
          rows="3"
          placeholder={"Retrieved context passage 1…\nRetrieved context passage 2…"}
          class="w-full rounded border px-3 py-2 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
        ></textarea>
      </div>
      <button
        type="submit"
        data-testid="kag-sci-run-ragas"
        disabled={ragasRunning}
        class="self-start rounded bg-[var(--color-accent)] px-4 py-2 text-[var(--color-on-primary)] disabled:opacity-50"
      >{ragasRunning ? 'Scoring…' : 'Score with RAGAS'}</button>
    </form>
    {#if ragasError}
      <p class="text-sm text-[var(--color-danger)]" data-testid="kag-sci-ragas-error">{ragasError}</p>
    {/if}
    {#if ragas}
      {#if ragasMetrics.length > 0}
        <div class="flex flex-wrap gap-x-6 gap-y-1 text-sm" data-testid="kag-sci-ragas">
          {#each ragasMetrics as [k, v] (k)}
            <span>
              <span class="text-[var(--color-text-muted)]">{metricLabel(k)}</span>
              <strong>{fmt(v)}</strong>
            </span>
          {/each}
        </div>
      {:else}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="kag-sci-ragas-empty">
          Scored, but no numeric metrics were returned.
        </p>
      {/if}
    {/if}
  </section>
</div>
