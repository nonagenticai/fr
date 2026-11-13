<script lang="ts">
  // The live n8n workflow list from the `n8n_workflows` block — straight from
  // fr's crawl of the production n8n instance. No registry, no derived states:
  // what n8n has, and whether it is active.
  import { isAvailable, type Block } from '$lib/types/read-model';
  import type { LiveWorkflows } from '$lib/types/control-tower';
  import Tag from '$lib/components/ui/Tag.svelte';
  import BlockUnavailable from '$lib/components/blocks/BlockUnavailable.svelte';

  interface Props {
    block: Block<LiveWorkflows>;
  }
  let { block }: Props = $props();
</script>

<section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="live-workflows-panel">
  <header class="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--color-border)] px-4 py-3">
    <div>
      <h2 class="text-sm font-semibold text-[var(--color-text)]">n8n workflows</h2>
      <p class="text-xs text-[var(--color-text-muted)]">
        Live from n8n{#if isAvailable(block)} · fetched {block.data.fetched_at}{#if block.data.degraded} (stale){/if}{/if}
      </p>
    </div>
    {#if isAvailable(block)}
      <div class="flex gap-2">
        <Tag tone="success">{block.data.active} active</Tag>
        <Tag tone="neutral">{block.data.inactive} inactive</Tag>
        <Tag tone="neutral">{block.data.total} total</Tag>
      </div>
    {/if}
  </header>

  {#if isAvailable(block)}
    {#if block.data.rows.length === 0}
      <p class="px-4 py-6 text-sm text-[var(--color-text-muted)]">n8n reports no workflows.</p>
    {:else}
      <div class="max-h-[32rem] overflow-auto">
        <table class="w-full text-left text-xs">
          <thead class="sticky top-0 bg-[var(--color-surface)] text-[11px] uppercase tracking-wider text-[var(--color-text-muted)]">
            <tr class="border-b border-[var(--color-border)]">
              <th class="px-4 py-2 font-semibold">Name</th>
              <th class="px-4 py-2 font-semibold">Id</th>
              <th class="px-4 py-2 font-semibold">State</th>
              <th class="px-4 py-2 font-semibold">Updated</th>
              <th class="px-4 py-2 font-semibold">Tags</th>
            </tr>
          </thead>
          <tbody>
            {#each block.data.rows as row (row.id)}
              <tr class="border-b border-[var(--color-border)] last:border-0" data-testid="live-workflow-row">
                <td class="px-4 py-2 text-[var(--color-text)]">{row.name}</td>
                <td class="px-4 py-2 font-mono text-[var(--color-text-muted)]">{row.id}</td>
                <td class="px-4 py-2"><Tag tone={row.active ? 'success' : 'neutral'}>{row.active ? 'active' : 'inactive'}</Tag></td>
                <td class="px-4 py-2 text-[var(--color-text-muted)]">{row.updated_at ?? '—'}</td>
                <td class="px-4 py-2 text-[var(--color-text-muted)]">{row.tags.join(', ') || '—'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
  {:else}
    <div class="p-4"><BlockUnavailable meta={block.meta} title="n8n workflows" /></div>
  {/if}
</section>
