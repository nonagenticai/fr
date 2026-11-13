<!--
  KAG "Media" tab — media discovery (video/audio) for the KAG product.

  A curated, read-only surface over the Media Discovery service (proxied at
  `/api/research/media/*` + `mediaApi`): federated media search, then per-item
  transcript + related-items exploration. The transcript is the trust surface —
  what was actually said in the source. Browse-only: collection/download/ingest
  writes stay in the n8n node / admin tooling.
-->
<script lang="ts">
  import { mediaApi, mediaItemIdOf, type MediaItem, type MediaTranscript } from '$lib/api/media';
  import { kagDetailRows, type KagDetailRow } from '$lib/components/kag/graph-normalise';
  import { askScaleLabel } from '$lib/components/kag/kagAsk';

  type Bag = Record<string, unknown>;

  function errMsg(e: unknown): string {
    return e instanceof Error ? e.message : String(e);
  }
  /** First non-empty string/number value among the given keys. */
  function pick(r: Bag, keys: string[]): string {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'string' && v.length > 0) return v;
      if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    }
    return '';
  }
  /** First finite number among the given keys. */
  function pickNum(r: Bag, keys: string[]): number | null {
    for (const k of keys) {
      const v = r[k];
      if (typeof v === 'number' && Number.isFinite(v)) return v;
    }
    return null;
  }
  /** Displayable rows for everything not already shown (objects flagged `raw`). */
  function detailRows(r: Bag, shown: string[]): KagDetailRow[] {
    return kagDetailRows(r, shown);
  }
  /** Compact `key: value · …` trail of the scalar rows (objects go behind an opt-in toggle). */
  function scalarTrail(rows: KagDetailRow[]): string {
    return rows
      .filter((x) => !x.raw)
      .map((x) => `${x.key}: ${x.value}`)
      .join(' · ');
  }
  /** Normalise a loosely-typed payload into an array of item bags. */
  function asItems(raw: unknown): MediaItem[] {
    if (Array.isArray(raw)) return raw as MediaItem[];
    const obj = (raw ?? {}) as Bag;
    const arr = obj.items ?? obj.results ?? obj.collections ?? obj.related;
    return Array.isArray(arr) ? (arr as MediaItem[]) : [];
  }

  let query = $state('');
  let mediaType = $state('');
  let maxPerSource = $state(10);

  let searching = $state(false);
  let error = $state('');
  let results = $state<MediaItem[]>([]);
  let totalResults = $state<number | null>(null);
  let sourcesQueried = $state<string[]>([]);
  let sourcesFailed = $state<string[]>([]);
  let ran = $state(false);

  // Per-item transcript state, keyed by item id.
  let openTranscript = $state<string | null>(null);
  let transcriptLoading = $state(false);
  let transcriptError = $state('');
  let transcript = $state<MediaTranscript | null>(null);

  // Per-item detail expander state, keyed by item id. The three sub-fetches
  // (item / related / score) are independent — a failure in one must not blank
  // the others, so each owns its loading + error state.
  let openDetail = $state<string | null>(null);

  let detailItem = $state<MediaItem | null>(null);
  let detailLoading = $state(false);
  let detailError = $state('');

  let related = $state<MediaItem[]>([]);
  let relatedLoading = $state(false);
  let relatedError = $state('');

  let score = $state<unknown>(null);
  let scoreLoading = $state(false);
  let scoreError = $state('');

  const SCORE_KEYS = [
    'score',
    'trust_score',
    'relevance',
    'relevance_score',
    'quality',
    'quality_score',
    'confidence',
    'value',
  ];

  const DETAIL_SHOWN = [
    'id',
    'item_id',
    'title',
    'source',
    'media_type',
    'duration_seconds',
    'published_at',
    'url',
    'thumbnail_url',
    'description',
  ];

  const scoreValue = $derived.by<number | null>(() => {
    if (score == null) return null;
    if (typeof score === 'number') return Number.isFinite(score) ? score : null;
    if (typeof score === 'object') return pickNum(score as Bag, SCORE_KEYS);
    return null;
  });
  const scoreLabel = $derived.by<string>(() => {
    const v = scoreValue;
    if (v === null) return askScaleLabel('none');
    // ⛔ NOT a percentage — corrected 2026-09-04, same principle as PR #933.
    //
    // The producer is media-discovery's `quality_score`
    // (`src/services/quality.py`): a WEIGHTED HEURISTIC COMPOSITE of seven
    // signals, clamped to 0..1. Being bounded 0..1 does not make it a
    // probability, a confidence or a match score, so multiplying by 100 and
    // appending "%" invents a meaning the number does not carry — and
    // `Math.round` additionally turned 0.99964 into a flat "100%", the exact
    // manufactured-precision bug #933 was opened for.
    //
    // Rendered raw at 4dp instead, matching the sibling precedent in
    // KagTextAnalysisTab (`{score.toFixed(4)}`). A reader can compare two raw
    // scores honestly; they cannot un-see a fabricated percentage.
    return Number.isFinite(v) ? v.toFixed(4) : askScaleLabel('none');
  });
  const scoreRows = $derived.by<KagDetailRow[]>(() => {
    if (score == null || typeof score !== 'object') return [];
    return detailRows(score as Bag, SCORE_KEYS);
  });

  const detailMeta = $derived.by<string>(() => {
    if (!detailItem) return '';
    return [
      detailItem.source,
      detailItem.media_type,
      fmtDuration(detailItem.duration_seconds),
      typeof detailItem.published_at === 'string' ? detailItem.published_at.slice(0, 10) : '',
    ]
      .filter(Boolean)
      .join(' · ');
  });
  const detailExtraRows = $derived.by<KagDetailRow[]>(() =>
    detailItem ? detailRows(detailItem as Bag, DETAIL_SHOWN) : [],
  );

  async function runSearch(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    if (!query.trim()) {
      error = 'Enter a search query.';
      return;
    }
    searching = true;
    error = '';
    ran = true;
    openTranscript = null;
    openDetail = null;
    try {
      const body: Parameters<typeof mediaApi.search>[0] = {
        query: query.trim(),
        max_results_per_source: maxPerSource,
      };
      if (mediaType) body.media_type = mediaType;
      const res = await mediaApi.search(body);
      results = res.results ?? [];
      totalResults = typeof res.total_results === 'number' ? res.total_results : results.length;
      sourcesQueried = res.sources_queried ?? [];
      sourcesFailed = res.sources_failed ?? [];
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      results = [];
      totalResults = null;
      sourcesQueried = [];
      sourcesFailed = [];
    } finally {
      searching = false;
    }
  }

  async function toggleTranscript(id: string): Promise<void> {
    if (openTranscript === id) {
      openTranscript = null;
      return;
    }
    openTranscript = id;
    transcript = null;
    transcriptError = '';
    transcriptLoading = true;
    try {
      const res = await mediaApi.transcript(id);
      // Drop a stale response: the user may have switched items while this was in flight.
      if (openTranscript === id) transcript = res;
    } catch (err) {
      if (openTranscript === id)
        transcriptError = err instanceof Error ? err.message : String(err);
    } finally {
      if (openTranscript === id) transcriptLoading = false;
    }
  }

  // Detail expander: lazily load item / related / score independently.
  async function toggleDetail(id: string): Promise<void> {
    if (openDetail === id) {
      openDetail = null;
      return;
    }
    openDetail = id;
    detailItem = null;
    detailError = '';
    related = [];
    relatedError = '';
    score = null;
    scoreError = '';
    void loadDetail(id);
    void loadRelated(id);
    void loadScore(id);
  }

  async function loadDetail(id: string): Promise<void> {
    detailLoading = true;
    try {
      const res = await mediaApi.item(id);
      if (openDetail === id) detailItem = res ?? null;
    } catch (err) {
      if (openDetail === id) detailError = errMsg(err);
    } finally {
      if (openDetail === id) detailLoading = false;
    }
  }

  async function loadRelated(id: string): Promise<void> {
    relatedLoading = true;
    try {
      const res = await mediaApi.related(id);
      if (openDetail === id) related = Array.isArray(res) ? res : [];
    } catch (err) {
      if (openDetail === id) relatedError = errMsg(err);
    } finally {
      if (openDetail === id) relatedLoading = false;
    }
  }

  async function loadScore(id: string): Promise<void> {
    scoreLoading = true;
    try {
      const res = await mediaApi.itemScore(id);
      if (openDetail === id) score = res ?? null;
    } catch (err) {
      if (openDetail === id) scoreError = errMsg(err);
    } finally {
      if (openDetail === id) scoreLoading = false;
    }
  }

  /** Selecting a related item promotes it into the results list + opens it. */
  function selectRelated(item: MediaItem): void {
    const id = mediaItemIdOf(item);
    if (!id) return;
    if (!results.some((r) => mediaItemIdOf(r) === id)) {
      results = [item, ...results];
    }
    openTranscript = null;
    void toggleDetail(id);
  }

  // ---- Collections (read-only browse) ----
  let collectionsOpen = $state(false);
  let collections = $state<MediaItem[] | null>(null);
  let collectionsLoading = $state(false);
  let collectionsError = $state('');

  let openCollection = $state<string | null>(null);
  let collectionItems = $state<MediaItem[]>([]);
  let collectionLoading = $state(false);
  let collectionError = $state('');

  async function toggleCollections(): Promise<void> {
    collectionsOpen = !collectionsOpen;
    if (collectionsOpen && collections === null && !collectionsLoading) {
      await loadCollections();
    }
  }

  async function loadCollections(): Promise<void> {
    collectionsLoading = true;
    collectionsError = '';
    try {
      collections = asItems(await mediaApi.collections());
    } catch (err) {
      collectionsError = errMsg(err);
      collections = [];
    } finally {
      collectionsLoading = false;
    }
  }

  async function toggleCollection(id: string): Promise<void> {
    if (openCollection === id) {
      openCollection = null;
      return;
    }
    openCollection = id;
    collectionItems = [];
    collectionError = '';
    collectionLoading = true;
    try {
      const res = asItems(await mediaApi.collection(id));
      if (openCollection === id) collectionItems = res;
    } catch (err) {
      if (openCollection === id) collectionError = errMsg(err);
    } finally {
      if (openCollection === id) collectionLoading = false;
    }
  }

  const collectionLabel = (c: MediaItem): string =>
    pick(c as Bag, ['name', 'title', 'label', 'id', 'collection_id']) || '(collection)';
  const collectionSub = (c: MediaItem): string => {
    const n = pickNum(c as Bag, ['item_count', 'count', 'size', 'total']);
    const desc = pick(c as Bag, ['description', 'summary']);
    return [n !== null ? `${n} item${n === 1 ? '' : 's'}` : '', desc].filter(Boolean).join(' · ');
  };
  const collectionIdOf = (c: MediaItem): string | undefined =>
    pick(c as Bag, ['id', 'collection_id', 'name']) || undefined;

  function fmtDuration(s?: number): string {
    if (typeof s !== 'number' || !isFinite(s) || s <= 0) return '';
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  /** Timecode of a segment boundary (allows 0:00, unlike fmtDuration which drops non-positive). */
  function fmtTimecode(s?: number): string {
    if (typeof s !== 'number' || !isFinite(s) || s < 0) return '';
    const m = Math.floor(s / 60);
    const sec = Math.round(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }
  function fmtTimecodeRange(start?: number, end?: number): string {
    const a = fmtTimecode(start);
    const b = fmtTimecode(end);
    if (a && b) return `${a}–${b}`;
    return a || b || '';
  }

  const transcriptLang = $derived.by<string>(() =>
    transcript && typeof transcript.language === 'string' ? transcript.language : '',
  );

  // Per-segment transcript view: preserves the timecodes (and, via the header,
  // the language) that the trust surface exists to show — never flatten to a blob.
  type TranscriptSeg = { time: string; text: string };
  const transcriptSegments = $derived.by<TranscriptSeg[]>(() => {
    if (!transcript || !Array.isArray(transcript.segments)) return [];
    return transcript.segments
      .filter((seg) => typeof seg?.text === 'string' && seg.text.trim())
      .map((seg) => ({ time: fmtTimecodeRange(seg?.start, seg?.end), text: (seg?.text ?? '').trim() }));
  });

  // Plain-text fallback for transcripts that only carry a `text` blob (no segments).
  const transcriptText = $derived.by(() => {
    if (!transcript) return '';
    if (typeof transcript.text === 'string' && transcript.text.trim()) return transcript.text;
    if (Array.isArray(transcript.segments)) {
      return transcript.segments.map((seg) => seg?.text ?? '').filter(Boolean).join(' ');
    }
    return '';
  });
</script>

<!-- Object-valued leftover fields, behind an opt-in disclosure (never a naked dump). -->
{#snippet rawDetails(rows: KagDetailRow[])}
  {#if rows.some((r) => r.raw)}
    <details class="mt-1 text-[10px] text-[var(--color-text-muted)]">
      <summary class="cursor-pointer hover:underline">details</summary>
      {#each rows.filter((r) => r.raw) as r (r.key)}
        <div class="mt-1">
          <span class="font-medium">{r.key}</span>
          <pre class="overflow-x-auto whitespace-pre-wrap break-words text-[var(--color-text)]">{r.value}</pre>
        </div>
      {/each}
    </details>
  {/if}
{/snippet}

<div class="max-w-4xl" data-testid="kag-media-tab">
  <section
    class="mb-6 border border-[var(--color-border)] rounded-lg p-4 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
  >
    <h2 class="text-lg font-semibold mb-2">Discover media</h2>
    <p class="text-sm text-[var(--color-text-muted)] mb-3 dark:text-[var(--color-text-muted)]">
      Search video and audio across the registered media sources, then read the transcript of what
      was actually said or open the source.
    </p>
    <form class="space-y-3" onsubmit={runSearch}>
      <div>
        <label
          for="media-q"
          class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
          >Query</label
        >
        <input
          id="media-q"
          data-testid="kag-media-q"
          bind:value={query}
          placeholder="how retrieval-augmented generation works"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
          required
        />
      </div>
      <div class="flex flex-wrap items-end gap-3">
        <div>
          <label
            for="media-type"
            class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
            >Type</label
          >
          <select
            id="media-type"
            bind:value={mediaType}
            class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
          >
            <option value="">any</option>
            <option value="video">video</option>
            <option value="audio">audio</option>
          </select>
        </div>
        <div>
          <label
            for="media-max"
            class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]"
            >Per source</label
          >
          <input
            id="media-max"
            type="number"
            min="1"
            max="50"
            bind:value={maxPerSource}
            class="w-20 border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm bg-[var(--color-bg)] dark:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
          />
        </div>
        <button
          type="submit"
          data-testid="kag-media-submit"
          disabled={searching}
          class="ml-auto px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        >
          {searching ? 'Searching…' : 'Search'}
        </button>
      </div>
    </form>

    {#if error}
      <div
        data-testid="kag-media-error"
        class="mt-3 bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm"
      >
        {error}
      </div>
    {/if}
  </section>

  {#if searching}
    <div
      class="flex items-center gap-2 text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]"
    >
      <span
        class="inline-block animate-spin rounded-full h-4 w-4 border-b-2 border-[var(--color-accent)]"
      ></span>
      Searching media sources…
    </div>
  {:else if ran && !error}
    <p
      data-testid="kag-media-summary"
      class="mb-3 text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]"
    >
      {#if results.length > 0}
        {totalResults ?? results.length} result{(totalResults ?? results.length) === 1 ? '' : 's'}
        {#if sourcesQueried.length > 0}· {sourcesQueried.length} source{sourcesQueried.length === 1 ? '' : 's'} queried{/if}
        {#if sourcesFailed.length > 0}· <span class="text-[var(--color-warning-text)]"
            >{sourcesFailed.length} unavailable</span
          >{/if}
      {:else}
        No media matched. Try broader terms or a different type.
      {/if}
    </p>
    <ul class="space-y-3">
      {#each results as item (mediaItemIdOf(item) ?? item)}
        {@const id = mediaItemIdOf(item)}
        <li
          class="border border-[var(--color-border)] rounded-lg p-3 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]"
        >
          <div class="flex items-start gap-3">
            {#if typeof item.thumbnail_url === 'string' && item.thumbnail_url}
              <img
                src={item.thumbnail_url}
                alt=""
                class="w-28 h-16 object-cover rounded flex-shrink-0 bg-[var(--color-surface-strong)]"
                loading="lazy"
              />
            {/if}
            <div class="min-w-0 flex-1">
              <p class="font-medium truncate">{item.title ?? '(untitled)'}</p>
              <p class="text-xs text-[var(--color-text-muted)] mt-0.5 dark:text-[var(--color-text-muted)]">
                {[
                  item.source,
                  item.media_type,
                  fmtDuration(item.duration_seconds),
                  typeof item.published_at === 'string' ? item.published_at.slice(0, 10) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </p>
              {#if typeof item.description === 'string' && item.description}
                <p class="text-sm text-[var(--color-text)] mt-1 line-clamp-2">{item.description}</p>
              {/if}
              <div class="flex flex-wrap items-center gap-3 mt-2 text-sm">
                {#if typeof item.url === 'string' && /^https?:\/\//.test(item.url)}
                  <a
                    href={item.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    class="text-[var(--color-accent)] hover:underline">Open source ↗</a
                  >
                {/if}
                {#if id}
                  <button
                    type="button"
                    data-testid="kag-media-transcript-toggle"
                    onclick={() => toggleTranscript(id)}
                    class="text-[var(--color-accent)] hover:underline"
                    >{openTranscript === id ? 'Hide transcript' : 'Transcript'}</button
                  >
                  <button
                    type="button"
                    data-testid="kag-media-detail-toggle"
                    onclick={() => toggleDetail(id)}
                    class="text-[var(--color-accent)] hover:underline"
                    >{openDetail === id ? 'Hide details' : 'Details'}</button
                  >
                {/if}
              </div>

              {#if id && openTranscript === id}
                <div
                  data-testid="kag-media-transcript"
                  class="mt-2 border-t border-[var(--color-border)] pt-2"
                >
                  {#if transcriptLoading}
                    <p class="text-sm text-[var(--color-text-muted)]">Loading transcript…</p>
                  {:else if transcriptError}
                    <p class="text-sm text-[var(--color-danger-text)]">{transcriptError}</p>
                  {:else if transcriptSegments.length > 0 || transcriptText}
                    {#if transcriptLang}
                      <p
                        data-testid="kag-media-transcript-lang"
                        class="text-[10px] font-semibold uppercase text-[var(--color-text-muted)] mb-1"
                      >
                        Language: {transcriptLang}
                      </p>
                    {/if}
                    {#if transcriptSegments.length > 0}
                      <ol
                        data-testid="kag-media-transcript-segments"
                        class="text-sm text-[var(--color-text)] max-h-56 overflow-y-auto space-y-1"
                      >
                        {#each transcriptSegments as seg, i (i)}
                          <li class="flex gap-2" data-testid="kag-media-transcript-segment">
                            {#if seg.time}
                              <span
                                class="flex-shrink-0 font-mono text-[10px] text-[var(--color-text-muted)] tabular-nums pt-0.5"
                                data-testid="kag-media-transcript-time">{seg.time}</span
                              >
                            {/if}
                            <span class="whitespace-pre-wrap">{seg.text}</span>
                          </li>
                        {/each}
                      </ol>
                    {:else}
                      <p
                        class="text-sm text-[var(--color-text)] max-h-56 overflow-y-auto whitespace-pre-wrap"
                      >
                        {transcriptText}
                      </p>
                    {/if}
                  {:else}
                    <p class="text-sm text-[var(--color-text-muted)]">
                      No transcript available for this item.
                    </p>
                  {/if}
                </div>
              {/if}

              {#if id && openDetail === id}
                <div
                  data-testid="kag-media-detail"
                  class="mt-2 border-t border-[var(--color-border)] pt-2 space-y-3"
                >
                  <!-- Quality score. NOT "trust": the producer weighs freshness,
                       engagement and source authority — none of which is a
                       trust judgement, and labelling it so overclaims. -->
                  <div class="flex items-center gap-2" data-testid="kag-media-score">
                    <span
                      class="text-xs font-semibold uppercase text-[var(--color-text-muted)]"
                      >Quality score</span
                    >
                    {#if scoreLoading}
                      <span class="text-xs text-[var(--color-text-muted)]">Scoring…</span>
                    {:else if scoreError}
                      <span class="text-xs text-[var(--color-danger)]" data-testid="kag-media-score-error"
                        >{scoreError}</span
                      >
                    {:else if scoreLabel}
                      <span
                        data-testid="kag-media-score-badge"
                        class="rounded-full border border-[var(--color-accent)] px-2 py-0.5 text-xs text-[var(--color-accent)]"
                        >{scoreLabel}</span
                      >
                      {#if scalarTrail(scoreRows)}
                        <span class="text-[10px] text-[var(--color-text-muted)]">{scalarTrail(scoreRows)}</span>
                      {/if}
                      {@render rawDetails(scoreRows)}
                    {:else}
                      <span class="text-xs text-[var(--color-text-muted)]">No score reported.</span>
                    {/if}
                  </div>

                  <!-- Item metadata -->
                  <div data-testid="kag-media-detail-item">
                    <span
                      class="text-xs font-semibold uppercase text-[var(--color-text-muted)]"
                      >Details</span
                    >
                    {#if detailLoading}
                      <p class="text-xs text-[var(--color-text-muted)]">Loading details…</p>
                    {:else if detailError}
                      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-media-detail-error">
                        {detailError}
                      </p>
                    {:else if detailItem}
                      <p class="text-sm font-medium">{detailItem.title ?? '(untitled)'}</p>
                      {#if detailMeta}
                        <p class="text-xs text-[var(--color-text-muted)] mt-0.5">{detailMeta}</p>
                      {/if}
                      {#if typeof detailItem.description === 'string' && detailItem.description}
                        <p class="text-sm text-[var(--color-text)] mt-1">{detailItem.description}</p>
                      {/if}
                      {#if typeof detailItem.url === 'string' && /^https?:\/\//.test(detailItem.url)}
                        <a
                          href={detailItem.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          class="text-xs text-[var(--color-accent)] hover:underline">Open source ↗</a
                        >
                      {/if}
                      {#if scalarTrail(detailExtraRows)}
                        <p class="text-[10px] text-[var(--color-text-muted)] mt-1">{scalarTrail(detailExtraRows)}</p>
                      {/if}
                      {@render rawDetails(detailExtraRows)}
                    {:else}
                      <p class="text-xs text-[var(--color-text-muted)]">No extra detail available.</p>
                    {/if}
                  </div>

                  <!-- Related media -->
                  <div data-testid="kag-media-related">
                    <span
                      class="text-xs font-semibold uppercase text-[var(--color-text-muted)]"
                      >Related</span
                    >
                    {#if relatedLoading}
                      <p class="text-xs text-[var(--color-text-muted)]">Finding related media…</p>
                    {:else if relatedError}
                      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-media-related-error">
                        {relatedError}
                      </p>
                    {:else if related.length > 0}
                      <div class="flex gap-2 overflow-x-auto pt-1">
                        {#each related as rel, i (mediaItemIdOf(rel) ?? i)}
                          <button
                            type="button"
                            data-testid="kag-media-related-item"
                            onclick={() => selectRelated(rel)}
                            class="w-40 flex-shrink-0 rounded border border-[var(--color-border)] p-2 text-left hover:border-[var(--color-accent)] bg-[var(--color-bg)] dark:bg-[var(--color-surface)]"
                          >
                            {#if typeof rel.thumbnail_url === 'string' && rel.thumbnail_url}
                              <img
                                src={rel.thumbnail_url}
                                alt=""
                                class="w-full h-20 object-cover rounded mb-1 bg-[var(--color-surface-strong)]"
                                loading="lazy"
                              />
                            {/if}
                            <p class="text-xs font-medium line-clamp-2">{rel.title ?? '(untitled)'}</p>
                            <p class="text-[10px] text-[var(--color-text-muted)] mt-0.5 truncate">
                              {[rel.source, rel.media_type, fmtDuration(rel.duration_seconds)]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          </button>
                        {/each}
                      </div>
                    {:else}
                      <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-media-related-empty">
                        No related media found.
                      </p>
                    {/if}
                  </div>
                </div>
              {/if}
            </div>
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <!-- Collections (read-only browse) -->
  <section class="mt-6 border-t border-[var(--color-border)] pt-4" data-testid="kag-media-collections-section">
    <button
      type="button"
      data-testid="kag-media-collections-toggle"
      onclick={() => void toggleCollections()}
      class="text-sm font-semibold text-[var(--color-accent)] hover:underline"
      >{collectionsOpen ? 'Hide collections' : 'Browse collections'}</button
    >
    {#if collectionsOpen}
      <div class="mt-3">
        {#if collectionsLoading}
          <p class="text-xs text-[var(--color-text-muted)]">Loading collections…</p>
        {:else if collectionsError}
          <p class="text-xs text-[var(--color-danger)]" data-testid="kag-media-collections-error">
            {collectionsError}
          </p>
        {:else if collections && collections.length > 0}
          <ul class="space-y-2" data-testid="kag-media-collections">
            {#each collections as c, i (collectionIdOf(c) ?? i)}
              {@const cid = collectionIdOf(c)}
              <li class="rounded border border-[var(--color-border)] p-2">
                <div class="flex items-center gap-2">
                  <span class="text-sm font-medium">{collectionLabel(c)}</span>
                  {#if collectionSub(c)}
                    <span class="text-xs text-[var(--color-text-muted)]">{collectionSub(c)}</span>
                  {/if}
                  {#if cid}
                    <button
                      type="button"
                      data-testid="kag-media-collection-toggle"
                      onclick={() => toggleCollection(cid)}
                      class="ml-auto text-xs text-[var(--color-accent)] hover:underline"
                      >{openCollection === cid ? 'Hide' : 'Open'}</button
                    >
                  {/if}
                </div>
                {#if cid && openCollection === cid}
                  <div class="mt-2 border-t border-[var(--color-border)] pt-2" data-testid="kag-media-collection">
                    {#if collectionLoading}
                      <p class="text-xs text-[var(--color-text-muted)]">Loading items…</p>
                    {:else if collectionError}
                      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-media-collection-error">
                        {collectionError}
                      </p>
                    {:else if collectionItems.length > 0}
                      <ul class="space-y-1">
                        {#each collectionItems as ci, j (mediaItemIdOf(ci) ?? j)}
                          <li>
                            <button
                              type="button"
                              data-testid="kag-media-collection-item"
                              onclick={() => selectRelated(ci)}
                              class="text-left text-sm text-[var(--color-accent)] hover:underline"
                              >{ci.title ?? '(untitled)'}</button
                            >
                            <span class="text-[10px] text-[var(--color-text-muted)] ml-1">
                              {[ci.source, ci.media_type].filter(Boolean).join(' · ')}
                            </span>
                          </li>
                        {/each}
                      </ul>
                    {:else}
                      <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-media-collection-empty">
                        This collection is empty.
                      </p>
                    {/if}
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-media-collections-empty">
            No collections yet.
          </p>
        {/if}
      </div>
    {/if}
  </section>
</div>
