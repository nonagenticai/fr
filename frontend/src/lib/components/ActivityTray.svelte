<!--
  ActivityTray.svelte

  Floating bottom-right launcher + collapsible panel showing the top-3
  in-flight n8n executions plus the kanban LivenessBadge. Mounted from
  +layout.svelte (only when authenticated).

  Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
    §"Frontend"  — compact tray beside the toast root, links to the
    /executions Activity tab (re-homed from /tools/activity, roadmap Phase 3).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { activityStore } from '$lib/stores/activityStore.svelte';
  import LivenessBadge from './LivenessBadge.svelte';

  let open = $state(false);

  onMount(() => {
    // Page also calls start() — idempotent. We intentionally never stop()
    // here: the singleton store is shared with the /executions Activity tab,
    // and unmounting the tray during a route change would kill the page poll.
    activityStore.start();
  });

  function toggle(): void {
    open = !open;
  }

  function fmtChannel(initiatedVia: string): { label: string; cls: string } {
    const v = initiatedVia.toLowerCase();
    if (v === 'web') return { label: 'web', cls: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]' };
    if (v === 'teams') return { label: 'teams', cls: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] border-[var(--color-accent)]' };
    if (v === 'cron') return { label: 'cron', cls: 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)]' };
    if (v === 'agent') return { label: 'agent', cls: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] border-[var(--color-success)]' };
    return { label: v || '—', cls: 'bg-[var(--color-surface)] text-[var(--color-text)] border-[var(--color-border-strong)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)]' };
  }

  let top3 = $derived(activityStore.topInFlight(3));
  let inFlightCount = $derived(activityStore.inFlight.length);
</script>

<div class="fixed bottom-4 right-4 z-40 flex flex-col items-end gap-2" data-testid="activity-tray">
  {#if open}
    <div
      class="w-80 bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg shadow-xl p-3 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]"
      data-testid="activity-tray-panel"
    >
      <div class="flex items-center justify-between mb-2">
        <h3 class="text-sm font-semibold text-[var(--color-text)] dark:text-[var(--color-text-muted)]">Activity</h3>
        <LivenessBadge />
      </div>

      {#if activityStore.error}
        <div class="text-xs text-[var(--color-danger)] bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] rounded px-2 py-1 mb-2 dark:text-[var(--color-danger-text)] dark:bg-[var(--color-danger-bg)]/20">
          {activityStore.error}
        </div>
      {/if}

      {#if top3.length === 0}
        <p class="text-xs text-[var(--color-text-muted)] italic dark:text-[var(--color-text-muted)]">No in-flight executions.</p>
      {:else}
        <ul class="space-y-1.5 mb-2">
          {#each top3 as ex (ex.id)}
            {@const ch = fmtChannel(ex.initiated_via)}
            <li class="text-xs flex items-center gap-2">
              <span class="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse"></span>
              <span class="font-mono truncate flex-1" title={ex.id}>{ex.id}</span>
              <span class="px-1.5 py-0.5 rounded border {ch.cls}">{ch.label}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <a
        href="/executions/activity"
        class="text-xs text-[var(--color-accent)] hover:underline"
        data-testid="activity-tray-open-full"
      >
        Open full activity →
      </a>
    </div>
  {/if}

  <button
    type="button"
    onclick={toggle}
    class="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-full shadow px-3 py-1.5 text-xs font-medium text-[var(--color-text)] hover:bg-[var(--color-surface)] flex items-center gap-2 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)] dark:text-[var(--color-text-muted)] dark:hover:bg-[var(--color-surface-strong)]"
    data-testid="activity-tray-toggle"
    aria-label={open ? 'Close activity tray' : 'Open activity tray'}
  >
    <span class="inline-block w-2 h-2 rounded-full {inFlightCount > 0 ? 'bg-[var(--color-accent)] animate-pulse' : 'bg-[var(--color-surface-strong)]'}"></span>
    Activity{inFlightCount > 0 ? ` (${inFlightCount})` : ''}
  </button>
</div>
