<!--
  PaperCard — one federated-search result with read affordances.

  Renders the fields the Discovery Engine already returns but the Slice-0 list
  hid: an expandable abstract, an open-access badge, and Open-PDF / DOI / arXiv
  buttons (new tab). Selection drives the push working-set; the checkbox is
  disabled when the result has no id.
-->
<script lang="ts">
  import type {
    PaperResult,
    RelatedKind,
    RelatedItem,
    PaperDetail,
    TrustComponents,
  } from '$lib/api/research';
  import { paperIdOf, researchApi } from '$lib/api/research';
  import { safeHref } from '$lib/utils/safeUrl';

  interface Props {
    paper: PaperResult;
    selected: boolean;
    onToggle: (id: string) => void;
    /** 7-signal trust score from an explicit "Score results" run, if any. */
    score?: number;
    /** Tooltip text describing the score's signal breakdown. */
    scoreTitle?: string;
    /** Structured 7-signal breakdown from the same scoreBatch run, if any. */
    scoreComponents?: TrustComponents | null;
    /** Accent the card when its trust score clears the preset's scoreThreshold. */
    highlight?: boolean;
  }
  const {
    paper,
    selected,
    onToggle,
    score,
    scoreTitle,
    scoreComponents,
    highlight = false,
  }: Props = $props();

  let showAbstract = $state(false);
  let showBreakdown = $state(false);

  // 7-signal trust breakdown — human labels for the TrustComponents keys, in the
  // same order the batch summary uses. Sourced from the batch prop OR, on the
  // single-paper live-score path, from the score response itself (no extra fetch).
  const TRUST_SIGNALS = [
    { key: 'peer_review_status', label: 'Peer review' },
    { key: 'citation_impact', label: 'Citations' },
    { key: 'author_h_index', label: 'h-index' },
    { key: 'venue_prestige', label: 'Venue' },
    { key: 'recency', label: 'Recency' },
    { key: 'cross_reference_reliability', label: 'Cross-ref' },
    { key: 'consensus_confidence', label: 'Consensus' },
  ] as const satisfies ReadonlyArray<{ key: keyof TrustComponents; label: string }>;

  const id = $derived(paperIdOf(paper));

  // Related (citation-graph) state — fetched on demand per kind.
  let relatedKind = $state<RelatedKind | null>(null);
  let relatedLoading = $state(false);
  let relatedError = $state<string | null>(null);
  let relatedItems = $state<RelatedItem[]>([]);

  const RELATED_LABELS: Record<RelatedKind, string> = {
    similar: 'Similar',
    citations: 'Cited by',
    references: 'References',
  };

  async function loadRelated(kind: RelatedKind): Promise<void> {
    if (!id) return;
    if (relatedKind === kind) {
      relatedKind = null; // toggle off
      return;
    }
    relatedKind = kind;
    relatedLoading = true;
    relatedError = null;
    relatedItems = [];
    try {
      const res = await researchApi.getPaperRelated(id, kind);
      relatedItems = res.results ?? res.items ?? [];
    } catch (e) {
      relatedError = e instanceof Error ? e.message : String(e);
    } finally {
      relatedLoading = false;
    }
  }

  function relatedTitle(it: RelatedItem): string {
    return it.title ?? it.paper_id ?? it.id ?? 'untitled';
  }

  // Full metadata (`getPaper`) — fetched once, on demand, then toggled.
  let detail = $state<PaperDetail | null>(null);
  let showDetail = $state(false);
  let detailLoading = $state(false);
  let detailError = $state<string | null>(null);

  async function loadDetail(): Promise<void> {
    if (!id) return;
    if (showDetail) {
      showDetail = false; // toggle off
      return;
    }
    showDetail = true;
    if (detail) return; // already fetched
    detailLoading = true;
    detailError = null;
    try {
      detail = await researchApi.getPaper(id);
    } catch (e) {
      detailError = e instanceof Error ? e.message : String(e);
    } finally {
      detailLoading = false;
    }
  }

  // Single-paper score (`scorePaper`) — for a paper the batch didn't cover.
  let liveScore = $state<number | null>(null);
  let liveComponents = $state<TrustComponents | null>(null);
  let scoreLoading = $state(false);
  let scoreError = $state<string | null>(null);

  async function loadScore(): Promise<void> {
    if (!id || scoreLoading) return;
    scoreLoading = true;
    scoreError = null;
    try {
      const ts = await researchApi.scorePaper(id);
      liveScore = ts.overall_score;
      // C2: keep the structured breakdown the response already carries so the
      // single-paper path renders the SAME 7-signal chips as the batch path.
      liveComponents = ts.components ?? null;
    } catch (e) {
      scoreError = e instanceof Error ? e.message : String(e);
    } finally {
      scoreLoading = false;
    }
  }

  // Whichever breakdown applies: the batch prop, else the live single-paper score.
  const activeComponents = $derived(scoreComponents ?? liveComponents);
  const trustSignals = $derived(
    activeComponents
      ? TRUST_SIGNALS.flatMap((s) => {
          const value = activeComponents[s.key];
          return typeof value === 'number'
            ? [{ key: s.key, label: s.label, value }]
            : [];
        })
      : [],
  );

  function authorList(p: PaperResult): string {
    const a = p.authors ?? [];
    return a
      .map((x) => (typeof x === 'string' ? x : (x?.name ?? '')))
      .filter(Boolean)
      .slice(0, 5)
      .join(', ');
  }

  const doi = $derived(paper.external_ids?.doi);
  const arxivId = $derived(paper.external_ids?.arxiv_id);
  const doiHref = $derived(doi ? `https://doi.org/${doi}` : null);
  // pdf_url is upstream/ingested metadata — only http(s)/relative may become an href.
  const pdfHref = $derived(safeHref(paper.pdf_url));
  const arxivHref = $derived(
    arxivId ? `https://arxiv.org/abs/${arxivId}` : null,
  );
</script>

<li
  class={`rounded border p-3 bg-[var(--color-bg)] dark:bg-[var(--color-surface)] ${
    highlight
      ? 'ring-1 ring-[var(--color-accent-border)] border-[var(--color-accent)]'
      : ''
  }`}
  data-testid="research-paper-card"
  data-highlight={highlight}
>
  <div class="flex items-start gap-3">
    <input
      type="checkbox"
      class="mt-1"
      disabled={!id}
      checked={id ? selected : false}
      onchange={() => id && onToggle(id)}
      aria-label="Select paper"
    />
    <div class="flex flex-col gap-1 min-w-0 flex-1">
      <span class="font-medium">{paper.title ?? 'Untitled'}</span>

      <span class="text-sm text-[var(--color-text-muted)] flex flex-wrap gap-x-2 items-center">
        {#if authorList(paper)}<span>{authorList(paper)}</span>{/if}
        {#if paper.year}<span>· {paper.year}</span>{/if}
        {#if paper.venue}<span class="truncate">· {paper.venue}</span>{/if}
        {#if typeof paper.citation_count === 'number'}
          <span>· {paper.citation_count} citations</span>
        {/if}
      </span>

      <div class="flex flex-wrap items-center gap-2 mt-1">
        {#if paper.source}
          <span
            class="text-xs rounded px-1.5 py-0.5 bg-[var(--color-surface)] border"
            data-testid="paper-source-badge">{paper.source}</span
          >
        {/if}
        {#if paper.is_open_access}
          <span
            class="text-xs rounded px-1.5 py-0.5 bg-[var(--color-success-bg)] text-[var(--color-success-text)]"
            data-testid="paper-oa-badge">Open access</span
          >
        {/if}
        {#if typeof score === 'number'}
          <span
            class="text-xs rounded px-1.5 py-0.5 border bg-[var(--color-surface)]"
            data-testid="paper-trust-badge"
            title={scoreTitle}>trust {score.toFixed(2)}</span
          >
        {:else if typeof paper.trust_score === 'number'}
          <span class="text-xs text-[var(--color-text-muted)]"
            >trust {paper.trust_score.toFixed(2)}</span
          >
        {/if}

        {#if paper.pdf_url}
          {#if pdfHref}
            <a
              href={pdfHref}
              target="_blank"
              rel="noopener noreferrer"
              class="text-xs underline text-[var(--color-accent)]"
              data-testid="paper-pdf-link">Open PDF</a
            >
          {:else}
            <span class="text-xs text-[var(--color-text-muted)] break-all" data-testid="paper-pdf-text"
              >{paper.pdf_url}</span
            >
          {/if}
        {/if}
        {#if doiHref}
          <a
            href={doiHref}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs underline text-[var(--color-accent)]"
            data-testid="paper-doi-link">DOI</a
          >
        {/if}
        {#if arxivHref}
          <a
            href={arxivHref}
            target="_blank"
            rel="noopener noreferrer"
            class="text-xs underline text-[var(--color-accent)]"
            data-testid="paper-arxiv-link">arXiv</a
          >
        {/if}
        {#if paper.abstract}
          <button
            type="button"
            class="text-xs underline text-[var(--color-text-muted)]"
            data-testid="paper-abstract-toggle"
            onclick={() => (showAbstract = !showAbstract)}
            aria-expanded={showAbstract}
          >
            {showAbstract ? 'Hide abstract' : 'Show abstract'}
          </button>
        {/if}
        {#if trustSignals.length > 0}
          <button
            type="button"
            class="text-xs underline text-[var(--color-text-muted)]"
            data-testid="paper-trust-breakdown-toggle"
            onclick={() => (showBreakdown = !showBreakdown)}
            aria-expanded={showBreakdown}
          >
            {showBreakdown ? 'Hide signals' : 'Signals'}
          </button>
        {/if}
      </div>

      {#if showBreakdown && trustSignals.length > 0}
        <ul
          class="mt-2 flex flex-wrap gap-1.5"
          role="list"
          data-testid="paper-trust-breakdown"
        >
          {#each trustSignals as sig (sig.key)}
            <li
              class="text-xs rounded border px-1.5 py-0.5 bg-[var(--color-surface)] text-[var(--color-text-muted)]"
              data-testid={`paper-trust-signal-${sig.key}`}
            >
              <span class="text-[var(--color-text)]">{sig.label}</span>
              {sig.value.toFixed(2)}
            </li>
          {/each}
        </ul>
      {/if}

      {#if showAbstract && paper.abstract}
        <p
          class="text-sm mt-2 text-[var(--color-text)] whitespace-pre-line"
          data-testid="paper-abstract"
        >
          {paper.abstract}
        </p>
      {/if}

      {#if id}
        <div class="flex flex-wrap gap-3 mt-1" data-testid="paper-related-bar">
          {#each ['similar', 'citations', 'references'] as const as kind (kind)}
            <button
              type="button"
              data-testid={`paper-related-${kind}`}
              aria-pressed={relatedKind === kind}
              onclick={() => void loadRelated(kind)}
              class={`text-xs underline ${
                relatedKind === kind
                  ? 'text-[var(--color-accent)] font-medium'
                  : 'text-[var(--color-text-muted)]'
              }`}
            >
              {RELATED_LABELS[kind]}
            </button>
          {/each}
          <button
            type="button"
            data-testid="paper-detail-toggle"
            aria-pressed={showDetail}
            onclick={() => void loadDetail()}
            class={`text-xs underline ${
              showDetail
                ? 'text-[var(--color-accent)] font-medium'
                : 'text-[var(--color-text-muted)]'
            }`}
          >
            {showDetail ? 'Hide details' : 'Details'}
          </button>
          {#if typeof score !== 'number' && liveScore === null}
            <button
              type="button"
              data-testid="paper-score-btn"
              disabled={scoreLoading}
              onclick={() => void loadScore()}
              class="text-xs underline text-[var(--color-text-muted)] disabled:opacity-50"
            >
              {scoreLoading ? 'Scoring…' : 'Score'}
            </button>
          {/if}
          {#if liveScore !== null}
            <span class="text-xs text-[var(--color-text-muted)]" data-testid="paper-live-score"
              >trust {liveScore.toFixed(2)}</span
            >
          {/if}
          {#if scoreError}
            <span class="text-xs text-[var(--color-danger)]" data-testid="paper-score-error"
              >Couldn’t score</span
            >
          {/if}
        </div>

        {#if showDetail}
          <div class="mt-1 text-xs" data-testid="paper-detail">
            {#if detailLoading}
              <span class="text-[var(--color-text-muted)]">Loading…</span>
            {:else if detailError}
              <span class="text-[var(--color-danger)]">Couldn’t load details</span>
            {:else if detail}
              <div class="flex flex-wrap gap-x-4 gap-y-1 text-[var(--color-text-muted)]">
                {#if detail.venue}<span>venue: {detail.venue}</span>{/if}
                {#if typeof detail.citation_count_forward === 'number'}
                  <span>cited by {detail.citation_count_forward}</span>
                {/if}
                {#if typeof detail.citation_count_backward === 'number'}
                  <span>references {detail.citation_count_backward}</span>
                {/if}
                {#if typeof detail.influence_score === 'number'}
                  <span>influence {detail.influence_score.toFixed(2)}</span>
                {/if}
                {#if detail.is_open_access}<span>open access</span>{/if}
              </div>
            {/if}
          </div>
        {/if}

        {#if relatedKind}
          <div class="mt-1 text-sm" data-testid="paper-related-list">
            {#if relatedLoading}
              <span class="text-xs text-[var(--color-text-muted)]">Loading…</span>
            {:else if relatedError}
              <span class="text-xs text-[var(--color-danger)]"
                >Couldn’t load {RELATED_LABELS[relatedKind]}</span
              >
            {:else if relatedItems.length === 0}
              <span class="text-xs text-[var(--color-text-muted)]"
                >No {RELATED_LABELS[relatedKind]} found</span
              >
            {:else}
              <ul class="list-disc pl-5">
                {#each relatedItems.slice(0, 10) as it, i (it.paper_id ?? it.id ?? i)}
                  <li class="text-xs">
                    {relatedTitle(it)}
                    {#if it.year}· {it.year}{/if}
                    {#if typeof it.similarity_score === 'number'}
                      · sim {it.similarity_score.toFixed(2)}
                    {:else if typeof it.citation_count === 'number'}
                      · {it.citation_count} citations
                    {/if}
                  </li>
                {/each}
              </ul>
            {/if}
          </div>
        {/if}
      {/if}
    </div>
  </div>
</li>
