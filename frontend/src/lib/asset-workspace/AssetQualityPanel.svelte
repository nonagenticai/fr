<!--
  AssetQualityPanel.svelte

  Renders an asset's stored quality verdict and its score history, read-only.
  Driven by `manifest.quality`; omitted entirely for assets without one.

  There is no Evaluate action: requirements_management removed its LLM quality
  judges (RM #238), so fr shows only what RM has recorded — the verdict
  persisted on the entity row (the only source carrying when/by-whom) and every
  recorded run in the history.
-->
<script lang="ts">
  import { Pill } from '$lib/components/ui';
  import {
    fetchQualityHistory,
    isVerdictStale,
    readPersistedVerdict,
    type QualityHistoryEntry,
    type QualityKind,
  } from '$lib/api/quality';

  let {
    kind,
    label,
    id,
    item,
    modifiedAt = null,
    persistenceNote = '',
  }: {
    kind: QualityKind;
    label: string;
    id: string;
    item: unknown;
    modifiedAt?: string | null;
    persistenceNote?: string;
  } = $props();

  // ── Score history — every recorded run, not only the latest persisted one ──
  // A third state (`historyError`) keeps a failed read from rendering as "no
  // runs yet". A run with no score says "no score": never 0, never 0.5.
  let history = $state<QualityHistoryEntry[] | null>(null);
  let historyError = $state<string | null>(null);

  async function refreshHistory(): Promise<void> {
    try {
      history = await fetchQualityHistory(kind, id);
      historyError = null;
    } catch (e) {
      historyError = e instanceof Error ? e.message : String(e);
    }
  }

  $effect(() => {
    void kind;
    void id;
    history = null;
    historyError = null;
    void refreshHistory();
  });

  const verdict = $derived(readPersistedVerdict(item));
  const stale = $derived(isVerdictStale(verdict, modifiedAt));

  const scorePercent = $derived(
    verdict?.score === null || verdict?.score === undefined
      ? null
      : Math.round(verdict.score * 100),
  );
</script>

<section class="mt-8" data-testid="quality-panel">
  <div class="mb-3 flex items-center gap-3">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">{label}</h2>
    {#if stale}
      <Pill tone="warning">
        <span data-testid="quality-stale">Stale — edited since evaluation</span>
      </Pill>
    {/if}
  </div>

  {#if verdict}
    <div class="rounded border border-[var(--color-border)] p-3" data-testid="quality-verdict">
      <div class="flex items-baseline gap-3">
        {#if scorePercent !== null}
          <span class="text-2xl font-semibold" data-testid="quality-score">
            {scorePercent}%
          </span>
        {:else}
          <!-- No stored score. Rendering 0% would be a fabrication. -->
          <span class="text-sm text-[var(--color-text-muted)]" data-testid="quality-no-score">
            No score recorded.
          </span>
        {/if}
        {#if verdict.lastEvaluatedAt}
          <span class="text-xs text-[var(--color-text-muted)]" data-testid="quality-evaluated-at">
            Evaluated {new Date(verdict.lastEvaluatedAt).toLocaleString()}
            {#if verdict.lastEvaluatedByAgent}
              by {verdict.lastEvaluatedByAgent}
            {/if}
          </span>
        {/if}
      </div>

      <!--
        Issues and suggestions are rendered even when empty-but-evaluated, as an
        explicit "none", because a score with no findings shown is ambiguous
        between "clean" and "we did not fetch them".
      -->
      <div class="mt-3">
        <h3 class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
          Issues
        </h3>
        {#if verdict.issues.length}
          <ul class="mt-1 list-disc pl-5 text-sm" data-testid="quality-issues">
            {#each verdict.issues as issue, i (i)}
              <li>{issue}</li>
            {/each}
          </ul>
        {:else}
          <p class="mt-1 text-sm text-[var(--color-text-muted)]" data-testid="quality-no-issues">
            No issues raised.
          </p>
        {/if}
      </div>

      <div class="mt-3">
        <h3 class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">
          Suggestions
        </h3>
        {#if verdict.suggestions.length}
          <ul class="mt-1 list-disc pl-5 text-sm" data-testid="quality-suggestions">
            {#each verdict.suggestions as s, i (i)}
              <li>{s}</li>
            {/each}
          </ul>
        {:else}
          <p
            class="mt-1 text-sm text-[var(--color-text-muted)]"
            data-testid="quality-no-suggestions"
          >
            No suggestions recorded.
          </p>
        {/if}
      </div>
    </div>
  {:else}
    <div class="text-sm text-[var(--color-text-muted)]" data-testid="quality-idle">
      <p>No stored {label.toLowerCase()} result.</p>
      {#if persistenceNote}
        <p class="mt-1" data-testid="quality-persistence-note">{persistenceNote}</p>
      {/if}
    </div>
  {/if}

  <div class="mt-4" data-testid="quality-history">
    <h3 class="text-xs font-semibold uppercase text-[var(--color-text-muted)]">Score history</h3>
    {#if historyError}
      <p class="mt-1 text-sm text-[var(--color-danger-text)]" data-testid="quality-history-error">
        Couldn't load the score history: {historyError}
      </p>
    {:else if history === null}
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">Loading history…</p>
    {:else if history.length === 0}
      <p class="mt-1 text-sm text-[var(--color-text-muted)]" data-testid="quality-history-empty">
        No recorded runs.
      </p>
    {:else}
      <ul class="mt-1 divide-y divide-[var(--color-border)] text-sm">
        {#each history as h, i (h.created_at + i)}
          <li class="flex flex-wrap items-baseline gap-3 py-1" data-testid="quality-history-row">
            {#if h.score === null}
              <span class="w-16 text-[var(--color-text-muted)]" data-testid="quality-history-noscore">no score</span>
            {:else}
              <span class="w-16 font-semibold" data-testid="quality-history-score">{Math.round(h.score * 100)}%</span>
            {/if}
            <span class="text-[var(--color-text-muted)]">{h.evaluator ?? 'evaluator unrecorded'}</span>
            <span class="font-mono text-xs text-[var(--color-text-muted)]">{h.model_id ?? 'model unrecorded'}</span>
            <span class="ml-auto text-xs text-[var(--color-text-muted)]">{new Date(h.created_at).toLocaleString()}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </div>
</section>
