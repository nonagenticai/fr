<!--
  Spend this month and the workspace's token budget, read independently:
    GET /api/me/usage/summary?window=month  (requests, tokens, billed cost — null when withheld)
    GET /api/me/budget/status               (the workspace's token budgets)
  Detail lives on /settings/usage.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Skeleton } from '$lib/components/ui';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import {
    fetchUsageSummary,
    fetchBudgetStatus,
    type UsageSummaryResponse,
    type BudgetStatusResponse,
  } from '$lib/api/usage';
  import HomeCard from './HomeCard.svelte';
  import { failed, type Load } from './home';

  let usage = $state<Load<UsageSummaryResponse>>({ kind: 'loading' });
  let budget = $state<Load<BudgetStatusResponse>>({ kind: 'loading' });

  $effect(() => {
    void workspaces.scopeKey;
    let cancelled = false;
    // Only the workspace drives a re-read; nothing the loaders touch may re-trigger it.
    untrack(() => {
      usage = { kind: 'loading' };
      budget = { kind: 'loading' };
      fetchUsageSummary('month').then(
        (value) => {
          if (!cancelled) usage = { kind: 'ready', value };
        },
        (err) => {
          if (!cancelled) usage = failed('usage', err);
        },
      );
      fetchBudgetStatus().then(
        (value) => {
          if (!cancelled) budget = { kind: 'ready', value };
        },
        (err) => {
          if (!cancelled) budget = failed('budget', err);
        },
      );
    });
    return () => {
      cancelled = true;
    };
  });

  const fmt = (n: number) => n.toLocaleString();

  function money(usd: string | null): string | null {
    if (usd === null) return null;
    const n = Number(usd);
    return Number.isFinite(n) ? n.toLocaleString(undefined, { style: 'currency', currency: 'USD' }) : null;
  }

  /** Allocation / consumed summed over the budgets that report them; null when none do. */
  const budgetTotals = $derived.by(() => {
    if (budget.kind !== 'ready') return null;
    const rows = budget.value.budgets;
    const withAlloc = rows.filter((b) => typeof b.budget_tokens === 'number');
    if (withAlloc.length === 0) return null;
    const allocated = withAlloc.reduce((s, b) => s + (b.budget_tokens ?? 0), 0);
    const reported = withAlloc.every((b) => typeof b.consumed_tokens === 'number');
    const consumed = reported ? withAlloc.reduce((s, b) => s + (b.consumed_tokens ?? 0), 0) : null;
    return { allocated, consumed };
  });
</script>

<HomeCard
  title="Spending this month"
  explain="What AI work in this workspace has cost so far this month, and how much budget is left."
  linkLabel="Usage details"
  linkHref="/settings/usage"
  testid="home-spend"
>
  <dl class="grid grid-cols-1 gap-3 sm:grid-cols-2">
    <div>
      <dt class="text-xs text-[var(--color-text-muted)]">Spent so far</dt>
      <dd data-testid="home-spend-usage">
        {#if usage.kind === 'loading'}
          <Skeleton variant="text" class="w-24" />
        {:else if usage.kind === 'error'}
          <span class="text-sm text-[var(--color-danger)]" role="alert">Couldn't load spending.</span>
        {:else}
          {@const cost = money(usage.value.billed_cost_usd)}
          <span class="text-lg font-semibold text-[var(--color-text)]">{cost ?? '—'}</span>
          <span class="block text-xs text-[var(--color-text-muted)]">
            {cost === null ? 'Cost not available yet · ' : ''}{fmt(usage.value.requests)}
            {usage.value.requests === 1 ? 'request' : 'requests'} · {fmt(usage.value.tokens)} tokens
          </span>
        {/if}
      </dd>
    </div>
    <div>
      <dt class="text-xs text-[var(--color-text-muted)]">Token budget</dt>
      <dd data-testid="home-spend-budget">
        {#if budget.kind === 'loading'}
          <Skeleton variant="text" class="w-24" />
        {:else if budget.kind === 'error'}
          <span class="text-sm text-[var(--color-danger)]" role="alert">Couldn't load the budget.</span>
        {:else if budget.value.budget_count === 0}
          <span class="text-sm text-[var(--color-text-muted)]">No budget set for this workspace.</span>
        {:else}
          <span class="text-lg font-semibold text-[var(--color-text)]">{fmt(budget.value.total_remaining)}</span>
          <span class="block text-xs text-[var(--color-text-muted)]">
            tokens left{budgetTotals
              ? budgetTotals.consumed !== null
                ? ` · ${fmt(budgetTotals.consumed)} of ${fmt(budgetTotals.allocated)} used`
                : ` of ${fmt(budgetTotals.allocated)}`
              : ''}
          </span>
        {/if}
      </dd>
    </div>
  </dl>
</HomeCard>
