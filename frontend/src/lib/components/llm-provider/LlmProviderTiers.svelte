<!--
  LlmProviderTiers — the four tier cards (default, small, medium, high) for ONE
  tenant, bound to one `api`.

  Shared by /settings/llm-provider (the caller's own workspace; tenant_admin or
  super-admin) and /admin/tenants/[nameOrId] (a named customer tenant; owner
  only). The only difference between the two is the `api` base path — the
  backend serves the same contract on both — so there is one form, not two.

  Below the cards: "Recent changes", the tenant's BYO audit trail (owner ruling
  2026-10-02 — when the platform operator sets, tests or removes a customer's
  key, the customer must see it). Read-only; refreshed after Save/Remove/Test.

  Gating is the caller's job; the backend 403 is the real gate.
-->
<script lang="ts">
  import { ErrorState } from '$lib/components/ui';
  import {
    auditActionLabel,
    auditActorLabel,
    LlmAuditUnavailableError,
    type LlmAuditEntry,
    type LlmCatalog,
    type LlmConfigRow,
    type LlmProviderApi,
    type WorkTier,
  } from '$lib/api/llm-provider';
  import ProviderTierCard from './ProviderTierCard.svelte';

  interface Props {
    api: LlmProviderApi;
    /** The tenant's BYO mode when known (owner page); drives the Remove wording. */
    byoMode?: string | null;
  }
  let { api, byoMode = null }: Props = $props();

  interface TierDef {
    tier: WorkTier | null;
    label: string;
    description: string;
    classKey?: 'flash' | 'reasoning' | 'frontier';
  }

  const TIERS: TierDef[] = [
    {
      tier: null,
      label: 'Default',
      description:
        'Used for any work that does not specify a tier — and as the fallback when a tier below is left unconfigured.',
    },
    {
      tier: 'small',
      label: 'Small — flash',
      classKey: 'flash',
      description: 'Light, high-volume work. Pick a fast, inexpensive model.',
    },
    {
      tier: 'medium',
      label: 'Medium — reasoning',
      classKey: 'reasoning',
      description: 'Balanced work. Pick a capable reasoning model.',
    },
    {
      tier: 'high',
      label: 'High — frontier',
      classKey: 'frontier',
      description: 'Hard, high-stakes work. Pick your strongest model.',
    },
  ];

  let loading = $state(true);
  let loadError = $state<string | null>(null);
  let catalog = $state<LlmCatalog | null>(null);
  let rows = $state<LlmConfigRow[]>([]);

  function rowFor(tier: WorkTier | null): LlmConfigRow | null {
    return rows.find((r) => r.tier === tier) ?? null;
  }

  async function load(): Promise<void> {
    loading = true;
    loadError = null;
    try {
      const [cat, configs] = await Promise.all([api.getCatalog(), api.listConfigs()]);
      catalog = cat;
      rows = configs;
    } catch (e) {
      loadError = e instanceof Error ? e.message : 'Failed to load LLM provider settings.';
    } finally {
      loading = false;
    }
  }

  // --- Recent changes (read-only audit trail) -------------------------------
  const AUDIT_LIMIT = 20;
  let audit = $state<LlmAuditEntry[]>([]);
  let auditLoading = $state(true);
  let auditError = $state<string | null>(null);
  // The audit endpoint is not deployed yet (404) — a neutral note, not an error.
  let auditUnavailable = $state(false);

  async function loadAudit(): Promise<void> {
    auditError = null;
    auditUnavailable = false;
    try {
      audit = (await api.listAudit(AUDIT_LIMIT)).slice(0, AUDIT_LIMIT);
    } catch (e) {
      if (e instanceof LlmAuditUnavailableError) auditUnavailable = true;
      else auditError = e instanceof Error ? e.message : 'Failed to load recent changes.';
    } finally {
      auditLoading = false;
    }
  }

  function tierLabel(tier: WorkTier | null): string {
    return tier ?? 'default';
  }

  // Load once per api instance (the owner page hands a new one per tenant).
  let loadedFor: LlmProviderApi | null = null;
  $effect(() => {
    if (loadedFor === api) return;
    loadedFor = api;
    auditLoading = true;
    audit = [];
    void load();
    void loadAudit();
  });
</script>

{#if loading}
  <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
{:else if loadError}
  <ErrorState title="Couldn’t load LLM provider settings" error={loadError} onRetry={() => void load()} />
{:else if catalog}
  <div class="flex flex-col gap-6" data-testid="llm-provider-tiers">
    {#each TIERS as t (t.tier ?? '__default__')}
      <ProviderTierCard
        tier={t.tier}
        label={t.label}
        description={t.description}
        classKey={t.classKey}
        {catalog}
        {api}
        {byoMode}
        initialConfig={rowFor(t.tier)}
        onChange={() => void loadAudit()}
        onTested={() => void loadAudit()}
      />
    {/each}
  </div>
{/if}

<section
  class="mt-6 flex flex-col gap-2 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid="llm-audit"
>
  <h2 class="text-base font-semibold">Recent changes</h2>
  <p class="text-xs text-[var(--color-text-muted)]">
    Who set, removed or tested a key on this workspace — including changes made by the platform operator.
  </p>
  {#if auditLoading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else if auditUnavailable}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="llm-audit-unavailable">
      Recent changes are not available yet.
    </p>
  {:else if auditError}
    <p class="text-sm text-[var(--color-danger-text)]" data-testid="llm-audit-error">
      Couldn’t load recent changes: {auditError}
    </p>
  {:else if audit.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="llm-audit-empty">No changes recorded yet.</p>
  {:else}
    <ul class="flex flex-col divide-y divide-[var(--color-border)] text-sm">
      {#each audit as e, i (`${e.at}-${i}`)}
        <li class="flex flex-wrap items-baseline gap-x-2 py-1.5" data-testid="llm-audit-entry">
          <time class="text-xs text-[var(--color-text-muted)]" datetime={e.at}>{new Date(e.at).toLocaleString()}</time>
          <span class="font-medium" data-testid="llm-audit-action">{auditActionLabel(e.action)}</span>
          <span class="text-xs text-[var(--color-text-muted)]">tier</span>
          <span data-testid="llm-audit-tier">{tierLabel(e.tier)}</span>
          <span class="text-xs text-[var(--color-text-muted)]">by</span>
          <span data-testid="llm-audit-actor">{auditActorLabel(e.actor)}</span>
          {#if e.provider}<span class="text-xs" data-testid="llm-audit-provider">· {e.provider}</span>{/if}
          {#if e.keyId && e.keyId !== 'none'}
            <code class="text-xs text-[var(--color-text-muted)]" data-testid="llm-audit-key">key {e.keyId.slice(0, 8)}</code>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>
