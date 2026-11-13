<!--
  InferenceSetup — the owner's per-tenant inference decision (PLAN
  tenant-inference-provisioning §2.6). Used by the provision form
  (/admin/users, mode="provision") and the tenant page (mode="edit").

  All three setups are always VISIBLE; setups 2 and 3 are disabled with their
  reason until the config probe says otherwise (spend breakers / BYO custody).
  Setup 1 is locked to ONE tier, "Non-Agentic AI local" (local-llm). Markup applies
  to setups 2/3 only, so its fields are present but disabled under setup 1.

  The draft → wire conversion and every rule live in ./inference-form.ts.
  This component holds no key material: setup 3's key entry ships with BYO
  custody (IR gate 1b).
-->
<script lang="ts">
  import type { InferenceConfig } from '$lib/api/inference-admin';
  import {
    BUDGET_CURRENCIES,
    BYO_MODE_OPTIONS,
    PAYMENT_TERMS_BACKLOG,
    PAYMENT_TERM_LINES,
    LOCAL_TIER_LABEL,
    PLATFORM_MODEL,
    PLATFORM_PROVIDER,
    TIERS,
    emptyOwnerTier,
    setupHasMarkup,
    setupOptions,
    type InferenceDraft,
  } from './inference-form';

  let {
    draft = $bindable(),
    config,
    mode = 'provision',
    disabled = false,
  }: {
    draft: InferenceDraft;
    config: InferenceConfig | null;
    mode?: 'provision' | 'edit';
    disabled?: boolean;
  } = $props();

  const options = $derived(setupOptions(config));
  const hasMarkup = $derived(setupHasMarkup(draft.setup));
  const inputClass =
    'border border-[var(--color-border-strong)] rounded px-2 py-1 text-sm dark:bg-[var(--color-surface)] disabled:text-[var(--color-text-muted)]';

  function addTier(): void {
    const free = TIERS.find((t) => !draft.tiers.some((x) => x.tier === t));
    if (free && draft.tiers.length < 3) draft.tiers = [...draft.tiers, emptyOwnerTier(free)];
  }
  function removeTier(i: number): void {
    draft.tiers = draft.tiers.filter((_, j) => j !== i);
  }
</script>

<fieldset
  class="rounded border border-[var(--color-border-strong)] p-3 space-y-3"
  data-testid="inference-setup"
  data-mode={mode}
>
  <legend class="px-1 text-sm font-medium">Inference</legend>
  <p class="text-xs text-[var(--color-text-muted)]">
    Which LLM this tenant may use and how it is set up.
    {#if mode === 'provision'}
      Applied once for the tenant after the people above are provisioned.
    {/if}
    Each tier is then smoke-tested and shows “verified” only when the inference
    router’s ledger confirms the call.
  </p>

  <div role="radiogroup" aria-label="Inference setup" class="space-y-2">
    {#each options as o (o.setup)}
      <label
        class="flex items-start gap-2 text-sm"
        data-testid="inference-setup-option-{o.setup}"
        data-available={o.available ? 'true' : 'false'}
      >
        <input
          type="radio"
          name="inference-setup-{mode}"
          value={o.setup}
          bind:group={draft.setup}
          disabled={disabled || !o.available}
          data-testid="inference-setup-radio-{o.setup}"
        />
        <span>
          <span class="font-medium">{o.title}</span>
          <span class="block text-xs text-[var(--color-text-muted)]">{o.body}</span>
          {#if o.reason}
            <span
              class="block text-xs text-[var(--color-warning-text)]"
              data-testid="inference-setup-reason-{o.setup}"
            >
              Not available yet — {o.reason}.
            </span>
          {/if}
        </span>
      </label>
    {/each}
  </div>

  {#if draft.setup === 'local'}
    <div class="rounded border border-[var(--color-border-strong)] p-3 space-y-2 text-sm" data-testid="inference-local-tier">
      <p>
        <span class="font-medium">{LOCAL_TIER_LABEL}</span>
        <span class="font-mono text-xs" data-testid="inference-local-model">{PLATFORM_MODEL}</span>
        <span class="text-xs text-[var(--color-text-muted)]">on {PLATFORM_PROVIDER}</span>
      </p>
      <label class="flex items-center gap-2 text-xs">
        <span>Tier</span>
        <select
          bind:value={draft.tier}
          {disabled}
          class={inputClass}
          data-testid="inference-local-tier-select"
        >
          {#each TIERS as t (t)}
            <option value={t}>{t}</option>
          {/each}
        </select>
      </label>
      <p class="text-xs text-[var(--color-text-muted)]">
        One tier, no paid failover. Requests for any other tier size inherit it.
      </p>
    </div>
  {/if}

  <fieldset
    class="rounded border border-[var(--color-border-strong)] p-3 space-y-2"
    disabled={disabled || !hasMarkup}
    data-testid="inference-tiers-markup"
  >
    <legend class="px-1 text-xs font-medium">Tiers and markup % (setups 2 and 3)</legend>
    {#each draft.tiers as t, i (i)}
      <div class="flex flex-wrap items-end gap-2" data-testid="inference-tier-row">
        <label class="flex flex-col gap-1 text-xs">
          <span>Tier</span>
          <select bind:value={t.tier} class={inputClass} data-testid="inference-tier-select">
            {#each TIERS as opt (opt)}
              <option value={opt}>{opt}</option>
            {/each}
          </select>
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span>Provider</span>
          <input bind:value={t.provider} class={inputClass} placeholder="deepseek" data-testid="inference-tier-provider" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span>Model</span>
          <input bind:value={t.model} class={inputClass} placeholder="deepseek-v4-pro" data-testid="inference-tier-model" />
        </label>
        <label class="flex flex-col gap-1 text-xs">
          <span>Markup %</span>
          <input
            bind:value={t.pct}
            inputmode="decimal"
            class="{inputClass} w-24"
            placeholder="25.00"
            data-testid="inference-markup-pct"
          />
        </label>
        {#if draft.tiers.length > 1}
          <button
            type="button"
            class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs"
            onclick={() => removeTier(i)}
          >
            Remove
          </button>
        {/if}
      </div>
    {/each}
    {#if draft.tiers.length < 3}
      <button
        type="button"
        class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs"
        onclick={addTier}
        data-testid="inference-add-tier"
      >
        Add tier
      </button>
    {/if}
    {#if !hasMarkup}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="inference-markup-note">
        Setup 1 is billed at local cost price — markup applies to setups 2 and 3 only.
      </p>
    {/if}
  </fieldset>

  <div class="flex flex-col gap-1 text-sm">
    <span class="font-medium">Monthly budget (whole units)</span>
    <div class="flex flex-wrap items-center gap-2">
      <input
        type="number"
        bind:value={draft.budget_amount}
        min="0"
        step="1"
        required
        {disabled}
        aria-label="Monthly budget amount"
        class="{inputClass} py-2"
        data-testid="inference-budget-amount"
      />
      <select
        bind:value={draft.budget_currency}
        {disabled}
        aria-label="Budget currency"
        class="{inputClass} py-2"
        data-testid="inference-budget-currency"
      >
        {#each BUDGET_CURRENCIES as c (c)}
          <option value={c}>{c}</option>
        {/each}
      </select>
    </div>
    <span class="text-xs text-[var(--color-text-muted)]">
      The tenant’s spend cap in the chosen currency. It replaces the manual token budget for this tenant.
      {#if mode === 'edit'}
        Changing the currency mid-month converts the remaining budget at today’s FX rate.
      {/if}
    </span>
  </div>

  <div class="rounded border border-[var(--color-border-strong)] p-3 space-y-1 text-sm" data-testid="inference-payment-terms">
    <p class="text-xs font-medium">
      Pre-paid / post-paid
      <span class="text-[var(--color-text-muted)]">— coming soon ({PAYMENT_TERMS_BACKLOG})</span>
    </p>
    {#each PAYMENT_TERM_LINES as line (line.line)}
      <label class="flex items-center gap-2 text-xs">
        <span class="w-16">{line.label}</span>
        <select
          value={line.term}
          disabled
          aria-label="{line.label} payment term"
          class={inputClass}
          data-testid="inference-payment-term-{line.line}"
        >
          <option value="prepaid">pre-paid</option>
          <option value="postpaid">post-paid</option>
        </select>
      </label>
    {/each}
  </div>

  <label class="flex flex-col gap-1 text-sm">
    <span class="font-medium">BYO mode</span>
    <select bind:value={draft.byo_mode} {disabled} class="{inputClass} py-2" data-testid="inference-byo-mode">
      {#each BYO_MODE_OPTIONS as m (m.value)}
        <option value={m.value}>{m.label}</option>
      {/each}
    </select>
    <span class="text-xs text-[var(--color-text-muted)]">
      Set explicitly — it is never derived from the tiers.
    </span>
  </label>
</fieldset>
