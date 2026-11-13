// src/lib/stores/activityStore.svelte.ts
//
// Activity store — singleton rune-backed store for the n8n-execution
// observability surface. Polls `GET /api/tools/n8n/executions` every
// 15s (Wave 2 namespace alignment — was `/api/tools/activity/executions`)
// and exposes:
//   - `executions`        : full set returned by the most recent poll
//   - `inFlight`          : derived view (running/waiting) sorted newest-first
//   - `topInFlight(n)`    : derived helper used by the ActivityTray
//   - `loading`           : true while a refresh is in flight
//   - `error`             : last error message, if any
//   - `lastUpdated`       : ms-since-epoch of the last successful poll
//
// Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
//   §"Frontend"  — bespoke page polls every 15s + ActivityTray top-3 view
//   §"Telemetry / Idempotency" — reads are dedupe-safe

import { authFetch } from '$lib/api/auth-fetch';

export type ExecutionStatus =
  | 'running'
  | 'waiting'
  | 'success'
  | 'error'
  | 'canceled'
  | 'crashed'
  | string;

export interface ActivityExecution {
  id: string;
  workflow_id: string | null | undefined;
  status: ExecutionStatus | undefined;
  mode: string | undefined;
  started_at: string | undefined;
  stopped_at: string | undefined;
  duration_ms: number | undefined;
  project_id: string;
  initiated_via: string;
  correlation_id: string;
  trace_url: string | null;
}

export interface ActivityListResponse {
  data: ActivityExecution[];
  meta: { cursor: string | null; hasMore: boolean };
}

const DEFAULT_INTERVAL_MS = 15_000;
/**
 * Ceiling for the backed-off cadence. A dead upstream gets polled every 2min
 * instead of every 15s — an 8x reduction in both request volume and console
 * noise, while still recovering on its own within ~2min of the upstream
 * returning.
 */
const DEFAULT_MAX_INTERVAL_MS = 120_000;
const IN_FLIGHT_STATUSES = new Set<string>(['running', 'waiting', 'new']);

class ActivityStore {
  // Public reactive state
  executions = $state<ActivityExecution[]>([]);
  loading = $state(false);
  error = $state<string | null>(null);
  lastUpdated = $state<number | null>(null);
  /** Optional project-scope filter applied to the upstream query. */
  projectId = $state<string | null>(null);

  private readonly intervalMs = DEFAULT_INTERVAL_MS;

  // Internal lifecycle
  private timer: ReturnType<typeof setInterval> | null = null;
  private inflightRefresh: Promise<void> | null = null;
  private started = false;

  // Failure backoff.
  //
  // This tray polls n8n every 15s from every open tab. n8n runs a single
  // replica with `strategy: Recreate`, so every rollout is a hard outage
  // window — measured 2026-08-26, it rolled 9+ times in one day and each roll
  // produced a burst of 502s in the user's console. The old loop had no
  // failure counter at all: it hammered the dead upstream at full rate,
  // forever, and reported every attempt to the console.
  //
  // Backoff is implemented by SKIPPING ticks rather than by re-arming the
  // timer, so the interval itself never changes. Effective wait is
  // `intervalMs * 2^failureStreak`, capped — the same curve as
  // `lib/net/poll.ts`'s `computeWait`.
  private readonly maxIntervalMs = DEFAULT_MAX_INTERVAL_MS;
  private failureStreak = 0;
  private ticksToSkip = 0;

  // -------------------------------------------------------------------------
  // Derived getters (called from .svelte components — keep these as plain
  // method-style getters so consumers can write `activityStore.inFlight`).
  // -------------------------------------------------------------------------

  get inFlight(): ActivityExecution[] {
    return this.executions
      .filter((e) => IN_FLIGHT_STATUSES.has((e.status ?? '').toLowerCase()))
      .slice()
      .sort((a, b) => sortDesc(a.started_at, b.started_at));
  }

  topInFlight(n: number): ActivityExecution[] {
    return this.inFlight.slice(0, Math.max(0, n));
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  /** Start polling. Idempotent — calling twice is a no-op. */
  start(): void {
    if (this.started) return;
    this.started = true;
    // Kick off an immediate refresh so the UI doesn't sit empty for 15s.
    void this.refresh();
    // Interval ticks call doRefresh directly so a still-pending pointer from
    // the previous tick does not dedup-skip the next poll. The refresh()
    // dedup is for manual UI calls (e.g. a refresh-button mash).
    this.timer = setInterval(() => {
      this.onTick();
    }, this.intervalMs);
  }

  /** Stop polling. Safe to call when not started. */
  stop(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.started = false;
    // A fresh start() must not inherit a previous run's penalty.
    this.failureStreak = 0;
    this.ticksToSkip = 0;
  }

  /** Manual refresh — dedup'd against any in-flight poll. */
  async refresh(): Promise<void> {
    if (this.inflightRefresh) {
      return this.inflightRefresh;
    }
    this.inflightRefresh = this.doRefresh();
    try {
      await this.inflightRefresh;
    } finally {
      this.inflightRefresh = null;
    }
  }

  /** Update the project filter and re-poll (does not change cadence). */
  setProjectId(projectId: string | null): void {
    if (this.projectId === projectId) return;
    this.projectId = projectId;
    void this.refresh();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * One interval tick. Swallows the tick entirely while backing off, so the
   * base cadence stays 15s for the fast path and only the FAILING path slows.
   */
  private onTick(): void {
    if (this.ticksToSkip > 0) {
      this.ticksToSkip -= 1;
      return;
    }
    void this.doRefresh();
  }

  /**
   * Ticks to skip after `failureStreak` consecutive failures, so the effective
   * wait is `intervalMs * 2^streak` capped at `maxIntervalMs`. Returns 0 for a
   * healthy stream, which is what keeps the happy path at full cadence.
   */
  private backoffTicks(): number {
    if (this.failureStreak <= 0) return 0;
    const maxTicks = Math.max(1, Math.floor(this.maxIntervalMs / this.intervalMs));
    const wantTicks = Math.min(2 ** this.failureStreak, maxTicks);
    return wantTicks - 1;
  }

  /** Manual refresh is never throttled — reset the penalty. */
  private noteSuccess(): void {
    this.failureStreak = 0;
    this.ticksToSkip = 0;
  }

  private noteFailure(): void {
    // Cap the streak so `2 ** streak` cannot overflow on a long outage.
    this.failureStreak = Math.min(this.failureStreak + 1, 16);
    this.ticksToSkip = this.backoffTicks();
  }

  private buildUrl(): string {
    const params = new URLSearchParams();
    // 25, not 100: on the customer path each row costs the backend one n8n call and it clamps to 25 (fr#1322).
    params.set('limit', '25');
    if (this.projectId) params.set('projectId', this.projectId);
    return `/api/tools/n8n/executions?${params.toString()}`;
  }

  private async doRefresh(): Promise<void> {
    this.loading = true;
    try {
      const resp = await authFetch(this.buildUrl());
      if (!resp.ok) {
        const text = await safeText(resp);
        throw new Error(
          `activity.list failed: ${resp.status} ${resp.statusText}${text ? ` — ${text}` : ''}`,
        );
      }
      const json = (await resp.json()) as ActivityListResponse;
      this.executions = Array.isArray(json?.data) ? json.data : [];
      this.lastUpdated = Date.now();
      this.error = null;
      this.noteSuccess();
    } catch (err) {
      this.error = err instanceof Error ? err.message : String(err);
      // The error is swallowed into `this.error` for the UI (it must not
      // reject and blow up the caller), so the scheduler is told separately.
      // Without this the backoff would be dead code.
      this.noteFailure();
    } finally {
      this.loading = false;
    }
  }
}

function sortDesc(a: string | undefined, b: string | undefined): number {
  const av = a ? Date.parse(a) : 0;
  const bv = b ? Date.parse(b) : 0;
  return (Number.isFinite(bv) ? bv : 0) - (Number.isFinite(av) ? av : 0);
}

async function safeText(resp: Response): Promise<string> {
  try {
    return (await resp.text()).slice(0, 200);
  } catch {
    return '';
  }
}

export { ActivityStore };

export const activityStore = new ActivityStore();
