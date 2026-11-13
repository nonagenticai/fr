<!--
  SettledProvisionalChart (R6, cockpit C7) — one bar per day: what billing has rolled up (SETTLED,
  solid) and today's not-yet-rolled-up spend (PROVISIONAL, hatched). The as-of time and the basis
  sentence are passed in by the page so every figure on it carries the same basis.

  ⛔ A day whose amount is unknown is a GAP, never a zero-height zero: the bar is omitted and the
  table says "not available". Amounts are only rendered when `cost_basis !== 'unavailable'`.
-->
<script lang="ts">
  import type { CockpitProjectCosts } from '$lib/types/cockpit';
  import { moneyWords } from '$lib/projects/cockpit-status';
  import { costDays, dayWords } from './cost';

  let { costs }: { costs: CockpitProjectCosts } = $props();

  let asTable = $state(false);
  const days = $derived(costDays(costs));
  const currency = $derived(costs.currency || 'USD');
  const max = $derived(
    Math.max(
      1,
      ...days.map((d) => (typeof d.settled === 'number' ? d.settled : 0) + (typeof d.provisional === 'number' ? d.provisional : 0)),
    ),
  );
  const anyAmount = $derived(days.some((d) => typeof d.settled === 'number' || typeof d.provisional === 'number'));
  /**
   * The aria sentence behind the chart. ⛔ A day billing could not price is SKIPPED, never added as a
   * zero: the settled figure covers only days that carry an amount, says how many of the billed days
   * that was, and never prints "$0.00 settled" for a set of days whose amounts are unknown.
   */
  const summary = $derived.by(() => {
    const billed = costs.settled.length;
    const known = costs.settled.filter((d) => typeof d.cost === 'number');
    const unpriced = billed - known.length;
    const settledPart =
      known.length === 0
        ? billed === 0
          ? 'no settled day is recorded'
          : `none of the ${billed} billed day${billed === 1 ? '' : 's'} could be priced`
        : `${moneyWords(known.reduce((a, d) => a + (d.cost as number), 0), currency) ?? 'unknown'} settled across ${known.length} of ${billed} billed day${billed === 1 ? '' : 's'}${unpriced > 0 ? ` (${unpriced} not priced)` : ''}`;
    const todayPart =
      typeof costs.provisional.cost === 'number'
        ? `${moneyWords(costs.provisional.cost, currency) ?? 'unknown'} today, not yet rolled up`
        : 'today’s figure is not priced';
    return `${settledPart}; ${todayPart}`;
  });
</script>

<section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="cost-settled-provisional">
  <div class="mb-2 flex flex-wrap items-baseline gap-2">
    <h3 class="text-sm font-semibold text-[var(--color-text)]">Settled and today</h3>
    <span class="flex items-center gap-3 text-[11px] text-[var(--color-text-muted)]">
      <span class="flex items-center gap-1"><span class="inline-block h-2.5 w-3 rounded-sm bg-[var(--color-accent)]" aria-hidden="true"></span>Settled</span>
      <span class="flex items-center gap-1">
        <span
          class="inline-block h-2.5 w-3 rounded-sm border border-[var(--color-accent-border)]"
          style="background: repeating-linear-gradient(45deg, var(--color-accent) 0 2px, transparent 2px 5px)"
          aria-hidden="true"></span>Today, not yet rolled up
      </span>
    </span>
    <button
      type="button"
      class="ml-auto text-[11px] text-[var(--color-accent-strong)] underline"
      aria-pressed={asTable}
      data-testid="cost-settled-table-toggle"
      onclick={() => (asTable = !asTable)}>{asTable ? 'Show as chart' : 'Show as table'}</button
    >
  </div>

  {#if days.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="cost-settled-empty">No day has been billed for this project yet.</p>
  {:else if !anyAmount}
    <p class="text-xs text-[var(--color-warning-text)]" data-testid="cost-settled-no-amounts">
      The daily figures could not be priced, so no amounts are shown. This is not $0.
    </p>
  {:else if asTable}
    <div class="overflow-x-auto rounded border border-[var(--color-border)]">
      <table class="w-full min-w-[30rem] text-left text-xs" data-testid="cost-settled-table">
        <thead class="text-[11px] text-[var(--color-text-muted)]">
          <tr>
            <th scope="col" class="px-2 py-1">Day</th>
            <th scope="col" class="px-2 py-1">Settled</th>
            <th scope="col" class="px-2 py-1">Today, not yet rolled up</th>
            <th scope="col" class="px-2 py-1">Model calls</th>
          </tr>
        </thead>
        <tbody>
          {#each days as d (d.day)}
            <tr class="border-t border-[var(--color-border)]" data-testid="cost-settled-row" data-day={d.day}>
              <th scope="row" class="px-2 py-1 font-medium text-[var(--color-text)]">{dayWords(d.day)}</th>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{moneyWords(d.settled, currency) ?? 'Not available'}</td>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{moneyWords(d.provisional, currency) ?? '—'}</td>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{d.calls.toLocaleString('en-US')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div class="overflow-x-auto">
      <div
        class="flex min-w-[20rem] items-end gap-2 border-b border-[var(--color-border)] pt-2"
        role="img"
        aria-label={`Spend by day. ${summary}.`}
        data-testid="cost-settled-bars"
      >
        {#each days as d (d.day)}
          {@const settled = typeof d.settled === 'number' ? d.settled : 0}
          {@const provisional = typeof d.provisional === 'number' ? d.provisional : 0}
          {@const known = typeof d.settled === 'number' || typeof d.provisional === 'number'}
          {@const height = known ? Math.max(2, ((settled + provisional) / max) * 96) : 0}
          <div class="flex min-w-[2.5rem] flex-1 flex-col items-center justify-end gap-1" data-testid="cost-settled-col" data-day={d.day}>
            <span class="tabular-nums text-[10px] text-[var(--color-text-muted)]">
              {known ? (moneyWords(settled + provisional, currency) ?? '') : '—'}
            </span>
            <div class="flex w-full max-w-[3rem] flex-col justify-end" style={`height: ${height}px`}>
              {#if settled > 0}
                <div class="w-full bg-[var(--color-accent)]" style={`height: ${(settled / (settled + provisional || 1)) * 100}%`}></div>
              {/if}
              {#if provisional > 0}
                <div
                  class="w-full border border-[var(--color-accent-border)]"
                  style={`height: ${(provisional / (settled + provisional || 1)) * 100}%; background: repeating-linear-gradient(45deg, var(--color-accent) 0 2px, transparent 2px 5px)`}
                ></div>
              {/if}
            </div>
            <span class="text-[10px] text-[var(--color-text-muted)]">{dayWords(d.day)}</span>
          </div>
        {/each}
      </div>
    </div>
  {/if}
</section>
