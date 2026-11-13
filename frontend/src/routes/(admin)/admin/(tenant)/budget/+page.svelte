<!--
  /admin/budget — tenant-admin: view budget + top up.

  A workspace-admin sees THIS workspace's token budget (remaining, per-budget
  bars, next expiry) and tops it up by picking a package. Top-up is FREE today
  (the fleet has no payment processor) — the backend runs it through a payment
  seam so a future Stripe integration needs no change here; when packages get a
  non-zero price, this screen already shows it.

  Gate: inherits the workspace-admin OR super-admin gate from
  settings/admin/+layout.svelte. The backend re-checks per-tenant workspace-admin
  membership on the top-up write.
-->
<script lang="ts">
  import { Button, Combobox, Pill, Skeleton, EmptyState, ErrorState } from '$lib/components/ui';
  import { fetchBudgetStatus, type BudgetStatusResponse } from '$lib/api/usage';
  import {
    listTopUpPackages,
    topUpMyBudget,
    listMyTopUps,
    type TopUpPackage,
    type TopUpRecord,
  } from '$lib/api/budget';
  import {
    formatTokens,
    budgetRemaining,
    consumedFraction,
    isLowBudget,
    packageOptions,
    historyPanelState,
  } from './page-helpers';

  let status = $state<BudgetStatusResponse | null>(null);
  let packages = $state<TopUpPackage[]>([]);
  // BUDGET_TOPUP_ENABLED (backend kill switch, off until a payment gateway
  // exists — no free top-up). False hides the whole Top up section.
  let topupEnabled = $state(false);
  let history = $state<TopUpRecord[]>([]);
  // The history read stays non-fatal — it must not blank the remaining-tokens
  // figure or the top-up form — but its failure is RECORDED, because an empty
  // list renders as "this workspace has never been topped up".
  let historyError = $state<string | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  const historyState = $derived(historyPanelState(history.length, historyError));

  async function load() {
    loading = true;
    loadError = null;
    historyError = null;
    try {
      const [s, p, h] = await Promise.all([
        fetchBudgetStatus(),
        listTopUpPackages(),
        listMyTopUps().catch((e) => {
          historyError = e instanceof Error ? e.message : String(e);
          return [] as TopUpRecord[];
        }),
      ]);
      status = s;
      packages = p.packages;
      topupEnabled = p.topupEnabled;
      history = h;
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void load();
  });

  const low = $derived(status ? isLowBudget(status) : false);
  const pkgOpts = $derived(packageOptions(packages));

  // ---- top up -----------------------------------------------------------
  let selectedPackage = $state<string | null>(null);
  let toppingUp = $state(false);
  let topupError = $state<string | null>(null);
  let topupNotice = $state<string | null>(null);

  const selectedPkg = $derived(packages.find((p) => p.id === selectedPackage) ?? null);

  async function doTopUp() {
    if (!selectedPkg) return;
    const priced = selectedPkg.priceUsd > 0;
    if (
      !confirm(
        `Add ${formatTokens(selectedPkg.tokens)} tokens to this workspace's budget` +
          (priced ? ` for $${selectedPkg.priceUsd}?` : ' (free)?'),
      )
    )
      return;
    toppingUp = true;
    topupError = null;
    topupNotice = null;
    try {
      // Minted HERE, at confirm time, so every replay of THIS intent carries the
      // same key and the backend allocates once (migration 118). Minting it
      // inside the api helper would hand each retry a fresh key.
      const res = await topUpMyBudget(selectedPkg.id, crypto.randomUUID());
      topupNotice = `Added ${formatTokens(res.tokens)} tokens (${res.payment_status}).`;
      selectedPackage = null;
      await load();
    } catch (e) {
      topupError = e instanceof Error ? e.message : String(e);
    } finally {
      toppingUp = false;
    }
  }
</script>

<section class="p-6 space-y-8" data-testid="budget-page">
  <header>
    <h1 class="text-2xl font-semibold">Budget</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      This workspace's token budget.{#if topupEnabled} Top up when you're running low.{/if}
    </p>
  </header>

  {#if loading}
    <div class="space-y-2">
      {#each Array(3) as _, i (i)}<Skeleton class="h-12 w-full" />{/each}
    </div>
  {:else if loadError}
    <ErrorState error={loadError} onRetry={load} />
  {:else if status}
    <!-- Remaining ------------------------------------------------------- -->
    <section class="space-y-3" data-testid="budget-summary">
      <div class="flex items-center gap-3">
        <span class="text-3xl font-semibold">{formatTokens(status.total_remaining)}</span>
        <span class="text-sm text-[var(--color-text-muted)]">tokens remaining</span>
        {#if low}
          <span data-testid="low-budget"><Pill tone="warning">Running low</Pill></span>
        {/if}
      </div>

      {#if status.budgets.length === 0}
        <EmptyState
          title="No budget configured"
          body={topupEnabled
            ? 'This workspace has no token budget yet. Top one up below.'
            : 'This workspace has no token budget yet.'}
        />
      {:else}
        <ul class="space-y-2">
          {#each status.budgets as b (b.budget_id ?? b.source)}
            <li class="space-y-1" data-testid="budget-line">
              <div class="flex justify-between text-sm">
                <span>
                  {b.source ?? 'budget'}
                  {#if b.period}<span class="text-[var(--color-text-muted)]"> · {b.period}</span>{/if}
                </span>
                <span class="text-[var(--color-text-muted)]">
                  {formatTokens(budgetRemaining(b))} / {formatTokens(b.budget_tokens ?? 0)}
                </span>
              </div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-[var(--color-surface-strong)]">
                <div
                  class="h-full bg-[var(--color-accent)]"
                  style={`width:${Math.round(consumedFraction(b) * 100)}%`}
                ></div>
              </div>
            </li>
          {/each}
        </ul>
      {/if}
    </section>

    <!-- Top up ---------------------------------------------------------- -->
    {#if topupEnabled}
    <section class="space-y-3" data-testid="topup-section">
      <h2 class="text-lg font-semibold">Top up</h2>
      <p class="text-sm text-[var(--color-text-muted)]">
        Add tokens to this workspace. Top-ups are free while billing is being set up.
      </p>
      <div class="flex flex-wrap items-center gap-2 max-w-lg">
        <div class="min-w-56 flex-1">
          <Combobox
            bind:value={selectedPackage}
            options={pkgOpts}
            placeholder="Choose an amount…"
            emptyLabel="Choose an amount…"
            data-testid="package-picker"
          />
        </div>
        <Button variant="primary" disabled={!selectedPkg || toppingUp} onclick={doTopUp}>
          {toppingUp ? 'Adding…' : 'Top up'}
        </Button>
      </div>
      {#if topupNotice}
        <p class="text-sm text-[var(--color-success-text)]" data-testid="topup-notice">{topupNotice}</p>
      {/if}
      {#if topupError}
        <p class="text-sm text-[var(--color-danger-text)]" data-testid="topup-error">{topupError}</p>
      {/if}
    </section>
    {/if}

    <!-- History --------------------------------------------------------- -->
    {#if historyState === 'unreadable'}
      <section class="space-y-2">
        <h2 class="text-lg font-semibold">Recent top-ups</h2>
        <p
          class="text-sm text-[var(--color-warning-text)]"
          data-testid="topup-history-unreadable"
          role="alert"
        >
          Recent top-ups could not be read, so this is not a record that none were
          made. Any top-up you just completed may still have been applied — the
          remaining-token figure above is the authoritative one.
        </p>
        <p class="text-xs font-mono text-[var(--color-text-muted)]">{historyError}</p>
      </section>
    {:else if historyState === 'rows'}
      <section class="space-y-2">
        <h2 class="text-lg font-semibold">Recent top-ups</h2>
        <div class="overflow-x-auto">
          <table class="w-full text-sm">
            <thead class="text-left text-[var(--color-text-muted)]">
              <tr class="border-b border-[var(--color-border)]">
                <th class="py-2 pr-3 font-medium">When</th>
                <th class="py-2 pr-3 font-medium">Amount</th>
                <th class="py-2 pr-3 font-medium">Payment</th>
                <th class="py-2 pr-3 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {#each history as t (t.id)}
                <tr class="border-b border-[var(--color-border)]" data-testid="topup-row">
                  <td class="py-2 pr-3">{new Date(t.created_at).toLocaleString()}</td>
                  <td class="py-2 pr-3">{formatTokens(t.tokens)}</td>
                  <td class="py-2 pr-3">{t.payment_status}</td>
                  <td class="py-2 pr-3">
                    <Pill tone={t.status === 'allocated' ? 'success' : t.status === 'failed' ? 'danger' : 'neutral'}>
                      {t.status}
                    </Pill>
                  </td>
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </section>
    {/if}
  {/if}
</section>
