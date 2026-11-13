<!--
  ProviderTierCard — one provider/model/key form for a single work tier.

  Used by /settings/llm-provider (the caller's workspace) and by the owner's
  /admin/tenants/[nameOrId] (a named customer tenant) for the default row and
  each work-size tier (small/medium/high). Self-contained: it owns its form
  state and calls the tier-scoped `api` it is given (default: the settings
  workspace) — the owner page passes `adminTenantLlmProviderApi(id)`. The
  apiKey tri-state (preserve / clear / set) is identical to the single-provider
  form it was extracted from.
-->
<script lang="ts">
  import { Button, Input, Select, Pill } from '$lib/components/ui';
  import { keyTestView, keyTestErrorView, type KeyTestView } from './key-test';
  import {
    settingsLlmProviderApi,
    type LlmProviderApi,
    type LlmCatalog,
    type LlmCatalogProvider,
    type LlmConfigView,
    type LlmConfigUpdate,
    type WorkTier,
    removeCopy,
  } from '$lib/api/llm-provider';

  interface Props {
    /** null = the tenant default row; otherwise the work-size tier. */
    tier: WorkTier | null;
    label: string;
    description: string;
    catalog: LlmCatalog;
    initialConfig: LlmConfigView | null;
    /** Which model-class hint to surface (small→flash, medium→reasoning, high→frontier). */
    classKey?: 'flash' | 'reasoning' | 'frontier';
    /** Called after a successful save/remove so the parent can refresh summaries. */
    onChange?: () => void;
    /** Called after every key test (pass or fail) — WM records each one in the audit trail. */
    onTested?: () => void;
    /** Which tenant the card writes to. Default: the caller's own workspace. */
    api?: LlmProviderApi;
    /**
     * The tenant's BYO mode, when the caller knows it (the owner page). Drives
     * the Remove wording; absent (the /settings page) = neutral wording.
     */
    byoMode?: string | null;
  }

  let {
    tier,
    label,
    description,
    catalog,
    initialConfig,
    classKey,
    onChange,
    onTested,
    api = settingsLlmProviderApi,
    byoMode = null,
  }: Props = $props();

  const removeText = $derived(removeCopy(byoMode, tier));

  let saving = $state(false);
  let removing = $state(false);
  let formError = $state<string | null>(null);
  let successMsg = $state<string | null>(null);
  let confirmingRemove = $state(false);

  let config = $state<LlmConfigView | null>(initialConfig);

  // Live key test (owner ruling 2026-10-01): one call with this tier's saved
  // key through worker_management; green/red dot + the reason.
  let testing = $state(false);
  let testResult = $state<KeyTestView | null>(null);

  async function runKeyTest(): Promise<void> {
    testing = true;
    testResult = null;
    try {
      testResult = keyTestView(await api.testConfig(tier));
    } catch (e) {
      testResult = keyTestErrorView(e);
    } finally {
      testing = false;
      onTested?.();
    }
  }

  // Form fields
  let providerKey = $state('');
  let model = $state('');
  let baseUrl = $state('');
  let apiKeyInput = $state('');
  let temperature = $state('');
  let maxTokens = $state('');

  // Key tri-state bookkeeping
  let hadKey = $state(false);
  let clearKeyRequested = $state(false);

  const providerOptions = $derived(catalog.providers.map((p) => ({ value: p.key, label: p.label })));
  const selectedProvider = $derived<LlmCatalogProvider | null>(
    catalog.providers.find((p) => p.key === providerKey) ?? null,
  );
  const requiresBaseUrl = $derived(selectedProvider?.requires_base_url ?? false);
  const requiresApiKey = $derived(selectedProvider?.requires_api_key ?? false);
  const hasModelList = $derived((selectedProvider?.models.length ?? 0) > 0);
  const modelOptions = $derived(selectedProvider?.models.map((m) => ({ value: m, label: m })) ?? []);
  const recommendedModel = $derived(
    classKey ? (selectedProvider?.model_classes?.[classKey] ?? null) : null,
  );

  function applyConfig(cfg: LlmConfigView | null): void {
    config = cfg;
    hadKey = cfg?.hasKey ?? false;
    clearKeyRequested = false;
    apiKeyInput = '';
    if (cfg?.configured && cfg.provider && catalog.providers.some((p) => p.key === cfg.provider)) {
      providerKey = cfg.provider;
      model = cfg.model ?? '';
      baseUrl = cfg.baseUrl ?? '';
      temperature = cfg.temperature != null ? String(cfg.temperature) : '';
      maxTokens = cfg.maxTokens != null ? String(cfg.maxTokens) : '';
    } else {
      providerKey = catalog.providers[0]?.key ?? '';
      model = '';
      baseUrl = catalog.providers[0]?.default_base_url ?? '';
      temperature = '';
      maxTokens = '';
      applyProviderDefaults();
    }
  }

  function applyProviderDefaults(): void {
    formError = null;
    successMsg = null;
    const p = selectedProvider;
    if (!p) return;
    if (p.models.length > 0 && !p.models.includes(model)) {
      model = p.models[0] ?? '';
    }
    if (p.requires_base_url && !baseUrl && p.default_base_url) {
      baseUrl = p.default_base_url;
    }
  }

  function useRecommended(): void {
    if (recommendedModel) model = recommendedModel;
  }

  function clientValidate(): string | null {
    if (!providerKey) return 'Choose a provider.';
    if (!model.trim()) return 'A model is required.';
    if (requiresBaseUrl && !baseUrl.trim()) return 'This provider requires a base URL.';
    const willHaveKey = apiKeyInput.length > 0 || (hadKey && !clearKeyRequested);
    if (requiresApiKey && !willHaveKey) return 'This provider requires an API key.';
    if (temperature.trim()) {
      const t = Number(temperature);
      if (Number.isNaN(t) || t < 0 || t > 2) return 'Temperature must be between 0 and 2.';
    }
    if (maxTokens.trim()) {
      const m = Number(maxTokens);
      if (!Number.isInteger(m) || m < 1) return 'Max tokens must be a positive integer.';
    }
    return null;
  }

  function buildBody(): LlmConfigUpdate {
    const body: LlmConfigUpdate = { provider: providerKey, model: model.trim() };
    if (baseUrl.trim()) body.baseUrl = baseUrl.trim();
    if (temperature.trim()) body.temperature = Number(temperature);
    if (maxTokens.trim()) body.maxTokens = Number(maxTokens);
    if (apiKeyInput.length > 0) {
      body.apiKey = apiKeyInput;
    } else if (clearKeyRequested) {
      body.apiKey = '';
    }
    return body;
  }

  async function save(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    formError = null;
    successMsg = null;
    const err = clientValidate();
    if (err) {
      formError = err;
      return;
    }
    saving = true;
    try {
      const updated = await api.putConfig(buildBody(), tier);
      applyConfig(updated);
      testResult = null;
      successMsg = 'Saved. New agent runs at this tier will use it.';
      onChange?.();
    } catch (e2) {
      formError = e2 instanceof Error ? e2.message : 'Failed to save provider.';
    } finally {
      saving = false;
    }
  }

  async function removeConfig(): Promise<void> {
    removing = true;
    formError = null;
    successMsg = null;
    try {
      await api.deleteConfig(tier);
      applyConfig(null);
      testResult = null;
      confirmingRemove = false;
      successMsg = removeText.success;
      onChange?.();
    } catch (e) {
      formError = e instanceof Error ? e.message : 'Failed to remove provider.';
    } finally {
      removing = false;
    }
  }

  function requestClearKey(): void {
    clearKeyRequested = true;
    apiKeyInput = '';
  }
  function undoClearKey(): void {
    clearKeyRequested = false;
  }

  // Hydrate the form once from the initial row.
  applyConfig(initialConfig);
</script>

<section
  class="flex flex-col gap-4 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
>
  <header class="flex flex-col gap-1">
    <div class="flex items-center gap-2">
      <h2 class="text-base font-semibold">{label}</h2>
      {#if config?.configured}
        <Pill tone="success">Configured</Pill>
      {:else}
        <Pill tone="neutral">{tier === null ? 'Platform default' : 'Falls back to default'}</Pill>
      {/if}
    </div>
    <p class="text-xs text-[var(--color-text-muted)]">{description}</p>
    {#if config?.configured}
      <p class="text-xs text-[var(--color-text-muted)]">
        Using <span class="font-medium text-[var(--color-text)]">{config.provider}</span>
        · <span class="font-medium text-[var(--color-text)]">{config.model}</span>
        {#if config.updatedAt}· updated {new Date(config.updatedAt).toLocaleString()}{/if}
      </p>
    {/if}
  </header>

  <form class="flex flex-col gap-4" onsubmit={save}>
    <!-- Provider -->
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Provider</span>
      <Select bind:value={providerKey} options={providerOptions} onchange={applyProviderDefaults} />
      {#if selectedProvider}
        <span class="text-xs text-[var(--color-text-muted)]">
          {#if !selectedProvider.is_external}Runs on the platform's own inference.
          {:else}External provider — billed to your own account.{/if}
        </span>
      {/if}
    </label>

    <!-- Model -->
    <label class="flex flex-col gap-1 text-sm">
      <span class="font-medium">Model</span>
      {#if hasModelList}
        <Select bind:value={model} options={modelOptions} />
      {:else}
        <Input bind:value={model} placeholder="e.g. accounts/fireworks/models/…" />
      {/if}
      {#if recommendedModel && model !== recommendedModel}
        <button
          type="button"
          class="self-start text-xs underline text-[var(--color-accent)]"
          onclick={useRecommended}
        >
          Use recommended: {recommendedModel}
        </button>
      {/if}
    </label>

    <!-- Base URL (conditional) -->
    {#if requiresBaseUrl}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">Base URL</span>
        <Input bind:value={baseUrl} type="text" placeholder="https://api.example.com/v1" />
        <span class="text-xs text-[var(--color-text-muted)]">OpenAI-compatible endpoint base URL.</span>
      </label>
    {/if}

    <!-- API key (conditional) -->
    {#if requiresApiKey}
      <label class="flex flex-col gap-1 text-sm">
        <span class="font-medium">API key</span>
        {#if clearKeyRequested}
          <div class="flex items-center gap-2">
            <Pill tone="warning">Key will be cleared on save</Pill>
            <button type="button" class="text-xs underline text-[var(--color-accent)]" onclick={undoClearKey}>Undo</button>
          </div>
        {:else}
          <Input
            bind:value={apiKeyInput}
            type="password"
            placeholder={hadKey ? '•••••••• (leave blank to keep current key)' : 'sk-…'}
          />
          <div class="flex items-center gap-2">
            {#if hadKey}
              <Pill tone="success">Key saved</Pill>
              <span class="text-xs text-[var(--color-text-muted)]">Leave blank to keep it, or type a new key to replace it.</span>
              <button type="button" class="text-xs underline text-[var(--color-danger)]" onclick={requestClearKey}>Clear key</button>
            {:else}
              <span class="text-xs text-[var(--color-text-muted)]">Stored encrypted; never displayed after saving.</span>
            {/if}
          </div>
        {/if}
      </label>
    {/if}

    <!-- Advanced -->
    <details class="rounded-[var(--radius-md)] border border-[var(--color-border)] p-3">
      <summary class="cursor-pointer text-sm font-medium">Advanced (optional)</summary>
      <div class="mt-3 flex flex-col gap-4 sm:flex-row">
        <label class="flex flex-1 flex-col gap-1 text-sm">
          <span class="font-medium">Temperature</span>
          <Input bind:value={temperature} type="number" placeholder="0.0 – 2.0" />
        </label>
        <label class="flex flex-1 flex-col gap-1 text-sm">
          <span class="font-medium">Max tokens</span>
          <Input bind:value={maxTokens} type="number" placeholder="e.g. 4096" />
        </label>
      </div>
    </details>

    {#if formError}
      <p class="rounded-[var(--radius-md)] border border-[var(--color-danger)] bg-[var(--color-danger-bg)] p-3 text-sm text-[var(--color-danger-text)]">
        {formError}
      </p>
    {/if}
    {#if successMsg}
      <p class="rounded-[var(--radius-md)] border border-[var(--color-success)] bg-[var(--color-success-bg)] p-3 text-sm text-[var(--color-success-text)]">
        {successMsg}
      </p>
    {/if}

    {#if testResult}
      <div class="flex flex-col gap-1 text-sm" role="status" data-testid="key-test-result" data-tone={testResult.tone}>
        <div class="flex items-center gap-2">
          <span
            class="inline-block h-2.5 w-2.5 shrink-0 rounded-full {testResult.tone === 'ok'
              ? 'bg-[var(--color-success)]'
              : 'bg-[var(--color-danger)]'}"
            aria-hidden="true"
          ></span>
          <span class={testResult.tone === 'ok' ? 'text-[var(--color-success-text)]' : 'text-[var(--color-danger-text)]'}>
            {testResult.text}
          </span>
        </div>
        {#if testResult.warning}
          <span class="text-xs text-[var(--color-text-muted)]">{testResult.warning}</span>
        {/if}
      </div>
    {/if}

    <div class="flex items-center gap-3">
      <Button type="submit" variant="primary" disabled={saving}>
        {saving ? 'Saving…' : 'Save'}
      </Button>
      <Button variant="ghost" disabled={testing} onclick={() => void runKeyTest()}>
        {testing ? 'Testing…' : 'Test'}
      </Button>

      {#if config?.configured}
        {#if confirmingRemove}
          <span class="text-sm text-[var(--color-text-muted)]">
            {removeText.confirm}
          </span>
          <Button variant="danger" disabled={removing} onclick={() => void removeConfig()}>
            {removing ? 'Removing…' : 'Confirm'}
          </Button>
          <Button variant="ghost" onclick={() => (confirmingRemove = false)}>Cancel</Button>
        {:else}
          <Button variant="ghost" onclick={() => (confirmingRemove = true)}>Remove</Button>
        {/if}
      {/if}
    </div>
  </form>
</section>
