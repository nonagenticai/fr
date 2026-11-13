<!--
  KAG "Ask & search" tab — natural-language Q&A with citations + read-only
  semantic search over the knowledge graph (the KagGraph viz renders the search
  result set, so Ask, Search and Graph share state and live in one tab).

  Lifted verbatim from the bespoke /library/kag inline tab during the /tools
  dissolution (control-plane roadmap Phase 2); state/behaviour unchanged.
-->
<script lang="ts">
  import { assetFetch, AssetError } from '$lib/api/assets';
  import { kagGraphApi } from '$lib/api/kag';
  import { withOpenProject } from '$lib/api/kagProjectScope';
  import KagGraph from '$lib/components/kag/KagGraph.svelte';
  import KagNodeCard from '$lib/components/kag/KagNodeCard.svelte';
  import KagChunkCard from '$lib/components/kag/KagChunkCard.svelte';
  import {
    COMPARE_MODES,
    askContextsFrom,
    citationLabel,
    type AskMode,
    type AskResult,
    type CompareColumn,
  } from '$lib/components/kag/kagAsk';
  import KagAskAnswerBody from '$lib/components/kag/KagAskAnswerBody.svelte';
  import KagCompareModesPanel from '$lib/components/kag/KagCompareModesPanel.svelte';
  import KagAnswerVerification from '$lib/components/kag/KagAnswerVerification.svelte';
  import KagCallInspector from '$lib/components/kag/KagCallInspector.svelte';
  import type { GatewayCall } from '$lib/components/kag/kagInspect';

  type SemanticSearchResponse = {
    query_text?: string;
    nodes?: Array<Record<string, unknown>>;
    relationships?: Array<Record<string, unknown>>;
    total_results?: number;
    // The upstream may also return citations on some routes; render any
    // `citations`/`sources` array present without crashing if absent.
    citations?: Array<Record<string, unknown>>;
    sources?: Array<Record<string, unknown>>;
  };

  // kag POST /query/chunks — the retrieval leg of Ask with no synthesis on top.
  // `results` carries the SAME AnswerChunk records `/query/ask` puts in
  // `chunks` ({ text, score, source: { doc_id, title, url, page, chunk_id } }),
  // which is why they go STRAIGHT into KagChunkCard below — see the note there.
  type ChunkSearchResponse = {
    query?: string;
    results?: Array<Record<string, unknown>>;
    // kag's ChunkSearchDiagnostics — NOT the ask's RetrievalDiagnostics. The
    // only field this surface reads is `score_kind`, and it reads it because a
    // number without its unit is the fabrication this tab has shipped twice.
    diagnostics?: {
      score_kind?: 'cosine' | 'rrf';
      returned_count?: number;
      dense_top_score?: number | null;
    } | null;
  };

  // Upstream caps `top_k` at 20 (`ChunkSearchRequest.top_k` is `ge=1, le=20`) —
  // a PHI-containment ceiling, not a page size, so 50 is a 422 rather than a
  // bigger result. The Limit field allows up to 100 for the node search, which
  // has no such cap, so the passage leg clamps instead of inheriting it.
  const CHUNK_TOP_K_MAX = 20;

  let query = $state('');
  let limit = $state(10);
  // ⚠️ ONE FLAG PER LEG, DELIBERATELY. A single `searching` gating the whole
  // results region made the fast leg wait for the slow one: `/search` answers
  // in ~200ms, the passage leg is allowed 60s upstream
  // (`CHUNK_SEARCH_TIMEOUT_MS`), so a slow or hanging kag blanked results that
  // were ALREADY IN HAND for up to a minute. Each section renders the moment
  // ITS OWN leg settles.
  let searchingNodes = $state(false);
  let searchingPassages = $state(false);
  // …but the BUTTON is disabled while EITHER leg is open. That single-flight
  // property is load-bearing (see `searchSeq` below) and splitting the flag
  // must not weaken it.
  const searching = $derived(searchingNodes || searchingPassages);
  // Request-sequence guard. `disabled` makes a concurrent submit unreachable
  // through the button, but it is not a guarantee: `requestSubmit()` never
  // consults the submitter's disabled state, and neither would a future
  // programmatic caller. Every submit mints a new id and a leg writes state
  // only while its id is still current, so a slow first search can never
  // clobber a fast second one. NOT $state: nothing renders it.
  let searchSeq = 0;
  let error = $state('');
  let result = $state<SemanticSearchResponse | null>(null);
  // Passage results are a SEPARATE leg of the same submit: semantic search
  // returns graph ENTITY NODES, so a concept phrase that never got promoted to
  // a node renders an empty search even though the corpus answers it fine. Own
  // state + own error so neither leg can blank the other.
  let passages = $state<Array<Record<string, unknown>> | null>(null);
  let passagesError = $state('');
  // The UNIT of every passage `score`, straight from the response. `'rrf'` is a
  // pure function of RANK (~0.0164 for the top hit of EVERY query, however bad)
  // and `'cosine'` is a real 0..1 similarity; they are not comparable, so the
  // unit is disclosed rather than folded into one figure.
  let passagesScoreKind = $state<'cosine' | 'rrf' | undefined>(undefined);

  // Ask Q&A — independent state from the semantic-search form.
  let askQuery = $state('');
  let askMode = $state<AskMode>('hybrid_rerank');
  // When on, retrieve precise sentence/paragraph passages (hierarchical) instead
  // of composing a document-level RAG answer — tighter provenance, no synthesis.
  let usePrecise = $state(false);
  let asking = $state(false);
  // Request-sequence guard for the ask leg, exactly as `searchSeq` above and
  // for exactly the same reason: `disabled={asking}` makes a concurrent submit
  // unreachable through the button, but `requestSubmit()` never consults the
  // submitter's disabled state, so a slow ask could land its answer, citations
  // and verification widget under a DIFFERENT question. Every submit mints a
  // new id and writes state only while its id is still current. NOT $state:
  // nothing renders it.
  let askSeq = 0;
  let askError = $state('');
  let askResult = $state<AskResult | null>(null);
  // "Compare modes" fans the same question out across every retrieval mode and
  // renders the results side-by-side; independent of precise-passage mode.
  let compareMode = $state(false);
  let askColumns = $state<CompareColumn[]>([]);
  // The question + gateway call captured at submit time (so "verify this answer"
  // and the inspector reflect what produced THIS result, not the live inputs).
  let lastAskQuestion = $state('');
  let lastAskMode = $state<AskMode>('hybrid_rerank');
  // …and WHICH SHAPE of result this submit asked for. The results region is
  // gated on THIS, never on the live `compareMode` checkbox: `compareMode` says
  // what the NEXT submit will do, so gating on it made a finished answer
  // vanish into a blank region the instant "Compare modes" was ticked — no
  // error, no spinner, and no way back except re-asking. Same snapshot-at-
  // submit discipline as `lastAskQuestion`/`lastAskMode`/`lastAskCall` above.
  let lastAskCompare = $state(false);
  // …and whether it was a PRECISE (hierarchical, retrieval-only) submit. Same
  // snapshot-at-submit discipline and same reason: `usePrecise` says what the
  // NEXT submit will do, so rendering off it let un-ticking the box re-label a
  // finished retrieval as a failed ask ("No answer returned") with no request.
  let lastAskPrecise = $state(false);
  let lastAskCall = $state<GatewayCall | null>(null);
  let lastSearchCall = $state<GatewayCall | null>(null);
  // `runSearch` fires TWO legs and only the node leg was ever recorded, so the
  // inspector showed one of two calls with nothing indicating the other existed.
  let lastPassagesCall = $state<GatewayCall | null>(null);
  // The one cross-query-comparable number this route emits. kag sends it on
  // every chunk search; fr declared it nowhere and rendered it never, so the
  // surface threw away the only score a user could compare between two searches.
  let passagesDenseTop = $state<number | null>(null);

  async function runAsk(e: SubmitEvent) {
    e.preventDefault();
    // Mint the id BEFORE the early return, as `runSearch` does: an invalid
    // submit supersedes an in-flight one too, or the discarded question's
    // answer lands under "Question is required."
    const seq = ++askSeq;
    if (!askQuery.trim()) {
      askError = 'Question is required.';
      // ⛔ CLEAR THE ANSWER STATE ON THIS PATH TOO — the ask leg's half of the
      // defect `runSearch` already fixed below (see the matching note on its
      // "Query is required." branch; the two legs are deliberately symmetric).
      // `required` on the textarea admits a whitespace-only value, so this
      // branch is reachable by submitting spaces — and returning early without
      // this left the PREVIOUS question's answer, its citations, the
      // verification widget (still seeded with the OLD question and answer) and
      // the call inspector rendered underneath "Question is required.",
      // attributing one question's evidence to another.
      askResult = null;
      askColumns = [];
      lastAskQuestion = '';
      lastAskMode = askMode;
      lastAskCompare = false;
      lastAskPrecise = false;
      lastAskCall = null;
      // …including any request still in flight from the superseded submit:
      // `askSeq` has already moved on, so its response is dropped on arrival.
      // ⚠️ CLEARING `asking` HERE IS LOAD-BEARING, not tidiness. The in-flight
      // request's `finally` is ownership-guarded below and will therefore NOT
      // clear the flag when it returns, so this branch is the ONLY thing left
      // that can — and without it the submit button stays disabled forever
      // after an invalid submit made mid-flight. (This replaces an earlier note
      // arguing the exact opposite; it was correct only while this leg had no
      // sequence guard.)
      asking = false;
      return;
    }
    asking = true;
    askError = '';
    askResult = null;
    askColumns = [];
    lastAskQuestion = askQuery.trim();
    lastAskMode = askMode;
    lastAskCompare = compareMode;
    lastAskPrecise = usePrecise;
    lastAskCall = null;
    try {
      // Branch on the SNAPSHOT, symmetric with `lastAskCompare` below.
      if (lastAskPrecise) {
        // ⚠️ This must mirror what `kagGraphApi.hierarchicalRetrieval` puts ON
        // THE WIRE (`lib/api/kag.ts`), not the arguments it is called with. It
        // recorded `{ query, topK }` while the client sends
        // `{ query, document_id, levels, top_k }` — so the inspector's copyable
        // curl used `topK`, a field the route does not accept, and omitted
        // `levels` entirely. An inspector that shows a request the server would
        // reject is worse than no inspector: it is a confident wrong answer to
        // "what did we actually send?". `document_id` is omitted here because it
        // is undefined at this call site and JSON.stringify drops it.
        lastAskCall = {
          method: 'POST',
          path: '/api/assets/kag/hierarchical-retrieval',
          body: { query: askQuery.trim(), levels: ['sentence', 'paragraph'], top_k: 15 },
        };
        const res = await kagGraphApi.hierarchicalRetrieval({ query: askQuery.trim(), topK: 15 });
        if (seq !== askSeq) return;
        // Reuse the passages renderer; hierarchical retrieval has no synthesized
        // answer or citations, so surface just the ranked chunks.
        askResult = { chunks: res.results };
      } else if (lastAskCompare) {
        await runCompare(askQuery.trim(), seq);
      } else {
        const askBody = withOpenProject({ query: askQuery.trim(), mode: askMode });
        lastAskCall = { method: 'POST', path: '/api/assets/kag/ask', body: askBody };
        const res = await assetFetch<AskResult>('/api/assets/kag/ask', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(askBody),
        });
        if (seq !== askSeq) return;
        askResult = res;
      }
    } catch (e) {
      if (seq !== askSeq) return;
      askError = e instanceof AssetError ? e.message : (e instanceof Error ? e.message : String(e));
    } finally {
      // Only the CURRENT submit owns the flag; a superseded ask clearing it
      // would re-enable the button while the live one is still running.
      if (seq === askSeq) asking = false;
    }
  }

  // Fan the question out across every retrieval mode in parallel; each column
  // settles independently so one mode's failure never blanks the others.
  // `seq` is the submitting ask's request id: each column write is guarded by
  // it, so a superseded fan-out cannot repaint the live grid one column at a
  // time.
  async function runCompare(question: string, seq: number) {
    askColumns = COMPARE_MODES.map((mode) => ({ mode, status: 'pending' as const }));
    await Promise.allSettled(
      COMPARE_MODES.map(async (mode, i) => {
        const t0 = performance.now();
        try {
          const res = await assetFetch<AskResult>('/api/assets/kag/ask', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(withOpenProject({ query: question, mode })),
          });
          if (seq !== askSeq) return;
          askColumns[i] = { mode, status: 'ok', result: res, latencyMs: performance.now() - t0 };
        } catch (err) {
          if (seq !== askSeq) return;
          askColumns[i] = {
            mode,
            status: 'error',
            error:
              err instanceof AssetError
                ? err.message
                : err instanceof Error
                  ? err.message
                  : String(err),
            latencyMs: performance.now() - t0,
          };
        }
      }),
    );
  }

  function errMessage(e: unknown): string {
    return e instanceof AssetError ? e.message : e instanceof Error ? e.message : String(e);
  }

  // One submit, TWO independent retrievals over the same phrase:
  //   • /search        → graph entity nodes + relationships (the viz)
  //   • /chunk-search  → the source passages that mention it
  //
  // ⚠️ WHAT ACTUALLY ISOLATES THE LEGS IS THE PER-LEG `try/catch/finally`, NOT
  // `allSettled`. An earlier version of this comment credited `allSettled`,
  // which is false and worth correcting rather than deleting: each leg is an
  // async IIFE that catches its own error into its own state and clears its own
  // loading flag in `finally`, so neither promise ever REJECTS — `Promise.all`
  // would behave identically today. Believing the wrong mechanism is how
  // someone later "simplifies" the real one away.
  //
  // The legs are also not awaited for RENDERING purposes: each writes its own
  // state as it settles and the template gates each section on its own flag.
  // `allSettled` is kept as belt-and-braces for the refactor that removes or
  // narrows one of those catches — the `finally` clears the flag either way,
  // but a rejection escaping this `await` would still abort the function body.
  async function runSearch(e: SubmitEvent) {
    e.preventDefault();
    // Mint the id BEFORE the early return: an invalid submit supersedes an
    // in-flight one too, or the discarded query's results land under
    // "Query is required."
    const seq = ++searchSeq;
    if (!query.trim()) {
      error = 'Query is required.';
      // ⛔ CLEAR THE PASSAGE STATE ON THIS PATH TOO. `required` on the input
      // admits a whitespace-only value, so this branch is reachable by
      // submitting spaces — and returning early without this left the PREVIOUS
      // query's passages rendered underneath "Query is required.", attributing
      // one query's evidence to another. The node result is already nulled by
      // the same reasoning; these three were the half that got missed.
      passages = null;
      passagesScoreKind = undefined;
      passagesError = '';
      result = null;
      // …including any leg still in flight from the superseded submit: `seq`
      // has already moved on, so those responses are dropped on arrival.
      searchingNodes = false;
      searchingPassages = false;
      return;
    }
    searchingNodes = true;
    searchingPassages = true;
    error = '';
    passagesError = '';
    result = null;
    passages = null;
    passagesScoreKind = undefined;
    lastSearchCall = null;
    lastPassagesCall = null;
    passagesDenseTop = null;
    const q = query.trim();
    const nodeLimit = Number(limit) || 10;
    const topK = Math.min(nodeLimit, CHUNK_TOP_K_MAX);
    const body: Record<string, unknown> = withOpenProject({ query_text: q, limit: nodeLimit });
    const passagesBody = withOpenProject({ query: q, top_k: topK });
    lastSearchCall = { method: 'POST', path: '/api/assets/kag/search', body };
    lastPassagesCall = {
      method: 'POST',
      path: '/api/assets/kag/chunk-search',
      body: passagesBody,
    };
    await Promise.allSettled([
      (async () => {
        try {
          const res = await assetFetch<SemanticSearchResponse>('/api/assets/kag/search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          if (seq !== searchSeq) return;
          result = res;
        } catch (err) {
          if (seq !== searchSeq) return;
          error = errMessage(err);
        } finally {
          // Only the CURRENT submit owns the flag; a superseded leg clearing it
          // would re-enable the button while the live search is still running.
          if (seq === searchSeq) searchingNodes = false;
        }
      })(),
      (async () => {
        try {
          const res = await assetFetch<ChunkSearchResponse>('/api/assets/kag/chunk-search', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(passagesBody),
          });
          if (seq !== searchSeq) return;
          // `?? []` and NOT `?? null`: an answered-but-empty retrieval is a
          // real result and must render the empty state, not disappear.
          passages = res.results ?? [];
          passagesScoreKind = res.diagnostics?.score_kind;
          passagesDenseTop =
            typeof res.diagnostics?.dense_top_score === 'number'
              ? res.diagnostics.dense_top_score
              : null;
        } catch (err) {
          if (seq !== searchSeq) return;
          passagesError = errMessage(err);
        } finally {
          if (seq === searchSeq) searchingPassages = false;
        }
      })(),
    ]);
  }

  function relLabel(r: Record<string, unknown>): string {
    const t = typeof r.type === 'string' ? r.type : '';
    const s = typeof r.source === 'string' ? r.source : (typeof r.start === 'string' ? r.start : '?');
    const e = typeof r.target === 'string' ? r.target : (typeof r.end === 'string' ? r.end : '?');
    return `${s} -[${t || 'rel'}]-> ${e}`;
  }

  const citations = $derived(result?.citations ?? result?.sources ?? []);
  let selectedNode = $state<Record<string, unknown> | null>(null);
</script>

<div class="max-w-4xl">
  <!-- Ask: natural-language Q&A with citations.
       Backed by /query/ask upstream which routes through KAG's RAG pipeline. -->
  <section class="mb-8 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
    <h2 class="text-lg font-semibold mb-2">Ask</h2>
    <p class="text-sm text-[var(--color-text-muted)] mb-3 dark:text-[var(--color-text-muted)]">
      Ask a question in plain language. The assistant answers from your project's documents and shows citations.
    </p>
    <form class="space-y-3" onsubmit={runAsk}>
      <div>
        <label for="ask-q" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Question</label>
        <textarea
          id="ask-q"
          data-testid="kag-ask-q"
          bind:value={askQuery}
          rows="3"
          placeholder="What does the policy say about handling refunds?"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          required
        ></textarea>
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label for="ask-mode" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Mode</label>
          <select
            id="ask-mode"
            bind:value={askMode}
            disabled={usePrecise || compareMode}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] disabled:opacity-50"
          >
            <option value="hybrid_rerank">hybrid + rerank (default)</option>
            <option value="hybrid">hybrid</option>
            <option value="dense">dense (vector only)</option>
            <option value="full">full (slow, exhaustive)</option>
          </select>
        </div>
        <label class="flex items-center gap-1.5 pb-1 text-sm text-[var(--color-text)]" title="Retrieve exact sentence/paragraph passages instead of a composed answer">
          <input type="checkbox" bind:checked={usePrecise} disabled={compareMode} data-testid="kag-ask-precise" class="accent-[var(--color-accent)]" />
          Precise passages
        </label>
        <label class="flex items-center gap-1.5 pb-1 text-sm text-[var(--color-text)]" title="Run the question across every retrieval mode and compare the answers side-by-side">
          <input type="checkbox" bind:checked={compareMode} disabled={usePrecise} data-testid="kag-ask-compare" class="accent-[var(--color-accent)]" />
          Compare modes
        </label>
        <button type="submit" data-testid="kag-ask-submit" disabled={asking} class="ml-auto px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]">
          {asking ? (compareMode ? 'Comparing…' : 'Thinking…') : compareMode ? 'Compare' : usePrecise ? 'Retrieve' : 'Ask'}
        </button>
      </div>
    </form>

    {#if askError}
      <div class="mt-3 bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">{askError}</div>
    {/if}

    <!-- ⚠️ GATED ON THE SNAPSHOT, NOT ON THE LIVE CHECKBOX. `lastAskCompare`
         records what THIS result was asked for; `compareMode` records what the
         next submit will ask for. Gating here on `compareMode` blanked a
         finished answer the moment the box was ticked (and a finished compare
         grid the moment it was unticked) — see the note on `lastAskCompare`. -->
    {#if lastAskCompare}
      {#if askColumns.length}
        <div class="mt-4"><KagCompareModesPanel columns={askColumns} question={lastAskQuestion} /></div>
      {/if}
    {:else if asking}
      <div class="mt-4 flex items-center gap-2 text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">
        <span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"></span>
        Composing answer with citations…
      </div>
    {:else if askResult}
      <div class="mt-4"><KagAskAnswerBody result={askResult} mode={lastAskMode} retrievalOnly={lastAskPrecise} /></div>
      {#if typeof askResult.answer === 'string' && askResult.answer.trim()}
        <KagAnswerVerification
          question={lastAskQuestion}
          answer={askResult.answer}
          contexts={askContextsFrom(askResult)}
        />
      {/if}
      {#if lastAskCall}
        <KagCallInspector call={lastAskCall} />
      {/if}
    {/if}
  </section>

  <h2 class="text-lg font-semibold mb-2">Search</h2>
  <p class="text-sm text-[var(--color-text)] mb-4 dark:text-[var(--color-text-muted)]">
    Run a semantic search over the knowledge graph. Read-only.
  </p>

  <form class="space-y-3 mb-6" onsubmit={runSearch}>
    <div>
      <label for="q" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Query</label>
      <input
        id="q"
        type="search"
        bind:value={query}
        placeholder="Ask the graph a question…"
        data-testid="kag-search-q"
        class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
        required
      />
    </div>
    <div>
      <label for="lim" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Limit</label>
      <input id="lim" type="number" min="1" max="100" bind:value={limit} class="w-32 border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]" />
    </div>
    <button type="submit" disabled={searching} class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]">
      {searching ? 'Searching…' : 'Search'}
    </button>
  </form>

  {#if error}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4">{error}</div>
  {/if}

  <!-- ⚠️ EACH LEG GATES ITS OWN SECTION. A shared `{#if searching}` around both
       hid the ~200ms node results behind the passage leg's 60s budget — the
       user watched a spinner while the answer was already in memory. -->
  <!-- PASSAGES — the leg that makes a non-entity phrase answerable at all.
       Rendered above the graph because it is the result most searches
       actually have: entity promotion is lossy, the prose is not. -->
  {#if searchingPassages}
    <div
      class="flex items-center gap-2 text-[var(--color-text-muted)] text-sm mb-4 dark:text-[var(--color-text-muted)]"
      data-testid="kag-search-passages-loading"
    >
      <span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"></span>
      Retrieving passages…
    </div>
  {:else if passagesError}
    <div
      class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4"
      data-testid="kag-search-passages-error"
    >
      Passages unavailable: {passagesError}
    </div>
  {:else if passages}
    <section class="mb-6" data-testid="kag-search-passages">
      <!-- The Limit field feeds TWO legs with DIFFERENT ceilings: graph nodes
           legitimately accept up to 100, passages are capped at 20 upstream
           (`ChunkSearchRequest.top_k` is `ge=1, le=20`, a deliberate containment
           control on a HIPAA-targeted store). A user who types 100 and gets 20
           passages was given no way to know why — the count was disclosed, the
           CEILING was not. Shown only when it actually binds. -->
      <h2 class="text-lg font-semibold mb-2">
        Passages ({passages.length}){#if (Number(limit) || 10) > CHUNK_TOP_K_MAX}<span
            class="ml-2 text-xs font-normal text-[var(--color-text-muted)]"
            data-testid="kag-passages-ceiling"
            >passages cap at {CHUNK_TOP_K_MAX}; the limit of {Number(limit) || 10} applies to graph
            nodes</span
          >{/if}
      </h2>
      <!-- The per-passage score is NOT rendered as a percentage here (the
           card withholds it: see the `mode` note below), but the reader is
           still told which unit the ordering came from — an RRF score ranks,
           it does not measure. -->
      {#if passages.length > 0 && passagesScoreKind}
        <p
          class="text-xs text-[var(--color-text-muted)] mb-2"
          data-testid="kag-search-score-kind"
        >
          {passagesScoreKind === 'rrf'
            ? 'Ranked by reciprocal-rank fusion (dense + keyword). The score orders these passages; it is not a confidence.'
            : 'Ranked by vector similarity (cosine). No keyword arm contributed to this result.'}
        </p>
      {/if}
      <!-- The one number here a reader can carry BETWEEN searches.
           `score_kind` above tells you the unit of the per-passage scores, but
           that unit CHANGES between requests — a similarity under 'cosine', a
           rank statistic (1/61 == 0.016393 for a rank-0 hit) under 'rrf'. So
           comparing the top score of two searches cannot distinguish a better
           match from a different fusion state.
           `dense_top_score` is the raw top cosine of the dense arm, captured
           pre-fusion and emitted on EVERY request regardless of score_kind, so
           it is the only value that means the same thing each time.
           ⛔ Rendered RAW at 4dp — no percentage, no floor, no "weak match"
           badge. kag designed a relevance threshold and REFUSED it on live
           corpus data: a real relevant query scored 0.5979 while gibberish
           scored 0.6053, so the populations overlap and no cut-off separates
           them. Adding an interpretation here would re-invent exactly the
           judgement upstream measured and rejected. -->
      {#if passages.length > 0 && passagesDenseTop !== null}
        <p
          class="text-xs text-[var(--color-text-muted)] mb-2"
          data-testid="kag-search-dense-top"
        >
          Dense top cosine: <span class="font-mono">{passagesDenseTop.toFixed(4)}</span> — raw
          similarity of the best vector hit before fusion. Comparable across searches, unlike the
          per-passage score above. Not a confidence.
        </p>
      {/if}
      {#if passages.length === 0}
        <!-- ⛔ SAYS "THIS SEARCH FOUND NONE", NOT "THE CORPUS HAS NONE". A
             top-k retrieval miss is not evidence of absence: kag's own
             diagnostics separate `no_matching_content` from
             `insufficient_context` precisely because those are different
             claims, and this surface cannot tell which one it is holding. -->
        <p
          class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
          data-testid="kag-search-passages-empty"
        >
          This search found no matching passages. Try broader or different wording — and if
          you expected a specific document, check in Documents that it was ingested.
        </p>
      {:else}
        <div class="space-y-2">
          {#each passages as c, i (i)}
            <!-- No `mode` prop ON PURPOSE. `mode` is the ASK retrieval mode
                 that produced a chunk, and it is what KagChunkCard needs to
                 decide whether a score may be shown as a percentage. This
                 search has no ask mode, so declaring one would be inventing
                 it — and the card's contract is that an absent mode WITHHOLDS
                 the figure rather than guessing its scale.

                 But the scale is NOT unknown here, and passing nothing made
                 every card read a bare "unavailable", which a reader takes for
                 a broken score rather than a withheld one. `/query/chunks`
                 returns `score_kind` required-with-no-default precisely so the
                 unit travels with the number, so declare THAT instead. It still
                 cannot unlock a percentage — `scoreKindScale` never returns
                 `'crossencoder'` — it only lets the badge name its scale. -->
            <KagChunkCard chunk={c} scoreKind={passagesScoreKind} />
          {/each}
        </div>
      {/if}
    </section>
  {/if}

  {#if searchingNodes}
    <div
      class="flex items-center gap-2 text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]"
      data-testid="kag-search-nodes-loading"
    >
      <span class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"></span>
      Searching the knowledge graph…
    </div>
  {:else if result}
    <div class="space-y-6">
      <div class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Query: <span class="font-mono">{result.query_text ?? query}</span>
        {#if typeof result.total_results === 'number'} • {result.total_results} total results{/if}
      </div>

      <section>
        <h2 class="text-lg font-semibold mb-2">Graph</h2>
        <KagGraph
          nodes={result.nodes ?? []}
          relationships={result.relationships ?? []}
          onSelect={(n) => (selectedNode = n)}
        />
        {#if selectedNode}
          <div class="mt-2">
            <div class="text-xs uppercase text-[var(--color-text-muted)] mb-1">Selected node</div>
            <KagNodeCard node={selectedNode} />
          </div>
        {/if}
      </section>

      <section>
        <h2 class="text-lg font-semibold mb-2">Nodes ({(result.nodes ?? []).length})</h2>
        {#if !result.nodes || result.nodes.length === 0}
          <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No nodes.</p>
        {:else}
          <div class="space-y-2">
            {#each result.nodes as n, i (i)}
              <KagNodeCard node={n} />
            {/each}
          </div>
        {/if}
      </section>

      <section>
        <h2 class="text-lg font-semibold mb-2">Relationships ({(result.relationships ?? []).length})</h2>
        {#if !result.relationships || result.relationships.length === 0}
          <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No relationships.</p>
        {:else}
          <ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded dark:divide-[var(--color-border-strong)] dark:border-[var(--color-border)]">
            {#each result.relationships as r, i (i)}
              <li class="px-4 py-3">
                <div class="font-mono text-sm">{relLabel(r)}</div>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      {#if citations.length > 0}
        <section>
          <h2 class="text-lg font-semibold mb-2">Citations ({citations.length})</h2>
          <ul class="divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded dark:divide-[var(--color-border-strong)] dark:border-[var(--color-border)]">
            {#each citations as c, i (i)}
              <li class="px-4 py-3 text-sm">{citationLabel(c)}</li>
            {/each}
          </ul>
        </section>
      {/if}

      {#if lastSearchCall}
        <KagCallInspector call={lastSearchCall} />
      {/if}
      {#if lastPassagesCall}
        <KagCallInspector call={lastPassagesCall} />
      {/if}
    </div>
  {/if}
</div>
