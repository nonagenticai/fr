<!--
  ModelTraceLinks — every trace link that belongs to this model (requirements_management
  files a link under the model of its starting item). RM lists trace links by
  their ends, not by model, so this reads the workspace's links and keeps this
  model's; it says so when the list was cut off. Each item's own page shows its
  links both ways and lets you add or delete them.
-->
<script lang="ts">
  import { listTraceLinks, type TraceKind, type TraceLink, type TraceLinkType } from '$lib/api/modeling';
  import { LINK_VERB, TRACE_KIND_LABEL, traceHref, traceItemName } from '$lib/modeling/trace';

  let { modelId }: { modelId: string } = $props();

  let links = $state<TraceLink[]>([]);
  let truncated = $state(false);
  let loading = $state(true);
  let error = $state<string | null>(null);
  let names = $state<Record<string, string>>({});

  function resolve(kind: string, id: string): void {
    const key = `${kind}:${id}`;
    if (key in names) return;
    names = { ...names, [key]: id };
    traceItemName(kind, id).then(
      (n) => n && (names = { ...names, [key]: n }),
      (err) => console.warn('[ModelTraceLinks] an item name could not be read; its id is shown', kind, id, err),
    );
  }

  async function load(): Promise<void> {
    loading = true;
    error = null;
    try {
      const r = await listTraceLinks();
      links = r.items.filter((l) => l.model_id === modelId);
      truncated = r.truncated;
      for (const l of links) {
        resolve(l.source.kind, l.source.id);
        if (l.target) resolve(l.target.kind, l.target.id);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    } finally {
      loading = false;
    }
  }
  $effect(() => {
    void modelId;
    load();
  });
</script>

{#snippet end(e: { kind: string; id: string })}
  {@const href = traceHref(e.kind, e.id)}
  <span class="text-xs text-[var(--color-text-muted)]">{TRACE_KIND_LABEL[e.kind as TraceKind] ?? e.kind}</span>
  {#if href}<a class="text-[var(--color-link)] hover:underline" {href}>{names[`${e.kind}:${e.id}`] ?? e.id}</a>{:else}{e.id}{/if}
{/snippet}

<section class="flex flex-col gap-2 rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="model-trace-links">
  <h2 class="text-base font-semibold text-[var(--color-text)]">Trace links</h2>
  <p class="text-xs text-[var(--color-text-muted)]">Links that start at an item of this model. Open an item to add or delete its links.</p>
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading links…</p>
  {:else if error}
    <div class="flex flex-wrap items-center gap-2">
      <p class="text-sm text-[var(--color-danger)]">The links could not be loaded: {error}</p>
      <button type="button" class="text-sm font-medium text-[var(--color-link)] underline" onclick={load}>Try again</button>
    </div>
  {:else if links.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="model-trace-links-empty">No trace links in this model yet.</p>
  {:else}
    <ul class="flex flex-col gap-1 text-sm text-[var(--color-text)]">
      {#each links as l (l.id)}
        <li data-testid="model-trace-link-row">
          {@render end(l.source)} <strong>{LINK_VERB[l.link_type as TraceLinkType] ?? l.link_type}</strong>
          {#if l.target}{@render end(l.target)}{:else if l.target_code}<span class="font-mono text-xs">{l.target_code.symbol}</span> in {l.target_code.repo}{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if truncated}<p class="text-xs text-[var(--color-warning-text)]">The workspace has more than 1,000 links; only links among the first 1,000 are shown here. Each item's page shows all of its own.</p>{/if}
</section>
