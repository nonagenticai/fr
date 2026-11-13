<!--
  TenantInferenceSection — the owner's "Inference" section on
  /admin/tenants/[nameOrId] (PLAN tenant-inference-provisioning §2.6).

  Reads the tenant's active IR policy + version history, edits it with the SAME
  InferenceSetup component the provision form uses (mode="edit"), and applies
  the edit through provisioning (fresh idempotency key → same doc is an IR
  no-op, the smoke re-runs). A prior version can be re-activated (rollback).

  Every decision on the provision form is editable here mid-month (owner ruling
  2026-10-02): setup, tiers, budget amount, currency, byo_mode and markup — each
  apply goes through provisioning with a NEW idempotency key. A currency change
  asks the owner to confirm ("remaining budget converts at today's FX rate");
  when the tenant's current currency cannot be read, it asks anyway.

  Budget and markup are NOT in the policy doc — they live in billing — so the
  edit form starts with an EMPTY budget the owner must re-state; pre-filling a
  guess would silently rewrite the tenant's money budget.

  Super-admin only; the backend gates every call on the verified realm role.
-->
<script lang="ts">
  import { Button, Pill } from '$lib/components/ui';
  import {
    activateTenantInferenceVersion,
    applyTenantInference,
    getTenantInferencePolicy,
    type InferenceConfig,
    type InferenceInput,
    type InferenceOutcome,
    type TenantInferencePolicy,
  } from '$lib/api/inference-admin';
  import InferenceSetup from './InferenceSetup.svelte';
  import InferenceResult from './InferenceResult.svelte';
  import {
    CURRENCY_CHANGE_CONFIRM,
    currencyChange,
    draftFromPolicy,
    inferencePayload,
  } from './inference-form';

  let {
    tenantId,
    config,
    archived = false,
    currentCurrency = null,
  }: {
    tenantId: string;
    config: InferenceConfig;
    archived?: boolean;
    /** The tenant's budget currency as licences reports it; null = unknown. */
    currentCurrency?: string | null;
  } = $props();

  let policy = $state<TenantInferencePolicy | null>(null);
  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let draft = $state(draftFromPolicy(null, null));
  let editing = $state(false);
  let applying = $state(false);
  let applyError = $state<string | null>(null);
  let outcome = $state<InferenceOutcome | null>(null);
  let lastInput = $state<InferenceInput | null>(null);
  let activating = $state<number | null>(null);
  let activateError = $state<string | null>(null);

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      policy = await getTenantInferencePolicy(tenantId);
      draft = draftFromPolicy(policy.doc, currentCurrency);
    } catch (e) {
      loadError = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  let loadedFor: string | null = null;
  $effect(() => {
    if (archived || loadedFor === tenantId) return;
    loadedFor = tenantId;
    void load();
  });

  async function run(input: InferenceInput): Promise<void> {
    applying = true;
    applyError = null;
    try {
      outcome = await applyTenantInference(tenantId, input);
      lastInput = input;
      editing = false;
      await load();
    } catch (e) {
      applyError = e instanceof Error ? e.message : String(e);
    } finally {
      applying = false;
    }
  }

  async function apply(): Promise<void> {
    const p = inferencePayload(draft, config);
    if (!p.ok) {
      applyError = p.error;
      return;
    }
    // A currency change is the owner's explicit decision (ruling 2026-10-02).
    // If the current currency is unknown we cannot tell, so we ask rather than
    // assume "unchanged".
    const change = currencyChange(draft, currentCurrency);
    if (change === 'changed' || change === 'unknown') {
      const head =
        change === 'changed'
          ? `Change this tenant's budget currency from ${currentCurrency} to ${draft.budget_currency}?`
          : `This tenant's current budget currency could not be read. Apply the budget in ${draft.budget_currency}?`;
      if (!confirm(`${head}\n\n${CURRENCY_CHANGE_CONFIRM}`)) return;
    }
    await run(p.input);
  }

  async function activate(version: number): Promise<void> {
    if (!confirm(`Activate inference policy v${version} for this tenant?\n\nIt takes effect within ~15 seconds.`)) return;
    activating = version;
    activateError = null;
    try {
      await activateTenantInferenceVersion(tenantId, version);
      await load();
    } catch (e) {
      activateError = e instanceof Error ? e.message : String(e);
    } finally {
      activating = null;
    }
  }

  const activeSetup = $derived(
    policy?.doc && typeof policy.doc.setup === 'string' ? policy.doc.setup : null,
  );
</script>

<section class="space-y-3 max-w-2xl" data-testid="tenant-inference">
  <header class="space-y-1">
    <h2 class="text-lg font-semibold">Inference</h2>
    <p class="text-sm text-[var(--color-text-muted)]">
      Which LLM this tenant may use, how it is set up, and its EUR budget. Changes
      apply through provisioning and are smoke-tested against the router’s ledger.
    </p>
  </header>

  {#if archived}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="tenant-inference-archived">
      Archived tenants cannot be given an inference set-up. Restore the tenant first.
    </p>
  {:else if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if loadError}
    <div class="space-y-2" data-testid="tenant-inference-error">
      <p class="text-sm text-[var(--color-danger-text)]">Could not read this tenant’s inference policy: {loadError}</p>
      <Button variant="secondary" onclick={load}>Retry</Button>
    </div>
  {:else if policy}
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm" data-testid="tenant-inference-active">
      <dt class="text-[var(--color-text-muted)]">Active policy</dt>
      <dd>
        {#if policy.active_version !== null}
          v{policy.active_version} · {activeSetup ?? 'unknown setup'}
        {:else}
          <span data-testid="tenant-inference-none">None — this tenant is not policy-routed yet.</span>
        {/if}
      </dd>
    </dl>

    {#if policy.versions.length > 0}
      <div class="space-y-1" data-testid="tenant-inference-versions">
        <p class="text-xs uppercase text-[var(--color-text-muted)]">Version history</p>
        {#each policy.versions as v (v.version)}
          <div class="flex flex-wrap items-center gap-2 text-sm" data-testid="tenant-inference-version">
            <span class="font-mono">v{v.version}</span>
            <span class="text-xs text-[var(--color-text-muted)]">{v.created_at} · {v.actor_kind}</span>
            {#if v.version === policy.active_version}
              <Pill tone="success">active</Pill>
            {:else}
              <button
                type="button"
                class="px-2 py-1 border border-[var(--color-border-strong)] rounded text-xs"
                disabled={activating !== null}
                onclick={() => activate(v.version)}
                data-testid="tenant-inference-activate"
              >
                {activating === v.version ? 'Activating…' : 'Activate'}
              </button>
            {/if}
          </div>
        {/each}
        {#if activateError}
          <p class="text-sm text-[var(--color-danger-text)]" data-testid="tenant-inference-activate-error">{activateError}</p>
        {/if}
      </div>
    {/if}

    {#if editing}
      <div class="space-y-3" data-testid="tenant-inference-edit">
        <InferenceSetup bind:draft {config} mode="edit" disabled={applying} />
        {#if applyError}
          <p class="text-sm text-[var(--color-danger-text)]" data-testid="tenant-inference-apply-error">{applyError}</p>
        {/if}
        <div class="flex gap-2">
          <Button onclick={apply} disabled={applying}>{applying ? 'Applying…' : 'Apply'}</Button>
          <Button variant="ghost" onclick={() => (editing = false)} disabled={applying}>Cancel</Button>
        </div>
      </div>
    {:else}
      <Button variant="secondary" onclick={() => (editing = true)}>
        {policy.active_version !== null ? 'Edit inference' : 'Set up inference'}
      </Button>
    {/if}

    {#if outcome}
      <InferenceResult
        {outcome}
        onRerun={lastInput ? () => run(lastInput as InferenceInput) : undefined}
        rerunning={applying}
        rerunError={editing ? null : applyError}
      />
    {/if}
  {/if}
</section>
