<script lang="ts">
  // /settings/usage — "My usage by project and funding".
  //
  // Reads GET /api/me/usage/funding (billing /api/usage/breakdown/me with the
  // caller's own sub): only the signed-in user's usage, per project, split by
  // who paid — Local GPU / Platform-paid / Own key (BYO). Self-contained so the
  // page's other panels neither wait on nor fail with it.
  import { untrack } from 'svelte';
  import { Button } from '$lib/components/ui';
  import { authFetch } from '$lib/api/auth-fetch';
  import FundingSplit from './FundingSplit.svelte';
  import UsageFundingTable from './UsageFundingTable.svelte';
  import { lastDays, windowError, formatUsd, type UsageFundingBreakdown } from '$lib/usage/funding';

  const initial = lastDays(30);
  let from = $state(initial.from);
  let to = $state(initial.to);
  let data = $state<UsageFundingBreakdown | null>(null);
  let loading = $state(true);
  let error = $state<string | null>(null);
  const inputError = $derived(windowError(from, to));

  async function load() {
    if (windowError(from, to)) return;
    loading = true;
    error = null;
    try {
      const qs = new URLSearchParams({ from, to, group_by: 'project,funding' });
      const r = await authFetch(`/api/me/usage/funding?${qs}`);
      if (!r.ok) throw new Error(`Usage by funding could not be read (${r.status}).`);
      const body = (await r.json()) as { data?: UsageFundingBreakdown };
      if (!body?.data || !Array.isArray(body.data.rows)) {
        throw new Error('Usage by funding could not be read (unexpected response).');
      }
      data = body.data;
    } catch (e) {
      data = null;
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    untrack(() => void load());
  });

  const inputCls =
    'mt-1 block h-8 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs text-[var(--color-text)]';
</script>

<div
  class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid="usage-by-funding"
>
  <header class="mb-3 flex flex-wrap items-end justify-between gap-3">
    <div>
      <h2 class="text-sm font-medium">My usage by project and funding</h2>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Who paid for your usage: local GPU, platform-paid providers, or your workspace's own key (BYO).
        Complete UTC days only.
      </p>
    </div>
    <form
      class="flex items-end gap-2"
      onsubmit={(e) => {
        e.preventDefault();
        void load();
      }}
    >
      <label class="text-xs">From<input type="date" bind:value={from} aria-label="Funding from date" class={inputCls} /></label>
      <label class="text-xs">To<input type="date" bind:value={to} aria-label="Funding to date" class={inputCls} /></label>
      <Button type="submit" variant="secondary" disabled={loading || inputError !== null}>Apply</Button>
    </form>
  </header>
  {#if inputError}
    <p class="text-xs text-[var(--color-danger-text)]">{inputError}</p>
  {/if}
  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
  {:else if error}
    <p class="text-xs text-[var(--color-warning-text)]" role="alert" data-testid="usage-by-funding-error">{error}</p>
  {:else if data}
    <div class="mb-3 flex flex-wrap items-center gap-3">
      <span class="text-lg font-semibold tabular-nums">{formatUsd(data.totals.cost_usd)}</span>
      <FundingSplit byFunding={data.by_funding} testid="usage-by-funding-split" />
    </div>
    {#if data.cost_basis === 'unavailable'}
      <p class="mb-2 text-xs text-[var(--color-warning-text)]">
        Billed amounts for platform-funded usage cannot be established right now (“—”). This is not $0.
      </p>
    {/if}
    <UsageFundingTable {data} testid="usage-by-funding-table" />
  {/if}
</div>
