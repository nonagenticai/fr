<!--
  LivenessPill.svelte

  Compact display of a liveness snapshot — `{status, subscriberCount,
  maxLagSeconds}`. Sibling to the older `LivenessBadge.svelte`, which is the
  WS-heartbeat-driven badge wired into kanban. This pill takes its data from
  the kanban liveness REST endpoint instead, so the activity / n8n pages
  can render it without owning a WebSocket.

  Plan: docs/superpowers/plans/...woolly-harp Wave 2 Task 2.1 Step 6.
-->
<script lang="ts">
  import StatusBadge from './StatusBadge.svelte';

  type LivenessStatus = 'live' | 'stale' | 'disconnected' | 'unknown';

  let {
    status,
    subscriberCount,
    maxLagSeconds,
    wsLabel = 'Kanban WS',
  }: {
    status: LivenessStatus | string;
    subscriberCount: number;
    maxLagSeconds: number;
    wsLabel?: string;
  } = $props();

  // Map kanban statuses → StatusBadge palette. 'disconnected' has no direct
  // colour entry; tag it as 'error' so it renders red/amber in the badge.
  function badgeStatus(s: LivenessStatus | string): string {
    switch (s) {
      case 'live':
        return 'live';
      case 'stale':
        return 'stale';
      case 'disconnected':
        return 'error';
      default:
        return 'unknown';
    }
  }

  function lagLabel(s: LivenessStatus | string, lag: number): string {
    if (s === 'live') return 'Live';
    if (s === 'stale') return `Stale ${Math.round(lag)}s`;
    if (s === 'disconnected') return 'Disconnected';
    return 'Unknown';
  }
</script>

<span
  class="inline-flex items-center gap-2"
  data-testid="liveness-pill"
  data-status={status}
  title={`${wsLabel} — ${subscriberCount} subscriber${subscriberCount === 1 ? '' : 's'}, max lag ${maxLagSeconds}s`}
>
  <StatusBadge status={badgeStatus(status)} label={lagLabel(status, maxLagSeconds)} />
  <span class="text-xs text-[var(--color-text-muted)] tabular-nums">
    {subscriberCount} sub{subscriberCount === 1 ? '' : 's'}
  </span>
</span>
