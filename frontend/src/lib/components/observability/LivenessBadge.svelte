<!--
  observability/LivenessBadge.svelte

  REST-polled compact pill for kanban WS liveness. Polls
  `/api/tools/kanban/liveness` (the `kanban.verify_liveness` action exposed
  via the tools API) every 30s and renders a small "live" / "idle" indicator.

  Click → fires the `onclick` callback (typically: open ActivityTray).

  Sibling — NOT a replacement — to `frontend/src/lib/components/LivenessBadge.svelte`,
  which is the older WS-heartbeat-driven badge wired into kanban itself. The
  WS variant needs a live socket; this REST variant works on any page (login,
  projects, tools, etc.) without owning a socket.

  ⚠️ SAME NAME, SAME VISUAL LANGUAGE, DIFFERENT SUBJECT. This badge reports
  fr's SERVER-SIDE kanban WebSocket subscriber pool (how many clients are
  attached, and the worst lag among them). The sibling reports THIS browser
  tab's own socket. On /kanban both render at once, and in 2026-09 they sat
  side by side reading "Live" (here) and "Connecting" (there) with nothing on
  screen saying they measured different things. Neither was wrong; the LABELS
  were. ⛔ Do not "reconcile" the two by changing either one's value logic —
  the fix is that each says what it measures. `wsLabel` is the visible half of
  that here, and its DEFAULT is load-bearing: TopNav.svelte mounts this
  component without passing it.

  Plan: docs/superpowers/plans/completed/2026-04-25-n8n-observability-implementation.md
    §"Open follow-ups" — global ActivityTray / LivenessBadge mount.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import {
    snapshotToBadgeView,
    type KanbanLivenessSnapshot,
    type BadgeView,
  } from './livenessLogic';

  let {
    onclick,
    pollIntervalMs = 30_000,
    wsLabel = 'Kanban WS pool (server-side)',
    scopePrefix = '',
  }: {
    onclick?: () => void;
    pollIntervalMs?: number;
    wsLabel?: string;
    /**
     * Optional VISIBLE scope in front of the state word. FR-PROJECT-HOME-REDESIGN
     * D2: inside a project a bare "Idle" read as that project's state, while
     * this badge measures the server-wide board-update pool. The project header
     * passes "Board updates (all projects)"; empty keeps the bare word.
     */
    scopePrefix?: string;
  } = $props();

  let snapshot: KanbanLivenessSnapshot | null = $state(null);
  let loading = $state(false);
  let errorMessage: string | null = $state(null);
  let timer: ReturnType<typeof setInterval> | null = null;

  async function fetchOnce(): Promise<void> {
    loading = true;
    try {
      const resp = await authFetch('/api/tools/kanban/liveness');
      if (!resp.ok) {
        errorMessage = `HTTP ${resp.status}`;
        snapshot = null;
        return;
      }
      const json = (await resp.json()) as { data?: KanbanLivenessSnapshot };
      snapshot = json?.data ?? null;
      errorMessage = null;
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : 'fetch failed';
      snapshot = null;
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void fetchOnce();
    timer = setInterval(() => {
      void fetchOnce();
    }, pollIntervalMs);
    return () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
  });

  let view: BadgeView = $derived(snapshotToBadgeView(snapshot));

  function badgeClass(bucket: BadgeView['bucket']): string {
    return bucket === 'live'
      ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)]'
      : 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)]';
  }

  function dotClass(bucket: BadgeView['bucket']): string {
    return bucket === 'live' ? 'bg-[var(--color-success)] animate-pulse' : 'bg-[var(--color-surface-strong)]';
  }
</script>

<button
  type="button"
  onclick={() => onclick?.()}
  class="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-full border text-xs font-medium hover:opacity-90 disabled:cursor-default {badgeClass(view.bucket)}"
  data-testid="observability-liveness-badge"
  data-status={view.rawStatus}
  data-bucket={view.bucket}
  data-subject="server-subscriber-pool"
  title={errorMessage
    ? `${wsLabel} liveness probe failed: ${errorMessage}. Reports fr's server-side kanban WebSocket subscriber pool across all clients (REST-polled every ${Math.round(pollIntervalMs / 1000)}s), not this tab's own board connection.`
    : `${wsLabel} — ${view.label} (${view.subscriberCount} subscriber${view.subscriberCount === 1 ? '' : 's'}, max lag ${view.maxLagSeconds}s). Reports fr's server-side kanban WebSocket subscriber pool across all clients (REST-polled every ${Math.round(pollIntervalMs / 1000)}s), not this tab's own board connection.`}
  aria-label={`Open activity tray — ${wsLabel}: ${view.label}`}
>
  <span class="inline-block w-2 h-2 rounded-full {dotClass(view.bucket)}"></span>
  <span data-testid="observability-liveness-label"
    >{scopePrefix ? `${scopePrefix}: ` : ''}{loading && snapshot === null ? '…' : view.label}</span
  >
</button>
