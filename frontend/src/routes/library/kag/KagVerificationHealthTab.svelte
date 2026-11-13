<!--
  KAG "Verification health" tab — surfaces the Scientific Processor's continuous
  verification pipeline (proxied by fr-backend, exposed by researchApi). It is the
  graph-maintainer view (vs the per-entity "Scientific" tab):

    Status     queue depth · throughput · processed/failed totals · last run
    Anomalies  entities whose verification score dropped beyond a threshold
    History    verification score history for one entity
    Re-verify  find + (re)score unscored/stale entities (batch)
    Trigger    (re)verify a named list of entities (with optional CoVe/formal)

  Self-contained: all fetching lives here so the tab composes onto AssetTabs
  without touching the research route. Honest empty/loading/error states.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import {
    researchApi,
    type PipelineStatus,
    type PipelineAnomalies,
    type PipelineHistory,
  } from '$lib/api/research';
  import { kagDetailRows, type KagDetailRow } from '$lib/components/kag/graph-normalise';

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }
  function fmt(n: number | undefined, d = 0): string {
    return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
  }
  /** Best-effort label for a free-form anomaly / history row. */
  function rowLabel(r: Record<string, unknown>): string {
    for (const k of ['entity_id', 'name', 'title', 'id', 'label']) {
      const v = r[k];
      if (typeof v === 'string' && v.length > 0) return v;
    }
    return '(entity)';
  }
  const ROW_LABEL_KEYS = ['entity_id', 'name', 'title', 'id', 'label'];
  /** Displayable rows for a free-form row, minus the identity keys shown as a label. */
  function detailRows(r: Record<string, unknown>): KagDetailRow[] {
    return kagDetailRows(r, ROW_LABEL_KEYS);
  }
  /** Compact `key: value · …` trail of the scalar rows (objects go behind an opt-in toggle). */
  function scalarTrail(rows: KagDetailRow[]): string {
    return rows
      .filter((x) => !x.raw)
      .map((x) => `${x.key}: ${x.value}`)
      .join(' · ');
  }

  // ---- Status ----
  let status = $state<PipelineStatus | null>(null);
  let statusLoading = $state(false);
  let statusError = $state('');

  async function loadStatus(): Promise<void> {
    statusLoading = true;
    statusError = '';
    try {
      status = await researchApi.pipelineStatus();
    } catch (e) {
      statusError = errMsg(e);
    } finally {
      statusLoading = false;
    }
  }

  // ---- Anomalies ----
  let threshold = $state('0.1');
  let anomalies = $state<PipelineAnomalies | null>(null);
  let anomaliesLoading = $state(false);
  let anomaliesError = $state('');

  async function loadAnomalies(): Promise<void> {
    anomaliesLoading = true;
    anomaliesError = '';
    try {
      const t = Number(threshold);
      anomalies = await researchApi.pipelineAnomalies(
        Number.isFinite(t) ? t : undefined,
      );
    } catch (e) {
      anomaliesError = errMsg(e);
    } finally {
      anomaliesLoading = false;
    }
  }

  // ---- History ----
  let historyEntity = $state('');
  let history = $state<PipelineHistory | null>(null);
  let historyLoading = $state(false);
  let historyError = $state('');

  async function loadHistory(): Promise<void> {
    if (!historyEntity.trim()) {
      historyError = 'Enter an entity id.';
      return;
    }
    historyLoading = true;
    historyError = '';
    try {
      history = await researchApi.pipelineHistory(historyEntity.trim());
    } catch (e) {
      historyError = errMsg(e);
    } finally {
      historyLoading = false;
    }
  }

  // ---- Batch re-verify ----
  let batchRunning = $state(false);
  let batchMsg = $state('');
  let batchFailed = $state(false);

  async function runBatch(): Promise<void> {
    batchRunning = true;
    batchMsg = '';
    batchFailed = false;
    try {
      await researchApi.pipelineBatch({ batch_size: 50, max_hops: 2 });
      batchMsg = 'Re-verification queued. Refresh status to watch the queue drain.';
      await loadStatus();
    } catch (e) {
      batchMsg = errMsg(e);
      batchFailed = true;
    } finally {
      batchRunning = false;
    }
  }

  // ---- Trigger: (re)verify a named list of entities ----
  let triggerIds = $state('');
  let triggerCove = $state(false);
  let triggerFormal = $state(false);
  let triggerRunning = $state(false);
  let triggerMsg = $state('');
  let triggerError = $state('');

  /** Split a comma/whitespace-separated blob into trimmed, non-empty ids. */
  function parseIds(raw: string): string[] {
    return raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  async function runTrigger(): Promise<void> {
    triggerMsg = '';
    triggerError = '';
    const ids = parseIds(triggerIds);
    if (ids.length === 0) {
      triggerError = 'Enter one or more entity ids.';
      return;
    }
    if (ids.length > 100) {
      triggerError = 'At most 100 entity ids per trigger.';
      return;
    }
    triggerRunning = true;
    try {
      await researchApi.pipelineTrigger({
        entity_ids: ids,
        run_cove: triggerCove,
        run_formal: triggerFormal,
      });
      triggerMsg = `Queued ${ids.length} ${ids.length === 1 ? 'entity' : 'entities'} for verification. Refresh status to watch the queue drain.`;
      await loadStatus();
    } catch (e) {
      triggerError = errMsg(e);
    } finally {
      triggerRunning = false;
    }
  }

  onMount(() => {
    void loadStatus();
  });
</script>

<!-- Object-valued leftover fields, behind an opt-in disclosure (never a naked dump). -->
{#snippet rawDetails(rows: KagDetailRow[])}
  {#if rows.some((r) => r.raw)}
    <details class="mt-1 text-[var(--color-text-muted)]">
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

<div class="flex flex-col gap-5" data-testid="kag-health">
  <!-- Status -->
  <section class="flex flex-col gap-2">
    <div class="flex items-center gap-2">
      <h2 class="text-sm font-semibold">Pipeline status</h2>
      <button
        type="button"
        data-testid="kag-health-refresh"
        disabled={statusLoading}
        onclick={() => void loadStatus()}
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        >{statusLoading ? 'Refreshing…' : 'Refresh'}</button
      >
    </div>
    {#if statusError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-health-status-error">
        {statusError}
      </p>
    {:else if status}
      <div
        class="flex flex-wrap gap-x-6 gap-y-1 text-xs"
        data-testid="kag-health-status"
      >
        <span>
          <span class="text-[var(--color-text-muted)]">State</span>
          <strong data-testid="kag-health-state"
            >{status.running === true
              ? 'running'
              : status.running === false
                ? 'idle'
                : 'unknown'}</strong
          >
        </span>
        <span>
          <span class="text-[var(--color-text-muted)]">Queue</span>
          <strong>{fmt(status.queue_depth)}</strong>
        </span>
        <span>
          <span class="text-[var(--color-text-muted)]">Throughput</span>
          <strong>{fmt(status.throughput_per_minute, 1)}</strong>/min
        </span>
        <span>
          <span class="text-[var(--color-text-muted)]">Processed</span>
          <strong>{fmt(status.processed_total)}</strong>
        </span>
        <span>
          <span class="text-[var(--color-text-muted)]">Failed</span>
          <strong>{fmt(status.failed_total)}</strong>
        </span>
        {#if status.last_run_at}
          <span class="text-[var(--color-text-muted)]">last run {status.last_run_at}</span>
        {/if}
      </div>
    {:else}
      <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
    {/if}
    <div class="flex items-center gap-2">
      <button
        type="button"
        data-testid="kag-health-batch-btn"
        disabled={batchRunning}
        onclick={() => void runBatch()}
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        >{batchRunning ? 'Queuing…' : 'Re-verify unscored entities'}</button
      >
      {#if batchMsg}
        <span
          class="text-xs {batchFailed
            ? 'text-[var(--color-danger)]'
            : 'text-[var(--color-text-muted)]'}"
          data-testid="kag-health-batch-msg"
          data-status={batchFailed ? 'error' : 'ok'}>{batchMsg}</span
        >
      {/if}
    </div>
  </section>

  <!-- Anomalies -->
  <section class="flex flex-col gap-2 border-t pt-3">
    <h2 class="text-sm font-semibold">Score-drop anomalies</h2>
    <form
      class="flex flex-wrap items-center gap-2 text-xs"
      onsubmit={(e) => {
        e.preventDefault();
        void loadAnomalies();
      }}
    >
      <label class="flex items-center gap-1">
        <span class="text-[var(--color-text-muted)]">Min drop</span>
        <input
          data-testid="kag-health-threshold"
          bind:value={threshold}
          inputmode="decimal"
          class="w-20 rounded border bg-[var(--color-surface)] px-2 py-1"
        />
      </label>
      <button
        type="submit"
        data-testid="kag-health-anomalies-btn"
        disabled={anomaliesLoading}
        class="rounded border px-2 py-1 disabled:opacity-50"
        >{anomaliesLoading ? 'Scanning…' : 'Find anomalies'}</button
      >
    </form>
    {#if anomaliesError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-health-anomalies-error">
        {anomaliesError}
      </p>
    {:else if anomalies}
      {#if (anomalies.anomalies?.length ?? 0) > 0}
        <ul class="flex flex-col gap-1 text-xs" data-testid="kag-health-anomalies">
          {#each anomalies.anomalies ?? [] as a, i (i)}
            {@const rows = detailRows(a)}
            <li class="rounded border px-2 py-1">
              <span class="font-medium">{rowLabel(a)}</span>
              <span class="text-[var(--color-text-muted)]"> {scalarTrail(rows)}</span>
              {@render rawDetails(rows)}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-health-anomalies-empty">
          No entities dropped beyond this threshold.
        </p>
      {/if}
    {/if}
  </section>

  <!-- History -->
  <section class="flex flex-col gap-2 border-t pt-3">
    <h2 class="text-sm font-semibold">Entity score history</h2>
    <form
      class="flex flex-wrap items-center gap-2 text-xs"
      onsubmit={(e) => {
        e.preventDefault();
        void loadHistory();
      }}
    >
      <input
        data-testid="kag-health-history-input"
        bind:value={historyEntity}
        placeholder="Entity id (Neo4j node id)"
        class="min-w-60 flex-1 rounded border bg-[var(--color-surface)] px-2 py-1"
      />
      <button
        type="submit"
        data-testid="kag-health-history-btn"
        disabled={historyLoading}
        class="rounded border px-2 py-1 disabled:opacity-50"
        >{historyLoading ? 'Loading…' : 'Score history'}</button
      >
    </form>
    {#if historyError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-health-history-error">
        {historyError}
      </p>
    {:else if history}
      {#if (history.history?.length ?? 0) > 0}
        <ul class="flex flex-col gap-1 text-xs" data-testid="kag-health-history">
          {#each history.history ?? [] as h, i (i)}
            {@const rows = detailRows(h)}
            <li class="text-[var(--color-text-muted)]">
              <span class="font-medium text-[var(--color-text)]">{rowLabel(h)}</span>
              {scalarTrail(rows)}
              {@render rawDetails(rows)}
            </li>
          {/each}
        </ul>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-health-history-empty">
          No score history recorded for this entity yet.
        </p>
      {/if}
    {/if}
  </section>

  <!-- Trigger: verify specific entities -->
  <section class="flex flex-col gap-2 border-t pt-3" data-testid="kag-health-trigger-section">
    <h2 class="text-sm font-semibold">Verify specific entities</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      (Re)verify a named list of entities — vs the batch above, which auto-discovers
      unscored ones. Up to 100 ids, comma- or whitespace-separated.
    </p>
    <form
      class="flex flex-col gap-2 text-xs"
      onsubmit={(e) => {
        e.preventDefault();
        void runTrigger();
      }}
    >
      <textarea
        data-testid="kag-health-trigger-input"
        bind:value={triggerIds}
        rows="2"
        placeholder="entity-id-1, entity-id-2, …"
        class="w-full rounded border bg-[var(--color-surface)] px-2 py-1"
      ></textarea>
      <div class="flex flex-wrap items-center gap-3">
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="kag-health-trigger-cove"
            bind:checked={triggerCove}
          />
          <span>Run CoVe</span>
        </label>
        <label class="flex items-center gap-1">
          <input
            type="checkbox"
            data-testid="kag-health-trigger-formal"
            bind:checked={triggerFormal}
          />
          <span>Run formal</span>
        </label>
        <button
          type="submit"
          data-testid="kag-health-trigger-btn"
          disabled={triggerRunning}
          class="rounded border px-2 py-1 disabled:opacity-50"
          >{triggerRunning ? 'Queuing…' : 'Verify entities'}</button
        >
      </div>
    </form>
    {#if triggerError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="kag-health-trigger-error">
        {triggerError}
      </p>
    {:else if triggerMsg}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="kag-health-trigger-msg">
        {triggerMsg}
      </p>
    {/if}
  </section>
</div>
