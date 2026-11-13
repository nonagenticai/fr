<!--
  AssetPicker.svelte

  Kind-aware asset picker. Replaces the free-text UUID input on
  stream-member-add and stream-create. The picker switches its data
  source based on the `kind` prop:

    workflow             → /api/tools/n8n/workflows (n8n list)
    requirement          → /api/assets/requirements (fr)
    principle            → /api/assets/principles (fr)
    prompt | kag_source | coding_repository | decision | artifact
                         → UUID-paste fallback (these kinds have no
                            tenant-scoped list endpoint exposed to
                            fr's frontend yet; user pastes the upstream
                            id directly).

  Surface — single string `value` two-way bound. The fallback path
  validates that pasted values look like UUIDs so the parent's submit
  doesn't accept obvious junk.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { listWorkflows } from '$lib/api/n8n';
  import { authFetch } from '$lib/api/auth-fetch';
  type AssetKind =
    | 'workflow'
    | 'prompt'
    | 'kag_source'
    | 'coding_repository'
    | 'requirement'
    | 'principle'
    | 'decision'
    | 'artifact';

  type Props = {
    kind: AssetKind;
    value?: string;
    disabled?: boolean;
    placeholder?: string;
    id?: string;
  };

  let {
    kind,
    value = $bindable<string>(''),
    disabled = false,
    placeholder = 'Select…',
    id,
  }: Props = $props();

  type Option = { id: string; label: string };

  let options = $state<Option[]>([]);
  let loading = $state(false);
  let err = $state<string | null>(null);
  let listSupported = $state(true);

  // Fallback validation: a UUID v4 / v7 canonical hex form.
  const UUID_RE =
    /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  // n8n workflow ids are short alphanumeric strings (e.g. "AGz3..."), not UUIDs.
  const N8N_ID_RE = /^[A-Za-z0-9_-]{8,}$/;

  function isValidPasted(k: AssetKind, v: string): boolean {
    if (k === 'workflow') return UUID_RE.test(v) || N8N_ID_RE.test(v);
    return UUID_RE.test(v);
  }

  async function loadOptions(k: AssetKind): Promise<void> {
    loading = true;
    err = null;
    listSupported = true;
    try {
      if (k === 'workflow') {
        const { workflows } = await listWorkflows({ limit: 100 });
        options = workflows.map((w) => ({
          id: String(w.id),
          label: w.name ?? String(w.id),
        }));
      } else if (k === 'requirement' || k === 'principle') {
        const path =
          k === 'requirement' ? '/api/assets/requirements' : '/api/assets/principles';
        const resp = await authFetch(path);
        if (!resp.ok) {
          throw new Error(`${path} → ${resp.status}`);
        }
        const json = (await resp.json()) as
          | { data?: Array<{ id: string; name?: string; title?: string }> }
          | Array<{ id: string; name?: string; title?: string }>;
        const arr = Array.isArray(json) ? json : json.data ?? [];
        options = arr.map((r) => ({
          id: r.id,
          label: r.name ?? r.title ?? r.id,
        }));
      } else {
        listSupported = false;
        options = [];
      }
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    loadOptions(kind);
  });

  // Reload on kind change. Null-init + assign-inside-effect so `kind` is
  // read as a tracked dependency on every change (initialising with the
  // prop value would only capture the initial — Svelte's
  // state_referenced_locally warning).
  let lastKind = $state<AssetKind | null>(null);
  $effect(() => {
    if (lastKind !== kind) {
      lastKind = kind;
      loadOptions(kind);
    }
  });
</script>

{#if loading}
  <select {id} disabled class="asset-picker">
    <option>Loading…</option>
  </select>
{:else if err}
  <div class="text-sm text-[var(--color-danger)]" role="alert">
    Failed to load {kind}s: {err}
  </div>
{:else if listSupported && options.length > 0}
  <select
    {id}
    {disabled}
    bind:value
    data-testid="asset-picker-select"
    data-kind={kind}
    class="w-full px-3 py-2 text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
  >
    <option value="">{placeholder}</option>
    {#each options as opt (opt.id)}
      <option value={opt.id}>{opt.label}</option>
    {/each}
  </select>
{:else}
  <div class="space-y-1">
    <input
      {id}
      {disabled}
      type="text"
      bind:value
      placeholder={listSupported
        ? `No ${kind}s exist yet — paste an ID`
        : `Paste ${kind} ID`}
      data-testid="asset-picker-input"
      data-kind={kind}
      class="w-full px-3 py-2 font-mono text-sm rounded-md border border-[var(--color-border)] bg-[var(--color-surface)]"
    />
    {#if value && !isValidPasted(kind, value)}
      <p class="text-xs text-[var(--color-warning-text)]" role="alert">
        That doesn't look like a valid {kind} id.
      </p>
    {/if}
  </div>
{/if}
