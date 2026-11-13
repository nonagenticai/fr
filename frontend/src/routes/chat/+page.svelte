<script lang="ts">
  import { onDestroy } from 'svelte';
  import { fetchWithBudget, BudgetExceededError } from '$lib/net/fetchWithBudget';
  import { streamChatEvents } from './streamChat';
  import SchemaBuilder from '$lib/components/SchemaBuilder.svelte';
  import BooleanResult from '$lib/components/chat-output/BooleanResult.svelte';
  import ListResult from '$lib/components/chat-output/ListResult.svelte';
  import ObjectResult from '$lib/components/chat-output/ObjectResult.svelte';
  import TextResult from '$lib/components/chat-output/TextResult.svelte';
  import {
    fetchProviders,
    fetchProviderModels,
    resolveProvider,
    pickableProviders,
    defaultProviderName,
    PROVIDERS_ERROR_TEXT,
    type Provider
  } from '$lib/workers/providers';
  import { ProviderModelPicker } from '$lib/workers/provider-models.svelte';
  import ProviderModelStatus from '$lib/workers/ProviderModelStatus.svelte';
  import { toJsonSchema, emptyState, type SchemaState } from '$lib/workers/schema-builder';
  import { auth } from '$lib/stores/auth.svelte';
  import { workspaces } from '$lib/stores/workspaces.svelte';
  import { openWorkspaceSwitcher } from '$lib/utils/workspaceSwitcher';
  import { chatHttpErrorText, logRawError, SEND_ERROR_TEXT } from '$lib/workers/wm-errors';
  import { Button, ErrorState } from '$lib/components/ui';
  import {
    chatGate,
    providersEmptyState,
    CHAT_DENIED_MESSAGE,
    CHAT_UNSUPPORTED_WORKSPACE_MESSAGE,
    LLM_PROVIDER_SETTINGS_HREF,
    type ChatGate
  } from './chat-access';

  type Role = 'user' | 'assistant';
  type Message = {
    role: Role;
    content: string;
    pp?: number; // prompt-processing tokens/sec
    tg?: number; // token-generation tokens/sec
    inputTokens?: number;
    outputTokens?: number;
    resolvedModel?: string;
    resolvedProvider?: string;
    // Pinned at send-time from the schema selected when the user hit Send,
    // so editing the SchemaBuilder afterwards doesn't retroactively change
    // how prior assistant bubbles render. Cleared (undefined) for the
    // free-text path.
    schema?: Record<string, unknown>;
    // Validated typed output, populated when WM emits the `result` SSE
    // frame. Until it arrives, the bubble renders accumulating deltas via
    // TextResult so the user sees "something is happening".
    result?: unknown;
  };

  let providers = $state<Provider[]>([]);
  let providerName = $state('');
  let providerError = $state('');
  let providersLoaded = $state(false);

  // Tenant-admin tool (owner ruling 2026-10-01): workspace-admin or super-admin.
  // Defense in depth; the backend answers 403 to anyone else.
  // The workspace is part of the gate: the System view is a cross-tenant union
  // with no provider keys of its own, so a providers request there is a
  // guaranteed 403 that reads to the admin as a broken provider.
  const gate = $derived<ChatGate>(
    chatGate(auth, {
      loaded: workspaces.loaded,
      error: workspaces.error,
      kind: workspaces.active?.kind
    })
  );
  const emptyMessage = $derived(
    providersEmptyState(providersLoaded, providerError, providers.length)
  );

  // The provider's model list + selection (fr#1407): cleared on every provider
  // change, tagged with the provider it was fetched for, superseded responses
  // dropped. Shared with /workers/new and /workers/[name].
  const picker = new ProviderModelPicker();

  let temperature = $state(0.1);
  let systemPrompt = $state('');
  let schemaState = $state<SchemaState>(emptyState());

  let messages = $state<Message[]>([]);
  let input = $state('');
  let streaming = $state(false);
  let sendError = $state('');
  let stillWorking = $state(false);
  let takingLonger = $state(false);

  let controller: AbortController | null = null;

  const selectedProvider = $derived(resolveProvider(providers, providerName));
  // fr#1407: a model may be sent only with the provider whose list offered it.
  const canSend = $derived(picker.sendable(providerName));

  let providersRequested = false;
  $effect(() => {
    if (gate !== 'allowed' || providersRequested) return;
    providersRequested = true;
    void loadProviders();
  });

  async function loadProviders(): Promise<void> {
    providerError = '';
    try {
      // Only what worker_management returns: for a customer tenant that is the
      // tenant's configured rows whose key tests OK (possibly none). Of those,
      // only providers that can serve a request are offered (pickableProviders).
      const list = pickableProviders(await fetchProviders());
      providers = list;
      if (list.length > 0 && !providerName) {
        providerName = defaultProviderName(list);
      }
    } catch (e) {
      // fr#1409: fetchProviders throws `${status} ${statusText}: detail` —
      // console only, never page copy.
      logRawError('chat providers', e);
      providerError = PROVIDERS_ERROR_TEXT;
    } finally {
      providersLoaded = true;
    }
  }

  onDestroy(() => {
    controller?.abort();
  });

  $effect(() => {
    if (!providerName) return;
    // fr#1407: clears the previous provider's list and selection, then fetches;
    // the returned cleanup aborts it on a switch / unmount.
    return picker.load(providerName);
  });

  async function send(e?: SubmitEvent) {
    e?.preventDefault();
    if (streaming) return;
    const trimmed = input.trim();
    // fr#1407: never send a model the current provider's list does not offer.
    if (!trimmed || !canSend) return;

    sendError = '';
    messages = [...messages, { role: 'user', content: trimmed }];
    input = '';
    const assistantIdx = messages.length;
    // Compute the outgoing schema once and pin it onto the placeholder so the
    // dispatch site renders the right shape immediately — and so that if the
    // user changes the SchemaBuilder before the response lands, the in-flight
    // bubble still renders against the schema it was sent with.
    const schema = toJsonSchema(schemaState);
    messages = [
      ...messages,
      { role: 'assistant', content: '', schema: schema ?? undefined }
    ];

    // Pinned at send time: a provider switch mid-stream must not relabel the
    // PROVIDER_BUSY line for this request.
    const sentProviderLabel = selectedProvider?.label ?? providerName;
    const body: Record<string, unknown> = {
      provider: providerName,
      model: picker.model,
      messages: messages.slice(0, assistantIdx).map((m) => ({ role: m.role, content: m.content })),
      temperature,
      stream: true
    };
    const sys = systemPrompt.trim();
    if (sys) body.system_prompt = sys;
    if (schema) body.output_schema = schema;

    streaming = true;
    stillWorking = false;
    takingLonger = false;
    controller = new AbortController();
    try {
      const res = await fetchWithBudget(
        '/api/assets/workers/chat/completions',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        },
        {
          softTimeoutMs: 5_000,
          slowTimeoutMs: 30_000,
          hardTimeoutMs: 90_000,
          signal: controller.signal,
          onStillWorking: () => {
            stillWorking = true;
          },
          onTakingLonger: () => {
            takingLonger = true;
          }
        }
      );
      // Headers received; clear the "still working" / "taking longer"
      // pre-response indicators so the streaming bubble shows plain "streaming…".
      stillWorking = false;
      takingLonger = false;
      if (!res.ok || !res.body) {
        const errText = await res.text().catch(() => '');
        logRawError('chat send', res.status, res.statusText, errText);
        // WM BYO errors (BYO_KEY_WITHHELD, …) become an actionable sentence;
        // anything else is neutral copy (fr#1409).
        const text = chatHttpErrorText(res.status, errText);
        replaceAssistant(assistantIdx, text);
        sendError = text;
        return;
      }

      for await (const ev of streamChatEvents(res.body, { providerLabel: sentProviderLabel })) {
        if (ev.kind === 'malformed') {
          console.warn('[chat] skipped malformed SSE frame', ev.raw, ev.error);
          continue;
        }
        if (ev.kind === 'error') {
          // fr#1409: `ev.message` is neutral/BYO copy; WM's exception text
          // (`ev.raw`) goes to the console only.
          logRawError('chat stream', ev.code ?? 'stream error', ev.raw);
          replaceAssistant(assistantIdx, ev.message);
          break;
        }
        if (ev.kind === 'delta') {
          appendAssistant(assistantIdx, ev.delta);
          continue;
        }
        if (ev.kind === 'result') {
          setAssistantResult(assistantIdx, ev.value, ev.schema);
          continue;
        }
        if (ev.kind === 'meta') {
          updateAssistantMeta(assistantIdx, ev.meta);
          continue;
        }
        if (ev.kind === 'done') break;
      }
    } catch (err) {
      if (err instanceof BudgetExceededError) {
        const budgetMsg = 'This request was cancelled after 90s. The model may be unavailable.';
        replaceAssistant(assistantIdx, budgetMsg);
        sendError = budgetMsg;
      } else if (err instanceof DOMException && err.name === 'AbortError') {
        // user navigated away, reset, or cancel; leave whatever the cancel/reset
        // handler placed in the assistant message.
      } else {
        logRawError('chat send', err);
        replaceAssistant(assistantIdx, SEND_ERROR_TEXT);
        sendError = SEND_ERROR_TEXT;
      }
    } finally {
      streaming = false;
      stillWorking = false;
      takingLonger = false;
      controller = null;
    }
  }

  function cancelStream() {
    if (!streaming) return;
    const last = messages.length - 1;
    if (last >= 0 && messages[last].role === 'assistant' && !messages[last].content) {
      replaceAssistant(last, 'Cancelled by user.');
    }
    controller?.abort();
    controller = null;
    streaming = false;
    stillWorking = false;
    takingLonger = false;
  }

  function appendAssistant(idx: number, delta: string) {
    const next = messages.slice();
    const existing = next[idx];
    if (!existing || existing.role !== 'assistant') return;
    next[idx] = { ...existing, content: existing.content + delta };
    messages = next;
  }

  function replaceAssistant(idx: number, content: string) {
    const next = messages.slice();
    const existing = next[idx];
    if (!existing || existing.role !== 'assistant') return;
    next[idx] = { ...existing, content };
    messages = next;
  }

  function setAssistantResult(
    idx: number,
    value: unknown,
    serverSchema: Record<string, unknown>
  ) {
    const next = messages.slice();
    const existing = next[idx];
    if (!existing || existing.role !== 'assistant') return;
    // Prefer the server-echoed schema (defense-in-depth — should match the
    // send-time pin); fall back to the pinned one if WM didn't echo for any
    // reason.
    const schema =
      Object.keys(serverSchema).length > 0 ? serverSchema : existing.schema;
    next[idx] = { ...existing, result: value, schema };
    messages = next;
  }

  function updateAssistantMeta(idx: number, meta: Record<string, unknown>) {
    const next = messages.slice();
    const existing = next[idx];
    if (!existing || existing.role !== 'assistant') return;
    const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);
    const str = (v: unknown) => (typeof v === 'string' && v.length > 0 ? v : undefined);
    next[idx] = {
      ...existing,
      pp: num(meta.pp_tps) ?? existing.pp,
      tg: num(meta.tg_tps) ?? existing.tg,
      inputTokens: num(meta.input_tokens) ?? existing.inputTokens,
      outputTokens: num(meta.output_tokens) ?? existing.outputTokens,
      resolvedModel: str(meta.resolved_model) ?? existing.resolvedModel,
      resolvedProvider: str(meta.resolved_provider) ?? existing.resolvedProvider
    };
    messages = next;
  }

  function reset() {
    controller?.abort();
    controller = null;
    streaming = false;
    stillWorking = false;
    takingLonger = false;
    messages = [];
    sendError = '';
  }
</script>

{#if gate === 'pending'}
  <p class="p-6 text-sm text-[var(--color-text-muted)]">Loading…</p>
{:else if gate === 'denied'}
  <div class="p-6">
    <ErrorState title="Not available" error={CHAT_DENIED_MESSAGE} />
  </div>
{:else if gate === 'unsupported_workspace'}
  <div class="p-6 flex flex-col items-center gap-3" data-testid="chat-unsupported-workspace">
    <ErrorState title="Chat needs a workspace" error={CHAT_UNSUPPORTED_WORKSPACE_MESSAGE} />
    <Button variant="secondary" onclick={openWorkspaceSwitcher}>Switch workspace</Button>
  </div>
{:else}
<div class="flex flex-col h-full">
  {#if emptyMessage}
    <div
      class="mx-6 mt-4 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm text-[var(--color-text)]"
      role="status"
      data-testid="chat-no-providers"
    >
      {emptyMessage}
      <a class="ml-1 underline text-[var(--color-accent)]" href={LLM_PROVIDER_SETTINGS_HREF}>Open LLM provider settings</a>
    </div>
  {/if}
  <!-- Settings -->
  <div class="bg-[var(--color-bg)] border-b border-[var(--color-border)] px-6 py-4 space-y-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
      <div>
        <label for="provider" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Provider</label>
        <select
          id="provider"
          bind:value={providerName}
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 dark:border-[var(--color-border-strong)]"
          disabled={providers.length === 0}
        >
          {#each providers as p}
            <option value={p.name}>{p.label}</option>
          {/each}
        </select>
        {#if providerError}
          <p class="text-xs text-[var(--color-danger)] mt-1" data-testid="providers-error">
            {providerError}
            <button type="button" class="underline ml-1" onclick={() => void loadProviders()}>Retry</button>
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
          {#each picker.models as m}
            <option value={m.id}>{m.id}</option>
          {/each}
        </select>
        <ProviderModelStatus
          {picker}
          provider={providerName}
          label={selectedProvider?.label ?? providerName}
          id="chat-model-status"
        />
      </div>
    </div>

    <div class="grid grid-cols-1 md:grid-cols-[auto,1fr] gap-4">
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
        <label for="sys" class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">System prompt (optional)</label>
        <textarea
          id="sys"
          bind:value={systemPrompt}
          rows="3"
          class="w-full border border-[var(--color-border-strong)] rounded px-3 py-2 text-sm font-mono dark:border-[var(--color-border-strong)]"
          placeholder="You are a helpful assistant."
        ></textarea>
      </div>
    </div>

    <div>
      <div class="block text-xs font-semibold uppercase text-[var(--color-text)] mb-1 dark:text-[var(--color-text-muted)]">Output schema</div>
      <SchemaBuilder bind:state={schemaState} />
    </div>
  </div>

  <!-- Transcript -->
  <div class="flex-1 overflow-auto px-6 py-4 space-y-3 bg-[var(--color-surface)] dark:bg-[var(--color-bg)]">
    {#if messages.length === 0}
      <div class="h-full flex items-center justify-center text-[var(--color-text-muted)] text-sm dark:text-[var(--color-text-muted)]">
        Send a message to start a conversation.
      </div>
    {:else}
      {#each messages as msg, i (i)}
        {#if msg.role === 'user'}
          <div class="flex justify-end">
            <div class="max-w-[80%] bg-[var(--color-accent)] text-[var(--color-on-primary)] px-3 py-2 rounded-lg text-sm whitespace-pre-wrap">{msg.content}</div>
          </div>
        {:else}
          <div class="flex justify-start">
            <div class="flex flex-col items-start gap-1 max-w-[80%]">
              <div class="bg-[var(--color-bg)] border border-[var(--color-border)] px-3 py-2 rounded-lg text-sm dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
                {#if msg.schema?.type === 'boolean' && msg.result !== undefined}
                  <BooleanResult value={msg.result} />
                {:else if msg.schema?.type === 'array' && Array.isArray(msg.result)}
                  <ListResult items={msg.result} schema={msg.schema} />
                {:else if msg.schema?.type === 'object' && msg.result && typeof msg.result === 'object'}
                  <ObjectResult
                    value={msg.result as Record<string, unknown>}
                    schema={msg.schema}
                  />
                {:else}
                  <TextResult
                    content={msg.content}
                    placeholder={streaming && i === messages.length - 1 ? '…' : ''}
                  />
                {/if}
              </div>
              {#if msg.pp !== undefined || msg.tg !== undefined || msg.outputTokens !== undefined}
                <div class="text-[10px] text-[var(--color-text-muted)] font-mono pl-1 flex gap-2 dark:text-[var(--color-text-muted)]">
                  {#if msg.pp !== undefined}<span>pp {msg.pp.toFixed(1)} t/s</span>{/if}
                  {#if msg.tg !== undefined}<span>tg {msg.tg.toFixed(1)} t/s</span>{/if}
                  {#if msg.outputTokens !== undefined}<span>{msg.outputTokens} tok</span>{/if}
                </div>
              {/if}
            </div>
          </div>
        {/if}
      {/each}
      {#if streaming}
        <div class="text-xs text-[var(--color-text-muted)] flex items-center gap-2 dark:text-[var(--color-text-muted)]">
          <span class="inline-block w-2 h-2 rounded-full bg-[var(--color-accent)] animate-pulse"></span>
          {#if takingLonger}
            <span>taking longer than usual —</span>
            <button
              type="button"
              onclick={cancelStream}
              class="underline text-[var(--color-accent)] hover:text-[var(--color-accent-strong)] dark:text-[var(--color-accent)] dark:hover:text-[var(--color-accent)]"
            >
              Cancel
            </button>
          {:else if stillWorking}
            <span>still working…</span>
          {:else}
            <span>streaming…</span>
          {/if}
        </div>
      {/if}
    {/if}
    {#if sendError}
      <div class="bg-[var(--color-danger-bg)] border border-[var(--color-danger-bg)] text-[var(--color-danger-text)] px-3 py-2 rounded text-xs">{sendError}</div>
    {/if}
  </div>

  <!-- Input -->
  <div class="bg-[var(--color-bg)] border-t border-[var(--color-border)] px-6 py-4 dark:bg-[var(--color-surface)] dark:border-[var(--color-border)]">
    <form class="flex gap-2" onsubmit={send}>
      <input
        type="text"
        bind:value={input}
        disabled={streaming || !canSend}
        aria-describedby={providerName && !streaming && !canSend ? 'chat-model-status' : undefined}
        placeholder="Ask something…"
        class="flex-1 px-4 py-2 border border-[var(--color-border-strong)] rounded-lg focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)] disabled:bg-[var(--color-surface)] dark:border-[var(--color-border-strong)]"
      />
      <button
        type="submit"
        disabled={streaming || !input.trim() || !canSend}
        aria-describedby={providerName && !streaming && !canSend ? 'chat-model-status' : undefined}
        class="px-6 py-2 bg-[var(--color-accent)] text-[var(--color-on-primary)] rounded-lg hover:bg-[var(--color-accent-strong)] disabled:bg-[var(--color-surface-strong)] disabled:text-[var(--color-text-muted)] disabled:cursor-not-allowed transition-colors"
      >
        {streaming ? 'Streaming…' : 'Send'}
      </button>
      {#if streaming}
        <button
          type="button"
          onclick={cancelStream}
          class="px-4 py-2 text-sm text-[var(--color-danger)] border border-[var(--color-danger-border)] rounded-lg hover:bg-[var(--color-danger-bg)] dark:text-[var(--color-danger-text)] dark:border-[var(--color-danger)] dark:hover:bg-[var(--color-danger-bg)]/20"
        >
          Cancel
        </button>
      {/if}
      <button
        type="button"
        onclick={reset}
        class="px-4 py-2 text-sm text-[var(--color-text)] border border-[var(--color-border-strong)] rounded-lg hover:bg-[var(--color-surface)] dark:text-[var(--color-text-muted)] dark:border-[var(--color-border-strong)] dark:hover:bg-[var(--color-surface-strong)]"
      >
        Reset
      </button>
    </form>
  </div>
</div>
{/if}
