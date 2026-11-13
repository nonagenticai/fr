<!--
  /admin/billing — tenant-admin: usage by project × member × FUNDING.

  Reads GET /api/tenant/usage/breakdown?from&to&group_by. One table: the chosen
  dimensions (project, member, app, provider, model, day) as rows, funding —
  who paid: Local GPU / Platform-paid / Own key (BYO) — as columns, a row total
  and a totals footer. Spend billing could not tie to a project / member / app
  is labelled "Unattributed", never dropped. Today's not-yet-rolled-up spend is
  one line from GET /api/me/usage/summary?window=today (`today_provisional`,
  the same workspace figure /settings/usage shows), read independently.

  Gate: inherits the workspace-admin OR super-admin gate from ../+layout.ts; the
  backend re-checks per-tenant workspace-admin membership.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { Button, Skeleton, ErrorState } from '$lib/components/ui';
  import { authFetch } from '$lib/api/auth-fetch';
  import { fetchUsageSummary, type TodayProvisional } from '$lib/api/usage';
  import { provisionalTodayLine } from '$lib/components/cost/cost';
  import { errorDetailOf } from '$lib/api/error-detail';
  import FundingSplit from '$lib/components/usage/FundingSplit.svelte';
  import UsageFundingTable from '$lib/components/usage/UsageFundingTable.svelte';
  import {
    DIM_HEADERS,
    formatUsd,
    lastDays,
    windowError,
    type UsageFundingBreakdown,
  } from '$lib/usage/funding';

  const SELECTABLE = ['project', 'actor', 'app', 'provider', 'model', 'day'] as const;

  const initial = lastDays(30);
  let from = $state(initial.from);
  let to = $state(initial.to);
  let dims = $state<string[]>(['project', 'actor']);

  let data = $state<UsageFundingBreakdown | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  const inputError = $derived(
    windowError(from, to) ?? (dims.length === 0 ? 'Pick at least one dimension to group by.' : null),
  );

  function toggle(d: string, on: boolean) {
    dims = on ? SELECTABLE.filter((x) => x === d || dims.includes(x)) : dims.filter((x) => x !== d);
  }

  async function load() {
    if (inputError) return;
    loading = true;
    loadError = null;
    try {
      const qs = new URLSearchParams({ from, to, group_by: [...dims, 'funding'].join(',') });
      const r = await authFetch(`/api/tenant/usage/breakdown?${qs}`);
      if (!r.ok) {
        const detail = await errorDetailOf(r);
        throw new Error(`Usage could not be read: ${r.status}${detail ? ` — ${detail}` : ''}`);
      }
      data = ((await r.json()) as { data: UsageFundingBreakdown }).data;
    } catch (e) {
      // Stale figures under a new range/grouping would read as its answer.
      data = null;
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  // Today's provisional (not yet rolled up) spend for the active workspace — the
  // breakdown below covers complete days only. Read once, independently: its
  // failure leaves the line "unavailable" and never blanks the breakdown.
  let provisional = $state<TodayProvisional | null>(null);
  let provisionalReason = $state<string | null>(null);
  let provisionalError = $state<string | null>(null);
  let provisionalLoaded = $state(false);
  async function loadProvisional() {
    try {
      const s = await fetchUsageSummary('today');
      provisional = s.today_provisional ?? null;
      provisionalReason = s.today_provisional_unavailable_reason ?? null;
      provisionalError = null;
    } catch (e) {
      // Rendered as "unavailable" with the reason beside it — never as $0.
      provisional = null;
      provisionalReason = null;
      provisionalError = e instanceof Error ? e.message : String(e);
    } finally {
      provisionalLoaded = true;
    }
  }

  // Initial load only; the form applies later changes (no refetch per keystroke).
  $effect(() => {
    untrack(() => {
      void load();
      void loadProvisional();
    });
  });

  const inputCls =
    'mt-1 block h-9 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-sm text-[var(--color-text)]';
</script>

<section class="p-6 space-y-6" data-testid="billing-page">
  <header class="space-y-1">
    <h1 class="text-2xl font-semibold">Spend breakdown</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      What this workspace used, by project and member, split by who paid: local GPU, platform-paid
      providers, or your own provider key (BYO). Dates are UTC and inclusive; complete days only.
    </p>
  </header>

  <form
    class="flex flex-wrap items-end gap-3"
    onsubmit={(e) => {
      e.preventDefault();
      void load();
    }}
  >
    <label class="text-sm">
      From
      <input type="date" bind:value={from} aria-label="From date" class={inputCls} />
    </label>
    <label class="text-sm">
      To
      <input type="date" bind:value={to} aria-label="To date" class={inputCls} />
    </label>
    <fieldset class="flex flex-wrap items-center gap-3 text-sm" data-testid="billing-group-by">
      <legend class="mb-1 text-[var(--color-text-muted)]">Group by</legend>
      {#each SELECTABLE as d (d)}
        <label class="inline-flex items-center gap-1">
          <input
            type="checkbox"
            checked={dims.includes(d)}
            onchange={(e) => toggle(d, (e.currentTarget as HTMLInputElement).checked)}
          />
          {DIM_HEADERS[d]}
        </label>
      {/each}
    </fieldset>
    <Button type="submit" variant="primary" disabled={loading || inputError !== null}>Apply</Button>
    {#if inputError}
      <p class="text-sm text-[var(--color-danger-text)]" data-testid="billing-range-error">{inputError}</p>
    {/if}
  </form>

  {#if loading}
    <div class="space-y-2">
      {#each Array(4) as _, i (i)}<Skeleton class="h-10 w-full" />{/each}
    </div>
  {:else if loadError}
    <ErrorState error={loadError} onRetry={load} />
  {:else if data}
    <section class="space-y-2" data-testid="billing-summary">
      <div class="flex flex-wrap items-baseline gap-3">
        <div class="text-3xl font-semibold tabular-nums">{formatUsd(data.totals.cost_usd)}</div>
        <div class="text-sm text-[var(--color-text-muted)]">
          {data.totals.events.toLocaleString()} calls · {data.from} → {data.to}
          {#if data.cost_basis === 'incurred'} · incurred (provider) cost{:else if data.cost_basis === 'billed'} · billed{/if}
        </div>
      </div>
      {#if provisionalLoaded}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="billing-today-provisional">
          {provisionalTodayLine(provisional, provisionalReason)}{#if provisionalError}{' '}<span class="font-mono text-xs"
              >({provisionalError})</span
            >{/if}
        </p>
      {/if}
      <FundingSplit byFunding={data.by_funding} testid="billing-funding" />
      {#if data.cost_basis === 'unavailable'}
        <p class="text-sm text-[var(--color-warning-text)]" data-testid="billing-cost-withheld">
          Billed amounts for platform-funded usage cannot be established right now, so they show “—”.
          This is not $0. Your own-key (BYO) spend is shown as your provider billed it.
        </p>
      {/if}
      {#if data.names_unavailable.projects || data.names_unavailable.actors}
        <p class="text-sm text-[var(--color-warning-text)]" data-testid="billing-names-unavailable">
          Some names could not be looked up, so those rows show an id instead. The amounts are unaffected.
        </p>
      {/if}
    </section>

    <UsageFundingTable {data} testid="billing-table" />
  {/if}
</section>
