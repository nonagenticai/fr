<!-- src/routes/workers/[name]/+page.svelte -->
<script lang="ts">
  import { page } from '$app/stores';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { goto } from '$app/navigation';
  import { onMount } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import SchemaBuilder from '$lib/components/SchemaBuilder.svelte';
  import {
    fetchProviders,
    resolveProvider,
    pickableProviders,
    defaultProviderName,
    providerIsAvailable,
    PROVIDERS_ERROR_TEXT,
    type Provider
  } from '$lib/workers/providers';
  import { ProviderModelPicker } from '$lib/workers/provider-models.svelte';
  import ProviderModelStatus from '$lib/workers/ProviderModelStatus.svelte';
  import {
    toJsonSchema,
    fromJsonSchema,
    type SchemaState
  } from '$lib/workers/schema-builder';
  import { Skeleton, ErrorState } from '$lib/components/ui';
  import {
    wmHttpErrorText,
    neutralHttpErrorText,
    logRawError,
    WORKER_LOAD_ERROR_TEXT,
    WORKER_NOT_FOUND_TEXT,
    WORKER_SAVE_ERROR_TEXT,
    WORKER_DELETE_ERROR_TEXT,
    SEND_ERROR_TEXT
  } from '$lib/workers/wm-errors';

  type WorkerRecord = {
    name: string;
    agent_type?: string | null;
    agent_role?: string | null;
    model_provider?: string | null;
    model?: string | null;
    system_prompt?: string | null;
    temperature?: number | null;
    output_schema?: unknown;
  };

  const workerName = $derived(decodeURIComponent($page.params.name ?? ''));
  let worker = $state<WorkerRecord | null>(null);
  let loading = $state(true);
  let loadError = $state('');

  // Edit form state pre-filled from the worker record.
  let systemPrompt = $state('');
  let temperature = $state(0.1);
  let schemaState = $state<SchemaState>(fromJsonSchema(null));
  let providers = $state<Provider[]>([]);
  let providerName = $state<string>('');
  // Provider -> model list + selection, shared with /chat (fr#1407).
  const picker = new ProviderModelPicker();
  // The worker's SAVED (provider, model). Not reactive on purpose: it only
  // decides which model to re-select when that provider's list arrives.
  let saved: { provider: string; model: string } = { provider: '', model: '' };
  let savingEdit = $state(false);
  let editError = $state('');
  let deleting = $state(false);
  let deleteError = $state('');
  let providerError = $state('');

  // Send-message panel state.
  let userMessage = $state('');
  let sending = $state(false);
  let response = $state<string>('');
  let sendError = $state('');

  const selectedProvider = $derived(resolveProvider(providers, providerName));
  // fr#1407: only a model the CURRENT provider's fetched list offers is saved.
  const modelOk = $derived(picker.sendable(providerName));

  function seedForm(next: WorkerRecord) {
    systemPrompt = next.system_prompt ?? '';
    temperature = next.temperature ?? 0.1;
    saved = { provider: next.model_provider ?? '', model: next.model ?? '' };
    providerName = saved.provider;
    schemaState = fromJsonSchema(next.output_schema);
  }

  async function loadWorker() {
    loading = true;
    loadError = '';

    try {
      const res = await authFetch(`/api/assets/workers/${encodeURIComponent(workerName)}`);
      if (!res.ok) {
        // fr#1409: neutral copy; status + body go to the console only.
        logRawError('workers/[name] load', res.status, res.statusText, await res.text().catch(() => ''));
        loadError = res.status === 404 ? WORKER_NOT_FOUND_TEXT : WORKER_LOAD_ERROR_TEXT;
        worker = null;
        return;
      }

      // fr backend wraps single-resource endpoints in `{data: …}`
      // (backend/src/routes/assets/workers.ts:59). Without unwrapping
      // `worker.name` came back undefined and every downstream call
      // (Send, PUT, Delete) hit `/api/assets/workers/undefined/…`.
      const body = (await res.json()) as { data?: WorkerRecord } | WorkerRecord;
      const next = ('data' in body ? body.data : body) as WorkerRecord;
      worker = next;
      seedForm(next);
    } catch (e) {
      logRawError('workers/[name] load', e);
      loadError = WORKER_LOAD_ERROR_TEXT;
      worker = null;
    } finally {
      loading = false;
    }
  }

  async function loadProviders() {
    providerError = '';
    try {
      // Unavailable providers are hidden — except the worker's OWN stored
      // provider, which stays visible so the form shows the truth.
      const list = pickableProviders(await fetchProviders(), providerName);
      providers = list;
      if (list.length === 0) return;
      // If the worker's stored provider isn't in the catalog, fall back to the
      // first AVAILABLE provider (list[0] could be one that 502s).
      if (!list.some((p) => p.name === providerName)) {
        providerName = defaultProviderName(list);
      }
    } catch (e) {
      // fr#1409: fetchProviders throws `${status} ${statusText}: detail` —
      // console only, never page copy.
      logRawError('workers/[name] providers', e);
      providerError = PROVIDERS_ERROR_TEXT;
    }
  }

  onMount(async () => {
    await loadWorker();
    await loadProviders();
  });

  $effect(() => {
    if (!providerName) return;
    // fr#1407: clears the previous provider's list and selection, then fetches;
    // the returned cleanup aborts it on a switch / unmount. For the worker's
    // saved provider the saved model is re-selected IF that list offers it;
    // if not, nothing is auto-selected and the status line names the saved
    // model, so a save can never silently swap it for a default.
    const keep = providerName === saved.provider ? saved.model : undefined;
    return picker.load(providerName, { keep });
  });

  async function saveEdit(e: SubmitEvent) {
    e.preventDefault();
    if (!worker) return;
    // fr#1407: never persist a model the current provider's list does not offer
    // (the previous provider's model while this one's list is in flight, or a
    // saved model the provider no longer offers).
    if (!providerName || !modelOk) {
      editError = 'Choose a model offered by the selected provider.';
      return;
    }
    savingEdit = true;
    editError = '';
    // Re-send agent_role on update — worker_management requires it whenever
    // agent_type is set (models.py:395-400). WorkerResponse doesn't currently
    // round-trip it, so fall back to the same auto-create default
    // (message_endpoints.py:96).
    const body: Record<string, unknown> = {
      worker_name: worker.name,
      agent_type: worker.agent_type ?? 'pydantic_ai',
      agent_role: worker.agent_role ?? `AI Assistant for ${worker.name}`,
      model_provider: providerName,
      model: picker.model,
      temperature,
      system_prompt: systemPrompt.trim() || null,
      output_schema: toJsonSchema(schemaState)
    };

    // ⛔ try/catch, not a bare await. `authFetch` awaits `fetch` unguarded, so it
    // REJECTS on a transport failure — and without this the line resetting
    // `savingEdit` never ran, leaving the button disabled reading "Saving…"
    // with `editError` empty. The user could not even retry; only a full page
    // reload recovered. `workers/new/+page.svelte` wraps the identical call
    // correctly, so this was an omission, not a convention.
    try {
      const res = await authFetch(`/api/assets/workers/${encodeURIComponent(worker.name)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        const raw = await res.text().catch(() => '');
        logRawError('workers/[name] save', res.status, res.statusText, raw);
        editError = neutralHttpErrorText(WORKER_SAVE_ERROR_TEXT, raw);
      } else saved = { provider: String(body.model_provider), model: String(body.model) };
    } catch (e) {
      logRawError('workers/[name] save', e);
      editError = WORKER_SAVE_ERROR_TEXT;
    } finally {
      savingEdit = false;
    }
  }

  async function send(e: SubmitEvent) {
    e.preventDefault();
    if (!worker || !userMessage.trim()) return;
    sending = true;
    response = '';
    sendError = '';
    // Per-message output_schema override — picked up by worker_management
    // src/api/workers/message_endpoints.py:234-245 (clears worker cache and
    // rebuilds the worker with the override before dispatch). Only sent when
    // the user picked a non-`none` shape; null/none means "use the worker's
    // saved schema" so we omit the key entirely to keep that semantics.
    const schema = toJsonSchema(schemaState);
    const body: Record<string, unknown> = { message: userMessage };
    if (schema) body.output_schema = schema;
    // Same as saveEdit: a rejection here used to strand the button on
    // "Sending…" with no error shown. `res.json()` can throw too.
    try {
      const res = await authFetch(`/api/assets/workers/${encodeURIComponent(worker.name)}/message`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
      if (!res.ok) {
        // A BYO-key refusal (worker_management#316) as a sentence the admin can
        // act on, never the raw JSON envelope (fr BYO validator D3).
        const raw = await res.text().catch(() => '');
        logRawError('workers/[name] send', res.status, res.statusText, raw);
        sendError = wmHttpErrorText(res.status, raw);
      } else {
        const resBody = await res.json();
        response =
          typeof resBody.output === 'string'
            ? resBody.output
            : JSON.stringify(resBody.output, null, 2);
      }
    } catch (e) {
      logRawError('workers/[name] send', e);
      sendError = SEND_ERROR_TEXT;
    } finally {
      sending = false;
    }
  }

  async function remove() {
    if (!worker || !confirm(`Delete worker "${worker.name}"?`)) return;
    deleting = true;
    deleteError = '';
    // Same omission saveEdit documents above, and worse here: this is the only
    // IRREVERSIBLE action on the page. The DELETE was awaited bare, so a
    // rejected delete (403 from the tenant gate, 404, 409, or a transport
    // failure that makes `authFetch` REJECT) left the user on an unchanged page
    // with NO feedback at all — indistinguishable from "nothing happened", so
    // the usual response is to click Delete again. `goto` stays inside the try
    // for the same reason `send()` keeps `res.json()` there: it can reject too.
    try {
      const res = await authFetch(`/api/assets/workers/${encodeURIComponent(worker.name)}`, {
        method: 'DELETE'
      });
      if (!res.ok) {
        logRawError('workers/[name] delete', res.status, res.statusText, await res.text().catch(() => ''));
        deleteError = WORKER_DELETE_ERROR_TEXT;
      } else {
        await goto('/workers');
      }
    } catch (e) {
      logRawError('workers/[name] delete', e);
      deleteError = WORKER_DELETE_ERROR_TEXT;
    } finally {
      deleting = false;
    }
  }

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle($page.url.pathname, worker?.name ?? null);
  });
</script>

{#if loading}
  <div class="px-6 py-4 max-w-5xl">
    <Skeleton variant="box" height="20rem" />
  </div>
{:else if loadError || !worker}
  <div class="px-6 py-4">
    <ErrorState
      error={loadError || WORKER_NOT_FOUND_TEXT}
      title="Couldn't load worker"
      onRetry={loadWorker}
    />
  </div>
{:else}
  <div class="px-6 py-4 max-w-5xl grid grid-cols-2 gap-6">
    <div>
      <div class="flex items-center justify-between mb-4">
        <h1 class="text-2xl font-semibold font-mono">{worker?.name ?? '(deleted)'}</h1>
        <button type="button" onclick={remove} disabled={deleting} data-testid="worker-delete" class="text-sm text-[var(--color-danger)] hover:underline">
          {deleting ? 'Deleting…' : 'Delete'}
        </button>
      </div>

      {#if deleteError}
        <div
          role="alert"
          data-testid="delete-error"
          class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mb-4"
        >
          {deleteError}
        </div>
      {/if}

      <form class="space-y-3" onsubmit={saveEdit}>
        <div class="grid grid-cols-2 gap-3">
          <div>
            <label for="provider" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Provider</label>
            <select
              id="provider"
              bind:value={providerName}
              class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
              disabled={providers.length === 0}
            >
              {#each providers as p}
                <option value={p.name}>
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
              class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 font-mono dark:border-[var(--color-border-strong)]"
              disabled={picker.models.length === 0}
            >
              {#if picker.missingKept && !picker.model}
                <option value="" disabled>Choose a model</option>
              {/if}
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
          <input id="temp" type="number" min="0" max="2" step="0.05" bind:value={temperature} class="w-32 border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]" />
        </div>

        <div>
          <label for="sys" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">System prompt</label>
          <textarea id="sys" rows="4" bind:value={systemPrompt} class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"></textarea>
        </div>

        <div>
          <div class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Output schema</div>
          <SchemaBuilder bind:state={schemaState} />
        </div>

        {#if editError}
          <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm">{editError}</div>
        {/if}

        <button
          type="submit"
          disabled={savingEdit || !modelOk}
          aria-describedby={providerName && !savingEdit && !modelOk ? 'worker-model-status' : undefined}
          class="px-4 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)]">
          {savingEdit ? 'Saving…' : 'Save changes'}
        </button>
      </form>
    </div>

    <div>
      <h2 class="text-lg font-semibold mb-2">Send message</h2>
      <form class="space-y-2" onsubmit={send}>
        <textarea
          rows="4"
          bind:value={userMessage}
          placeholder="Message to the worker…"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm dark:border-[var(--color-border-strong)]"
        ></textarea>
        <button type="submit" disabled={sending || !userMessage.trim()} class="px-4 py-2 bg-[var(--color-success)] text-[var(--color-text)] rounded disabled:bg-[var(--color-surface-strong)]">
          {sending ? 'Sending…' : 'Send'}
        </button>
      </form>
      {#if sendError}
        <div data-testid="send-error" class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-sm mt-2">{sendError}</div>
      {/if}
      {#if response}
        <pre class="mt-3 bg-[var(--color-surface)] border border-[var(--color-border)] rounded p-3 text-sm overflow-auto dark:bg-[var(--color-bg)] dark:border-[var(--color-border)]">{response}</pre>
      {/if}
    </div>
  </div>
{/if}
