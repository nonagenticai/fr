<!--
  /settings/llm-provider — per-tenant BYO LLM provider configuration, per work tier.

  Workspace-admins (and super-admins) point their tenant at their OWN LLM
  provider + API key, optionally a DIFFERENT one per work-size tier
  (small/medium/high). The backend (/api/settings/llm-provider[?tier=]) proxies
  worker_management's /tenant-config/llm; keys are encrypted at rest and never
  returned (only `hasKey`). A worker run resolves its tier's row, falling back
  to the default row, then local-llm IF the tenant's BYO mode is local_allowed
  (byo_required fails a keyless tier). This page cannot see the mode, so its
  note is the conditional `LLM_MODE_NEUTRAL_NOTE`.

  The four cards are `LlmProviderTiers`, shared with the owner's per-customer
  tenant page (/admin/tenants/[nameOrId]) so both read and behave the same.

  Gate: defense-in-depth client check; the real gate is the backend 403.
-->
<script lang="ts">
  import { auth } from '$lib/stores/auth.svelte';
  import { ErrorState } from '$lib/components/ui';
  import { LLM_MODE_NEUTRAL_NOTE, settingsLlmProviderApi } from '$lib/api/llm-provider';
  import LlmProviderTiers from '$lib/components/llm-provider/LlmProviderTiers.svelte';

  let gate = $state<'pending' | 'allowed' | 'denied'>('pending');

  let gateProbeStarted = false;
  $effect(() => {
    if (gateProbeStarted) return;
    if (auth.isLoading) return; // wait for auth hydration
    gateProbeStarted = true;
    gate = auth.hasTenantRole('workspace-admin') || auth.isSuperAdmin ? 'allowed' : 'denied';
  });
</script>

<section class="flex flex-col gap-6 p-6 max-w-2xl">
  <header>
    <h1 class="text-xl font-semibold">LLM Provider</h1>
    <p class="text-sm text-[var(--color-text-muted)]">
      Bring your own LLM provider for this workspace. Configure a default provider, and optionally a
      different model per work-size tier — workers pick the model that matches the size of the task.
      Your API keys are encrypted and never shown again.
    </p>
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="local-llm-note">
      {LLM_MODE_NEUTRAL_NOTE}
    </p>
  </header>

  {#if gate === 'denied'}
    <ErrorState
      title="Not available"
      error="LLM provider settings are limited to workspace administrators."
    />
  {:else if gate === 'pending'}
    <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
  {:else}
    <LlmProviderTiers api={settingsLlmProviderApi} />
  {/if}
</section>
