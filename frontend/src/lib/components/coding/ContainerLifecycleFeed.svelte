<!--
  ContainerLifecycleFeed.svelte

  Live container-lifecycle status, fed by coding-realtime broadcasts (the
  consumer of the D9 publish endpoint + D2 cross-replica fan-out). Presentational
  only — the parent passes the derived current status + the recent-event list.
  No page wires a broadcast socket today (the unused CodingBroadcastSocket client
  was removed); keeping any socket out of the component keeps the status/label
  derivation (describeLifecycleStatus) unit-testable in node.

  Honesty rule: before any event arrives we render an explicit "waiting" state,
  never a fabricated "running". An `error` status is muted-danger, not silent.
-->
<script lang="ts" module>
  export interface LifecycleEvent {
    /** e.g. container_started | container_stopped | container_health */
    eventType: string;
    /** e.g. creating | running | stopped | error (from the broadcast payload) */
    status: string;
    /** ISO timestamp. */
    timestamp: string;
    /** Optional human detail (error_message, etc.). */
    detail?: string;
  }

  export interface LifecycleStatusView {
    label: string;
    tone: 'success' | 'danger' | 'warning' | 'muted';
  }

  // Pure. Maps the latest lifecycle status string to a labelled tone. Unknown /
  // absent status is muted ("—"/"Waiting"), never a fabricated healthy state.
  export function describeLifecycleStatus(status: string | null): LifecycleStatusView {
    switch (status) {
      case 'running':
        return { label: 'RUNNING', tone: 'success' };
      case 'creating':
        return { label: 'CREATING', tone: 'warning' };
      case 'stopped':
        return { label: 'STOPPED', tone: 'muted' };
      case 'error':
        return { label: 'ERROR', tone: 'danger' };
      default:
        return { label: status ? status.toUpperCase() : 'WAITING', tone: 'muted' };
    }
  }
</script>

<script lang="ts">
  interface Props {
    /** Current status (latest broadcast payload status), or null before any. */
    status?: string | null;
    /** Recent lifecycle events, newest first. */
    events?: LifecycleEvent[];
    /** True while the broadcast socket is connected. */
    connected?: boolean;
  }
  let { status = null, events = [], connected = false }: Props = $props();

  let view = $derived(describeLifecycleStatus(status));

  function toneClass(tone: LifecycleStatusView['tone']): string {
    switch (tone) {
      case 'success':
        return 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]';
      case 'danger':
        return 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]';
      case 'warning':
        return 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
      default:
        return 'bg-[var(--color-surface)] text-[var(--color-text-muted)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]';
    }
  }
</script>

<div
  class="bg-[var(--color-bg)] rounded-lg shadow p-6 dark:bg-[var(--color-surface)]"
  data-testid="container-lifecycle-feed"
>
  <div class="flex items-center justify-between mb-4 gap-4 flex-wrap">
    <h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">
      Container Lifecycle
    </h2>
    <span
      class="inline-block px-4 py-2 rounded-full text-sm font-medium {toneClass(view.tone)}"
      data-testid="lifecycle-status"
    >
      {view.label}
    </span>
  </div>

  {#if !connected}
    <p class="text-sm text-[var(--color-text-muted)] mb-4" data-testid="lifecycle-disconnected">
      Not connected to the live lifecycle stream.
    </p>
  {/if}

  {#if events.length === 0}
    <p
      class="text-[var(--color-text-muted)] text-center py-8 dark:text-[var(--color-text-muted)]"
      data-testid="lifecycle-empty"
    >
      No lifecycle events yet — provisioning activity will appear here in real time.
    </p>
  {:else}
    <ul class="space-y-2" data-testid="lifecycle-events">
      {#each events as ev}
        <li
          class="flex items-center justify-between p-3 border border-[var(--color-border)] rounded-lg dark:border-[var(--color-border)]"
          data-testid="lifecycle-event"
        >
          <span class="flex items-center gap-3 min-w-0">
            <span class="text-lg" aria-hidden="true">
              {ev.status === 'running'
                ? '✅'
                : ev.status === 'error'
                  ? '❌'
                  : ev.status === 'creating'
                    ? '⏳'
                    : '•'}
            </span>
            <span class="min-w-0">
              <span class="font-medium text-[var(--color-text)] dark:text-[var(--color-text)]"
                >{ev.eventType}</span
              >
              <span class="text-sm text-[var(--color-text-muted)]"> — {ev.status}</span>
              {#if ev.detail}
                <span
                  class="block text-xs text-[var(--color-text-muted)] truncate dark:text-[var(--color-text-muted)]"
                  >{ev.detail}</span
                >
              {/if}
            </span>
          </span>
          <span class="text-xs text-[var(--color-text-muted)] whitespace-nowrap ml-3"
            >{ev.timestamp}</span
          >
        </li>
      {/each}
    </ul>
  {/if}
</div>
