<!--
  BurnBudgetChart (R6, cockpit C7 / R-CK3) — the cumulative spend line against the budget line.

  ⛔ THE BUDGET LINE IS DRAWN ONLY WHEN THE PROJECT HAS A BUDGET (RM `Project.budget`, reporting
  only — nothing enforces it). With no budget the burn line still shows, and the chart says plainly
  that no budget is set — UNLESS RM could not be read (`budgetKnown === false`), in which case it
  says the budget is unknown instead of claiming the project has none. Only mounted when every
  amount is known: a cumulative line through nulls would be a fabricated total.
-->
<script lang="ts">
  import type { CockpitProjectCosts } from '$lib/types/cockpit';
  import { moneyWords } from '$lib/projects/cockpit-status';
  import { burnSeries, dayWords } from './cost';

  let {
    costs,
    budget,
    currency,
    budgetKnown = true,
  }: { costs: CockpitProjectCosts; budget: number | null; currency: string; budgetKnown?: boolean } = $props();

  let asTable = $state(false);
  const points = $derived(burnSeries(costs));
  const max = $derived(Math.max(1, budget ?? 0, ...points.map((p) => p.cumulative)));
  const W = 100;
  const H = 40;
  const path = $derived(
    points.length === 0
      ? ''
      : points
          .map((p, i) => {
            const x = points.length === 1 ? W : (i / (points.length - 1)) * W;
            const y = H - (p.cumulative / max) * (H - 2) - 1;
            return `${i === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
          })
          .join(' '),
  );
  const budgetY = $derived(budget === null ? null : H - (budget / max) * (H - 2) - 1);
  const last = $derived(points.at(-1) ?? null);
  const sentence = $derived.by(() => {
    const spent = last ? moneyWords(last.cumulative, currency) : null;
    const cap = budget === null ? null : moneyWords(budget, currency);
    return spent
      ? cap
        ? `${spent} spent so far of a ${cap} budget.`
        : budgetKnown
          ? `${spent} spent so far; no budget is set.`
          : `${spent} spent so far; the budget could not be read.`
      : 'No day has been billed yet.';
  });
  /** What to say where the budget would be: absent is a fact only when RM answered. */
  const noBudgetWords = $derived(budgetKnown ? 'No budget set' : 'Budget unreadable');
</script>

<section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="cost-burn">
  <div class="mb-2 flex flex-wrap items-baseline gap-2">
    <h3 class="text-sm font-semibold text-[var(--color-text)]">Spend over time</h3>
    <span class="text-[11px] text-[var(--color-text-muted)]">Cumulative, whole project</span>
    <button
      type="button"
      class="ml-auto text-[11px] text-[var(--color-accent-strong)] underline"
      aria-pressed={asTable}
      data-testid="cost-burn-table-toggle"
      onclick={() => (asTable = !asTable)}>{asTable ? 'Show as chart' : 'Show as table'}</button
    >
  </div>

  {#if points.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="cost-burn-empty">No spend has been recorded yet.</p>
  {:else if asTable}
    <div class="overflow-x-auto rounded border border-[var(--color-border)]">
      <table class="w-full min-w-[24rem] text-left text-xs" data-testid="cost-burn-table">
        <thead class="text-[11px] text-[var(--color-text-muted)]">
          <tr>
            <th scope="col" class="px-2 py-1">Day</th>
            <th scope="col" class="px-2 py-1">Spent so far</th>
            <th scope="col" class="px-2 py-1">Budget</th>
          </tr>
        </thead>
        <tbody>
          {#each points as p (p.day)}
            <tr class="border-t border-[var(--color-border)]" data-testid="cost-burn-row" data-day={p.day}>
              <th scope="row" class="px-2 py-1 font-medium text-[var(--color-text)]">
                {dayWords(p.day)}{p.includesProvisional ? ' (includes today, not yet rolled up)' : ''}
              </th>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{moneyWords(p.cumulative, currency) ?? 'Not available'}</td>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{moneyWords(budget, currency) ?? noBudgetWords}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <svg
      viewBox={`0 0 ${W} ${H}`}
      class="h-28 w-full"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Cumulative spend by day. ${sentence}`}
      data-testid="cost-burn-chart"
    >
      {#if budgetY !== null}
        <line x1="0" x2={W} y1={budgetY} y2={budgetY} stroke="var(--color-warning)" stroke-width="0.7" stroke-dasharray="2 1.5" />
      {/if}
      <path d={path} fill="none" stroke="var(--color-accent)" stroke-width="1" vector-effect="non-scaling-stroke" />
    </svg>
    <div class="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[11px] text-[var(--color-text-muted)]">
      <span>{dayWords(points[0]!.day)} → {dayWords(points.at(-1)!.day)}</span>
      <span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 bg-[var(--color-accent)]" aria-hidden="true"></span>Spent so far</span>
      {#if budget !== null}
        <span class="flex items-center gap-1"><span class="inline-block h-0.5 w-4 border-t border-dashed border-[var(--color-warning)]" aria-hidden="true"></span>Budget {moneyWords(budget, currency)}</span>
      {:else if budgetKnown}
        <span data-testid="cost-burn-no-budget">No budget is set for this project.</span>
      {:else}
        <span data-testid="cost-burn-budget-unavailable">The project's budget could not be read, so none is drawn.</span>
      {/if}
    </div>
  {/if}
</section>
