<!--
  KagChunkCard — a single retrieved passage rendered as a provenance card.

  This is the trust surface: every answer/entity is one click from the exact
  source text it came from. Inputs are the loosely-typed chunk records returned
  by /api/assets/kag/ask (chunks[]) and /api/assets/kag/search — both carry some
  subset of { text, score, doc_id, title, url, page, chunk_id }. We pick fields
  defensively so a card renders whatever provenance is present without crashing
  on the parts that aren't.
-->
<script lang="ts">
  import { safeHref } from '$lib/utils/safeUrl';
  import { kagGraphApi } from '$lib/api/kag';
  import { openDetailPane } from '$lib/stores/rightPane.svelte';
  import {
    askScaleLabel,
    askScorePct,
    askScoreScale,
    type AskMode,
    scoreKindScale,
    type AskScoreScale,
    type RetrievalDiagnostics,
  } from './kagAsk';

  interface Props {
    chunk: Record<string, unknown>;
    /**
     * The score scale DECLARED BY THE RESPONSE, for surfaces that know it from
     * `score_kind` rather than from an ask mode — passage search is the one.
     *
     * OPTIONAL. Absent keeps the `mode`-derived behaviour byte-identical, so no
     * existing mount site changes. When present it WINS over `mode`, because a
     * scale the producer stated outranks one inferred from how it was asked for.
     *
     * ⛔ It can never unlock a percentage: `scoreKindScale` cannot return
     * `'crossencoder'`. All it buys is that the withheld badge NAMES its scale
     * instead of reading a bare "unavailable", which reads as a broken score.
     */
    scoreKind?: 'cosine' | 'rrf';
    /** Compact mode trims padding for dense lists (e.g. the Ask tab). */
    compact?: boolean;
    /**
     * The ask mode that PRODUCED this chunk, when the mounting surface knows it.
     *
     * OPTIONAL, and absent means WITHHOLD — never "render the number anyway".
     * Three of the four mount sites (the graph node/edge detail panels and the
     * canvas peek) trace a concept back to its passages without going through
     * the Ask tab's mode selector, so they have no mode to declare; requiring
     * one would force them to invent a value, which is exactly how a fusion
     * score gets rendered as a cross-encoder confidence. Making the failure mode
     * "no figure" rather than "a wrong figure" is the whole point of the prop.
     */
    mode?: AskMode;
    /**
     * Retrieval diagnostics of the SAME ask. `askScoreScale` needs
     * `rerank_degraded` to tell a cross-encoder score from the fusion order the
     * pipeline falls back to when the hop fails, so the mode alone is not enough.
     */
    diagnostics?: RetrievalDiagnostics;
  }

  const { chunk, compact = false, mode, diagnostics, scoreKind }: Props = $props();

  // KAG's /ask returns AnswerChunk/Citation objects whose SOURCE metadata
  // (doc_id, title, url, page) is nested under `.source` — only `text`/`score`
  // sit at the top level. Semantic-search citations put the same fields at the
  // top level. Probe the top level first, then fall through to `.source`, so one
  // card renders both shapes without knowing which it got.
  const src = $derived(
    chunk.source && typeof chunk.source === 'object'
      ? (chunk.source as Record<string, unknown>)
      : {},
  );

  function pick(...keys: string[]): string | undefined {
    for (const bag of [chunk, src]) {
      for (const k of keys) {
        const v = bag[k];
        if (typeof v === 'string' && v.length > 0) return v;
        if (typeof v === 'number') return String(v);
      }
    }
    return undefined;
  }

  const text = $derived(pick('text', 'content', 'chunk', 'passage') ?? '');
  const title = $derived(pick('title', 'document_title', 'name'));
  const docId = $derived(pick('doc_id', 'document_id', 'source_id'));
  // Provenance URL comes from arbitrary ingested/scraped document metadata, so it
  // must be scheme-checked before it touches an href (javascript:/data: would run
  // in the app origin on click). An unsafe/absent url falls through to the doc link.
  const sourceHref = $derived(safeHref(pick('url', 'source_url')));
  const chunkId = $derived(pick('chunk_id', 'id'));

  // Page can be a number, a string, or an array of pages — top-level or nested.
  const pageLabel = $derived.by(() => {
    const p =
      chunk.page ?? chunk.pages ?? chunk.page_number ?? src.page ?? src.pages;
    if (Array.isArray(p) && p.length > 0) return `p. ${p.join(', ')}`;
    if (typeof p === 'number' || (typeof p === 'string' && p.length > 0))
      return `p. ${p}`;
    return undefined;
  });

  // Which score field the chunk carried, and what to call it. Prefer an explicit
  // rerank score when present — it's the score the retriever actually ranked on.
  // NOTE: the field NAME does not settle the scale. Only `askScoreScale` does.
  const scoreInfo = $derived.by(() => {
    const rr = chunk.rerank_score ?? chunk.rerank;
    if (typeof rr === 'number' && Number.isFinite(rr)) return { value: rr, label: 'Rerank' };
    const s = chunk.score ?? chunk.relevance ?? chunk.similarity;
    if (typeof s === 'number' && Number.isFinite(s)) return { value: s, label: 'Relevance' };
    return null;
  });

  // The per-passage score is the SAME unit as the ask's `top_score`: kag builds
  // every `AnswerChunk(score=…)` from `survivors`, the exact list `_top_score()`
  // maxes over. So the scale that decides whether "Best match" may be a
  // percentage decides this badge too — otherwise the card prints "100%
  // Relevance" two lines under "best match unavailable (fusion order, not
  // scored)", which is the withheld number handed back through a confidence bar.
  //
  // A response-declared `scoreKind` wins; otherwise no mode (or no diagnostics,
  // or no numeric `top_score`) → `'none'` → withheld. That default is deliberate:
  // an unknown scale is not an excuse to guess one — and `scoreKindScale` keeps
  // that rule, returning `'none'` for any kind it does not recognise.
  const scoreScale = $derived<AskScoreScale>(
    scoreKind !== undefined
      ? scoreKindScale(scoreKind)
      : mode === undefined
        ? 'none'
        : askScoreScale(mode, diagnostics),
  );
  // A percentage exists ONLY on the cross-encoder scale, and uses the same
  // floor/cap as `askBestMatchLabel` — one arithmetic site, not two.
  const scorePct = $derived(
    scoreInfo !== null && scoreScale === 'crossencoder' ? askScorePct(scoreInfo.value) : null,
  );
  // ...otherwise the reason, worded exactly as the "Best match" line words it.
  const withheldLabel = $derived(askScaleLabel(scoreScale));

  let expanded = $state(false);
  const isLong = $derived(text.length > 320);
  const shown = $derived(expanded || !isLong ? text : text.slice(0, 320) + '…');

  const sourceLabel = $derived(title ?? docId ?? 'Unknown source');

  // "View source page" — resolve this chunk back to the scrape session it came
  // from and open that session's screenshot (KagSessionView) in the right pane.
  // Lazy: we only hit the resolver on click (no per-card request on render). The
  // raw url (not the scheme-checked href) is the join key against the scrape
  // session, so it's captured separately.
  const rawUrl = $derived(pick('url', 'source_url'));
  const canResolveSource = $derived(Boolean(docId || rawUrl));

  type SourceState = 'idle' | 'loading' | 'none' | 'error';
  let sourceState = $state<SourceState>('idle');

  async function viewSourcePage() {
    if (sourceState === 'loading') return;
    sourceState = 'loading';
    try {
      const res = await kagGraphApi.sourcePage({ docId, url: rawUrl });
      if (res.found && res.session_id && res.has_screenshot) {
        openDetailPane({ kind: 'kag-session', id: res.session_id });
        sourceState = 'idle';
      } else {
        // Not from a scraped page (e.g. an uploaded document), or no screenshot
        // was captured — a normal outcome, not an error. Signal it and stop.
        sourceState = 'none';
      }
    } catch {
      sourceState = 'error';
    }
  }
</script>

<article
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] dark:bg-[var(--color-bg)] {compact
    ? 'p-3'
    : 'p-4'}"
  data-testid="kag-chunk-card"
>
  <!-- Source line + relevance meter -->
  <header class="flex items-start justify-between gap-3 mb-2">
    <div class="min-w-0">
      <div class="flex items-center gap-2 text-sm font-medium text-[var(--color-text)]">
        <svg
          class="h-4 w-4 shrink-0 text-[var(--color-text-muted)]"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          aria-hidden="true"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <path d="M14 2v6h6" />
        </svg>
        <span class="truncate" title={sourceLabel}>{sourceLabel}</span>
      </div>
      <div class="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-[var(--color-text-muted)]">
        {#if pageLabel}<span>{pageLabel}</span>{/if}
        {#if chunkId}<span class="font-mono" title="Chunk id">{chunkId.slice(0, 12)}</span>{/if}
      </div>
    </div>

    <!-- The figure and the meter stand or fall TOGETHER. A bar is a rendering of
         the same number, so drawing one beside a withheld percentage would hand
         the reader the value we just declined to name — 88% of a bar's width is
         88%. When the scale isn't the cross-encoder's, both go and the reason is
         named in their place. -->
    {#if scoreInfo}
      <div class="shrink-0 text-right" title={`${scoreInfo.label} score`} data-testid="kag-chunk-score">
        {#if scorePct !== null}
          <div class="text-sm font-semibold text-[var(--color-text)]">{scorePct}%</div>
          <div class="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{scoreInfo.label}</div>
          <div
            class="mt-1 h-1.5 w-20 overflow-hidden rounded-full bg-[var(--color-surface-strong)]"
            role="meter"
            aria-valuenow={scorePct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={scoreInfo.label}
          >
            <div
              class="h-full rounded-full bg-[var(--color-accent)]"
              style={`width:${scorePct}%`}
            ></div>
          </div>
        {:else}
          <div
            class="max-w-[9rem] text-[11px] font-medium leading-snug text-[var(--color-text-muted)]"
            data-testid="kag-chunk-score-withheld"
          >
            {withheldLabel}
          </div>
          <div class="text-[10px] font-medium uppercase tracking-wide text-[var(--color-text-muted)]">{scoreInfo.label}</div>
        {/if}
      </div>
    {/if}
  </header>

  <!-- Passage text -->
  {#if text}
    <p class="whitespace-pre-wrap text-sm leading-relaxed text-[var(--color-text)]">{shown}</p>
    {#if isLong}
      <button
        type="button"
        class="mt-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
        onclick={() => (expanded = !expanded)}
      >
        {expanded ? 'Show less' : 'Show more'}
      </button>
    {/if}
  {:else}
    <p class="text-sm italic text-[var(--color-text-muted)]">No passage text returned.</p>
  {/if}

  <!-- Open the original source -->
  {#if sourceHref}
    <a
      href={sourceHref}
      target="_blank"
      rel="noopener noreferrer"
      class="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
      data-testid="kag-chunk-source-link"
    >
      Open source
      <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
        <path d="M15 3h6v6" />
        <path d="M10 14 21 3" />
      </svg>
    </a>
  {:else if docId}
    <a
      href="/library/kag/documents"
      class="mt-3 inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:underline"
      data-testid="kag-chunk-doc-link"
    >
      View in documents →
    </a>
  {/if}

  <!-- Jump to the scraped source page's screenshot (resolved on demand). -->
  {#if canResolveSource}
    <div class="mt-2">
      <button
        type="button"
        class="inline-flex items-center gap-1 text-xs font-medium text-[var(--color-accent)] hover:underline disabled:cursor-default disabled:text-[var(--color-text-muted)] disabled:no-underline"
        onclick={viewSourcePage}
        disabled={sourceState === 'loading' || sourceState === 'none'}
        data-testid="kag-chunk-source-page"
      >
        {#if sourceState === 'loading'}
          Locating source page…
        {:else if sourceState === 'none'}
          No source page
        {:else if sourceState === 'error'}
          Couldn't load — retry
        {:else}
          View source page
        {/if}
        {#if sourceState === 'idle' || sourceState === 'error'}
          <svg class="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <path d="M3 9h18" />
          </svg>
        {/if}
      </button>
    </div>
  {/if}
</article>
