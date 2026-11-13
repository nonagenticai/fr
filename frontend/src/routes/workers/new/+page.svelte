<!-- src/routes/workers/new/+page.svelte -->
<script lang="ts">
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import SchemaBuilder from '$lib/components/SchemaBuilder.svelte';
  import {
    fetchProviders,
    resolveProvider,
    providerIsAvailable,
    pickableProviders,
    defaultProviderName,
    PROVIDERS_ERROR_TEXT,
    type Provider
  } from '$lib/workers/providers';
  import {
    neutralHttpErrorText,
    logRawError,
    WORKER_CREATE_ERROR_TEXT
  } from '$lib/workers/wm-errors';
  import { ProviderModelPicker } from '$lib/workers/provider-models.svelte';
  import ProviderModelStatus from '$lib/workers/ProviderModelStatus.svelte';
  import { toJsonSchema, emptyState, type SchemaState } from '$lib/workers/schema-builder';

  let name = $state('');
  let systemPrompt = $state('');
  let providers = $state<Provider[]>([]);
  let providerName = $state('');
  // Provider -> model list + selection, shared with /chat (fr#1407).
  const picker = new ProviderModelPicker();
  let temperature = $state(0.1);
  let schemaState = $state<SchemaState>(emptyState());

  let saving = $state(false);
  let errorMsg = $state('');
  let providerError = $state('');

  const selectedProvider = $derived(resolveProvider(providers, providerName));
  const selectedUnavailable = $derived(
    selectedProvider !== undefined && !providerIsAvailable(selectedProvider)
  );
  // fr#1407: only a model the CURRENT provider's fetched list offers is saved.
  const modelOk = $derived(picker.sendable(providerName));

  async function loadProviders() {
    providerError = '';
    try {
      // Unavailable providers are hidden, not offered disabled.
      const list = pickableProviders(await fetchProviders());
      providers = list;
      if (list.length > 0 && !providerName) {
        // Default to the first provider that can actually serve a request.
        providerName = defaultProviderName(list);
      }
    } catch (e) {
      // fr#1409: fetchProviders throws `${status} ${statusText}: detail` —
      // console only, never page copy.
      logRawError('workers/new providers', e);
      providerError = PROVIDERS_ERROR_TEXT;
    }
  }

  onMount(loadProviders);

  $effect(() => {
    if (!providerName) return;
    // Do not call upstream for a provider the catalog already told us cannot be
    // served. The request would 502, and the old code painted that raw string
    // -- including the internal env-var name -- straight at the user.
    if (selectedUnavailable) {
      picker.block('This provider needs an API key that is not configured. Choose another.');
      return;
    }
    // fr#1407: clears the previous provider's list and selection, then fetches;
    // the returned cleanup aborts it on a switch / unmount.
    return picker.load(providerName);
  });

  async function save(e: SubmitEvent) {
    e.preventDefault();
    if (!name.trim()) {
      errorMsg = 'Name is required.';
      return;
    }
    if (!providerName) {
      errorMsg = 'Select a provider.';
      return;
    }
    // fr#1407: never persist a model the current provider's list does not offer
    // (e.g. the previous provider's model while this one's list is in flight).
    if (!modelOk) {
      errorMsg = 'Choose a model offered by the selected provider.';
      return;
    }
    saving = true;
    errorMsg = '';
    // worker_management's WorkerCreateRequest validator (models.py:395-400)
    // rejects `agent_type` without `agent_role`. There's no field for it in
    // this form — synthesize a sensible default mirroring the auto-create
    // path (message_endpoints.py:96 → `AI Assistant for {worker_name}`).
    const body: Record<string, unknown> = {
      worker_name: name.trim(),
      agent_type: 'pydantic_ai',
      agent_role: `AI Assistant for ${name.trim()}`,
      model_provider: providerName,
      model: picker.model,
      temperature,
      system_prompt: systemPrompt.trim() || null,
      output_schema: toJsonSchema(schemaState)
    };

    try {
      const res = await authFetch('/api/assets/workers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        logRawError('workers/new create', res.status, res.statusText, raw);
        errorMsg = neutralHttpErrorText(WORKER_CREATE_ERROR_TEXT, raw);
        saving = false;
        return;
      }
      await goto(`/workers/${encodeURIComponent(name.trim())}`);
    } catch (e) {
      logRawError('workers/new create', e);
      errorMsg = WORKER_CREATE_ERROR_TEXT;
      saving = false;
    }
  }
</script>

<div class="px-6 py-4 max-w-3xl">
  <h1 class="text-2xl font-semibold mb-4">New worker</h1>
  <form class="space-y-4" onsubmit={save}>
    <div>
      <label for="name" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Name</label>
      <input
        id="name"
        type="text"
        bind:value={name}
        required
        pattern="[A-Za-z0-9_-]+"
        class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
        placeholder="my_worker"
      />
    </div>

    <div class="grid grid-cols-2 gap-4">
      <div>
        <label for="provider" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Provider</label>
        <select
          id="provider"
          bind:value={providerName}
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
          disabled={providers.length === 0}
        >
          {#each providers as p}
            <option value={p.name} disabled={!providerIsAvailable(p)}>
              {p.label}{providerIsAvailable(p) ? '' : ' — needs an API key'}
            </option>
          {/each}
        </select>
        {#if providerError}
          <p class="text-xs text-[var(--color-danger)] mt-1" data-testid="providers-error">
            {providerError}
            <button type="button" class="underline ml-1" onclick={loadProviders}>Retry</button>
          </p>
        {:else if selectedProvider}
          <p class="text-xs text-[var(--color-text-muted)] mt-1 dark:text-[var(--color-text-muted)]">{selectedProvider.description}</p>
        {/if}
      </div>
      <div>
        <label for="model" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Model</label>
        <select
          id="model"
          bind:value={picker.model}
          required
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 font-mono dark:border-[var(--color-border-strong)]"
          disabled={picker.models.length === 0}
        >
          {#each picker.models as m}
            <option value={m.id}>{m.id}</option>
          {/each}
        </select>
        <ProviderModelStatus
          {picker}
          provider={providerName}
          label={selectedProvider?.label ?? providerName}
          id="worker-model-status"
        />
      </div>
    </div>

    <div>
      <label for="temp" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Temperature</label>
      <input
        id="temp"
        type="number"
        min="0"
        max="2"
        step="0.05"
        bind:value={temperature}
        class="w-32 border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
      />
    </div>

    <div>
      <label for="sys" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">System prompt</label>
      <textarea
        id="sys"
        rows="4"
        bind:value={systemPrompt}
        class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
      ></textarea>
    </div>

    <div>
      <div class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Output schema</div>
      <SchemaBuilder bind:state={schemaState} />
    </div>

    {#if errorMsg}
      <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">
        {errorMsg}
      </div>
    {/if}

    <div class="flex gap-2">
      <button
        type="submit"
        disabled={saving || !modelOk}
        aria-describedby={providerName && !saving && !modelOk ? 'worker-model-status' : undefined}
        class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded hover:bg-[var(--color-accent-strong)] disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]"
      >
        {saving ? 'Saving…' : 'Create'}
      </button>
      <a href="/workers" class="px-4 py-2 border border-[var(--color-border-strong)] rounded hover:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]">Cancel</a>
    </div>
  </form>
</div>
