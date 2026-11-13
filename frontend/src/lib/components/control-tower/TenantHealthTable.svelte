<script lang="ts">
  // Tenant + board health table from the `tenants` block. One row per canonical
  // tenant: workspace name + kind, board liveness (via StatusBadge), WIP/blocked
  // counts, andon + archived flags. Rows are selectable → the inspector. The
  // block itself is DERIVED; a per-row board_available:false renders a muted
  // "board unreachable" liveness while the block stays available.
  import { isAvailable, type Block } from '$lib/types/read-model';
  import type { TenantHealthRow } from '$lib/types/control-tower';
  import StatusBadge from '$lib/components/observability/StatusBadge.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';
  import { tenantKindLabel, boardBadge } from './logic';

  interface Props {
    block: Block<TenantHealthRow[]>;
    selectedId?: string | null;
    onselect?: (row: TenantHealthRow) => void;
  }
  let { block, selectedId = null, onselect }: Props = $props();
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="tenant-health-table">
  <header class="border-b border-[var(--color-border)] px-4 py-3">
    <h2 class="text-sm font-semibold text-[var(--color-text)]">Tenant and board health</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      Operational isolation, board reachability, and active work by workspace.
    </p>
  </header>

  {#if isAvailable(block)}
    <div class="overflow-x-auto">
      <table class="w-full min-w-[46rem] text-left text-sm">
        <thead class="text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
          <tr class="border-b border-[var(--color-border)]">
            <th class="px-4 py-2 font-semibold">Workspace</th>
            <th class="px-4 py-2 font-semibold">Kind</th>
            <th class="px-4 py-2 font-semibold">Board</th>
            <th class="px-4 py-2 text-right font-semibold">WIP</th>
            <th class="px-4 py-2 text-right font-semibold">Blocked</th>
            <th class="px-4 py-2 font-semibold">Flags</th>
          </tr>
        </thead>
        <tbody>
          {#each block.data as row (row.tenant_id)}
            <tr
              class="cursor-pointer border-b border-[var(--color-border)] last:border-0 transition-colors hover:bg-[var(--color-surface-strong)] {selectedId ===
              row.tenant_id
                ? 'bg-[var(--color-surface-strong)]'
                : ''}"
              onclick={() => onselect?.(row)}
              data-inspect="tenant"
              data-testid="tenant-row"
            >
              <td class="px-4 py-2">
                <span class="font-medium text-[var(--color-text)]">{row.name}</span>
                <span class="block font-mono text-[10px] text-[var(--color-text-muted)]">{row.tenant_id}</span>
              </td>
              <td class="px-4 py-2 text-[var(--color-text-muted)]">{tenantKindLabel(row.kind)}</td>
              <td class="px-4 py-2">
                {#if row.board_id}
                  <StatusBadge status={boardBadge(row.board_available)} label={row.board_available ? 'live' : 'unreachable'} />
                {:else}
                  <span class="text-xs text-[var(--color-text-muted)]">no board</span>
                {/if}
              </td>
              <td class="px-4 py-2 text-right tabular-nums">{row.wip}</td>
              <td class="px-4 py-2 text-right tabular-nums">
                <span class={row.blocked > 0 ? 'text-[var(--color-danger-text)]' : ''}>{row.blocked}</span>
              </td>
              <td class="px-4 py-2">
                <span class="flex flex-wrap gap-1">
                  {#if row.andon_engaged}<Tag tone="danger" dot>Andon</Tag>{/if}
                  {#if row.is_system}<Tag tone="info">System</Tag>{/if}
                  {#if row.archived}<Tag tone="neutral">Archived</Tag>{/if}
                </span>
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="p-4">
      <BlockUnavailable meta={block.meta} title="Tenant health" />
    </div>
  {/if}
</section>
