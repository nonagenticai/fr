<!--
  /measure (Govern zone) — operator analytics. Re-homed from /tools/analytics
  during the /tools dissolution (control-plane roadmap Phase 3) as the
  PRECURSOR to the full T/I/OE measurement dashboard (roadmap Phase 7, which
  will add Throughput/Inventory/Operating-Expense over this same surface).
  /tools/analytics 308-redirects here.

  Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §9
        + docs/archive/2026-04-27-foundation-design.md §9.3
          (Plan-4 Lane B polish: compare-period, drill-down table,
           per-channel send volumes).

  Layout:
    - Header strip: window picker + initiator filter + project filter +
      "compare to previous period" toggle + stale badge + export CSV +
      refresh.
    - KPI grid: one KpiCard per metric returned by /api/tools/analytics/summary,
      each with a sparkline. When compare is on, every card shows ±delta
      vs the prior window.
    - Drill-down table (DrilldownTable.svelte) — per-(bucket, service)
      rows derived from KPI sparklines; click a sparkline point to filter
      the table to that date.
    - Per-channel notification volumes (PerChannelBars.svelte) sourced from
      /api/tools/analytics/per-channel.

  CSV export was already wired in Wave 3 — the link is preserved verbatim.

  Charting library: d3 (already a dependency — `d3@^7.9.0` in
  frontend/package.json). The spec §6.4 explicitly settled on this. Charts
  are hand-rolled SVG-in-Svelte using d3-scale + d3-shape; no d3-selection.
-->
<script lang="ts">
  import { onMount, onDestroy } from 'svelte';
  import {
    analyticsStore,
    type Window,
    type KpiCard as KpiCardData,
  } from '$lib/stores/analyticsStore.svelte';
  import KpiCard from '$lib/components/analytics/KpiCard.svelte';
  import Sparkline from '$lib/components/analytics/Sparkline.svelte';
  import DrilldownTable, {
    type DrilldownRow,
  } from '$lib/components/analytics/DrilldownTable.svelte';
  import PerChannelBars from '$lib/components/analytics/PerChannelBars.svelte';
  import TioeBand from '$lib/components/measure/TioeBand.svelte';

  const WINDOWS: Window[] = ['24h', '7d', '30d', '90d'];
  const INITIATORS = ['all', 'human', 'agent', 'cron', 'unknown'] as const;

  let projectFilter = $state('');
  let initiatorFilter = $state<(typeof INITIATORS)[number]>('all');
  /** Drill-down date filter: ISO date the user clicked on a sparkline. */
  let drilldownDate = $state<string | null>(null);

  onMount(() => {
    analyticsStore.start();
  });

  onDestroy(() => {
    analyticsStore.stop();
  });

  function applyProjectFilter(): void {
    const v = projectFilter.trim();
    analyticsStore.setProjectId(v.length > 0 ? v : null);
  }

  function applyInitiatorFilter(): void {
    analyticsStore.setInitiator(initiatorFilter === 'all' ? null : initiatorFilter);
  }

  function toggleCompare(): void {
    analyticsStore.setCompare(!analyticsStore.compare);
  }

  function fmtTick(iso: string | null): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  function exportUrl(): string {
    const params = new URLSearchParams();
    params.set('window', analyticsStore.window);
    if (analyticsStore.projectId) params.set('project_id', analyticsStore.projectId);
    return `/api/tools/analytics/export.csv?${params.toString()}`;
  }

  // ---------------------------------------------------------------------------
  // Compare-period helpers
  // ---------------------------------------------------------------------------

  /**
   * Lookup the prior-window total for one metric. Returns null when compare
   * is off, the prior series is missing, or the metric simply wasn't
   * present in the previous window.
   */
  function priorTotal(metric: string): number | null {
    const prev = analyticsStore.previousKpis;
    if (!prev) return null;
    const match = prev.find((k) => k.metric === metric);
    return match ? match.value : null;
  }

  function priorSeries(metric: string): number[] | null {
    const prev = analyticsStore.previousKpis;
    if (!prev) return null;
    const match = prev.find((k) => k.metric === metric);
    return match ? match.sparkline : null;
  }

  function deltaPct(current: number, prior: number | null): number | null {
    if (prior === null) return null;
    if (prior === 0) return current === 0 ? 0 : null;
    return ((current - prior) / Math.abs(prior)) * 100;
  }

  function fmtDelta(pct: number | null): string {
    if (pct === null) return '';
    const sign = pct > 0 ? '+' : '';
    return `${sign}${pct.toFixed(1)}%`;
  }

  function deltaClass(pct: number | null): string {
    if (pct === null || pct === 0) return 'text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]';
    return pct > 0
      ? 'text-[var(--color-success)] dark:text-[var(--color-success)]'
      : 'text-[var(--color-danger)] dark:text-[var(--color-danger-text)]';
  }

  // ---------------------------------------------------------------------------
  // Drill-down derivation
  // ---------------------------------------------------------------------------

  const WINDOW_DAYS: Record<Window, number> = {
    '24h': 1,
    '7d': 7,
    '30d': 30,
    '90d': 90,
  };

  /**
   * Meta-metric names emitted by the rollup writer that represent
   * cross-cutting tenant totals (tokens through the LLM, USD spend) rather
   * than producer-service KPIs. They are folded into the drill-down rows
   * for every (date, service) cell and are NOT rendered as their own KPI
   * tiles.
   */
  const META_METRICS = new Set(['tokens', 'cost_usd']);

  /**
   * Service KPIs only — `tokens` / `cost_usd` come back as their own
   * KpiCards from the rollup query (one row per `metric_name`) but they
   * belong in the drill-down columns, not the headline tile grid.
   */
  const serviceKpis = $derived(
    analyticsStore.kpis.filter((k) => !META_METRICS.has(k.metric)),
  );

  /**
   * Derive (date, service) rows from the kpi sparklines. Each sparkline
   * value becomes one row; the date is reverse-projected from the page's
   * `last_tick_ts` using the window length divided by the bucket count.
   *
   * tokens + cost are sourced from the parallel `tokens` / `cost_usd`
   * KpiCards (cross-cutting tenant totals per bucket — they are not
   * tagged by producer service in the upstream metering counters). Each
   * service row at index `i` reads its tokens/cost from the meta-KPI's
   * sparkline at the same index, so a (date, service) row carries the
   * tenant's tokens/cost for that bucket. When the meta-KPI is missing
   * (legacy buckets, or upstream metering counters not yet emitting),
   * we surface NaN so the DrilldownTable's `fmt` helper renders "—".
   */
  function deriveDrilldown(kpis: KpiCardData[], lastTickIso: string | null): DrilldownRow[] {
    const rows: DrilldownRow[] = [];
    const tokensSpark = kpis.find((k) => k.metric === 'tokens')?.sparkline ?? null;
    const costSpark = kpis.find((k) => k.metric === 'cost_usd')?.sparkline ?? null;
    const lastTickMs = lastTickIso ? Date.parse(lastTickIso) : Date.now();
    const windowDays = WINDOW_DAYS[analyticsStore.window];
    for (const k of kpis) {
      if (META_METRICS.has(k.metric)) continue;
      const n = k.sparkline.length;
      if (n === 0) continue;
      const stepMs = (windowDays * 86_400_000) / Math.max(n, 1);
      for (let i = 0; i < n; i++) {
        const ts = lastTickMs - (n - 1 - i) * stepMs;
        const iso = new Date(ts).toISOString().slice(0, 10);
        // Align meta-KPI bucket position with the service KPI's by reverse
        // index from the END (most-recent bucket aligns first). Meta arrays
        // may be shorter/longer; we clamp and surface NaN for missing.
        const tokensVal = bucketAlignedFromTail(tokensSpark, n, i);
        const costVal = bucketAlignedFromTail(costSpark, n, i);
        rows.push({
          date: iso,
          service: k.metric,
          requests: k.sparkline[i] ?? 0,
          tokens: tokensVal,
          cost: costVal,
        });
      }
    }
    return rows;
  }

  /**
   * Read the meta-KPI bucket aligned to the service KPI's bucket `i` (out
   * of `n`). We align from the tail (most-recent bucket) so a meta series
   * of length `m < n` still yields the right number for the trailing
   * bucket. Returns NaN when the meta series is null or the position
   * predates the meta series — the table renders "—".
   */
  function bucketAlignedFromTail(meta: number[] | null, n: number, i: number): number {
    if (!meta || meta.length === 0) return NaN;
    const tailOffset = n - 1 - i;
    const idx = meta.length - 1 - tailOffset;
    if (idx < 0 || idx >= meta.length) return NaN;
    return meta[idx] ?? NaN;
  }

  const drilldownRows = $derived(
    deriveDrilldown(analyticsStore.kpis, analyticsStore.lastTick),
  );

  /** Available unique dates the user can click to scope the table. */
  const drilldownDates = $derived(
    Array.from(new Set(drilldownRows.map((r) => r.date))).sort(),
  );

  function pickFirstDate(): void {
    if (drilldownDates.length === 0) return;
    drilldownDate = drilldownDates[0]!;
  }

  function clearDrilldown(): void {
    drilldownDate = null;
  }
</script>

<div class="flex flex-col h-full" data-testid="analytics-page">
  <!-- Phase-7 T/I/OE lens. Self-contained + defensive: if /api/measure is
       absent or returns an unexpected shape, the band shows an empty state and
       the operator-analytics section below renders unchanged. -->
  <TioeBand />

  <header class="flex flex-wrap items-center gap-3 mb-4">
    <h2 class="text-lg font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Operator analytics</h2>

    <!-- Window picker -->
    <div class="inline-flex rounded border border-[var(--color-border-strong)] overflow-hidden text-sm dark:border-[var(--color-border-strong)]">
      {#each WINDOWS as w (w)}
        <button
          type="button"
          class="px-3 py-1 {analyticsStore.window === w ? 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] font-semibold' : 'bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:bg-[var(--color-surface)] dark:bg-[var(--color-surface)] dark:hover:bg-[var(--color-surface-strong)]'}"
          onclick={() => analyticsStore.setWindow(w)}
          data-testid="analytics-window-{w}"
        >
          {w}
        </button>
      {/each}
    </div>

    <!-- Initiator filter -->
    <select
      bind:value={initiatorFilter}
      onchange={applyInitiatorFilter}
      class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm dark:border-[var(--color-border-strong)]"
      data-testid="analytics-initiator-filter"
    >
      {#each INITIATORS as i (i)}
        <option value={i}>{i}</option>
      {/each}
    </select>

    <!-- Project filter -->
    <input
      type="text"
      bind:value={projectFilter}
      onchange={applyProjectFilter}
      placeholder="Project ID (optional)"
      class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm font-mono w-72 dark:border-[var(--color-border-strong)]"
      data-testid="analytics-project-filter"
    />

    <!-- Plan-4 Lane B: compare to previous period toggle -->
    <label class="inline-flex items-center gap-1.5 text-sm text-[var(--color-text)] dark:text-[var(--color-text-muted)]">
      <input
        type="checkbox"
        checked={analyticsStore.compare}
        onchange={toggleCompare}
        class="accent-blue-600"
        data-testid="analytics-compare-toggle"
      />
      vs previous period
    </label>

    <span class="ml-auto text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      Last tick: {fmtTick(analyticsStore.lastTick)}
      {#if analyticsStore.stale}
        <span class="ml-2 px-2 py-0.5 bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] rounded text-xs font-medium">
          stale
        </span>
      {/if}
    </span>

    <a
      href={exportUrl()}
      class="px-3 py-1 bg-[var(--color-surface)] text-[var(--color-text)] text-sm rounded hover:bg-[var(--color-surface-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
      data-testid="analytics-export-csv"
    >
      Export CSV
    </a>

    <button
      type="button"
      onclick={() => analyticsStore.refresh()}
      disabled={analyticsStore.loading}
      class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      data-testid="analytics-refresh"
    >
      {analyticsStore.loading ? '…' : 'Refresh'}
    </button>
  </header>

  {#if analyticsStore.error}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4">
      {analyticsStore.error}
    </div>
  {/if}

  {#if serviceKpis.length === 0 && !analyticsStore.loading}
    <!-- Spec §9.5 — zero-data path -->
    <p class="text-sm text-[var(--color-text-muted)] mt-8 text-center dark:text-[var(--color-text-muted)]">
      No analytics data for this window yet. The rollup worker writes new
      buckets every 5 minutes; activity from the
      <a href="/library/kag/documents" class="text-[var(--color-accent)] underline">KAG</a>,
      <a href="/executions/n8n" class="text-[var(--color-accent)] underline">n8n</a>, or
      coding-analysis surfaces will populate KPIs here.
    </p>
  {:else}
    <div class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3" data-testid="analytics-kpi-grid">
      {#each serviceKpis as kpi (kpi.metric)}
        {@const prior = priorTotal(kpi.metric)}
        {@const pct = deltaPct(kpi.value, prior)}
        {@const priorSpark = priorSeries(kpi.metric)}
        <div class="flex flex-col gap-1" data-testid="analytics-kpi-tile">
          <KpiCard title={kpi.metric} value={kpi.value} sparkline={kpi.sparkline} />
          {#if analyticsStore.compare}
            <div class="flex items-center gap-2 px-1 text-xs">
              <span class={deltaClass(pct)} data-testid="analytics-delta">
                {pct === null ? 'no prior data' : fmtDelta(pct)}
              </span>
              {#if priorSpark}
                <span class="opacity-60" title="previous period">
                  <Sparkline values={priorSpark} color="var(--color-text-muted)" />
                </span>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>

    <!-- Plan-4 Lane B: drill-down -->
    <section class="mt-4">
      {#if drilldownDates.length > 1}
        <div class="flex items-center gap-2 text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)] mb-2">
          <span>Filter by bucket:</span>
          <select
            bind:value={drilldownDate}
            class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs dark:border-[var(--color-border-strong)]"
            data-testid="analytics-drilldown-date-picker"
          >
            <option value={null}>All buckets</option>
            {#each drilldownDates as d (d)}
              <option value={d}>{d}</option>
            {/each}
          </select>
          {#if drilldownDate === null}
            <button
              type="button"
              class="text-[var(--color-accent)] underline"
              onclick={pickFirstDate}
              data-testid="analytics-drilldown-pick-first"
            >
              jump to first bucket
            </button>
          {/if}
        </div>
      {/if}
      <DrilldownTable
        rows={drilldownRows}
        dateFilter={drilldownDate}
        onClearFilter={clearDrilldown}
      />
    </section>

    <!-- Plan-4 Lane B: per-channel notification volumes -->
    <section class="mt-4">
      <PerChannelBars
        channels={analyticsStore.channels}
        unavailable={analyticsStore.perChannelError}
      />
    </section>
  {/if}
</div>
