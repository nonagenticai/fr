<!--
  /settings/usage — "My Usage" page.

  Foundation Plan 4 Lane A. Renders the authenticated user's metering
  data via the backend `/api/me/usage/*` endpoints:
    * Headline cards: requests today / this month, tokens (month),
      internal cost (month).
    * 30-day chart: real per-bucket data from the upstream
      metering_service. When the granularity has no cost rollup
      (hourly today) cost_unavailable is set on the response and we
      omit cost numbers from the chart card; we still render the
      requests sparkline.
    * Per-service breakdown table with tokens + cost columns.
      cost_usd renders as `—` when the upstream reports
      cost_unavailable=true.
    * My quota vs my consumption: today every quota is null
      (= unmetered) because upstream has no per-user quota concept yet.

  Data is fetched in onMount: every helper uses authFetch which reads
  the Bearer token from the in-browser auth store, so there's nothing
  to load SSR-side. The shell renders immediately, then swaps to the
  data view once all five calls resolve.

  Logic lives in page-helpers.ts so vitest can verify it without DOM.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import Sparkline from '$lib/components/analytics/Sparkline.svelte';
  import MyUsageByFunding from '$lib/components/usage/MyUsageByFunding.svelte';
  import {
    fetchBudgetStatus,
    fetchUsageBreakdown,
    fetchUsageQuota,
    fetchUsageSeries,
    fetchUsageSummary,
    fetchMyPlan,
    type BudgetStatusResponse,
    type UsageBreakdownResponse,
    type UsageQuotaResponse,
    type UsageSeriesResponse,
    type UsageSummaryResponse,
    type MyPlanResponse,
  } from '$lib/api/usage';
  import { authFetch } from '$lib/api/auth-fetch';
  import { auth } from '$lib/stores/auth.svelte';
  import {
    formatNumber,
    formatCostUsd,
    breakdownCostCell,
    breakdownCostNote,
    breakdownMetricCell,
    breakdownTotalsNote,
    budgetConsumption,
    budgetReconciliationNote,
    quotaLabel,
    quotaPercent,
    planTileState,
    includedUsagePercent,
  } from './page-helpers';
  import { provisionalTodayLine } from '$lib/components/cost/cost';

  // W5 per-tenant breakdown response (mirrors backend
  // routes/me/usage.ts:PerTenantUsageResponse). Kept inline rather than
  // in $lib/api/usage.ts so this page's worktree stays self-contained.
  interface PerTenantUsageEntry {
    tenant_id: string;
    tenant_name: string | null;
    today: { requests: number; cost_usd: string };
    month: { requests: number; cost_usd: string };
  }
  interface PerTenantUsageResponse {
    items: PerTenantUsageEntry[];
  }

  let summaryToday = $state<UsageSummaryResponse | null>(null);
  let summaryMonth = $state<UsageSummaryResponse | null>(null);
  let series = $state<UsageSeriesResponse | null>(null);
  let breakdown = $state<UsageBreakdownResponse | null>(null);
  let quota = $state<UsageQuotaResponse | null>(null);
  let budget = $state<BudgetStatusResponse | null>(null);
  let budgetError = $state<string | null>(null);
  let perTenant = $state<PerTenantUsageResponse | null>(null);
  let perTenantError = $state<string | null>(null);
  let plan = $state<MyPlanResponse | null>(null);
  let planError = $state<string | null>(null);
  let planLoaded = $state(false);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  // "Your plan" tile: shows the fee when there is one, an explicit unreadable
  // state when the billing read failed, and nothing only when the read
  // SUCCEEDED and there genuinely is no recurring access fee. Hiding the tile
  // on failure is how the free tier renders — see planTileState's comment.
  const planState = $derived(
    planTileState({ plan, error: planError, loaded: planLoaded }),
  );

  // Audience-aware cost field selector. Super-admin sees the raw
  // provider/incurred number; everyone else sees the billed (markup-applied)
  // number that matches what they're charged.
  const isSuperAdmin = $derived(auth.isSuperAdmin);
  // The backend sends incurred cost to super-admins only, so `internal` is
  // absent for everyone else; the billed figure is always present.
  function costField(internal: string | undefined, billed: string | null): string | null {
    return isSuperAdmin ? (internal ?? billed) : billed;
  }

  const sparkValues = $derived(
    series ? series.buckets.map((b: { requests: number }) => b.requests) : [],
  );

  // Show the BYO provider-cost estimate column only when at least one service
  // carries an estimate (i.e. the tenant has BYO usage priced by a list rate).
  const hasByoEstimate = $derived(
    (breakdown?.services ?? []).some(
      (s) => s.provider_estimate_usd != null && s.provider_estimate_usd !== '',
    ),
  );

  // Cross-panel honesty captions. Each returns null when there is nothing to
  // explain, so a page whose numbers DO reconcile stays quiet.
  const totalsNote = $derived(
    summaryMonth && breakdown
      ? breakdownTotalsNote({
          monthRequests: summaryMonth.requests,
          monthTokens: summaryMonth.tokens,
          rows: breakdown.services,
        })
      : null,
  );
  const costNote = $derived(
    summaryMonth && breakdown
      ? breakdownCostNote(
          breakdown.cost_unavailable,
          costField(summaryMonth.internal_cost_usd, summaryMonth.billed_cost_usd),
          isSuperAdmin ? 'incurred (provider)' : 'billed',
        )
      : null,
  );
  const budgetNote = $derived(
    budget && summaryMonth
      ? budgetReconciliationNote({
          budgets: budget.budgets,
          monthTokens: summaryMonth.tokens,
        })
      : null,
  );

  async function fetchPerTenantUsage(): Promise<PerTenantUsageResponse> {
    const r = await authFetch('/api/me/usage/by-tenant');
    if (!r.ok) throw new Error(`fetchPerTenantUsage: ${r.status}`);
    return (await r.json()) as PerTenantUsageResponse;
  }

  onMount(async () => {
    try {
      const [today, month, ser, brk, quo] = await Promise.all([
        fetchUsageSummary('today'),
        fetchUsageSummary('month'),
        fetchUsageSeries('daily'),
        fetchUsageBreakdown(),
        fetchUsageQuota(),
      ]);
      summaryToday = today;
      summaryMonth = month;
      series = ser;
      breakdown = brk;
      quota = quo;
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load usage';
    } finally {
      loading = false;
    }
    // Budget status — additive; treat any failure as "no budget configured"
    // so the panel renders cleanly without blocking the page.
    try {
      budget = await fetchBudgetStatus();
    } catch (err) {
      budgetError = err instanceof Error ? err.message : 'Failed to load budget';
    }
    // "Your plan" access charges — additive to the page (a failure must not
    // blank the usage tables that did load), but NOT silent: hiding the tile is
    // indistinguishable from being on no plan at all.
    try {
      plan = await fetchMyPlan();
      planError = null;
    } catch (err) {
      plan = null;
      planError = err instanceof Error ? err.message : 'Failed to load your plan';
    } finally {
      planLoaded = true;
    }
    // Super-admin per-tenant breakdown — additive; failures here don't
    // hide the primary single-tenant view. Fired after the main load so
    // a slow per-tenant fan-out doesn't gate the initial render.
    if (auth.isSuperAdmin) {
      try {
        perTenant = await fetchPerTenantUsage();
      } catch (err) {
        perTenantError =
          err instanceof Error ? err.message : 'Failed to load per-tenant usage';
      }
    }
  });
</script>

<section class="flex flex-col gap-6 p-6" data-testid="usage-page">
  <header>
    <h1 class="text-xl font-semibold">Workspace usage</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Request volume, tokens, and cost for the active workspace (use the workspace
      switcher to change scope), from the metering service.
    </p>
  </header>

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading usage…</p>
  {:else if loadError}
    <div
      class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] dark:bg-[var(--color-danger-bg)]/20 p-4 text-sm text-[var(--color-danger)] dark:text-[var(--color-danger-text)]"
      role="alert"
    >
      {loadError}
    </div>
  {:else if summaryToday && summaryMonth && series && breakdown && quota}
    <!-- Headline counters -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-4" data-testid="usage-summary-cards">
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Requests today</p>
        <p class="text-2xl font-semibold">{formatNumber(summaryToday.requests)}</p>
      </div>
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Requests this month</p>
        <p class="text-2xl font-semibold">{formatNumber(summaryMonth.requests)}</p>
      </div>
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Tokens this month</p>
        <p class="text-2xl font-semibold">{formatNumber(summaryMonth.tokens)}</p>
      </div>
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      >
        <p class="text-xs uppercase text-[var(--color-text-muted)]">
          {isSuperAdmin ? 'Incurred (provider) cost this month' : 'Billed cost this month'}
        </p>
        <p class="text-2xl font-semibold">
          {formatCostUsd(costField(summaryMonth.internal_cost_usd, summaryMonth.billed_cost_usd))}
        </p>
      </div>
    </div>
    <!-- Today's spend is not in the settled figures above until the nightly rollup. -->
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="usage-today-provisional">
      {provisionalTodayLine(summaryToday.today_provisional, summaryToday.today_provisional_unavailable_reason)}
    </p>

    <!-- Your plan (ACCESS-billing axis) -->
    {#if planState === 'unreadable'}
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-warning-border,var(--color-border))] bg-[var(--color-surface)] p-4"
        data-testid="usage-plan-unreadable"
        role="alert"
      >
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Your plan</p>
        <p class="mt-1 text-sm text-[var(--color-warning-text)]">
          Your plan could not be read. This is <strong>not</strong> a statement that you are
          on a free plan — any recurring access fee and included usage are unknown right
          now.
        </p>
        {#if planError}
          <p class="mt-1 text-xs font-mono text-[var(--color-text-muted)]">{planError}</p>
        {/if}
      </div>
    {:else if planState === 'loading'}
      <p class="text-xs text-[var(--color-text-muted)]" role="status">Loading your plan…</p>
    {:else if planState === 'plan' && plan}
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="usage-plan"
      >
        <div class="flex items-baseline justify-between">
          <p class="text-xs uppercase text-[var(--color-text-muted)]">Your plan</p>
          <p class="text-2xl font-semibold" data-testid="usage-plan-total">
            {formatCostUsd(plan.monthly_total_usd)}<span
              class="text-sm font-normal text-[var(--color-text-muted)]">/mo</span
            >
          </p>
        </div>
        {#if Number.parseFloat(plan.monthly_included_usd) > 0}
          {@const pct = includedUsagePercent(plan.included_used_usd, plan.monthly_included_usd)}
          <div class="mt-1" data-testid="usage-plan-included">
            <p class="text-sm text-[var(--color-text-muted)]">
              {formatCostUsd(plan.included_used_usd)} of {formatCostUsd(plan.monthly_included_usd)}/mo
              usage included ·
              <span class="font-medium text-[var(--color-text)]"
                >{formatCostUsd(plan.included_remaining_usd)} left</span
              >
            </p>
            {#if pct !== null}
              <div
                class="mt-1 h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-border)]"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label="Included usage consumed"
              >
                <div class="h-full rounded-full bg-[var(--color-accent)]" style="width: {pct}%"></div>
              </div>
            {/if}
          </div>
        {/if}
        <ul class="mt-2 space-y-1 text-sm">
          {#each plan.access_charges as charge (charge.service_key ?? 'tenant-wide')}
            {@const hasUsage =
              charge.used_usd != null &&
              charge.included_cost_usd != null &&
              Number.parseFloat(charge.included_cost_usd) > 0}
            <li class="flex flex-col" data-testid="usage-plan-charge">
              <div class="flex justify-between">
                <span>{charge.service_key ?? 'All products'}</span>
                <span class="text-[var(--color-text-muted)]">
                  {formatCostUsd(charge.amount_usd)}
                  {charge.cadence === 'one_time' ? 'one-time' : '/mo'}
                  {#if charge.included_cost_usd && Number.parseFloat(charge.included_cost_usd) > 0}
                    · {formatCostUsd(charge.included_cost_usd)} incl.
                  {/if}
                </span>
              </div>
              {#if hasUsage}
                <span
                  class="text-xs text-[var(--color-text-muted)]"
                  data-testid="usage-plan-charge-usage"
                >
                  {formatCostUsd(charge.used_usd ?? '0')} used ·
                  <span class="font-medium text-[var(--color-text)]"
                    >{formatCostUsd(charge.remaining_usd)} left</span
                  >
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      </div>
    {/if}

    <!-- 30-day chart -->
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="usage-chart"
    >
      <header class="mb-3 flex items-baseline justify-between">
        <h2 class="text-sm font-medium">Requests, last 30 days</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          Granularity: {series.granularity}
        </p>
      </header>
      {#if series.buckets.length === 0}
        <p
          class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] p-4 text-center text-xs text-[var(--color-text-muted)]"
          data-testid="usage-chart-empty"
        >
          No requests recorded in the last 30 days.
        </p>
      {:else}
        <Sparkline values={sparkValues} width={640} height={80} />
      {/if}
    </div>

    <!-- Budget panel -->
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="usage-budget"
    >
      <header class="mb-3">
        <h2 class="text-sm font-medium">Token budget (active tenant)</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          Consumption vs. allocation for the workspace you're in.
        </p>
      </header>
      {#if budgetError}
        <p class="text-xs text-[var(--color-danger)]" role="alert">{budgetError}</p>
      {:else if budget === null}
        <p class="text-xs text-[var(--color-text-muted)]" role="status">Loading budget…</p>
      {:else if budget.budget_count === 0}
        <p class="text-xs text-[var(--color-text-muted)]">No budget configured for this tenant.</p>
      {:else}
        {#if budgetNote}
          <p
            class="mb-3 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2 text-xs text-[var(--color-text-muted)]"
            data-testid="usage-budget-reconciliation-note"
            role="note"
          >
            {budgetNote}
          </p>
        {/if}
        <div class="flex flex-col gap-3">
          {#each budget.budgets as b (b.budget_id ?? b.source ?? Math.random())}
            {@const c = budgetConsumption(b)}
            <div>
              <div class="flex items-baseline justify-between text-sm">
                <span>
                  {b.source ?? 'budget'}
                  {#if b.period}<span class="text-[var(--color-text-muted)]"> · {b.period}</span>{/if}
                </span>
                <span
                  class="text-[var(--color-text-muted)]"
                  data-testid="usage-budget-consumption"
                  title={c.kind === 'unreported' ? c.title : undefined}
                >
                  {c.consumedText} / {c.allocationText} tokens{#if c.pct !== null} · {c.pct}%{:else if c.kind === 'unreported'} · not reported{/if}
                </span>
              </div>
              {#if c.pct !== null}
                <div class="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
                  <div class="h-2 bg-[var(--color-accent)]" style="width: {c.pct}%"></div>
                </div>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

    <!-- Per-service breakdown -->
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="usage-breakdown"
    >
      <header class="mb-3">
        <h2 class="text-sm font-medium">By service, last 30 days</h2>
        {#if totalsNote}
          <p
            class="mt-1 text-xs text-[var(--color-text-muted)]"
            data-testid="usage-breakdown-window-note"
            role="note"
          >
            {totalsNote}
          </p>
        {/if}
        {#if costNote}
          <p
            class="mt-1 text-xs text-[var(--color-text-muted)]"
            data-testid="usage-breakdown-cost-note"
            role="note"
          >
            {costNote}
          </p>
        {/if}
      </header>
      {#if breakdown.services.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]">No requests recorded in the last 30 days.</p>
      {:else}
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase text-[var(--color-text-muted)]">
              <th class="py-2">Service</th>
              <th class="py-2 text-right">Requests</th>
              <th class="py-2 text-right">Tokens</th>
              <th class="py-2 text-right">{isSuperAdmin ? 'Incurred' : 'Billed'} cost</th>
              {#if hasByoEstimate}
                <th class="py-2 text-right" title="Estimated cost on your own provider's public list price (BYO)">
                  Est. provider (BYO)
                </th>
              {/if}
            </tr>
          </thead>
          <tbody>
            {#each breakdown.services as svc (svc.service)}
              {@const requestsCell = breakdownMetricCell('requests', svc)}
              {@const tokensCell = breakdownMetricCell('tokens', svc)}
              <tr class="border-b border-[var(--color-border)] last:border-b-0">
                <td class="py-2 font-mono text-xs">{svc.service}</td>
                <td
                  class="py-2 text-right {requestsCell.kind === 'unattributed'
                    ? 'text-[var(--color-text-muted)]'
                    : ''}"
                  data-testid="breakdown-requests-cell"
                  title={requestsCell.kind === 'unattributed' ? requestsCell.title : undefined}
                >{requestsCell.text}</td>
                <td
                  class="py-2 text-right {tokensCell.kind === 'unattributed'
                    ? 'text-[var(--color-text-muted)]'
                    : ''}"
                  data-testid="breakdown-tokens-cell"
                  title={tokensCell.kind === 'unattributed' ? tokensCell.title : undefined}
                >{tokensCell.text}</td>
                <td class="py-2 text-right" data-testid="breakdown-cost-cell">
                  {breakdownCostCell(
                    costField(svc.cost_usd, svc.billed_cost_usd),
                    breakdown.cost_unavailable,
                  )}
                </td>
                {#if hasByoEstimate}
                  <td class="py-2 text-right text-[var(--color-text-muted)]" data-testid="breakdown-byo-estimate-cell">
                    {svc.provider_estimate_usd != null && svc.provider_estimate_usd !== ''
                      ? formatCostUsd(svc.provider_estimate_usd)
                      : '—'}
                  </td>
                {/if}
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- My usage by project × funding (billing /api/usage/breakdown/me) -->
    <MyUsageByFunding />

    <!-- Quota vs consumption -->
    <div
      class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
      data-testid="usage-quota"
    >
      <header class="mb-3">
        <h2 class="text-sm font-medium">Quota vs consumption (this month)</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          Per-user quotas are not enforced today — license-level quotas remain on the
          Licenses &amp; tokens page.
        </p>
      </header>
      <div class="flex flex-col gap-3">
        {#each [
          {
            label: 'Requests',
            consumed: quota.requests_per_month.consumed,
            quota: quota.requests_per_month.quota,
            consumedDisplay: formatNumber(quota.requests_per_month.consumed),
          },
          {
            label: 'Tokens',
            consumed: quota.tokens_per_month.consumed,
            quota: quota.tokens_per_month.quota,
            consumedDisplay: formatNumber(quota.tokens_per_month.consumed),
          },
          {
            // Super-admins get incurred cost here; everyone else gets billed.
            label: isSuperAdmin ? 'Internal cost (USD)' : 'Cost (USD)',
            consumed: 0, // unused for cost row, we display the string directly
            quota: quota.cost_usd_per_month.quota,
            consumedDisplay: formatCostUsd(quota.cost_usd_per_month.consumed),
          },
        ] as row (row.label)}
          <div>
            <div class="flex items-baseline justify-between text-sm">
              <span>{row.label}</span>
              <span class="text-[var(--color-text-muted)]">
                {row.quota === null ? row.consumedDisplay + ' (unmetered)' : quotaLabel(row.consumedDisplay, row.quota)}
              </span>
            </div>
            {#if quotaPercent(row.consumed, row.quota) !== null}
              <div class="mt-1 h-2 w-full overflow-hidden rounded-full bg-[var(--color-bg)]">
                <div
                  class="h-2 bg-[var(--color-accent)]"
                  style="width: {quotaPercent(row.consumed, row.quota)}%"
                ></div>
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>

    {#if auth.isSuperAdmin}
      <!-- W5: per-tenant breakdown — super-admin only -->
      <div
        class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
        data-testid="usage-by-tenant"
      >
        <header class="mb-3">
          <h2 class="text-sm font-medium">Per-tenant breakdown</h2>
          <p class="text-xs text-[var(--color-text-muted)]">
            Super-admin view — every workspace you can act in. Today + this month, scoped per tenant.
          </p>
        </header>
        {#if perTenantError}
          <p class="text-xs text-[var(--color-danger)]" role="alert">
            {perTenantError}
          </p>
        {:else if perTenant === null}
          <p class="text-xs text-[var(--color-text-muted)]" role="status">
            Loading per-tenant usage…
          </p>
        {:else if perTenant.items.length === 0}
          <p class="text-xs text-[var(--color-text-muted)]">No tenants accessible.</p>
        {:else}
          <table class="w-full text-sm">
            <thead>
              <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase text-[var(--color-text-muted)]">
                <th class="py-2">Tenant</th>
                <th class="py-2 text-right">Today requests</th>
                <th class="py-2 text-right">Today cost</th>
                <th class="py-2 text-right">Month requests</th>
                <th class="py-2 text-right">Month cost</th>
              </tr>
            </thead>
            <tbody>
              {#each perTenant.items as row (row.tenant_id)}
                <tr class="border-b border-[var(--color-border)] last:border-b-0">
                  <td class="py-2">
                    <span class="font-medium">{row.tenant_name ?? row.tenant_id}</span>
                  </td>
                  <td class="py-2 text-right">{formatNumber(row.today.requests)}</td>
                  <td class="py-2 text-right">{formatCostUsd(row.today.cost_usd)}</td>
                  <td class="py-2 text-right">{formatNumber(row.month.requests)}</td>
                  <td class="py-2 text-right">{formatCostUsd(row.month.cost_usd)}</td>
                </tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    {/if}
  {/if}
</section>
