<!--
  CostStackedBar (R6, cockpit C7) — where the card spend went, as one stacked bar: by phase or by
  capability. Every segment is a token colour AND a labelled legend row, so colour is never the only
  signal; the same facts are a table via "Show as table". More than five groups fold into "Other"
  (a repeated colour would make two segments indistinguishable).
-->
<script lang="ts">
  import { moneyWords } from '$lib/projects/cockpit-status';
  import { segmentWidth, stackColor, stackGroups, type CostGroup } from './cost';

  let {
    title,
    groups,
    currency,
    emptyWords,
    testid,
  }: { title: string; groups: readonly CostGroup[]; currency: string; emptyWords: string; testid: string } = $props();

  let asTable = $state(false);
  const stack = $derived(stackGroups(groups));
  const total = $derived.by(() => {
    if (groups.length === 0) return null;
    let sum = 0;
    for (const g of groups) {
      if (g.cost === null) return null;
      sum += g.cost;
    }
    return sum;
  });
  const partial = $derived(groups.some((g) => g.partial));
  const sentence = $derived.by(() => {
    if (groups.length === 0) return emptyWords;
    if (total === null) return 'The amounts could not be priced, so the split is not shown. This is not $0.';
    return stack
      .map((g) => `${g.label}: ${moneyWords(g.cost, currency) ?? 'unknown'}`)
      .join('; ');
  });
  const shareWords = (g: CostGroup): string =>
    g.share === null ? 'share unknown' : `${g.share < 10 ? g.share.toFixed(1) : Math.round(g.share)}%`;
</script>

<section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid={testid}>
  <div class="mb-2 flex flex-wrap items-baseline gap-2">
    <h3 class="text-sm font-semibold text-[var(--color-text)]">{title}</h3>
    <button
      type="button"
      class="ml-auto text-[11px] text-[var(--color-accent-strong)] underline"
      aria-pressed={asTable}
      data-testid={`${testid}-table-toggle`}
      onclick={() => (asTable = !asTable)}>{asTable ? 'Show as chart' : 'Show as table'}</button
    >
  </div>

  {#if groups.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid={`${testid}-empty`}>{emptyWords}</p>
  {:else if total === null}
    <p class="text-xs text-[var(--color-warning-text)]" data-testid={`${testid}-no-amounts`}>
      The amounts could not be priced, so the split is not shown. This is not $0.
    </p>
  {:else if asTable}
    <div class="overflow-x-auto rounded border border-[var(--color-border)]">
      <table class="w-full min-w-[24rem] text-left text-xs" data-testid={`${testid}-table`}>
        <thead class="text-[11px] text-[var(--color-text-muted)]">
          <tr>
            <th scope="col" class="px-2 py-1">Group</th>
            <th scope="col" class="px-2 py-1">Spend</th>
            <th scope="col" class="px-2 py-1">Share</th>
            <th scope="col" class="px-2 py-1">Model calls</th>
          </tr>
        </thead>
        <tbody>
          {#each groups as g (g.key)}
            <tr class="border-t border-[var(--color-border)]" data-testid={`${testid}-row`}>
              <th scope="row" class="px-2 py-1 font-medium text-[var(--color-text)]">{g.label}</th>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">
                {moneyWords(g.cost, currency) ?? 'Not available'}{g.partial ? ' (floor)' : ''}
              </td>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{shareWords(g)}</td>
              <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{g.calls.toLocaleString('en-US')}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>
  {:else}
    <div
      class="flex h-4 w-full overflow-hidden rounded-full border border-[var(--color-border)]"
      role="img"
      aria-label={`${title}. ${sentence}.`}
      data-testid={`${testid}-bar`}
    >
      {#each stack as g, i (g.key)}
        <span
          class="h-full"
          style={`width:${segmentWidth(g, total)}%; background-color:${stackColor(i)}`}
          data-testid={`${testid}-segment`}
          data-key={g.key}
        ></span>
      {/each}
    </div>
    <ul class="mt-2 flex flex-col gap-1 text-xs" data-testid={`${testid}-legend`}>
      {#each stack as g, i (g.key)}
        <li class="flex flex-wrap items-baseline gap-2" data-testid={`${testid}-legend-row`}>
          <span class="inline-block h-2.5 w-2.5 rounded-sm" style={`background-color:${stackColor(i)}`} aria-hidden="true"></span>
          <span class="font-medium text-[var(--color-text)]">{g.label}</span>
          <span class="tabular-nums text-[var(--color-text)]">{moneyWords(g.cost, currency) ?? 'Not available'}</span>
          <span class="text-[var(--color-text-muted)]">{shareWords(g)}</span>
          <span class="ml-auto text-[var(--color-text-muted)]">{g.calls.toLocaleString('en-US')} model call{g.calls === 1 ? '' : 's'}</span>
        </li>
      {/each}
    </ul>
    {#if partial}
      <p class="mt-1 text-[11px] text-[var(--color-warning-text)]" data-testid={`${testid}-partial`}>
        At least one amount could not be priced, so these totals are a floor.
      </p>
    {/if}
  {/if}
</section>
