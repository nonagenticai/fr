<!--
  FxRateCard — the owner's USD→EUR FX row on /admin/pricing (PLAN
  tenant-inference-provisioning §3.1/§2.6). EUR money budgets consume
  `fx × USD price`, so without a rate billing's quote answers `fx_rate_missing`
  and provisioning refuses an EUR tenant before touching IR.

  Billing effective-dates every row: saving opens a new rate and closes the
  open one; there is no delete. The FIRST rate should be back-dated to before
  the first EUR tenant's first call — the effective-from field exists for that.
-->
<script lang="ts">
  import { listFxRates, putFxRate, type FxRateRow } from '$lib/api/fx-rates';

  let rows = $state<FxRateRow[]>([]);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let rate = $state('');
  let effectiveFrom = $state('');
  let saving = $state(false);
  let saveError = $state<string | null>(null);

  const current = $derived(rows.find((r) => r.base === 'USD' && r.quote === 'EUR' && !r.effective_until) ?? null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      rows = await listFxRates();
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  let started = false;
  $effect(() => {
    if (started) return;
    started = true;
    void load();
  });

  async function save(): Promise<void> {
    saveError = null;
    const r = rate.trim();
    if (!/^(0|[1-9]\d{0,5})(\.\d{1,8})?$/.test(r) || Number(r) <= 0) {
      saveError = 'Rate must be a positive decimal, e.g. 0.9200.';
      return;
    }
    let iso: string | undefined;
    if (effectiveFrom.trim()) {
      const d = new Date(effectiveFrom);
      if (Number.isNaN(d.getTime())) {
        saveError = 'Effective-from is not a valid date/time.';
        return;
      }
      iso = d.toISOString();
    }
    saving = true;
    try {
      await putFxRate({ rate: r, ...(iso ? { effective_from: iso } : {}) });
      rate = '';
      effectiveFrom = '';
      await load();
    } catch (e) {
      saveError = e instanceof Error ? e.message : String(e);
    } finally {
      saving = false;
    }
  }
</script>

<div class="rounded border border-[var(--color-border-strong)] p-4 space-y-3 text-sm" data-testid="fx-rate-card">
  <div>
    <h2 class="text-lg font-semibold">USD → EUR FX rate</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      EUR inference budgets are charged at USD price × this rate. Without a rate no
      tenant can be provisioned with an EUR budget.
    </p>
  </div>
  {#if loading}
    <p class="text-xs text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <p class="text-xs text-[var(--color-danger-text)]" data-testid="fx-rate-error">
      FX rates unreadable — {loadError}. This is not “no rate”.
    </p>
  {:else if current}
    <p data-testid="fx-rate-current">
      Current: <span class="font-mono">{current.rate}</span>
      <span class="text-xs text-[var(--color-text-muted)]">since {current.effective_from}</span>
    </p>
  {:else}
    <p class="text-[var(--color-warning-text)]" data-testid="fx-rate-none">
      No USD→EUR rate yet — EUR provisioning will be refused (fx_rate_missing).
    </p>
  {/if}
  <div class="flex flex-wrap items-end gap-2">
    <label class="flex flex-col gap-1 text-xs">
      <span>New rate</span>
      <input
        bind:value={rate}
        inputmode="decimal"
        placeholder="0.9200"
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm w-28 dark:bg-[var(--color-surface)]"
        data-testid="fx-rate-input"
      />
    </label>
    <label class="flex flex-col gap-1 text-xs">
      <span>Effective from (optional; back-date the first rate)</span>
      <input
        type="datetime-local"
        bind:value={effectiveFrom}
        class="border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm dark:bg-[var(--color-surface)]"
        data-testid="fx-rate-effective-from"
      />
    </label>
    <button
      type="button"
      class="px-3 py-1 border border-[var(--color-border-strong)] rounded text-sm"
      disabled={saving}
      onclick={() => void save()}
      data-testid="fx-rate-save"
    >
      {saving ? 'Saving…' : 'Set rate'}
    </button>
  </div>
  {#if saveError}
    <p class="text-xs text-[var(--color-danger-text)]" data-testid="fx-rate-save-error">{saveError}</p>
  {/if}
</div>
