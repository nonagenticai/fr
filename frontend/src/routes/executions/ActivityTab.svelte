<!--
  Executions → Activity tab — global execution/activity feed.

  Lifted from /tools/activity during the /tools dissolution (control-plane
  roadmap Phase 3). Backed by the shared `activityStore` singleton (15s poll
  on GET /api/tools/n8n/executions). Mounted as /executions/activity (nav
  standard 2026-10-03 — formerly a keepAlive tab); /tools/activity 308s there.

  Spec: docs/superpowers/specs/completed/2026-04-24-n8n-observability-kanban-liveness.md
    §"Frontend / bespoke page".
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { activityStore, type ActivityExecution } from '$lib/stores/activityStore.svelte';
  import LivenessBadge from '$lib/components/LivenessBadge.svelte';
  import { StatusBadge } from '$lib/components/observability';

  let projectFilter = $state('');

  onMount(() => {
    activityStore.start();
  });

  function applyFilter(): void {
    const trimmed = projectFilter.trim();
    activityStore.setProjectId(trimmed.length > 0 ? trimmed : null);
  }

  function clearFilter(): void {
    projectFilter = '';
    activityStore.setProjectId(null);
  }

  // Map n8n execution status → StatusBadge palette key.
  function statusKey(status: string | undefined): string {
    const v = (status ?? '').toLowerCase();
    if (v === 'running' || v === 'waiting' || v === 'new') return v === 'waiting' ? 'waiting' : 'running';
    if (v === 'success') return 'success';
    if (v === 'error' || v === 'crashed') return 'error';
    if (v === 'canceled') return 'idle';
    return 'unknown';
  }

  function statusLabel(status: string | undefined): string {
    const v = (status ?? '').toLowerCase();
    return v === '' ? '—' : v;
  }

  function channelKey(initiatedVia: string): string {
    const v = initiatedVia.toLowerCase();
    // No 1:1 with the StatusBadge palette — pick the closest tone:
    //   web/telegram/teams/agent/cron all map to 'idle' for a neutral pill.
    if (!v) return 'unknown';
    return 'idle';
  }

  function fmtDuration(ms: number | undefined, status: string | undefined): string {
    if (ms === undefined || !Number.isFinite(ms)) {
      const v = (status ?? '').toLowerCase();
      if (v === 'running' || v === 'waiting' || v === 'new') return 'in progress';
      return '—';
    }
    if (ms < 1_000) return `${ms}ms`;
    if (ms < 60_000) return `${(ms / 1_000).toFixed(1)}s`;
    const mins = Math.floor(ms / 60_000);
    const secs = Math.floor((ms % 60_000) / 1_000);
    return `${mins}m ${secs}s`;
  }

  function fmtTime(iso: string | undefined): string {
    if (!iso) return '—';
    const t = Date.parse(iso);
    if (!Number.isFinite(t)) return iso;
    return new Date(t).toLocaleString();
  }

  let rows = $derived<ActivityExecution[]>(activityStore.executions);
</script>

<div class="flex flex-col h-full" data-testid="activity-page">
  <header class="flex items-center justify-between mb-4">
    <div class="flex items-center gap-3">
      <h2 class="text-xl font-semibold text-[var(--color-text)] dark:text-[var(--color-text)]">Activity</h2>
      <LivenessBadge />
    </div>
    <div class="flex items-center gap-2">
      <input
        type="text"
        bind:value={projectFilter}
        onchange={applyFilter}
        placeholder="Filter by project ID"
        class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-sm font-mono w-72 dark:border-[var(--color-border-strong)]"
        data-testid="activity-project-filter"
      />
      {#if activityStore.projectId}
        <button
          type="button"
          onclick={clearFilter}
          class="px-2 py-1 text-xs text-[var(--color-text)] hover:text-[var(--color-text)] dark:text-[var(--color-text-muted)] dark:hover:text-[var(--color-text)]"
        >
          Clear
        </button>
      {/if}
      <button
        type="button"
        onclick={() => activityStore.refresh()}
        disabled={activityStore.loading}
        class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
        data-testid="activity-refresh"
      >
        {activityStore.loading ? '…' : 'Refresh'}
      </button>
    </div>
  </header>

  {#if activityStore.error}
    <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4">
      {activityStore.error}
    </div>
  {/if}

  {#if rows.length === 0 && !activityStore.loading}
    <p class="text-sm text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">No executions visible to your account yet.</p>
  {:else}
    <div class="text-xs text-[var(--color-text-muted)] mb-2 dark:text-[var(--color-text-muted)]">
      {rows.length} execution{rows.length === 1 ? '' : 's'}{activityStore.lastUpdated
        ? ` · updated ${new Date(activityStore.lastUpdated).toLocaleTimeString()}`
        : ''}
    </div>
    <table class="w-full text-sm border border-[var(--color-border)] rounded overflow-hidden dark:border-[var(--color-border)]">
      <thead class="bg-[var(--color-surface)] text-xs uppercase text-[var(--color-text)] dark:bg-[var(--color-bg)] dark:text-[var(--color-text-muted)]">
        <tr>
          <th class="text-left px-2 py-1">Status</th>
          <th class="text-left px-2 py-1">Channel</th>
          <th class="text-left px-2 py-1">Execution</th>
          <th class="text-left px-2 py-1">Workflow</th>
          <th class="text-right px-2 py-1">Duration</th>
          <th class="text-left px-2 py-1">Started</th>
          <th class="text-left px-2 py-1">Project</th>
          <th class="text-left px-2 py-1">Trace</th>
        </tr>
      </thead>
      <tbody>
        {#each rows as ex (ex.id)}
          <tr class="border-t border-[var(--color-border)] hover:bg-[var(--color-accent)] dark:border-[var(--color-border)]" data-testid="activity-row">
            <td class="px-2 py-1">
              <StatusBadge status={statusKey(ex.status)} label={statusLabel(ex.status)} />
            </td>
            <td class="px-2 py-1">
              <StatusBadge status={channelKey(ex.initiated_via)} label={ex.initiated_via || '—'} />
            </td>
            <td class="px-2 py-1 font-mono text-xs">{ex.id}</td>
            <td class="px-2 py-1 font-mono text-xs">{ex.workflow_id ?? '—'}</td>
            <td class="px-2 py-1 text-right tabular-nums text-xs">{fmtDuration(ex.duration_ms, ex.status)}</td>
            <td class="px-2 py-1 text-xs text-[var(--color-text)] dark:text-[var(--color-text-muted)]">{fmtTime(ex.started_at)}</td>
            <td class="px-2 py-1 font-mono text-xs">{ex.project_id}</td>
            <td class="px-2 py-1 text-xs">
              {#if ex.trace_url}
                <a
                  href={ex.trace_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  class="text-[var(--color-accent)] hover:underline"
                >
                  Tempo →
                </a>
              {:else}
                —
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</div>
