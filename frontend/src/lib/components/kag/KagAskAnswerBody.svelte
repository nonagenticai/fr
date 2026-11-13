<!--
  KagAskAnswerBody — the single Ask result render block (answer / abstention
  branches / retrieval summary / diagnostics strip / citations / retrieved
  passages), lifted VERBATIM from KagAskSearchTab.svelte's inline result markup
  so it can be reused per-column in the "Compare modes" panel. The only change
  from the tab is that the values are re-sourced from a `result` prop instead of
  the tab's local $state, and the inline diagnostics <dl> is delegated to
  KagDiagnosticsStrip.
-->
<script lang="ts">
  import KagChunkCard from './KagChunkCard.svelte';
  import KagDiagnosticsStrip from './KagDiagnosticsStrip.svelte';
  // `shortId`, not `<EntityRef>`: the workspace stub sits mid-sentence inside a
  // single `<p>` of retrieval prose, where a component would break the flow.
  // TAIL 8, leading ellipsis (fr#1203/#1205).
  import { shortId } from '$lib/utils/shortId';
  import {
    askBestMatchLabel,
    askScoreScale,
    askSearchedFrom,
    citationLabel,
    type AskMode,
    type AskResult,
  } from './kagAsk';

  interface Props {
    result: AskResult;
    /** The mode that PRODUCED this result — NOT the live mode selector. Required,
        with no default: `top_score` is only a confidence figure on the reranking
        modes, so the scale cannot be assumed. */
    mode: AskMode;
    /** True when the result came from a RETRIEVAL-ONLY leg (hierarchical
        "Precise passages"), which by design returns ranked passages and NO
        synthesized answer and NO diagnostics. Without this the absent answer
        was read as the ordinary failure case and the component printed "No
        answer returned" over a successful retrieval whose passages were, for
        want of diagnostics, collapsed out of sight. Like `mode`, this is the
        SNAPSHOT of what produced this result, never the live checkbox. */
    retrievalOnly?: boolean;
  }
  const { result, mode, retrievalOnly = false }: Props = $props();

  const diag = $derived(result.diagnostics);
  const citations = $derived(result.citations ?? result.sources ?? []);
  const chunks = $derived(result.chunks ?? []);
  const searched = $derived(askSearchedFrom(diag));
  const scoreScale = $derived(askScoreScale(mode, diag));
  const bestMatch = $derived(askBestMatchLabel(mode, diag));

  // Built as a STRING, not as a second `{#if}` block. Svelte trims leading
  // whitespace at the start of a block body, so the ` (reranker: …)` suffix lost
  // its separator the moment it moved into its own block and the line read
  // `…not scored)(reranker: timeout)`. A string literal is not trimmed.
  // `rerank_degraded` also implies the "best match" clause renders, so folding
  // the suffix into that clause changes nothing about WHEN it appears.
  const rerankNote = $derived(
    diag?.rerank_degraded ? ` (reranker: ${diag.rerank_degraded_reason ?? 'degraded'})` : '',
  );

</script>

<div class="space-y-4">
  {#if diag?.abstained && diag.abstain_reason === 'no_matching_content'}
    <!-- Retrieval found nothing for this workspace/scope — NOT the same as
         "the model couldn't answer". Explain so the user can act. -->
    <div data-testid="kag-ask-no-content" class="border-l-2 border-[var(--color-warning-text)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] pl-3 py-2 rounded-r">
      <p class="text-sm font-semibold text-[var(--color-text)]">No matching content in your library</p>
      <p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Nothing in this workspace's indexed documents matched your question. Usually the document
        hasn't finished indexing, or you're viewing a different workspace than the one it was
        uploaded to. Check <a href="/library/kag/documents" class="font-medium text-[var(--color-accent)] hover:underline">KAG documents</a>, or switch workspace.
      </p>
    </div>
  {:else if diag?.abstained && diag.abstain_reason === 'insufficient_context'}
    <!-- Passages WERE retrieved, but they don't answer this question. -->
    <div data-testid="kag-ask-insufficient" class="border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] pl-3 py-2 rounded-r">
      <p class="text-sm font-semibold text-[var(--color-text)]">
        Found {diag.survivor_count ?? chunks.length} relevant passage(s), but they don't answer this question
      </p>
      <p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Your documents were searched and matching excerpts were retrieved (below), but they don't
        contain enough to answer this specific question. Try rephrasing, or ask about what the
        documents actually cover.
      </p>
    </div>
  {:else if diag?.abstained && diag.abstain_reason === 'partial_context'}
    <!-- Partial coverage is NOT a suppression: the model answered part of the
         question from real passages and declared insufficiency only on the
         rest, so the grounded answer MUST still render next to the notice.
         Hence the article is repeated here — a bare {:else if} would
         short-circuit the {:else if result.answer} branch and discard it. -->
    <div data-testid="kag-ask-partial" class="border-l-2 border-[var(--color-accent)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] pl-3 py-2 rounded-r">
      <p class="text-sm font-semibold text-[var(--color-text)]">Answers part of your question</p>
      <p class="mt-1 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
        Your documents cover some of what you asked. The rest isn't in your indexed documents — the
        answer below is limited to what they support.
      </p>
    </div>
    {#if result.answer}
      <article data-testid="kag-ask-answer" class="prose prose-sm max-w-none whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-3 py-1">
        {result.answer}
      </article>
    {:else}
      <!-- `answer` is optional in AskResult and the backend applies no schema, so
           partial_context CAN arrive with nothing to render. An empty bordered
           article would be a second fabrication; the notice above stays (partial
           coverage is still true), and the no-answer fallback takes over. -->
      <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No answer returned. Try a different mode or rephrasing the question.</p>
    {/if}
  {:else if result.answer}
    <article data-testid="kag-ask-answer" class="prose prose-sm max-w-none whitespace-pre-wrap border-l-2 border-[var(--color-accent)] pl-3 py-1">
      {result.answer}
    </article>
  {:else if retrievalOnly}
    <!-- NOT a failure: this leg never synthesizes. Say what it did return
         instead of advising a rephrase that would change nothing. -->
    <p data-testid="kag-ask-retrieval-only" class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">This mode returns ranked passages from your documents, not a synthesized answer. The matching passages are below.</p>
  {:else}
    <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No answer returned. Try a different mode or rephrasing the question.</p>
  {/if}

  <!-- A percentage is shown ONLY when `top_score` came from the cross-encoder.
       Two things put it on the RRF FUSION scale instead: a degraded rerank hop,
       and a mode that never reranks at all (dense / hybrid) — the latter is the
       live one, since Compare fans a question across all four modes at once. RRF
       scores (`sum(weight / (60 + rank))`) peak near 0.021–0.071, so rendering
       one as a percentage prints "best match 2%", which reads as "nothing
       matched". Withhold the figure and name the scale; a degraded hop also gets
       its cause. (`top_score` is still in the API response; it is just not a
       confidence figure.) -->
  {#if diag && searched !== null}
    <p data-testid="kag-ask-retrieval" class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      Searched {searched} passage(s){#if scoreScale !== 'none' || diag.rerank_degraded} · best match {bestMatch}{rerankNote}{/if}{#if diag.tenant_id} · workspace {shortId(diag.tenant_id)}{/if}
    </p>
  {/if}

  <KagDiagnosticsStrip diagnostics={diag} {mode} />

  {#if citations.length > 0}
    <details class="text-sm" open>
      <summary class="cursor-pointer font-semibold">Citations ({citations.length})</summary>
      <ul class="mt-2 divide-y divide-[var(--color-border)] border border-[var(--color-border)] rounded dark:divide-[var(--color-border-strong)] dark:border-[var(--color-border)]">
        {#each citations as c, i (i)}
          <li class="px-3 py-2">{citationLabel(c)}</li>
        {/each}
      </ul>
    </details>
  {/if}

  {#if chunks.length > 0}
    <!-- `retrievalOnly` forces this OPEN: there is nothing above it to read, the
         passages ARE the result, and the `diag`-keyed gate can never fire for a
         leg that sends no diagnostics. -->
    <details class="text-sm" open={retrievalOnly || diag?.abstain_reason === 'insufficient_context' || diag?.abstain_reason === 'partial_context'}>
      <summary class="cursor-pointer font-semibold">Retrieved passages ({chunks.length})</summary>
      <div class="mt-2 space-y-2">
        <!-- The per-passage score is the SAME unit as `top_score` above (kag
             builds every AnswerChunk from `survivors`, the list `_top_score()`
             maxes over), so the card gets the mode and the diagnostics and
             withholds its badge on exactly the scales this line withholds on.
             Without them it printed "100% Relevance" directly under "best match
             unavailable". -->
        {#each chunks as c, i (i)}
          <KagChunkCard chunk={c} compact {mode} diagnostics={diag} />
        {/each}
      </div>
    </details>
  {/if}
</div>
