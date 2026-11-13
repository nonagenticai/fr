<!--
  observability/ActivityTray.svelte

  Slide-out right-side panel showing:
    - Top: kanban LivenessPill + "n executions in last hour" summary
    - List: last 20 n8n executions (via `listExecutions({ limit: 20 })`)
    - "View all" link to /tools/n8n
    - Manual refresh button + auto-refresh every 30s while open
    - Close button + ESC-key dismiss

  Sibling to `frontend/src/lib/components/ActivityTray.svelte` (which is the
  older bottom-right floating launcher). This variant is driven by the
  layout's `open` $state and renders as a full-height slide-out drawer.

  Plan: docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
    §"Open follow-ups" — global ActivityTray + LivenessBadge mount.
-->
<script lang="ts">
  import { onMount, untrack } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { listExecutions, type ScopedExecution } from '$lib/api/n8n';
  import { ExecutionRow, LivenessPill } from './';
  import {
    snapshotToBadgeView,
    unreadableBadgeView,
    countWithinLastMs,
    type KanbanLivenessSnapshot,
  } from './livenessLogic';

  let {
    open = $bindable(false),
    pollIntervalMs = 30_000,
  }: {
    open?: boolean;
    pollIntervalMs?: number;
  } = $props();

  let snapshot: KanbanLivenessSnapshot | null = $state(null);
  /**
   * The liveness read itself failed (non-2xx or a thrown fetch).
   *
   * ⚠️ This is the andon defect. `snapshot = null` was BOTH "the pool reported
   * nothing" and "we could not ask", and `snapshotToBadgeView(null)` turned the
   * second into a pill reading "Unknown · 0 subs" with a tooltip asserting
   * "0 subscribers, max lag 0s" — a measurement of a read that never happened.
   * A tray whose whole job is to say whether the system is alive must not be
   * quietest when it is blind, so the failed read gets its own state and its own
   * pixels. This is the per-input flag idiom (`kaizen_available`,
   * `projectsUnreadable`), not a blank: the executions list beside it is read
   * from a different endpoint and still renders.
   */
  let snapshotUnreadable: string | null = $state(null);
  let executions: ScopedExecution[] = $state([]);
  let loading = $state(false);
  let errorMessage: string | null = $state(null);
  let lastUpdated: number | null = $state(null);
  let pollTimer: ReturnType<typeof setInterval> | null = null;
  let now = $state(Date.now());
  let nowTimer: ReturnType<typeof setInterval> | null = null;

  async function fetchSnapshot(): Promise<void> {
    try {
      const resp = await authFetch('/api/tools/kanban/liveness');
      if (!resp.ok) {
        snapshot = null;
        snapshotUnreadable = `liveness read failed (${resp.status})`;
        return;
      }
      const json = (await resp.json()) as { data?: KanbanLivenessSnapshot };
      snapshot = json?.data ?? null;
      // A 200 with no `data` IS a measurement ("nothing subscribed"); only the
      // two failure paths above and below are unreadable.
      snapshotUnreadable = null;
    } catch (err) {
      snapshot = null;
      snapshotUnreadable = err instanceof Error ? err.message : 'liveness read failed';
    }
  }

  async function fetchExecutions(): Promise<void> {
    try {
      const r = await listExecutions({ limit: 20 });
      executions = r.data;
      errorMessage = null;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'fetch failed';
    }
  }

  async function refresh(): Promise<void> {
    if (loading) return;
    loading = true;
    try {
      await Promise.all([fetchSnapshot(), fetchExecutions()]);
      lastUpdated = Date.now();
    } finally {
      loading = false;
    }
  }

  function close(): void {
    open = false;
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' && open) {
      e.preventDefault();
      close();
    }
  }

  onMount(() => {
    nowTimer = setInterval(() => {
      now = Date.now();
    }, 1000);
    return () => {
      if (pollTimer !== null) clearInterval(pollTimer);
      if (nowTimer !== null) clearInterval(nowTimer);
      pollTimer = null;
      nowTimer = null;
    };
  });

  // Manage the auto-refresh poll based on `open`.
  //
  // ⚠️ THE BODY RUNS UNTRACKED, DELIBERATELY. `refresh()` READS `loading` (its
  // re-entrancy guard) and then WRITES it, twice, in the same run. When that
  // happened inside the effect's tracking scope every settle re-dirtied the
  // effect, which called `refresh()` again — a self-feeding loop. Svelte's
  // `effect_update_depth_exceeded` guard never trips on it because the re-entry
  // crosses a MICROTASK boundary rather than one synchronous flush, so nothing
  // reports it. Measured on the un-fixed code: 1,674 refreshes in 3s of
  // browser-shaped I/O (~1,100 req/s against `/api/tools/kanban/liveness` and
  // n8n) with `pollIntervalMs = 10_000_000` — the 30s poll was fiction — and
  // under jsdom 368,800 `listExecutions` calls in 60s with the macrotask queue
  // starved so hard a `setTimeout(…, 0)` never ran and `--testTimeout` could
  // not fire.
  //
  // `open` and `pollIntervalMs` are read OUTSIDE `untrack` and are therefore
  // still the effect's only dependencies: toggling the tray still starts and
  // stops the poll. Untracking the whole thing (including those reads) would
  // break that, which is why they are lifted into locals first.
  $effect(() => {
    const isOpen = open;
    const everyMs = pollIntervalMs;
    untrack(() => {
      if (isOpen) {
        void refresh();
        if (pollTimer === null) {
          pollTimer = setInterval(() => {
            void refresh();
          }, everyMs);
        }
      } else if (pollTimer !== null) {
        clearInterval(pollTimer);
        pollTimer = null;
      }
    });
  });

  let badgeView = $derived(
    snapshotUnreadable !== null ? unreadableBadgeView() : snapshotToBadgeView(snapshot),
  );
  let lastHourCount = $derived(countWithinLastMs(executions, now, 60 * 60 * 1000));

  function statusKey(status: string | undefined): string {
    const v = (status ?? '').toLowerCase();
    if (v === 'running' || v === 'new') return 'running';
    if (v === 'waiting') return 'waiting';
    if (v === 'success') return 'success';
    if (v === 'error' || v === 'crashed') return 'error';
    if (v === 'canceled') return 'idle';
    return 'unknown';
  }

  function rowName(ex: ScopedExecution): string {
    return ex.workflow_id ? `${ex.workflow_id} · ${ex.id}` : ex.id;
  }
</script>

<svelte:window onkeydown={onKey} />

{#if open}
  <!-- Backdrop -->
  <button
    type="button"
    aria-label="Close activity tray"
    class="fixed inset-0 bg-[var(--color-bg)]/30 z-40"
    onclick={close}
    data-testid="activity-tray-backdrop"
  ></button>

  <!-- Slide-out panel -->
  <aside
    class="fixed right-0 top-0 bottom-0 w-96 max-w-[90vw] bg-[var(--color-bg)] border-l border-[var(--color-border)] shadow-xl z-50 flex flex-col dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
    data-testid="observability-activity-tray"
    aria-label="Activity tray"
  >
    <header class="flex items-center justify-between px-4 py-3 border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
      <div class="flex items-center gap-3">
        <h3 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Activity</h3>
        {#if snapshotUnreadable !== null}
          <!-- Not the pill: the pill's tooltip asserts a subscriber count and a
               lag, and we have neither. Say so instead of printing zeros. -->
          <span
            class="inline-flex items-center gap-1.5 rounded-full border border-[var(--color-warning-text)] px-2 py-0.5 text-xs font-medium text-[var(--color-warning-text)]"
            data-testid="liveness-unreadable"
            title={`Kanban WS liveness could not be read — ${snapshotUnreadable}. Subscriber count and lag are UNKNOWN, not zero.`}
          >
            <span class="inline-block h-2 w-2 rounded-full bg-[var(--color-warning-text)]"></span>
            Liveness unreadable
          </span>
        {:else}
          <LivenessPill
            status={badgeView.rawStatus}
            subscriberCount={badgeView.subscriberCount}
            maxLagSeconds={badgeView.maxLagSeconds}
          />
        {/if}
      </div>
      <div class="flex items-center gap-1">
        <button
          type="button"
          onclick={() => void refresh()}
          disabled={loading}
          class="text-xs px-2 py-1 rounded border border-[var(--color-border-strong)] hover:bg-[var(--color-surface)] disabled:opacity-50 dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
          data-testid="activity-tray-refresh"
          aria-label="Refresh activity"
        >
          {loading ? '…' : 'Refresh'}
        </button>
        <button
          type="button"
          onclick={close}
          class="text-[var(--color-text-muted)] hover:text-[var(--color-text)] px-2 py-1 dark:text-[var(--color-text-muted)]"
          data-testid="activity-tray-close"
          aria-label="Close"
        >
          ✕
        </button>
      </div>
    </header>

    <div class="px-4 py-2 text-xs text-[var(--color-text)] border-b border-[var(--color-border)] flex items-center justify-between dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)]">
      <span>
        {lastHourCount} execution{lastHourCount === 1 ? '' : 's'} in last hour
      </span>
      {#if lastUpdated !== null}
        <span class="tabular-nums">
          updated {new Date(lastUpdated).toLocaleTimeString()}
        </span>
      {/if}
    </div>

    {#if errorMessage}
      <div class="m-3 px-2 py-1 text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded dark:text-[var(--color-danger-text)] dark:bg-[var(--color-danger-bg)]/20">
        {errorMessage}
      </div>
    {/if}

    <div class="flex-1 overflow-y-auto px-2 py-2" data-testid="activity-tray-list">
      {#if executions.length === 0 && !loading}
        <p class="text-xs italic text-[var(--color-text-muted)] px-2 py-3 dark:text-[var(--color-text-muted)]">No executions visible.</p>
      {:else}
        <ul class="divide-y divide-[var(--color-border)] dark:divide-[var(--color-border-strong)]">
          {#each executions as ex (ex.id)}
            <li class="px-2">
              <ExecutionRow
                status={statusKey(ex.status)}
                name={rowName(ex)}
                durationMs={ex.duration_ms}
                startedAt={ex.started_at}
              />
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <footer class="px-4 py-3 border-t border-[var(--color-border)] text-right dark:border-[var(--color-border)]">
      <a
        href="/executions/n8n"
        class="text-xs text-[var(--color-accent)] hover:underline"
        data-testid="activity-tray-view-all"
        onclick={close}
      >
        View all →
      </a>
    </footer>
  </aside>
{/if}
