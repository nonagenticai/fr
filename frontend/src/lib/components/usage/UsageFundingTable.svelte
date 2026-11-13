<script lang="ts">
  // One table: the requested dims (project / member / app / …) as row headers,
  // funding (Local GPU / Platform-paid / Own key) as columns, a row total, input /
  // output tokens, calls, and a
  // totals footer. Unattributed (null) dims are labelled "Unattributed".
  import { Pill } from '$lib/components/ui';
  import {
    DIM_HEADERS,
    dimCell,
    fundingLabel,
    formatTokens,
    formatUsd,
    pivotByFunding,
    type UsageFundingBreakdown,
  } from '$lib/usage/funding';

  interface Props {
    data: UsageFundingBreakdown;
    testid?: string;
  }
  let { data, testid = 'usage-funding-table' }: Props = $props();

  const pivot = $derived(pivotByFunding(data.rows, data.group_by));
  const byFundingTotal = $derived(Object.fromEntries(data.by_funding.map((f) => [f.funding, f.cost_usd])));
  // Footer: the TRUE totals (billing's, all rows) — not the sum of a truncated page.
  const footFundings = $derived(
    pivot.fundings.length ? pivot.fundings : data.by_funding.map((f) => f.funding),
  );
</script>

<div class="overflow-x-auto" data-testid={testid}>
  <table class="w-full min-w-[32rem] text-sm">
    <thead class="text-left text-[var(--color-text-muted)]">
      <tr class="border-b border-[var(--color-border)]">
        {#each pivot.dims as d (d)}
          <th class="py-2 pr-3 font-medium">{DIM_HEADERS[d] ?? d}</th>
        {/each}
        {#each footFundings as f (f)}
          <th class="py-2 pr-3 text-right font-medium" data-testid={`${testid}-funding-col`}>{fundingLabel(f)}</th>
        {/each}
        <th class="py-2 pr-3 text-right font-medium">Total</th>
        <th class="py-2 pr-3 text-right font-medium">Input tokens</th>
        <th class="py-2 pr-3 text-right font-medium">Output tokens</th>
        <th class="py-2 pr-3 text-right font-medium">Calls</th>
      </tr>
    </thead>
    <tbody>
      {#if pivot.rows.length === 0}
        <tr>
          <td class="py-3 text-[var(--color-text-muted)]" colspan={pivot.dims.length + footFundings.length + 4}>
            No usage in this range.
          </td>
        </tr>
      {/if}
      {#each pivot.rows as row (row.key)}
        <tr
          class={`border-b border-[var(--color-border)] ${row.unattributed ? 'bg-[var(--color-surface-strong)] italic' : ''}`}
          data-testid={row.unattributed ? `${testid}-unattributed` : `${testid}-row`}
        >
          {#each pivot.dims as d (d)}
            {@const c = dimCell(row.head, d)}
            <td class="py-2 pr-3">
              <div class="flex items-center gap-2">
                <!-- One label per cell: an unattributed dim is the warning pill alone
                     (c.label is already "Unattributed" — rendering both doubled it). -->
                {#if c.unattributed}<Pill tone="warning">{c.label}</Pill>{:else}<span
                    class={c.unnamed ? 'font-mono text-xs' : ''}>{c.label}</span
                  >{/if}
              </div>
              {#if c.sublabel}<div class="text-xs text-[var(--color-text-muted)]">{c.sublabel}</div>{/if}
            </td>
          {/each}
          {#each footFundings as f (f)}
            <td class="py-2 pr-3 text-right tabular-nums" data-funding={f}>
              {f in row.byFunding ? formatUsd(row.byFunding[f]) : ''}
            </td>
          {/each}
          <td class="py-2 pr-3 text-right font-medium tabular-nums">{formatUsd(row.cost_usd)}</td>
          <td class="py-2 pr-3 text-right tabular-nums" data-testid={`${testid}-input-tokens`}>{formatTokens(row.input_tokens)}</td>
          <td class="py-2 pr-3 text-right tabular-nums" data-testid={`${testid}-output-tokens`}>{formatTokens(row.output_tokens)}</td>
          <td class="py-2 pr-3 text-right tabular-nums">{row.events.toLocaleString()}</td>
        </tr>
      {/each}
    </tbody>
    <tfoot>
      <tr class="font-semibold" data-testid={`${testid}-total`}>
        {#if pivot.dims.length}<td class="py-2 pr-3" colspan={pivot.dims.length}>Total</td>{/if}
        {#each footFundings as f (f)}
          <td class="py-2 pr-3 text-right tabular-nums" data-funding={f}>{formatUsd(byFundingTotal[f] ?? 0)}</td>
        {/each}
        <td class="py-2 pr-3 text-right tabular-nums">{formatUsd(data.totals.cost_usd)}</td>
        <td class="py-2 pr-3 text-right tabular-nums">{formatTokens(data.totals.input_tokens)}</td>
        <td class="py-2 pr-3 text-right tabular-nums">{formatTokens(data.totals.output_tokens)}</td>
        <td class="py-2 pr-3 text-right tabular-nums">{data.totals.events.toLocaleString()}</td>
      </tr>
    </tfoot>
  </table>
  {#if data.truncated}
    <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid={`${testid}-truncated`}>
      Only the largest 5,000 groups are listed; the totals row still covers everything.
    </p>
  {/if}
</div>
