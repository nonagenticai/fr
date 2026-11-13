<!--
  ExecutionsTable.svelte — Plan 2-C Phase 3 (Task 3.1)

  Surfaces the last N runs of a scheduled trigger on the /channels/[id]
  detail page.

  Wire shape (verified 2026-05-01 in lib/types/api.ts):
    GET /api/scheduled-triggers/:id/runs?limit=N
      → { items: ScheduledTriggerRun[], total: number }

  Status mapping covers the full ScheduledTriggerRunStatus union (9 values).
  Unknown / future values fall through to the `error` styling so we never
  render a status string with no badge.

  Plan: docs/superpowers/plans/2026-04-29-spec-2-plan-c-ui-surfaces.md §3.1.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import type {
    ScheduledTriggerRun,
    ScheduledTriggerRunStatus,
  } from '$lib/types/api';

  type EntityKind = 'schedule-intake';

  type Props = {
    entityId: string;
    entityKind: EntityKind;
    /** Soft cap; backend hard-caps at 200, defaults to 25 here. */
    limit?: number;
  };

  let { entityId, limit = 25 }: Props = $props();

  let runs = $state<ScheduledTriggerRun[]>([]);
  let loading = $state(true);
  let err = $state<string | null>(null);
  // Per-row toggle for the "show full error" tooltip-on-click affordance.
  let expandedErrorId = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    err = null;
    try {
      const result = await apiClient.scheduledTriggers.listRuns(entityId, { limit });
      // ListResponse envelope — pull `items`, NOT the response itself.
      runs = result.items;
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
      runs = [];
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });

  // Tailwind class fragments for the 9 status values. Falls back to error
  // styling so we never silently emit an unstyled badge.
  const STATUS_CLASS: Record<ScheduledTriggerRunStatus, string> = {
    ok: 'bg-[var(--color-success-bg)] text-[var(--color-success-text)] dark:bg-[var(--color-success-bg)] dark:text-[var(--color-success)]',
    error: 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
    no_new_records:
      'bg-[var(--color-surface)] text-[var(--color-text)] dark:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)]',
    skipped_no_connector:
      'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
    config_invalid:
      'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
    partial_failure:
      'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
    template_not_found:
      'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
    render_error:
      'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
    in_progress:
      'bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]',
  };

  function statusClass(status: string): string {
    return (
      STATUS_CLASS[status as ScheduledTriggerRunStatus] ??
      STATUS_CLASS.error
    );
  }

  function truncate(s: string | null, n: number): string {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n) + '…';
  }

  function fmtTimestamp(iso: string | null): string {
    if (!iso) return '—';
    try {
      return new Date(iso).toLocaleString();
    } catch {
      return iso;
    }
  }
</script>

<section class="executions-table" data-testid="executions-table">
  <header class="flex items-baseline justify-between mb-2">
    <h2 class="text-base font-semibold">Recent runs</h2>
    <button
      type="button"
      onclick={() => void load()}
      disabled={loading}
      class="px-2 py-1 text-xs border border-[var(--color-border-strong)] rounded hover:bg-[var(--color-surface)] disabled:opacity-50 dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
      data-testid="executions-refresh"
    >
      {loading ? 'Loading…' : 'Refresh'}
    </button>
  </header>

  {#if err}
    <p
      class="text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]"
      data-testid="executions-error"
    >
      Failed to load runs: {err}
    </p>
  {:else if loading && runs.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if runs.length === 0}
    <p
      class="text-sm text-[var(--color-text-muted)]"
      data-testid="executions-empty"
    >
      No runs yet.
    </p>
  {:else}
    <table
      class="w-full text-sm border-collapse"
      data-testid="executions-table-rows"
    >
      <thead>
        <tr class="text-left border-b border-[var(--color-border)] dark:border-[var(--color-border)]">
          <th class="py-1 pr-3 font-medium">Fired</th>
          <th class="py-1 pr-3 font-medium">Status</th>
          <th class="py-1 pr-3 font-medium">Records</th>
          <th class="py-1 pr-3 font-medium">Kind</th>
          <th class="py-1 font-medium">Error</th>
        </tr>
      </thead>
      <tbody>
        {#each runs as run (run.id)}
          <tr class="border-b border-[var(--color-border)] dark:border-[var(--color-border-strong)]">
            <td class="py-1 pr-3 font-mono text-xs whitespace-nowrap">
              {fmtTimestamp(run.fired_at)}
            </td>
            <td class="py-1 pr-3">
              <span
                class="inline-block rounded px-1.5 py-0.5 text-xs {statusClass(
                  run.status,
                )}"
                data-testid="execution-status"
                data-status={run.status}
              >
                {run.status}
              </span>
            </td>
            <td class="py-1 pr-3 font-mono text-xs">
              {run.records_processed}
            </td>
            <td class="py-1 pr-3 text-xs text-[var(--color-text-muted)]">
              {run.kind}
            </td>
            <td class="py-1 text-xs">
              {#if run.error_message}
                <button
                  type="button"
                  onclick={() =>
                    (expandedErrorId =
                      expandedErrorId === run.id ? null : run.id)}
                  class="text-left underline decoration-dotted hover:text-[var(--color-danger)] dark:hover:text-[var(--color-danger-text)]"
                  title={run.error_message}
                >
                  {expandedErrorId === run.id
                    ? run.error_message
                    : truncate(run.error_message, 60)}
                </button>
              {:else}
                <span class="text-[var(--color-text-muted)]">—</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  {/if}
</section>
