<!--
  KAG "Text analysis" tab — surfaces the curated-compute operations of the KAG
  gateway that had no product surface until now. Two clearly separated sections:

    Section A — Text analysis (NLP)   paste text → analyse. Seven ops over the
      already-proxied `/api/assets/kag/nlp/*` routes (extract entities, parse
      entities+relationships, segment, detect language, assess quality, entity
      density, and two-text / batch semantic similarity).

    Section B — ML tools (raw primitives)   developer / inspection tools over
      `/api/assets/kag/ml/*` (list models, generate embeddings, vector
      similarity, scaled-dot-product attention). Labelled as low-level so a
      customer isn't misled into thinking these are the everyday surface.

  Every op runs LAZILY on submit (never on keystroke); each carries its own
  honest idle/loading/empty/error state via a per-op state bag. Results are
  untyped loose payloads (shapes vary by ML backend / NLP model), so every field
  access is guarded and we render a readable SUMMARY — chips, a score, a
  code+confidence, key→value rows, an "N × D" embedding preview — never a raw
  384-float dump. All reads: no writes, no mutations. The ML model list is the
  only auto-load (once, when Section B first renders).
-->
<script lang="ts">
  import { AssetError } from '$lib/api/assets';
  import { kagComputeApi, type KagRecord } from '$lib/api/kag';
  import { kagDetailRows } from '$lib/components/kag/graph-normalise';
  import { askScorePct, askScaleLabel } from '$lib/components/kag/kagAsk';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  // --- Per-op state bag -------------------------------------------------------
  // One entry per operation id; keeps idle/loading/error/result independent so
  // one failing op never blanks another. Svelte 5 `$state` is deeply reactive,
  // so reassigning `ops[id]` re-renders just that op's panel.
  interface OpState {
    loading: boolean;
    error: string;
    result: unknown;
    ran: boolean;
  }
  let ops = $state<Record<string, OpState>>({});
  function op(id: string): OpState {
    return ops[id] ?? { loading: false, error: '', result: null, ran: false };
  }
  async function run(id: string, fn: () => Promise<unknown>): Promise<void> {
    ops[id] = { loading: true, error: '', result: op(id).result, ran: true };
    try {
      const r = await fn();
      ops[id] = { loading: false, error: '', result: r, ran: true };
    } catch (e) {
      ops[id] = { loading: false, error: errMsg(e), result: null, ran: true };
    }
  }

  // --- Defensive payload probes ----------------------------------------------
  function isRecord(v: unknown): v is KagRecord {
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  }
  /** First array found under the given keys, drilling one level into data/result. */
  function findArray(v: unknown, keys: string[]): unknown[] {
    if (Array.isArray(v)) return v;
    if (!isRecord(v)) return [];
    for (const k of keys) if (Array.isArray(v[k])) return v[k] as unknown[];
    for (const nest of ['data', 'result', 'results']) {
      if (isRecord(v[nest])) {
        for (const k of keys) {
          const inner = (v[nest] as KagRecord)[k];
          if (Array.isArray(inner)) return inner as unknown[];
        }
      }
    }
    return [];
  }
  /** First finite number found under the given keys, drilling one level into data/result/results
   *  (mirrors findArray) — some ops wrap scalars as `{result:{similarity:…}}`. */
  function findNumber(v: unknown, keys: string[]): number | undefined {
    if (typeof v === 'number' && Number.isFinite(v)) return v;
    if (!isRecord(v)) return undefined;
    for (const k of keys) {
      const x = v[k];
      if (typeof x === 'number' && Number.isFinite(x)) return x;
    }
    for (const nest of ['data', 'result', 'results']) {
      if (isRecord(v[nest])) {
        for (const k of keys) {
          const x = (v[nest] as KagRecord)[k];
          if (typeof x === 'number' && Number.isFinite(x)) return x;
        }
      }
    }
    return undefined;
  }
  /** First non-empty string found under the given keys, drilling one level into data/result/results. */
  function findString(v: unknown, keys: string[]): string | undefined {
    if (!isRecord(v)) return undefined;
    for (const k of keys) {
      const x = v[k];
      if (typeof x === 'string' && x.length > 0) return x;
    }
    for (const nest of ['data', 'result', 'results']) {
      if (isRecord(v[nest])) {
        for (const k of keys) {
          const x = (v[nest] as KagRecord)[k];
          if (typeof x === 'string' && x.length > 0) return x;
        }
      }
    }
    return undefined;
  }
  /**
   * Top-level scalar entries as ordered key→value rows (for quality/density).
   * Drops echoed-input keys (the caller's own pasted text re-presented as a
   * "metric" is a lie) and nested objects, via the shared `kagDetailRows`.
   */
  function scalarRows(v: unknown): Array<[string, string]> {
    if (!isRecord(v)) return [];
    return kagDetailRows(v, [], { dropInputEcho: true })
      .filter((r) => !r.raw)
      .map((r) => [r.key, r.value] as [string, string]);
  }
  function procMs(v: unknown): number | undefined {
    return findNumber(v, [
      'processing_time_ms',
      'processing_ms',
      'took_ms',
      'elapsed_ms',
    ]);
  }

  const ENTITY_LABEL = ['text', 'name', 'entity', 'value', 'mention', 'word'];
  const ENTITY_TYPE = ['label', 'type', 'entity_type', 'ner', 'tag', 'category'];
  function entityLabel(e: unknown): string {
    if (typeof e === 'string') return e;
    return (isRecord(e) && findString(e, ENTITY_LABEL)) || '(entity)';
  }
  function entityType(e: unknown): string {
    return (isRecord(e) && findString(e, ENTITY_TYPE)) || '';
  }

  // --- Section A inputs -------------------------------------------------------
  let nlpText = $state('');
  let segmentMode = $state('sentences');
  let simA = $state('');
  let simB = $state('');
  let batchQuery = $state('');
  let batchCandidates = $state(''); // one candidate per line

  const nlpReady = $derived(nlpText.trim().length > 0);

  function candidateList(): string[] {
    return batchCandidates
      .split('\n')
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // --- Section C — Pipeline stages (KARMA enrich / HiRAG decompose) -----------
  let pipelineText = $state('');
  const pipelineReady = $derived(pipelineText.trim().length > 0);
  // Result bags are untyped and vary by pipeline version, so every panel probes
  // known array/scalar keys and falls back to an explicit "unexpected shape" note
  // (never a blank panel) when nothing is readable.
  const ENRICH_ENTITY_KEYS = ['entities', 'enriched_entities', 'items', 'nodes'];
  const ENRICH_TRIPLE_KEYS = ['triples', 'relationships', 'relations', 'edges'];
  const DECOMPOSE_LEVEL_KEYS = [
    'hierarchy',
    'levels',
    'layers',
    'communities',
    'clusters',
    'segments',
    'items',
  ];

  // --- Section B inputs -------------------------------------------------------
  let embedTexts = $state(''); // one text per line
  let embedNormalize = $state(true);
  let vecA = $state(''); // comma-separated floats
  let vecB = $state('');
  let simMetric = $state('cosine');
  let attnQuery = $state(''); // comma-separated floats
  let attnKeys = $state(''); // one key vector per line, comma-separated
  let attnHeads = $state(1);
  let attnTemp = $state(1);

  /** Parse a comma/space-separated list of floats; ignores blanks. */
  function parseVector(s: string): number[] {
    return s
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
      .map(Number)
      .filter((n) => Number.isFinite(n));
  }
  function parseKeyVectors(s: string): number[][] {
    return s
      .split('\n')
      .map((line) => parseVector(line))
      .filter((v) => v.length > 0);
  }
  function textLines(s: string): string[] {
    return s
      .split('\n')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);
  }

  // --- ML model list (the single auto-load) ----------------------------------
  let modelsLoaded = false;
  $effect(() => {
    if (modelsLoaded) return;
    modelsLoaded = true;
    void run('ml-models', () => kagComputeApi.listMlModels());
  });

  // Embedding-result probes.
  function embeddingMatrix(v: unknown): number[][] {
    const arr = findArray(v, ['embeddings', 'vectors', 'data']);
    return arr.filter((row): row is number[] => Array.isArray(row));
  }
  function attentionShape(v: unknown): string {
    const w = findArray(v, ['attention_weights', 'weights', 'attention', 'output']);
    if (w.length === 0) return '';
    const rows = w.length;
    const first = w[0];
    if (Array.isArray(first)) {
      const cols = first.length;
      const inner = first[0];
      if (Array.isArray(inner)) return `${rows} × ${cols} × ${inner.length}`;
      return `${rows} × ${cols}`;
    }
    return `${rows}`;
  }

  const metrics = ['cosine', 'euclidean', 'dot'];
</script>

<div class="flex flex-col gap-6" data-testid="kag-textanalysis-tab">
  <div>
    <h2 class="text-lg font-semibold text-[var(--color-text)]">Text analysis</h2>
    <p class="mt-1 max-w-3xl text-sm text-[var(--color-text-muted)]">
      Run the knowledge platform's language and vector primitives on ad-hoc text —
      without ingesting anything. Paste text below to extract entities, gauge
      quality, compare passages and more. Low-level ML tools live further down.
    </p>
  </div>

  <!-- ===================== Section A — Text analysis (NLP) ==================== -->
  <section class="flex flex-col gap-4">
    <div>
      <h3 class="text-sm font-semibold text-[var(--color-text)]">Text analysis (NLP)</h3>
      <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
        Paste text once, then run any analysis over it.
      </p>
    </div>

    <textarea
      bind:value={nlpText}
      rows="5"
      placeholder="Paste or type text to analyse…"
      data-testid="kag-textanalysis-input"
      class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
    ></textarea>

    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="kag-textanalysis-entities-run"
        disabled={!nlpReady || op('entities').loading}
        onclick={() => void run('entities', () => kagComputeApi.entities(nlpText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('entities').loading ? 'Analyzing…' : 'Extract entities'}</button
      >
      <button
        type="button"
        data-testid="kag-textanalysis-parse-run"
        disabled={!nlpReady || op('parse').loading}
        onclick={() => void run('parse', () => kagComputeApi.parse(nlpText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('parse').loading ? 'Analyzing…' : 'Parse (entities + relationships)'}</button
      >
      <button
        type="button"
        data-testid="kag-textanalysis-detect-language-run"
        disabled={!nlpReady || op('detect-language').loading}
        onclick={() =>
          void run('detect-language', () => kagComputeApi.detectLanguage(nlpText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('detect-language').loading ? 'Analyzing…' : 'Detect language'}</button
      >
      <button
        type="button"
        data-testid="kag-textanalysis-text-quality-run"
        disabled={!nlpReady || op('text-quality').loading}
        onclick={() => void run('text-quality', () => kagComputeApi.textQuality(nlpText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('text-quality').loading ? 'Analyzing…' : 'Assess quality'}</button
      >
      <button
        type="button"
        data-testid="kag-textanalysis-entity-density-run"
        disabled={!nlpReady || op('entity-density').loading}
        onclick={() =>
          void run('entity-density', () => kagComputeApi.entityDensity(nlpText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('entity-density').loading ? 'Analyzing…' : 'Entity density'}</button
      >
      <div class="flex items-center gap-1">
        <label
          class="text-xs font-medium uppercase tracking-wide text-[var(--color-text-muted)]"
          for="kag-ta-segment-mode">Mode</label
        >
        <select
          id="kag-ta-segment-mode"
          bind:value={segmentMode}
          data-testid="kag-textanalysis-segment-mode"
          class="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        >
          <option value="sentences">sentences</option>
          <option value="paragraphs">paragraphs</option>
        </select>
        <button
          type="button"
          data-testid="kag-textanalysis-segment-run"
          disabled={!nlpReady || op('segment').loading}
          onclick={() =>
            void run('segment', () => kagComputeApi.segment(nlpText, segmentMode))}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('segment').loading ? 'Analyzing…' : 'Segment'}</button
        >
      </div>
    </div>

    <!-- Entities result -->
    {#if op('entities').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-entities"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-xs font-semibold text-[var(--color-text)]">Entities</span>
          {#if procMs(op('entities').result) !== undefined}
            <span class="text-[10px] text-[var(--color-text-muted)]"
              >{procMs(op('entities').result)} ms</span
            >
          {/if}
        </div>
        {#if op('entities').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('entities').error}
          <p class="text-xs text-[var(--color-danger)]" data-testid="kag-textanalysis-entities-error">
            {op('entities').error}
          </p>
        {:else}
          {@const list = findArray(op('entities').result, ['entities', 'items', 'results'])}
          {#if list.length > 0}
            <ul class="flex flex-wrap gap-1" data-testid="kag-textanalysis-entities-list">
              {#each list as e, i (i)}
                <li
                  class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text)]"
                >
                  <span class="font-medium">{entityLabel(e)}</span>
                  {#if entityType(e)}
                    <span class="text-[10px] text-[var(--color-accent)]">{entityType(e)}</span>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-textanalysis-entities-empty">
              No entities found in this text.
            </p>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Parse result (entities + relationships) -->
    {#if op('parse').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-parse"
      >
        <div class="mb-1 text-xs font-semibold text-[var(--color-text)]">Parse</div>
        {#if op('parse').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('parse').error}
          <p class="text-xs text-[var(--color-danger)]">{op('parse').error}</p>
        {:else}
          {@const ents = findArray(op('parse').result, ['entities', 'nodes', 'items'])}
          {@const rels = findArray(op('parse').result, ['relationships', 'relations', 'edges'])}
          <div class="flex flex-col gap-2">
            <div>
              <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                >Entities ({ents.length})</span
              >
              {#if ents.length > 0}
                <ul class="mt-1 flex flex-wrap gap-1">
                  {#each ents as e, i (i)}
                    <li
                      class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs"
                    >
                      <span class="font-medium">{entityLabel(e)}</span>
                      {#if entityType(e)}<span class="text-[10px] text-[var(--color-accent)]"
                          >{entityType(e)}</span
                        >{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
            <div>
              <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                >Relationships ({rels.length})</span
              >
              {#if rels.length > 0}
                <ul class="mt-1 flex flex-col gap-0.5">
                  {#each rels as r, i (i)}
                    <li class="text-xs text-[var(--color-text)]">
                      {#if isRecord(r)}
                        {findString(r, ['source', 'from', 'subject', 'head']) ?? '?'}
                        <span class="text-[var(--color-accent)]"
                          >— {findString(r, ['type', 'relation', 'label', 'predicate']) ?? 'related'} →</span
                        >
                        {findString(r, ['target', 'to', 'object', 'tail']) ?? '?'}
                      {:else}{String(r)}{/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            </div>
            {#if ents.length === 0 && rels.length === 0}
              <p class="text-xs text-[var(--color-text-muted)]">No entities or relationships found.</p>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    <!-- Segment result -->
    {#if op('segment').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-segment"
      >
        <div class="mb-1 text-xs font-semibold text-[var(--color-text)]">Segments</div>
        {#if op('segment').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('segment').error}
          <p class="text-xs text-[var(--color-danger)]">{op('segment').error}</p>
        {:else}
          {@const segs = findArray(op('segment').result, ['segments', 'sentences', 'paragraphs', 'chunks', 'items'])}
          {#if segs.length > 0}
            <ol class="flex list-decimal flex-col gap-1 pl-5 text-xs text-[var(--color-text)]">
              {#each segs as s, i (i)}
                <li>{typeof s === 'string' ? s : (findString(s, ['text', 'content', 'sentence']) ?? '(unlabeled segment)')}</li>
              {/each}
            </ol>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">No segments returned.</p>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Detect-language result -->
    {#if op('detect-language').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-detect-language"
      >
        <div class="mb-1 text-xs font-semibold text-[var(--color-text)]">Language</div>
        {#if op('detect-language').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('detect-language').error}
          <p class="text-xs text-[var(--color-danger)]">{op('detect-language').error}</p>
        {:else}
          {@const code = findString(op('detect-language').result, ['language', 'lang', 'detected_language', 'code', 'iso_code'])}
          {@const conf = findNumber(op('detect-language').result, ['confidence', 'probability', 'score'])}
          {#if code}
            <p class="text-sm text-[var(--color-text)]">
              <span class="font-mono font-semibold">{code}</span>
              {#if conf !== undefined}
                <!-- A percentage IS legitimate here: langdetect returns a real
                     posterior in 0..1 (nlp_service `detect_langs(...)[0].prob`).
                     The bug was the arithmetic, not the unit. `conf <= 1 ? …`
                     guessed the scale, and .toFixed(1) rendered 0.99964 as
                     "100.0%" — precision the detector never claimed. Use the
                     house helper, which floors and caps at 99 for exactly this.
                     A value above 1 is a broken contract, not a percentage. -->
                {#if conf > 1}
                  <span class="text-xs text-[var(--color-text-muted)]"
                    >({askScaleLabel('none')} confidence)</span
                  >
                {:else}
                  <span class="text-xs text-[var(--color-text-muted)]"
                    >({askScorePct(conf)}% confidence)</span
                  >
                {/if}
              {/if}
            </p>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">Language could not be determined.</p>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Text-quality result -->
    {#if op('text-quality').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-text-quality"
      >
        <div class="mb-1 text-xs font-semibold text-[var(--color-text)]">Quality</div>
        {#if op('text-quality').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('text-quality').error}
          <p class="text-xs text-[var(--color-danger)]">{op('text-quality').error}</p>
        {:else}
          {@const rows = scalarRows(op('text-quality').result)}
          {#if rows.length > 0}
            <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {#each rows as [k, v] (k)}
                <div class="flex items-baseline justify-between gap-2 text-xs">
                  <dt class="text-[var(--color-text-muted)]">{k}</dt>
                  <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                </div>
              {/each}
            </dl>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">No quality metrics returned.</p>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Entity-density result -->
    {#if op('entity-density').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-textanalysis-entity-density"
      >
        <div class="mb-1 text-xs font-semibold text-[var(--color-text)]">Entity density</div>
        {#if op('entity-density').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
        {:else if op('entity-density').error}
          <p class="text-xs text-[var(--color-danger)]">{op('entity-density').error}</p>
        {:else}
          {@const rows = scalarRows(op('entity-density').result)}
          {#if rows.length > 0}
            <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
              {#each rows as [k, v] (k)}
                <div class="flex items-baseline justify-between gap-2 text-xs">
                  <dt class="text-[var(--color-text-muted)]">{k}</dt>
                  <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                </div>
              {/each}
            </dl>
          {:else}
            <p class="text-xs text-[var(--color-text-muted)]">No density metrics returned.</p>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Two-text similarity -->
    <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
      <h4 class="text-xs font-semibold text-[var(--color-text)]">Text similarity</h4>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <textarea
          bind:value={simA}
          rows="3"
          placeholder="Text A"
          data-testid="kag-textanalysis-similarity-a"
          class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        ></textarea>
        <textarea
          bind:value={simB}
          rows="3"
          placeholder="Text B"
          data-testid="kag-textanalysis-similarity-b"
          class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        ></textarea>
      </div>
      <div>
        <button
          type="button"
          data-testid="kag-textanalysis-similarity-run"
          disabled={simA.trim().length === 0 || simB.trim().length === 0 || op('similarity').loading}
          onclick={() => void run('similarity', () => kagComputeApi.similarity(simA, simB))}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('similarity').loading ? 'Analyzing…' : 'Compare texts'}</button
        >
      </div>
      {#if op('similarity').ran}
        <div data-testid="kag-textanalysis-similarity">
          {#if op('similarity').loading}
            <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
          {:else if op('similarity').error}
            <p class="text-xs text-[var(--color-danger)]" data-testid="kag-textanalysis-similarity-error">
              {op('similarity').error}
            </p>
          {:else}
            {@const score = findNumber(op('similarity').result, ['similarity', 'score', 'cosine', 'value', 'cosine_similarity'])}
            {#if score !== undefined}
              <p class="text-sm text-[var(--color-text)]">
                Similarity: <span class="font-mono font-semibold text-[var(--color-accent)]">{score.toFixed(4)}</span>
              </p>
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">No similarity score returned.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Batch similarity -->
    <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-4">
      <h4 class="text-xs font-semibold text-[var(--color-text)]">Batch similarity</h4>
      <p class="text-[10px] text-[var(--color-text-muted)]">
        Rank candidate texts (one per line) against a single query.
      </p>
      <input
        bind:value={batchQuery}
        placeholder="Query text"
        data-testid="kag-textanalysis-batch-query"
        class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      />
      <textarea
        bind:value={batchCandidates}
        rows="3"
        placeholder="Candidate texts, one per line"
        data-testid="kag-textanalysis-batch-candidates"
        class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      ></textarea>
      <div>
        <button
          type="button"
          data-testid="kag-textanalysis-batch-similarity-run"
          disabled={batchQuery.trim().length === 0 ||
            candidateList().length === 0 ||
            op('batch-similarity').loading}
          onclick={() =>
            void run('batch-similarity', () =>
              kagComputeApi.batchSimilarity(batchQuery, candidateList()),
            )}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('batch-similarity').loading ? 'Analyzing…' : 'Rank candidates'}</button
        >
      </div>
      {#if op('batch-similarity').ran}
        <div data-testid="kag-textanalysis-batch-similarity">
          {#if op('batch-similarity').loading}
            <p class="text-xs text-[var(--color-text-muted)]">Analyzing…</p>
          {:else if op('batch-similarity').error}
            <p class="text-xs text-[var(--color-danger)]">{op('batch-similarity').error}</p>
          {:else}
            {@const results = findArray(op('batch-similarity').result, ['results', 'similarities', 'scores', 'items'])}
            {#if results.length > 0}
              <ul class="flex flex-col gap-1">
                {#each results as r, i (i)}
                  {@const s = findNumber(r, ['similarity', 'score', 'cosine', 'value'])}
                  {@const t = isRecord(r) ? findString(r, ['text', 'candidate', 'content']) : (typeof r === 'string' ? r : undefined)}
                  <li class="flex items-baseline justify-between gap-2 rounded border border-[var(--color-border)] px-2 py-1 text-xs">
                    <span class="min-w-0 truncate text-[var(--color-text)]">{t ?? `Candidate ${i + 1}`}</span>
                    {#if s !== undefined}
                      <span class="shrink-0 font-mono text-[var(--color-accent)]">{s.toFixed(4)}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">No ranking returned.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </section>

  <!-- ==================== Section C — Pipeline stages ======================== -->
  <section
    class="flex flex-col gap-4 border-t-2 border-[var(--color-border)] pt-5"
    data-testid="kag-pipeline"
  >
    <div>
      <h3 class="text-sm font-semibold text-[var(--color-text)]">Pipeline stages</h3>
      <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
        See what the ingestion pipeline produces from raw text — KARMA enrichment
        (entities + triples) and HiRAG decomposition (a hierarchy of the document).
        A live demo of the stages that run during ingestion.
      </p>
    </div>

    <textarea
      bind:value={pipelineText}
      rows="5"
      placeholder="Paste or type text to run through the pipeline stages…"
      data-testid="kag-pipeline-input"
      class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
    ></textarea>

    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="kag-pipeline-enrich-run"
        disabled={!pipelineReady || op('enrich').loading}
        onclick={() => void run('enrich', () => kagComputeApi.enrich(pipelineText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('enrich').loading ? 'Enriching…' : 'Enrich (KARMA)'}</button
      >
      <button
        type="button"
        data-testid="kag-pipeline-decompose-run"
        disabled={!pipelineReady || op('decompose').loading}
        onclick={() => void run('decompose', () => kagComputeApi.decompose(pipelineText))}
        class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        >{op('decompose').loading ? 'Decomposing…' : 'Decompose (HiRAG)'}</button
      >
    </div>

    <!-- Enrich result (entities + triples) -->
    {#if op('enrich').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-pipeline-enrich"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-xs font-semibold text-[var(--color-text)]">Enrichment (KARMA)</span>
          {#if procMs(op('enrich').result) !== undefined}
            <span class="text-[10px] text-[var(--color-text-muted)]">{procMs(op('enrich').result)} ms</span>
          {/if}
        </div>
        {#if op('enrich').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Enriching…</p>
        {:else if op('enrich').error}
          <p class="text-xs text-[var(--color-danger)]" data-testid="kag-pipeline-enrich-error">
            {op('enrich').error}
          </p>
        {:else}
          {@const ents = findArray(op('enrich').result, ENRICH_ENTITY_KEYS)}
          {@const triples = findArray(op('enrich').result, ENRICH_TRIPLE_KEYS)}
          {@const rows = scalarRows(op('enrich').result)}
          {#if ents.length === 0 && triples.length === 0 && rows.length === 0}
            <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-pipeline-enrich-empty">
              Couldn't read the enrichment result — unexpected shape.
            </p>
          {:else}
            <div class="flex flex-col gap-2">
              <div>
                <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                  >Entities ({ents.length})</span
                >
                {#if ents.length > 0}
                  <ul class="mt-1 flex flex-wrap gap-1">
                    {#each ents as e, i (i)}
                      <li class="inline-flex items-center gap-1 rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs">
                        <span class="font-medium">{entityLabel(e)}</span>
                        {#if entityType(e)}<span class="text-[10px] text-[var(--color-accent)]">{entityType(e)}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
              <div>
                <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                  >Triples ({triples.length})</span
                >
                {#if triples.length > 0}
                  <ul class="mt-1 flex flex-col gap-0.5" data-testid="kag-pipeline-enrich-triples">
                    {#each triples as t, i (i)}
                      <li class="text-xs text-[var(--color-text)]">
                        {#if isRecord(t)}
                          {findString(t, ['subject', 'source', 'head', 'from']) ?? '?'}
                          <span class="text-[var(--color-accent)]"
                            >— {findString(t, ['predicate', 'relation', 'type', 'label']) ?? 'related to'} →</span
                          >
                          {findString(t, ['object', 'target', 'tail', 'to']) ?? '?'}
                        {:else}{String(t)}{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              </div>
              {#if rows.length > 0}
                <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  {#each rows as [k, v] (k)}
                    <div class="flex items-baseline justify-between gap-2 text-xs">
                      <dt class="text-[var(--color-text-muted)]">{k}</dt>
                      <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    {/if}

    <!-- Decompose result (hierarchy) -->
    {#if op('decompose').ran}
      <div
        class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 dark:bg-[var(--color-bg)]"
        data-testid="kag-pipeline-decompose"
      >
        <div class="mb-1 flex items-center gap-2">
          <span class="text-xs font-semibold text-[var(--color-text)]">Decomposition (HiRAG)</span>
          {#if procMs(op('decompose').result) !== undefined}
            <span class="text-[10px] text-[var(--color-text-muted)]">{procMs(op('decompose').result)} ms</span>
          {/if}
        </div>
        {#if op('decompose').loading}
          <p class="text-xs text-[var(--color-text-muted)]">Decomposing…</p>
        {:else if op('decompose').error}
          <p class="text-xs text-[var(--color-danger)]" data-testid="kag-pipeline-decompose-error">
            {op('decompose').error}
          </p>
        {:else}
          {@const levels = findArray(op('decompose').result, DECOMPOSE_LEVEL_KEYS)}
          {@const rows = scalarRows(op('decompose').result)}
          {#if levels.length === 0 && rows.length === 0}
            <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-pipeline-decompose-empty">
              Couldn't read the decomposition result — unexpected shape.
            </p>
          {:else}
            <div class="flex flex-col gap-2">
              {#if levels.length > 0}
                <div>
                  <span class="text-[10px] uppercase tracking-wide text-[var(--color-text-muted)]"
                    >Hierarchy ({levels.length})</span
                  >
                  <ol class="mt-1 flex list-decimal flex-col gap-1 pl-5 text-xs text-[var(--color-text)]" data-testid="kag-pipeline-decompose-levels">
                    {#each levels as lvl, i (i)}
                      <li>
                        {#if isRecord(lvl)}
                          <span class="font-medium">{findString(lvl, ['level', 'name', 'title', 'label', 'summary', 'text']) ?? `Level ${i + 1}`}</span>
                          {#if findNumber(lvl, ['node_count', 'count', 'size', 'total']) !== undefined}
                            <span class="text-[10px] text-[var(--color-text-muted)]">({findNumber(lvl, ['node_count', 'count', 'size', 'total'])} nodes)</span>
                          {/if}
                        {:else}{String(lvl)}{/if}
                      </li>
                    {/each}
                  </ol>
                </div>
              {/if}
              {#if rows.length > 0}
                <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  {#each rows as [k, v] (k)}
                    <div class="flex items-baseline justify-between gap-2 text-xs">
                      <dt class="text-[var(--color-text-muted)]">{k}</dt>
                      <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                    </div>
                  {/each}
                </dl>
              {/if}
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </section>

  <!-- ========================= Section B — ML tools ========================== -->
  <section class="flex flex-col gap-4 border-t-2 border-[var(--color-border)] pt-5" data-testid="kag-mltools">
    <div>
      <h3 class="text-sm font-semibold text-[var(--color-text)]">ML tools</h3>
      <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
        Developer / inspection tools — raw ML-backend primitives (embeddings,
        vector similarity, attention). For debugging and exploration, not the
        everyday analysis surface above.
      </p>
    </div>

    <!-- Models (auto-load) -->
    <div class="flex flex-col gap-2">
      <div class="flex items-center gap-2">
        <h4 class="text-xs font-semibold text-[var(--color-text)]">Models</h4>
        <button
          type="button"
          data-testid="kag-mltools-models-refresh"
          disabled={op('ml-models').loading}
          onclick={() => void run('ml-models', () => kagComputeApi.listMlModels())}
          class="ml-auto rounded border border-[var(--color-border-strong)] px-2 py-1 text-xs text-[var(--color-text)] disabled:opacity-50"
          >{op('ml-models').loading ? 'Loading…' : 'Refresh'}</button
        >
      </div>
      {#if op('ml-models').loading && !op('ml-models').result}
        <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
      {:else if op('ml-models').error}
        <p class="text-xs text-[var(--color-danger)]" data-testid="kag-mltools-models-error">
          {op('ml-models').error}
        </p>
      {:else if op('ml-models').ran}
        {@const models = findArray(op('ml-models').result, ['models', 'items', 'data', 'results'])}
        {#if models.length > 0}
          <ul class="flex flex-wrap gap-1" data-testid="kag-mltools-models">
            {#each models as m, i (i)}
              <li class="rounded-full border border-[var(--color-border)] px-2 py-0.5 text-xs text-[var(--color-text)]">
                {typeof m === 'string' ? m : (findString(m, ['name', 'model', 'model_name', 'id']) ?? '(model)')}
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-mltools-models-empty">
            No models reported.
          </p>
        {/if}
      {/if}
    </div>

    <!-- Embeddings -->
    <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <h4 class="text-xs font-semibold text-[var(--color-text)]">Generate embeddings</h4>
      <textarea
        bind:value={embedTexts}
        rows="3"
        placeholder="One text per line"
        data-testid="kag-mltools-embeddings-input"
        class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      ></textarea>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          <input type="checkbox" bind:checked={embedNormalize} />
          normalize
        </label>
        <button
          type="button"
          data-testid="kag-mltools-embeddings-run"
          disabled={textLines(embedTexts).length === 0 || op('ml-embeddings').loading}
          onclick={() =>
            void run('ml-embeddings', () =>
              kagComputeApi.embeddings(textLines(embedTexts), { normalize: embedNormalize }),
            )}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('ml-embeddings').loading ? 'Computing…' : 'Generate'}</button
        >
      </div>
      {#if op('ml-embeddings').ran}
        <div data-testid="kag-mltools-embeddings">
          {#if op('ml-embeddings').loading}
            <p class="text-xs text-[var(--color-text-muted)]">Computing…</p>
          {:else if op('ml-embeddings').error}
            <p class="text-xs text-[var(--color-danger)]">{op('ml-embeddings').error}</p>
          {:else}
            {@const mat = embeddingMatrix(op('ml-embeddings').result)}
            {#if mat.length > 0}
              <p class="text-xs text-[var(--color-text)]">
                <span class="font-mono font-semibold">{mat.length}</span> vector{mat.length === 1 ? '' : 's'} ×
                <span class="font-mono font-semibold">{mat[0]?.length ?? 0}</span> dims
              </p>
              <p class="mt-1 truncate font-mono text-[10px] text-[var(--color-text-muted)]">
                [{(mat[0] ?? []).slice(0, 6).map((n) => (typeof n === 'number' ? n.toFixed(3) : n)).join(', ')}{(mat[0]?.length ?? 0) > 6 ? ', …' : ''}]
              </p>
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">No embeddings returned.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Vector similarity -->
    <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <h4 class="text-xs font-semibold text-[var(--color-text)]">Vector similarity</h4>
      <div class="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <input
          bind:value={vecA}
          placeholder="Vector A: 0.1, 0.2, …"
          data-testid="kag-mltools-similarity-a"
          class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        />
        <input
          bind:value={vecB}
          placeholder="Vector B: 0.1, 0.2, …"
          data-testid="kag-mltools-similarity-b"
          class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        />
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <select
          bind:value={simMetric}
          data-testid="kag-mltools-similarity-metric"
          class="rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-2 text-sm text-[var(--color-text)] dark:bg-[var(--color-surface)]"
        >
          {#each metrics as m (m)}
            <option value={m}>{m}</option>
          {/each}
        </select>
        <button
          type="button"
          data-testid="kag-mltools-similarity-run"
          disabled={parseVector(vecA).length === 0 || parseVector(vecB).length === 0 || op('ml-similarity').loading}
          onclick={() =>
            void run('ml-similarity', () =>
              kagComputeApi.mlSimilarity(parseVector(vecA), parseVector(vecB), simMetric),
            )}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('ml-similarity').loading ? 'Computing…' : 'Compute'}</button
        >
      </div>
      {#if op('ml-similarity').ran}
        <div data-testid="kag-mltools-similarity">
          {#if op('ml-similarity').loading}
            <p class="text-xs text-[var(--color-text-muted)]">Computing…</p>
          {:else if op('ml-similarity').error}
            <p class="text-xs text-[var(--color-danger)]">{op('ml-similarity').error}</p>
          {:else}
            {@const score = findNumber(op('ml-similarity').result, ['similarity', 'score', 'cosine', 'value', 'distance'])}
            {#if score !== undefined}
              <p class="text-sm text-[var(--color-text)]">
                {simMetric}: <span class="font-mono font-semibold text-[var(--color-accent)]">{score.toFixed(4)}</span>
              </p>
            {:else}
              <p class="text-xs text-[var(--color-text-muted)]">No score returned.</p>
            {/if}
          {/if}
        </div>
      {/if}
    </div>

    <!-- Attention -->
    <div class="flex flex-col gap-2 border-t border-[var(--color-border)] pt-3">
      <h4 class="text-xs font-semibold text-[var(--color-text)]">Attention</h4>
      <input
        bind:value={attnQuery}
        placeholder="Query vector: 0.1, 0.2, …"
        data-testid="kag-mltools-attention-query"
        class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      />
      <textarea
        bind:value={attnKeys}
        rows="3"
        placeholder="Key vectors — one per line, comma-separated"
        data-testid="kag-mltools-attention-keys"
        class="w-full rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-3 py-2 font-mono text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
      ></textarea>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          heads
          <input
            type="number"
            min="1"
            bind:value={attnHeads}
            class="w-16 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
          />
        </label>
        <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
          temperature
          <input
            type="number"
            min="0"
            step="0.1"
            bind:value={attnTemp}
            class="w-20 rounded border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-xs text-[var(--color-text)] dark:bg-[var(--color-surface)]"
          />
        </label>
        <button
          type="button"
          data-testid="kag-mltools-attention-run"
          disabled={parseVector(attnQuery).length === 0 || parseKeyVectors(attnKeys).length === 0 || op('ml-attention').loading}
          onclick={() =>
            void run('ml-attention', () =>
              kagComputeApi.attention(parseVector(attnQuery), parseKeyVectors(attnKeys), {
                numHeads: attnHeads,
                temperature: attnTemp,
              }),
            )}
          class="rounded border border-[var(--color-border-strong)] px-3 py-2 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
          >{op('ml-attention').loading ? 'Computing…' : 'Compute'}</button
        >
      </div>
      {#if op('ml-attention').ran}
        <div data-testid="kag-mltools-attention">
          {#if op('ml-attention').loading}
            <p class="text-xs text-[var(--color-text-muted)]">Computing…</p>
          {:else if op('ml-attention').error}
            <p class="text-xs text-[var(--color-danger)]">{op('ml-attention').error}</p>
          {:else}
            {@const shape = attentionShape(op('ml-attention').result)}
            {@const weights = findArray(op('ml-attention').result, ['attention_weights', 'weights', 'attention'])}
            {#if shape}
              <p class="text-xs text-[var(--color-text)]">
                Attention weights <span class="font-mono text-[var(--color-text-muted)]">({shape})</span>
              </p>
              {#if weights.length > 0 && Array.isArray(weights[0]) && !Array.isArray((weights[0] as unknown[])[0])}
                <div class="mt-1 overflow-x-auto">
                  <table class="text-[10px] text-[var(--color-text)]">
                    <tbody>
                      {#each weights.slice(0, 8) as row, ri (ri)}
                        <tr>
                          {#each (row as number[]).slice(0, 8) as cell, ci (ci)}
                            <td class="border border-[var(--color-border)] px-1 py-0.5 font-mono">{typeof cell === 'number' ? cell.toFixed(2) : String(cell)}</td>
                          {/each}
                        </tr>
                      {/each}
                    </tbody>
                  </table>
                </div>
              {/if}
            {:else}
              {@const rows = scalarRows(op('ml-attention').result)}
              {#if rows.length > 0}
                <dl class="grid grid-cols-1 gap-x-4 gap-y-0.5 sm:grid-cols-2">
                  {#each rows as [k, v] (k)}
                    <div class="flex items-baseline justify-between gap-2 text-xs">
                      <dt class="text-[var(--color-text-muted)]">{k}</dt>
                      <dd class="font-mono text-[var(--color-text)]">{v}</dd>
                    </div>
                  {/each}
                </dl>
              {:else}
                <p class="text-xs text-[var(--color-text-muted)]">No attention output returned.</p>
              {/if}
            {/if}
          {/if}
        </div>
      {/if}
    </div>
  </section>
</div>
