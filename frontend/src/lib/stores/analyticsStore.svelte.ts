// src/lib/stores/analyticsStore.svelte.ts
//
// Wave-3 analytics store — singleton rune-backed state for the
// /tools/analytics page.
// Spec: docs/superpowers/specs/completed/2026-04-24-analytics-page.md §9.4.
//
// - Polls `GET /api/tools/analytics/summary` every 30s (spec §6.6).
// - In-flight requests are aborted (`AbortController`) when filters change.
// - Exposes `summary`, `loading`, `error`, `lastTick`, `stale`, `lastUpdated`.

import { authFetch } from '$lib/api/auth-fetch';

export type Window = '24h' | '7d' | '30d' | '90d';

export interface KpiCard {
  metric: string;
  value: number;
  sparkline: number[];
}

export interface SummaryResponse {
  data: {
    window: Window;
    project_id: string | null;
    kpis: KpiCard[];
    /** Plan-4 Lane B: prior-window kpis when compare=prev. */
    previous?: { kpis: KpiCard[] } | null;
  };
  meta: {
    last_tick_ts: string | null;
    stale: boolean;
    last_outcome: string | null;
  };
}

export interface ChannelDatum {
  kind: string;
  sends: number;
}

export interface PerChannelResponse {
  data: { channels: ChannelDatum[] };
  meta: { window: Window; row_count: number };
}

const DEFAULT_POLL_MS = 30_000;

class AnalyticsStore {
  // Reactive state
  summary = $state<SummaryResponse | null>(null);
  perChannel = $state<PerChannelResponse | null>(null);
  /**
   * Why the per-channel read produced no data — null ONLY when it succeeded.
   *
   * `perChannel = null` on its own is indistinguishable from a window in which
   * nothing was dispatched, and `PerChannelBars` renders exactly that: "No
   * notifications dispatched in this window." plus a "0 channels" count. A 502
   * from the route therefore told an operator that zero notifications were sent
   * — a confident, wrong operational claim. Keeping the reason lets the panel
   * say the read failed instead. The summary half is untouched: a per-channel
   * failure must not blank KPIs that did load.
   */
  perChannelError = $state<string | null>(null);
  loading = $state(false);
  error = $state<string | null>(null);
  lastUpdated = $state<number | null>(null);
  window = $state<Window>('7d');
  projectId = $state<string | null>(null);
  initiator = $state<string | null>(null);
  channel = $state<string | null>(null);
  /** Plan-4 Lane B: when true, request `?compare=prev` on summary fetches. */
  compare = $state(false);

  // Internal state
  private timer: ReturnType<typeof setInterval> | null = null;
  private currentAbort: AbortController | null = null;
  private started = false;

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.refresh();
    this.timer = setInterval(() => {
      void this.refresh();
    }, DEFAULT_POLL_MS);
  }

  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.currentAbort) {
      this.currentAbort.abort();
      this.currentAbort = null;
    }
    this.started = false;
  }

  // -------------------------------------------------------------------------
  // Filter setters — each cancels any in-flight request before re-polling.
  // -------------------------------------------------------------------------

  setWindow(w: Window): void {
    if (this.window === w) return;
    this.window = w;
    void this.refresh();
  }

  setProjectId(id: string | null): void {
    if (this.projectId === id) return;
    this.projectId = id;
    void this.refresh();
  }

  setInitiator(v: string | null): void {
    if (this.initiator === v) return;
    this.initiator = v;
    void this.refresh();
  }

  setChannel(v: string | null): void {
    if (this.channel === v) return;
    this.channel = v;
    void this.refresh();
  }

  setCompare(v: boolean): void {
    if (this.compare === v) return;
    this.compare = v;
    void this.refresh();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildUrl(): string {
    const params = new URLSearchParams();
    params.set('window', this.window);
    if (this.projectId) params.set('project_id', this.projectId);
    if (this.initiator) params.set('initiator', this.initiator);
    if (this.channel) params.set('channel', this.channel);
    if (this.compare) params.set('compare', 'prev');
    return `/api/tools/analytics/summary?${params.toString()}`;
  }

  private buildPerChannelUrl(): string {
    const params = new URLSearchParams();
    params.set('window', this.window);
    if (this.projectId) params.set('project_id', this.projectId);
    return `/api/tools/analytics/per-channel?${params.toString()}`;
  }

  async refresh(): Promise<void> {
    // Abort any in-flight refresh — filter just changed or new tick fired.
    if (this.currentAbort) {
      this.currentAbort.abort();
    }
    const ac = new AbortController();
    this.currentAbort = ac;

    this.loading = true;
    try {
      const [summaryResp, perChanResp] = await Promise.all([
        authFetch(this.buildUrl(), { signal: ac.signal }),
        authFetch(this.buildPerChannelUrl(), { signal: ac.signal }),
      ]);
      if (!summaryResp.ok) {
        const text = await safeText(summaryResp);
        throw new Error(`analytics.summary failed: ${summaryResp.status} ${text}`);
      }
      const json = (await summaryResp.json()) as SummaryResponse;
      this.summary = json;
      // per-channel is best-effort for RENDERING — a failure here must not
      // blank the KPIs that did load — but it is not best-effort for TRUTH:
      // every non-success path records why, so the panel can say "unreadable"
      // instead of "no notifications dispatched".
      if (perChanResp.ok) {
        try {
          this.perChannel = (await perChanResp.json()) as PerChannelResponse;
          this.perChannelError = null;
        } catch (e) {
          this.perChannel = null;
          this.perChannelError = `analytics.per-channel: unreadable response body (${
            e instanceof Error ? e.message : String(e)
          })`;
        }
      } else {
        this.perChannel = null;
        this.perChannelError = `analytics.per-channel failed: ${
          perChanResp.status
        } ${await safeText(perChanResp)}`;
      }
      this.lastUpdated = Date.now();
      this.error = null;
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      this.error = err instanceof Error ? err.message : String(err);
    } finally {
      this.loading = false;
      if (this.currentAbort === ac) this.currentAbort = null;
    }
  }

  // Derived
  get stale(): boolean {
    return this.summary?.meta.stale ?? false;
  }

  get lastTick(): string | null {
    return this.summary?.meta.last_tick_ts ?? null;
  }

  get kpis(): KpiCard[] {
    return this.summary?.data.kpis ?? [];
  }

  get previousKpis(): KpiCard[] | null {
    return this.summary?.data.previous?.kpis ?? null;
  }

  get channels(): ChannelDatum[] {
    return this.perChannel?.data.channels ?? [];
  }
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '';
  }
}

export { AnalyticsStore };

export const analyticsStore = new AnalyticsStore();
