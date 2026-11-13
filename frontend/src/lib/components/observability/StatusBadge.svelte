<!--
  StatusBadge.svelte

  Reusable colour-coded pill for execution / liveness status. Used by both
  the bespoke `/tools/activity` aggregator and the data-source-specific
  `/tools/n8n` page. Centralising the status-colour map here means future
  data sources (ingestion runs, agent traces, etc.) can drop in without
  re-stating the palette.

  Plan: docs/superpowers/plans/...woolly-harp Wave 2 Task 2.1 Step 6.
-->
<script lang="ts">
  type Status =
    | 'success'
    | 'running'
    | 'error'
    | 'waiting'
    | 'live'
    | 'idle'
    | 'stale'
    | 'unknown';

  let { status, label }: { status: Status | string; label?: string } = $props();

  const colors: Record<Status, string> = {
    success: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] ring-[var(--color-success)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]',
    running: 'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)] ring-[var(--color-accent)]',
    error:   'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)] ring-[var(--color-danger-bg)]',
    waiting: 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] ring-[var(--color-warning-bg)]',
    live:    'bg-[var(--color-success-bg)] text-[var(--color-success-text)] ring-[var(--color-success)]',
    idle:    'bg-[var(--color-surface)] text-[var(--color-text)] ring-[var(--color-border)]',
    stale:   'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] ring-[var(--color-warning-bg)]',
    unknown: 'bg-[var(--color-surface)] text-[var(--color-text)] ring-[var(--color-border)]',
  };
  const cls = $derived(colors[status as Status] ?? colors.unknown);
</script>

<span
  class="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset {cls}"
  data-testid="status-badge"
  data-status={status}
>
  {label ?? status}
</span>
