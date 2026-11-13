<script lang="ts">
  // In-flight executions from the `active_executions` block — recent n8n runs +
  // worker-management sessions, merged. The block stays available if EITHER
  // source is up; a per-source outage shows a degrade note. gate_waiting is the
  // count parked at a human gate.
  import { isAvailable, type Block } from '$lib/types/read-model';
  import type { ActiveExecutions } from '$lib/types/control-tower';
  import StatusBadge from '$lib/components/observability/StatusBadge.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';
  import { correlationLabel, correlationState } from './logic';

  interface Props {
    block: Block<ActiveExecutions>;
  }
  let { block }: Props = $props();
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="active-executions-panel">
  <header class="flex items-center justify-between border-b border-[var(--color-border)] px-4 py-3">
    <div>
      <h2 class="text-sm font-semibold text-[var(--color-text)]">Active executions</h2>
      <p class="text-xs text-[var(--color-text-muted)]">In-flight n8n runs and worker sessions.</p>
    </div>
    {#if isAvailable(block)}
      <Tag tone={block.data.gate_waiting > 0 ? 'warning' : 'neutral'}>{block.data.gate_waiting} at gate</Tag>
    {/if}
  </header>

  {#if isAvailable(block)}
    {#if !block.data.n8n_available || !block.data.worker_management_available}
      <p class="border-b border-[var(--color-border)] px-4 py-2 text-[11px] text-[var(--color-text-muted)]">
        {#if !block.data.n8n_available}n8n not reporting.{/if}
        {#if !block.data.worker_management_available} worker-management not reporting.{/if}
      </p>
    {/if}
    {#if block.data.rows.length === 0}
      <p class="px-4 py-6 text-sm text-[var(--color-text-muted)]">No in-flight executions.</p>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full text-left text-xs">
          <thead class="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="px-4 py-2 font-semibold">Source</th>
              <th class="px-4 py-2 font-semibold">Mode</th>
              <th class="px-4 py-2 font-semibold">Status</th>
              <th class="px-4 py-2 font-semibold">Correlation</th>
            </tr>
          </thead>
          <tbody>
            {#each block.data.rows as row (row.execution_id)}
              <tr class="border-b border-[var(--color-border)] last:border-0" data-testid="active-execution-row">
                <td class="px-4 py-2">
                  <Tag tone={row.source === 'n8n' ? 'accent' : 'info'}>{row.source}</Tag>
                </td>
                <td class="px-4 py-2 text-[var(--color-text-muted)]">{row.mode ?? '—'}</td>
                <td class="px-4 py-2"><StatusBadge status={row.status} /></td>
                <!-- "external" is a FACT (an n8n schedule/webhook started this
                     run, so no fr correlation id exists), not a gap; "—" is
                     reserved for a mapping lookup we could not do. -->
                <td
                  class="px-4 py-2 text-[var(--color-text-muted)] {correlationState(row) === 'present' ? 'font-mono' : 'italic'}"
                  title={correlationState(row) === 'not_fr_initiated'
                    ? 'Started outside fr (an n8n schedule or webhook) — no fr correlation id exists for this run'
                    : correlationState(row) === 'unavailable'
                      ? 'The correlation mapping lookup failed — unknown, not absent'
                      : (row.correlation_id ?? '')}
                >{correlationLabel(row)}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <div class="p-4"><BlockUnavailable meta={block.meta} title="Active executions" /></div>
  {/if}
</section>
