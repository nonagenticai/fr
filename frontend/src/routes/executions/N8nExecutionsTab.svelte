<!--
  N8nExecutionsTab — executions for the calling user via the mapping-table
  JOIN, polled every 15s. Lifted out of the old /tools/n8n page during the
  /tools dissolution (control-plane roadmap Phase 1); the polling handle +
  onMount(start)/onDestroy(stop) move intact. The old page's Workflows section
  is intentionally dropped — the /workflows faceted catalog is the
  authoritative read of the n8n workflow list.
-->
<script lang="ts">
  import { onDestroy, onMount } from 'svelte';
  import { listExecutions, type ScopedExecution } from '$lib/api/n8n';
  import { ExecutionRow } from '$lib/components/observability';
  import { EmptyState, ErrorState } from '$lib/components/ui';
  import { openDetailPane } from '$lib/stores/rightPane.svelte';
  import { usePoll, type PollHandle } from '$lib/net/poll';

  const POLL_INTERVAL_MS = 15_000;

  let executions = $state<ScopedExecution[]>([]);
  let executionsLoading = $state(false);
  let executionsError = $state<string | null>(null);
  let lastExecutionsUpdate = $state<number | null>(null);

  // Fires immediately on start, then every 15s. Pauses when the tab/document
  // is hidden, exponential backoff on failure.
  const pollHandle: PollHandle = usePoll(refreshExecutions, {
    intervalMs: POLL_INTERVAL_MS,
  });

  function openInRightPane(executionId: string): void {
    openDetailPane({ kind: 'n8n-execution', id: executionId });
  }

  async function refreshExecutions(): Promise<void> {
    executionsLoading = true;
    try {
      const out = await listExecutions({ limit: 100 });
      executions = out.data;
      lastExecutionsUpdate = Date.now();
      executionsError = null;
    } catch (err) {
      executionsError = err instanceof Error ? err.message : String(err);
    } finally {
      executionsLoading = false;
    }
  }

  onMount(() => {
    pollHandle.start();
  });

  onDestroy(() => {
    pollHandle.stop();
  });
</script>

<section class="flex flex-col gap-2" data-testid="n8n-executions-section">
  <div class="flex items-center justify-between">
    <span class="text-xs text-[var(--color-text-muted)] dark:text-[var(--color-text-muted)]">
      {executions.length} execution{executions.length === 1 ? '' : 's'}{lastExecutionsUpdate
        ? ` · updated ${new Date(lastExecutionsUpdate).toLocaleTimeString()}`
        : ''}
    </span>
    <button
      type="button"
      onclick={() => void refreshExecutions()}
      disabled={executionsLoading}
      class="px-3 py-1 bg-[var(--color-accent)] text-[var(--color-on-primary)] text-sm rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      data-testid="n8n-refresh"
    >
      {executionsLoading ? '…' : 'Refresh'}
    </button>
  </div>
  {#if executionsError}
    <ErrorState error={executionsError} title="Couldn't load executions" />
  {/if}
  {#if executions.length === 0 && !executionsLoading && !executionsError}
    <EmptyState
      title="No executions yet"
      body="Workflow runs will show here once n8n executes a flow visible to your account."
    />
  {:else if executions.length > 0}
    <div
      class="border border-[var(--color-border)] rounded divide-y divide-[var(--color-border)] dark:border-[var(--color-border)] dark:divide-[var(--color-border-strong)]"
    >
      {#each executions as ex (ex.id)}
        <div class="flex items-center gap-2 px-3" data-testid="n8n-execution-wrapper">
          <div class="flex-1 min-w-0">
            <ExecutionRow
              status={ex.status}
              name={ex.workflow_id ? `${ex.workflow_id} · #${ex.id}` : `#${ex.id}`}
              durationMs={ex.duration_ms}
              startedAt={ex.started_at}
              traceUrl={ex.trace_url}
            />
          </div>
          <button
            type="button"
            class="shrink-0 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)] underline"
            onclick={() => openInRightPane(ex.id)}
            aria-label="Open execution detail in right pane"
            data-testid="n8n-execution-open"
          >
            Open
          </button>
        </div>
      {/each}
    </div>
  {/if}
</section>
