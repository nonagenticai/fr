<!--
  TraceLinksPanel — the trace links of ONE item (a requirement, principle,
  decision, architecture element / relationship / view, or a UML element /
  relationship / interaction / diagram), both ways: what it realizes, refines,
  traces to, satisfies, implements or depends on, and what does so to it.

  Add a link (to another item by kind + id, or to a place in the code: repo +
  commit + symbol) and delete one. requirements_management checks that both ends
  exist and are visible to you; its refusal is shown as it says.
-->
<script lang="ts">
  import { createTraceLink, deleteTraceLink, traceLinksOf, type TraceKind, type TraceLink, type TraceLinkType } from '$lib/api/modeling';
  import { LINK_VERB, TRACE_KIND_LABEL, TRACE_KINDS, TRACE_LINK_TYPES, linkFromHere, traceHref, traceItemName } from '$lib/modeling/trace';
  import { personLabel } from '$lib/modeling/people';
  import { when } from '$lib/modeling/explain';

  let { kind, itemId, title = 'Trace links' }: { kind: TraceKind; itemId: string; title?: string } = $props();

  let links = $state<TraceLink[]>([]);
  let truncated = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let names = $state<Record<string, string>>({});
  let unnamed = $state<Record<string, true>>({});

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const r = await traceLinksOf(itemId);
      links = r.items;
      truncated = r.truncated;
      for (const l of r.items) {
        const other = linkFromHere(l, itemId).other;
        if (other) resolveName(other.kind, other.id);
      }
    } catch (e) {
      links = [];
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }

  function resolveName(k: string, id: string): void {
    const key = `${k}:${id}`;
    if (key in names || key in unnamed) return;
    traceItemName(k, id).then(
      (n) => (names = { ...names, [key]: n || `${TRACE_KIND_LABEL[k as TraceKind] ?? k} ${id}` }),
      (err) => {
        // The id is still shown, with its kind: the link stays readable and deletable.
        console.warn('[TraceLinksPanel] an item name could not be read', k, id, err);
        unnamed = { ...unnamed, [key]: true };
      },
    );
  }

  $effect(() => {
    void itemId;
    load();
  });

  // --- Add ---------------------------------------------------------------------
  let adding = $state(false);
  let direction = $state<'from' | 'to'>('from');
  let linkType = $state<TraceLinkType>('traces_to');
  let targetMode = $state<'item' | 'code'>('item');
  let otherKind = $state<TraceKind>('requirement');
  let otherId = $state('');
  let repo = $state('');
  let commit = $state('');
  let symbol = $state('');
  let note = $state('');
  let saving = $state(false);
  let addError = $state<string | null>(null);

  async function add(e: Event): Promise<void> {
    e.preventDefault();
    addError = null;
    const self = { kind, id: itemId };
    const code = targetMode === 'code';
    if (code ? !(repo.trim() && commit.trim() && symbol.trim()) : !otherId.trim()) {
      addError = code ? 'Give the repository, the commit and the symbol.' : 'Give the id of the other item.';
      return;
    }
    saving = true;
    try {
      const other = { kind: otherKind, id: otherId.trim() };
      await createTraceLink({
        ...(code || direction === 'from' ? { source: self } : { source: other }),
        link_type: linkType,
        ...(code ? { target_code: { repo: repo.trim(), commit: commit.trim(), symbol: symbol.trim() } } : { target: direction === 'from' ? other : self }),
        ...(note.trim() ? { note: note.trim() } : {}),
      });
      adding = false;
      otherId = '';
      repo = commit = symbol = note = '';
      await load();
    } catch (err) {
      addError = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }

  // --- Delete ------------------------------------------------------------------
  let confirming = $state<string | null>(null);
  let deleteError = $state<string | null>(null);
  async function remove(id: string): Promise<void> {
    deleteError = null;
    try {
      await deleteTraceLink(id);
      confirming = null;
      await load();
    } catch (err) {
      deleteError = err instanceof Error ? err.message : String(err);
    }
  }

  const field = 'rounded-md border border-[var(--color-border-strong)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]';
</script>

<section class="flex flex-col gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="trace-links">
  <div class="flex flex-wrap items-center justify-between gap-2">
    <h2 class="text-base font-semibold text-[var(--color-text)]">{title}</h2>
    {#if !adding}
      <button type="button" class="rounded-md border border-[var(--color-border-strong)] px-3 py-1 text-sm font-medium text-[var(--color-text)] hover:bg-[var(--color-surface-strong)]" onclick={() => (adding = true)} data-testid="trace-links-add">
        Add a link
      </button>
    {/if}
  </div>

  {#if adding}
    <form class="flex flex-col gap-2 rounded-md border border-[var(--color-border)] p-3" onsubmit={add} data-testid="trace-links-form">
      <div class="flex flex-wrap items-end gap-2 text-sm text-[var(--color-text)]">
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          Link
          <select class={field} bind:value={targetMode} data-testid="trace-links-mode">
            <option value="item">to another item</option>
            <option value="code">to a place in the code</option>
          </select>
        </label>
        {#if targetMode === 'item'}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Direction
            <select class={field} bind:value={direction} data-testid="trace-links-direction">
              <option value="from">this item …</option>
              <option value="to">the other item …</option>
            </select>
          </label>
        {/if}
        <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          How
          <select class={field} bind:value={linkType} data-testid="trace-links-type">
            {#each TRACE_LINK_TYPES as t (t)}<option value={t}>{LINK_VERB[t]}</option>{/each}
          </select>
        </label>
        {#if targetMode === 'item'}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            The other item — kind
            <select class={field} bind:value={otherKind} data-testid="trace-links-other-kind">
              {#each TRACE_KINDS as k (k)}<option value={k}>{TRACE_KIND_LABEL[k]}</option>{/each}
            </select>
          </label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            Its id
            <input class={field} bind:value={otherId} placeholder="Paste the id from its page" data-testid="trace-links-other-id" />
          </label>
        {:else}
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Repository<input class={field} bind:value={repo} placeholder="acme/payments" data-testid="trace-links-repo" /></label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Commit<input class={field} bind:value={commit} data-testid="trace-links-commit" /></label>
          <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Symbol<input class={field} bind:value={symbol} placeholder="Order.total" data-testid="trace-links-symbol" /></label>
        {/if}
      </div>
      <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">Note (optional)<input class={field} bind:value={note} maxlength="4000" /></label>
      {#if addError}<p class="text-sm text-[var(--color-danger)]" data-testid="trace-links-add-error">{addError}</p>{/if}
      <div class="flex gap-2">
        <button type="submit" class="rounded-md bg-[var(--color-accent)] px-3 py-1 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50" disabled={saving} data-testid="trace-links-save">{saving ? 'Saving…' : 'Add link'}</button>
        <button type="button" class="px-3 py-1 text-sm text-[var(--color-text-muted)]" onclick={() => (adding = false)}>Cancel</button>
      </div>
    </form>
  {/if}

  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading links…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2" data-testid="trace-links-error">
      <p class="text-sm text-[var(--color-danger)]">The links could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if links.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="trace-links-empty">No trace links yet.</p>
  {:else}
    <ul class="flex flex-col divide-y divide-[var(--color-border)]" data-testid="trace-links-list">
      {#each links as l (l.id)}
        {@const f = linkFromHere(l, itemId)}
        <li class="flex flex-wrap items-start justify-between gap-2 py-2 text-sm" data-testid="trace-link-row">
          <span class="text-[var(--color-text)]">
            This item <strong>{f.verb}</strong>
            {#if f.other}
              {@const key = `${f.other.kind}:${f.other.id}`}
              {@const href = traceHref(f.other.kind, f.other.id)}
              {TRACE_KIND_LABEL[f.other.kind as TraceKind] ?? f.other.kind}
              {#if href}<a class="text-[var(--color-link)] hover:underline" {href}>{names[key] ?? f.other.id}</a>{:else}{names[key] ?? f.other.id}{/if}
            {:else if f.code}
              <span class="font-mono text-xs">{f.code.symbol}</span> in {f.code.repo} at {f.code.commit.slice(0, 12)}
            {/if}
            {#if l.note}<span class="block text-xs text-[var(--color-text-muted)]">{l.note}</span>{/if}
            <span class="block text-xs text-[var(--color-text-muted)]">Added by {personLabel(l.created_by)}, {when(l.created_at)}</span>
          </span>
          {#if confirming === l.id}
            <span class="flex items-center gap-2">
              <button type="button" class="text-sm font-semibold text-[var(--color-danger)]" onclick={() => remove(l.id)} data-testid="trace-link-delete-confirm">Delete this link</button>
              <button type="button" class="text-sm text-[var(--color-text-muted)]" onclick={() => (confirming = null)}>Keep</button>
            </span>
          {:else}
            <button type="button" class="text-sm text-[var(--color-text-muted)] hover:text-[var(--color-danger)]" onclick={() => (confirming = l.id)} data-testid="trace-link-delete">Delete</button>
          {/if}
        </li>
      {/each}
    </ul>
    {#if deleteError}<p class="text-sm text-[var(--color-danger)]" data-testid="trace-links-delete-error">{deleteError}</p>{/if}
    {#if truncated}<p class="text-xs text-[var(--color-warning-text)]">Only the first 1,000 links each way are shown.</p>{/if}
  {/if}
</section>
