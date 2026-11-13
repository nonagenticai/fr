<!--
  SessionQualityPanel — Stage 3 (Appraise) session-wide quality view, surfacing
  three Discovery-Engine reads the stepper didn't previously expose:

    Report     the WHOLE session's trust distribution + recommended-for-ingest
               (vs the per-paper scoreBatch already in Appraise)
    Insights   ingest-event health (total / pending / failed)
    Semantic   similarity search over the session's discovered papers (vs the
               federated keyword search in Discover)

  Self-contained: the host passes only the sessionId; all fetching lives here.
  Honest empty/loading/error states; nothing loads until a session exists.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import {
    researchApi,
    paperIdOf,
    type QualityReport,
    type SessionInsights,
    type SemanticSearchResponse,
    type SessionResponse,
    type PaperResult,
    type TrustScore,
  } from '$lib/api/research';

  interface Props {
    /** The discovery session id (null until the first search persists one). */
    sessionId: string | null;
    /** Called after the session is deleted so the host can clear its state. */
    ondelete?: () => void;
  }
  const { sessionId, ondelete }: Props = $props();

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }

  let report = $state<QualityReport | null>(null);
  let insights = $state<SessionInsights | null>(null);
  let loading = $state(false);
  let error = $state('');

  async function load(): Promise<void> {
    if (!sessionId) return;
    loading = true;
    error = '';
    try {
      // Independent reads — surface whichever succeeds even if the other 404s.
      const [r, i, s] = await Promise.allSettled([
        researchApi.scoreReport(sessionId),
        researchApi.sessionInsights(sessionId),
        researchApi.getSession(sessionId),
      ]);
      if (r.status === 'fulfilled') report = r.value;
      if (i.status === 'fulfilled') insights = i.value;
      if (s.status === 'fulfilled' && s.value) {
        session = s.value;
        sessionStatus = s.value.status ?? sessionStatus;
        if (typeof s.value.name === 'string') nameDraft = s.value.name;
      }
      if (r.status === 'rejected' && i.status === 'rejected') {
        error = errMsg(r.reason);
      }
    } finally {
      loading = false;
    }
  }

  // Distribution buckets sorted by their lower bound for a stable bar order.
  const buckets = $derived.by<Array<[string, number]>>(() => {
    const d = report?.score_distribution;
    if (!d) return [];
    return Object.entries(d).sort(
      (a, b) => parseFloat(a[0]) - parseFloat(b[0]),
    );
  });
  const maxBucket = $derived(
    buckets.reduce((m, [, n]) => Math.max(m, n), 0) || 1,
  );

  // Recommended-for-ingest + trust-ranked top papers — both already in the
  // scoreReport response; render the LISTS, not just the counts.
  const recommended = $derived<PaperResult[]>(report?.recommended_for_ingest ?? []);
  const topPapers = $derived<TrustScore[]>(report?.top_papers ?? []);
  function paperTitle(p: PaperResult): string {
    return p.title ?? paperIdOf(p) ?? 'untitled';
  }
  function trustTitle(t: TrustScore): string {
    return (typeof t.title === 'string' && t.title) || t.paper_id || 'untitled';
  }

  // ---- Semantic search within the session ----
  let query = $state('');
  let searching = $state(false);
  let searchError = $state('');
  let semantic = $state<SemanticSearchResponse | null>(null);

  async function runSemantic(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    if (!sessionId || !query.trim() || searching) return;
    searching = true;
    searchError = '';
    semantic = null;
    try {
      semantic = await researchApi.semanticSearch({
        query: query.trim(),
        session_id: sessionId,
        limit: 10,
      });
    } catch (err) {
      searchError = errMsg(err);
    } finally {
      searching = false;
    }
  }

  // ---- Session management: status / pause / resume / rename / delete ----
  // `load()` reads the session via getSession so `status` is known up front; each
  // pause/resume/rename call returns the updated SessionDetail we reflect here.
  let session = $state<SessionResponse | null>(null);
  let sessionStatus = $state<string | null>(null);
  let stateBusy = $state(false);
  let stateError = $state('');
  let deleted = $state(false);
  const isPaused = $derived((sessionStatus ?? '').toLowerCase() === 'paused');

  async function pause(): Promise<void> {
    if (!sessionId || stateBusy) return;
    stateBusy = true;
    stateError = '';
    try {
      const s = await researchApi.pauseSession(sessionId);
      sessionStatus = s.status ?? 'paused';
    } catch (e) {
      stateError = errMsg(e);
    } finally {
      stateBusy = false;
    }
  }

  async function resume(): Promise<void> {
    if (!sessionId || stateBusy) return;
    stateBusy = true;
    stateError = '';
    try {
      const s = await researchApi.resumeSession(sessionId);
      sessionStatus = s.status ?? 'active';
    } catch (e) {
      stateError = errMsg(e);
    } finally {
      stateBusy = false;
    }
  }

  // ---- Rename ----
  let editingName = $state(false);
  let nameDraft = $state('');
  let renameBusy = $state(false);

  async function saveName(): Promise<void> {
    if (!sessionId || renameBusy || !nameDraft.trim()) return;
    renameBusy = true;
    stateError = '';
    try {
      const s = await researchApi.updateSession(sessionId, { name: nameDraft.trim() });
      session = s;
      editingName = false;
    } catch (e) {
      stateError = errMsg(e);
    } finally {
      renameBusy = false;
    }
  }

  // ---- Delete ----
  let confirmingDelete = $state(false);
  let deleteBusy = $state(false);

  async function remove(): Promise<void> {
    if (!sessionId || deleteBusy) return;
    deleteBusy = true;
    stateError = '';
    try {
      await researchApi.deleteSession(sessionId);
      deleted = true;
      confirmingDelete = false;
      ondelete?.();
    } catch (e) {
      stateError = errMsg(e);
    } finally {
      deleteBusy = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

{#if !sessionId}
  <p class="text-xs text-[var(--color-text-muted)]" data-testid="sq-empty">
    Run a search first — session quality appears once results are persisted.
  </p>
{:else if deleted}
  <p class="text-xs text-[var(--color-text-muted)]" data-testid="sq-deleted">
    Session deleted.
  </p>
{:else}
  <div class="flex flex-col gap-4" data-testid="session-quality">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">Session quality</h2>
      <button
        type="button"
        data-testid="sq-refresh"
        disabled={loading}
        onclick={() => void load()}
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        >{loading ? 'Loading…' : 'Refresh'}</button
      >
    </div>

    {#if error}
      <p class="text-xs text-[var(--color-danger)]" data-testid="sq-error">{error}</p>
    {/if}

    <!-- Session management: name · status · pause/resume · rename · delete -->
    <div class="flex flex-col gap-2 text-xs" data-testid="sq-state">
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-[var(--color-text-muted)]">Session</span>
        {#if editingName}
          <input
            data-testid="sq-name-input"
            bind:value={nameDraft}
            class="min-w-40 rounded border bg-[var(--color-surface)] px-2 py-1"
          />
          <button
            type="button"
            data-testid="sq-name-save"
            disabled={renameBusy || !nameDraft.trim()}
            onclick={() => void saveName()}
            class="rounded border px-2 py-1 disabled:opacity-50"
            >{renameBusy ? 'Saving…' : 'Save'}</button
          >
          <button
            type="button"
            data-testid="sq-name-cancel"
            onclick={() => (editingName = false)}
            class="rounded border px-2 py-1">Cancel</button
          >
        {:else}
          {#if session?.name}
            <span class="font-medium text-[var(--color-text)]" data-testid="sq-name"
              >{session.name}</span
            >
          {/if}
          <button
            type="button"
            data-testid="sq-name-edit"
            onclick={() => (editingName = true)}
            class="rounded border px-2 py-1">Rename</button
          >
        {/if}
        {#if sessionStatus}
          <span
            class="rounded bg-[var(--color-surface)] px-1.5 py-0.5 font-medium text-[var(--color-text)]"
            data-testid="sq-state-label">{sessionStatus}</span
          >
        {/if}
        {#if isPaused}
          <button
            type="button"
            data-testid="sq-resume"
            disabled={stateBusy}
            onclick={() => void resume()}
            class="rounded border px-2 py-1 disabled:opacity-50"
            >{stateBusy ? 'Resuming…' : 'Resume'}</button
          >
        {:else}
          <button
            type="button"
            data-testid="sq-pause"
            disabled={stateBusy}
            onclick={() => void pause()}
            class="rounded border px-2 py-1 disabled:opacity-50"
            >{stateBusy ? 'Pausing…' : 'Pause'}</button
          >
        {/if}
        {#if confirmingDelete}
          <span class="text-[var(--color-danger)]">Delete this session?</span>
          <button
            type="button"
            data-testid="sq-delete-confirm"
            disabled={deleteBusy}
            onclick={() => void remove()}
            class="rounded border border-[var(--color-danger)] px-2 py-1 text-[var(--color-danger)] disabled:opacity-50"
            >{deleteBusy ? 'Deleting…' : 'Confirm'}</button
          >
          <button
            type="button"
            data-testid="sq-delete-cancel"
            onclick={() => (confirmingDelete = false)}
            class="rounded border px-2 py-1">Cancel</button
          >
        {:else}
          <button
            type="button"
            data-testid="sq-delete"
            onclick={() => (confirmingDelete = true)}
            class="rounded border px-2 py-1 text-[var(--color-text-muted)]">Delete</button
          >
        {/if}
      </div>
      {#if stateError}
        <span class="text-[var(--color-danger)]" data-testid="sq-state-error">{stateError}</span>
      {/if}
    </div>

    <!-- Report: trust distribution + recommended-for-ingest -->
    {#if report}
      <div class="flex flex-col gap-2 text-xs" data-testid="sq-report">
        <div class="flex flex-wrap gap-x-4 text-[var(--color-text-muted)]">
          <span><strong class="text-[var(--color-text)]">{report.total_papers ?? 0}</strong> papers</span>
          {#if report.recommended_for_ingest}
            <span data-testid="sq-recommended"
              ><strong class="text-[var(--color-text)]"
                >{report.recommended_for_ingest.length}</strong
              > recommended for ingest</span
            >
          {/if}
          {#if typeof report.threshold === 'number'}
            <span>threshold {report.threshold.toFixed(2)}</span>
          {/if}
        </div>
        {#if buckets.length > 0}
          <div class="flex flex-col gap-1" data-testid="sq-distribution">
            {#each buckets as [label, n] (label)}
              <div class="flex items-center gap-2">
                <span class="w-16 shrink-0 text-right text-[var(--color-text-muted)]">{label}</span>
                <div
                  class="h-3 rounded bg-[var(--color-accent)]"
                  style={`width:${(n / maxBucket) * 100}%;min-width:2px`}
                ></div>
                <span class="text-[var(--color-text-muted)]">{n}</span>
              </div>
            {/each}
          </div>
        {/if}

        <!-- Recommended-for-ingest — the actual titled list, not just a count. -->
        <div class="flex flex-col gap-1" data-testid="session-recommended-list">
          <span class="font-medium text-[var(--color-text)]"
            >Recommended for ingest ({recommended.length})</span
          >
          {#if recommended.length > 0}
            <ul class="list-disc pl-5">
              {#each recommended as p, i (paperIdOf(p) ?? i)}
                <li class="text-[var(--color-text-muted)]">{paperTitle(p)}</li>
              {/each}
            </ul>
          {:else}
            <span class="text-[var(--color-text-muted)]" data-testid="sq-recommended-none"
              >None yet</span
            >
          {/if}
        </div>

        <!-- Trust-ranked top papers (TrustScore[]) — title + overall score. -->
        <div class="flex flex-col gap-1" data-testid="session-top-papers">
          <span class="font-medium text-[var(--color-text)]">Top papers by trust</span>
          {#if topPapers.length > 0}
            <ol class="list-decimal pl-5">
              {#each topPapers as t, i (t.paper_id ?? i)}
                <li class="flex items-baseline justify-between gap-2 text-[var(--color-text-muted)]">
                  <span class="truncate" title={trustTitle(t)}>{trustTitle(t)}</span>
                  {#if typeof t.overall_score === 'number'}
                    <span class="shrink-0">{t.overall_score.toFixed(2)}</span>
                  {/if}
                </li>
              {/each}
            </ol>
          {:else}
            <span class="text-[var(--color-text-muted)]" data-testid="sq-top-papers-none"
              >None yet</span
            >
          {/if}
        </div>
      </div>
    {/if}

    <!-- Insights: ingest-event health -->
    {#if insights}
      <div
        class="flex flex-wrap gap-x-4 text-xs text-[var(--color-text-muted)]"
        data-testid="sq-insights"
      >
        <span>Ingest events</span>
        <span><strong class="text-[var(--color-text)]">{insights.total_events ?? 0}</strong> total</span>
        <span><strong class="text-[var(--color-text)]">{insights.pending_events ?? 0}</strong> pending</span>
        <span
          class={insights.failed_events ? 'text-[var(--color-danger)]' : ''}
          ><strong>{insights.failed_events ?? 0}</strong> failed</span
        >
      </div>
    {/if}

    <!-- Semantic search within the session -->
    <form class="flex flex-col gap-1 border-t pt-3" onsubmit={runSemantic}>
      <label class="text-xs font-medium" for="sq-semantic">Semantic search within this session</label>
      <div class="flex flex-wrap items-center gap-2">
        <input
          id="sq-semantic"
          data-testid="sq-semantic-input"
          bind:value={query}
          placeholder="e.g. prognostic value of stress echocardiography"
          class="min-w-60 flex-1 rounded border bg-[var(--color-surface)] px-2 py-1 text-xs"
        />
        <button
          type="submit"
          data-testid="sq-semantic-btn"
          disabled={searching || !query.trim()}
          class="rounded border px-3 py-1 text-xs disabled:opacity-50"
          >{searching ? 'Searching…' : 'Search'}</button
        >
      </div>
      {#if searchError}
        <p class="text-xs text-[var(--color-danger)]" data-testid="sq-semantic-error">
          {searchError}
        </p>
      {:else if semantic}
        {#if (semantic.results?.length ?? 0) > 0}
          <ul class="flex flex-col gap-1 text-xs" data-testid="sq-semantic-results">
            {#each semantic.results ?? [] as r (r.paper_id)}
              <li class="flex items-baseline justify-between gap-2">
                <span class="truncate" title={r.title}>{r.title}</span>
                <span class="shrink-0 text-[var(--color-text-muted)]"
                  >{(r.similarity_score * 100).toFixed(0)}%</span
                >
              </li>
            {/each}
          </ul>
        {:else}
          <p class="text-xs text-[var(--color-text-muted)]" data-testid="sq-semantic-empty">
            No semantically similar papers in this session yet.
          </p>
        {/if}
      {/if}
    </form>
  </div>
{/if}
