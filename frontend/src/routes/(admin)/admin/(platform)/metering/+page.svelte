<!--
  /admin/metering — super-admin system-wide metering dashboard.

  Crosses every tenant; deliberately ignores the WorkspaceSwitcher's
  active tenant. Shows what we paid external providers (incurred) AND
  what we billed tenants (markup applied), with the delta as margin.

  Sections:
    * System totals (window selector: today / month / 30d)
      requests · tokens · incurred USD · billed USD · margin
    * By tenant — per-tenant incurred + markup_pct + billed
    * By provider — incurred only (we don't bill providers)

  Auth: page renders the "forbidden" state for non-super-admin users
  (server still 403s the underlying /api/admin/usage/system call).
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import {
    fetchAdminSystemUsage,
    type AdminSystemUsageResponse,
    type AdminUsageWindow,
  } from '$lib/api/usage';
  import { auth } from '$lib/stores/auth.svelte';
  import { formatNumber } from '../../../../settings/usage/page-helpers';
  // ⚠️ `formatCostUsd` is deliberately NOT imported any more. It answers an
  // unreadable amount with `'$0.00'`, which on THIS page is a claim about
  // money nobody measured. `moneyCell`/`marginCell` render `—` with a reason
  // instead; see page-helpers.ts for why the sibling helper keeps its own
  // behaviour rather than being changed underneath /settings/usage.
  import { moneyCell, marginCell } from './page-helpers';

  let window: AdminUsageWindow = $state('month');
  let data = $state<AdminSystemUsageResponse | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      data = await fetchAdminSystemUsage(window);
    } catch (err) {
      loadError = err instanceof Error ? err.message : 'Failed to load metering';
    } finally {
      loading = false;
    }
  }

  onMount(load);

  async function selectWindow(w: AdminUsageWindow): Promise<void> {
    if (w === window) return;
    window = w;
    await load();
  }
</script>

<section class="flex flex-col gap-6 p-6" data-testid="admin-metering-page">
  <header class="flex items-baseline justify-between">
    <div>
      <h1 class="text-xl font-semibold">System metering</h1>
      <p class="text-sm text-[var(--color-text-muted)]">
        Provider/incurred vs. billed spend across every tenant. Super-admin only.
      </p>
    </div>
    <div class="flex gap-2 text-xs" data-testid="window-selector">
      {#each ['today', 'month', '30d', '7d'] as w (w)}
        <button
          type="button"
          class="rounded border px-2 py-1 {window === w ? 'border-[var(--color-accent)] bg-[var(--color-accent)] text-white' : 'border-[var(--color-border)] bg-[var(--color-surface)]'}"
          onclick={() => selectWindow(w)}
        >
          {w}
        </button>
      {/each}
    </div>
  </header>

  {#if !auth.isSuperAdmin}
    <div
      class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 text-sm text-[var(--color-danger)]"
      role="alert"
    >
      Super-admin role required. This page deliberately crosses tenant boundaries.
    </div>
  {:else if loading}
    <p class="text-sm text-[var(--color-text-muted)]" role="status">Loading metering…</p>
  {:else if loadError}
    <div
      class="rounded-md border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] p-4 text-sm text-[var(--color-danger)]"
      role="alert"
    >
      {loadError}
    </div>
  {:else if data}
    <!--
      ⚠️ `{@const}` must be an immediate child of a block, not of an element —
      so the money cells are computed here, at the top of this `{:else if}`,
      rather than inside the grid below.
    -->
    {@const incurredTotal = moneyCell(data.grand_total.incurred_cost_usd, 'Incurred spend')}
    {@const billedTotal = moneyCell(data.grand_total.billed_cost_usd, 'Billed spend')}
    {@const margin = marginCell(
      data.grand_total.incurred_cost_usd,
      data.grand_total.billed_cost_usd,
    )}
    <!-- Grand totals -->
    <div class="grid grid-cols-1 gap-4 md:grid-cols-5" data-testid="grand-totals">
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Requests</p>
        <p class="text-2xl font-semibold">{formatNumber(data.grand_total.requests)}</p>
      </div>
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Input tokens</p>
        <p class="text-2xl font-semibold">{formatNumber(data.grand_total.input_tokens)}</p>
      </div>
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Output tokens</p>
        <p class="text-2xl font-semibold">{formatNumber(data.grand_total.output_tokens)}</p>
      </div>
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Incurred (provider)</p>
        <p
          class="text-2xl font-semibold {incurredTotal.kind === 'unknown'
            ? 'text-[var(--color-text-muted)]'
            : ''}"
          data-testid="grand-incurred"
          data-kind={incurredTotal.kind}
          title={incurredTotal.kind === 'unknown' ? incurredTotal.title : undefined}
        >{incurredTotal.text}</p>
        {#if incurredTotal.kind === 'unknown'}
          <!--
            ⚠️ The copy must NOT print the literal it warns about. It said
            "not $0.00" and thereby rendered the exact string a reader (and a
            test asserting the string is absent) scans for — a caption
            impersonating the value it describes.
          -->
          <p class="text-xs text-[var(--color-warning-text)]">
            Not reported by metering — this is missing data, not a zero amount.
          </p>
        {/if}
      </div>
      <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Billed (tenants)</p>
        <p
          class="text-2xl font-semibold {billedTotal.kind === 'unknown'
            ? 'text-[var(--color-text-muted)]'
            : ''}"
          data-testid="grand-billed"
          data-kind={billedTotal.kind}
          title={billedTotal.kind === 'unknown' ? billedTotal.title : undefined}
        >{billedTotal.text}</p>
        <!--
          The margin is a SUBTRACTION of the two amounts above. When either
          operand is unreadable the difference is unknown, and the page must
          say so rather than print a break-even figure it did not measure.
        -->
        <p
          class="text-xs text-[var(--color-text-muted)]"
          data-testid="grand-margin"
          data-kind={margin.kind}
          title={margin.kind === 'unknown' ? margin.title : undefined}
        >
          margin {margin.text}{#if margin.kind === 'unknown'}
            <span class="text-[var(--color-warning-text)]"
              >(not reported — the margin is unknown, not zero)</span
            >
          {/if}
        </p>
      </div>
    </div>

    <!-- By tenant -->
    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="by-tenant">
      <header class="mb-3">
        <h2 class="text-sm font-medium">By tenant</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          One row per tenant. Incurred is what we paid providers; billed is what we charged the tenant after their markup.
        </p>
      </header>
      {#if data.by_tenant.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]">No tenant activity in window.</p>
      {:else}
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase text-[var(--color-text-muted)]">
              <th class="py-2">Tenant</th>
              <th class="py-2 text-right">Requests</th>
              <th class="py-2 text-right">Tokens</th>
              <th class="py-2 text-right">Incurred</th>
              <th class="py-2 text-right">Markup</th>
              <th class="py-2 text-right">Billed</th>
            </tr>
          </thead>
          <tbody>
            {#each data.by_tenant as t (t.tenant_id)}
              {@const rowIncurred = moneyCell(t.incurred_cost_usd, 'Incurred spend')}
              {@const rowBilled = moneyCell(t.billed_cost_usd, 'Billed spend')}
              <tr class="border-b border-[var(--color-border)] last:border-b-0">
                <td class="py-2">
                  <span class="font-medium">{t.tenant_name ?? t.tenant_id}</span>
                  {#if t.tenant_name}
                    <span class="ml-2 font-mono text-xs text-[var(--color-text-muted)]">{t.tenant_id}</span>
                  {/if}
                </td>
                <td class="py-2 text-right">{formatNumber(t.requests)}</td>
                <td class="py-2 text-right">{formatNumber(t.input_tokens + t.output_tokens)}</td>
                <td
                  class="py-2 text-right"
                  data-kind={rowIncurred.kind}
                  title={rowIncurred.kind === 'unknown' ? rowIncurred.title : undefined}
                >{rowIncurred.text}</td>
                <td class="py-2 text-right">
                  {Number.isFinite(t.markup_pct) ? `${t.markup_pct.toFixed(1)}%` : '—'}
                </td>
                <td
                  class="py-2 text-right"
                  data-kind={rowBilled.kind}
                  title={rowBilled.kind === 'unknown' ? rowBilled.title : undefined}
                >{rowBilled.text}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <!-- By provider -->
    <div class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="by-provider">
      <header class="mb-3">
        <h2 class="text-sm font-medium">By provider (incurred only)</h2>
        <p class="text-xs text-[var(--color-text-muted)]">
          Real external spend per provider. No markup column — we don't bill providers.
        </p>
      </header>
      {#if data.by_provider.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]">No provider activity in window.</p>
      {:else}
        <table class="w-full text-sm">
          <thead>
            <tr class="border-b border-[var(--color-border)] text-left text-xs uppercase text-[var(--color-text-muted)]">
              <th class="py-2">Provider</th>
              <th class="py-2 text-right">Requests</th>
              <th class="py-2 text-right">Input tokens</th>
              <th class="py-2 text-right">Output tokens</th>
              <th class="py-2 text-right">Incurred</th>
            </tr>
          </thead>
          <tbody>
            {#each data.by_provider as p (p.provider)}
              {@const provIncurred = moneyCell(p.incurred_cost_usd, 'Incurred spend')}
              <tr class="border-b border-[var(--color-border)] last:border-b-0">
                <td class="py-2 font-mono text-xs">{p.provider}</td>
                <td class="py-2 text-right">{formatNumber(p.requests)}</td>
                <td class="py-2 text-right">{formatNumber(p.input_tokens)}</td>
                <td class="py-2 text-right">{formatNumber(p.output_tokens)}</td>
                <td
                  class="py-2 text-right"
                  data-kind={provIncurred.kind}
                  title={provIncurred.kind === 'unknown' ? provIncurred.title : undefined}
                >{provIncurred.text}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <footer class="text-xs text-[var(--color-text-muted)]">
      Window: {data.window} · {data.start.slice(0, 10)} → {data.end.slice(0, 10)} ·
      Generated {data.generated_at.slice(0, 16).replace('T', ' ')} UTC
    </footer>
  {/if}
</section>
