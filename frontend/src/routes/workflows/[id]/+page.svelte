<!--
  /workflows/[id] — Svelte Flow canvas viewer with prev/next nav.
-->
<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import WorkflowCanvas, {
    type LayoutMode,
  } from '$lib/workflows/WorkflowCanvas.svelte';
  import NodeParameterPanel from '$lib/workflows/NodeParameterPanel.svelte';
  import ErrorMessage from '$lib/components/ErrorMessage.svelte';
  import type { FlowNode } from '$lib/workflows/adapter';
  import {
    parseFacetSelection,
    matchesFacets,
  } from '$lib/workflows/facets';
  import type { PageData } from './$types';

  const { data }: { data: PageData } = $props();

  let selectedNode = $state<FlowNode | null>(null);

  // Per-workflow layout preference. 'auto' detects overlap and picks
  // dagre; the user can pin to 'dagre' (Tidy) or 'n8n' (Original).
  const layoutKey = $derived(`fr.workflows.layout.${data.workflow?.id ?? 'unknown'}`);
  let layoutMode = $state<LayoutMode>('auto');

  $effect(() => {
    if (typeof window === 'undefined') return;
    if (typeof window.localStorage?.getItem !== 'function') return;
    const stored = window.localStorage.getItem(layoutKey);
    layoutMode =
      stored === 'n8n' || stored === 'dagre' || stored === 'auto'
        ? stored
        : 'auto';
  });

  function setLayout(mode: LayoutMode) {
    layoutMode = mode;
    if (typeof window !== 'undefined' && typeof window.localStorage?.setItem === 'function') {
      window.localStorage.setItem(layoutKey, mode);
    }
  }

  // Sidebar facet filters the user came from — kept sticky across
  // prev/next so navigation stays inside the same multi-facet selection.
  // Reuse the index page's query string verbatim; it carries the CSV
  // per-facet params (`?domain=a,b&purpose=x&...`).
  const filterSearch = $derived(page.url.search);
  const filterSelection = $derived(
    parseFacetSelection(page.url.searchParams),
  );

  // Restrict prev/next to the same facet selection the user came from —
  // the SAME predicate the index list uses (OR within facet, AND across).
  const filteredList = $derived(
    data.workflows.filter((w) => matchesFacets(w, filterSelection)),
  );

  const currentIndex = $derived(
    data.workflow ? filteredList.findIndex((w) => w.id === data.workflow!.id) : -1,
  );
  const prev = $derived(currentIndex > 0 ? filteredList[currentIndex - 1] : null);
  const next = $derived(
    currentIndex >= 0 && currentIndex < filteredList.length - 1
      ? filteredList[currentIndex + 1]
      : null,
  );

  function nav(target: { id: string } | null) {
    if (!target) return;
    goto(`/workflows/${target.id}${filterSearch}`);
  }

  function onKey(e: KeyboardEvent) {
    if (e.target && (e.target as HTMLElement).tagName === 'INPUT') return;
    if (e.key === 'ArrowLeft' && prev) nav(prev);
    else if (e.key === 'ArrowRight' && next) nav(next);
  }

  const tags = $derived(
    Array.isArray((data.workflow as unknown as { tags?: unknown } | null)?.tags)
      ? ((data.workflow as unknown as { tags: Array<string | { name?: string }> }).tags ?? [])
          .map((t) => (typeof t === 'string' ? t : (t.name ?? '')))
          .filter((s) => s.length > 0)
      : [],
  );

  const updatedAt = $derived(
    typeof (data.workflow as unknown as { updatedAt?: unknown } | null)?.updatedAt === 'string'
      ? (data.workflow as unknown as { updatedAt: string }).updatedAt
      : '',
  );
  const active = $derived(
    Boolean((data.workflow as unknown as { active?: unknown } | null)?.active),
  );

  // The workflow itself could not be read. `data.workflow` is null, and every
  // derived above is null-safe so this branch can render alone. An unloadable
  // workflow must NOT draw as a blank canvas — same honesty rule as the index
  // page's "No workflows yet." and the backend's refusal to serve `0/0`.
  const detailFailed = $derived(data.workflow === null);

  function retry() {
    void invalidateAll();
  }

  // Publish this route's entity name to the single title element in the
  // root layout. Always the CURRENT pathname: the resolver drops an override
  // whose path no longer matches, which is what makes a stale tab title
  // impossible. `null` while loading falls back to the static map entry.
  $effect(() => {
    setPageTitle(page.url.pathname, data.workflow?.name ?? null);
  });
</script>

<svelte:window onkeydown={onKey} />

{#if detailFailed}
  <div class="detail-page">
    <header class="bar">
      <a class="back" href="/workflows{filterSearch}">← Workflows</a>
      <div class="title-block">
        <div class="title">{data.breadcrumbLabel}</div>
      </div>
    </header>
    <div class="load-error">
      <ErrorMessage
        title="Couldn't load this workflow"
        message={`The workflow definition could not be read from n8n, so there is nothing to draw. This is not an empty workflow — it is an unknown one. ${data.workflowError}`}
        dismissible={false}
        onRetry={retry}
      />
    </div>
  </div>
{:else}
<div class="detail-page">
  <header class="bar">
    <a class="back" href="/workflows{filterSearch}">← Workflows</a>
    <div class="title-block">
      <div class="title">{data.workflow!.name ?? data.workflow!.id}</div>
      <div class="meta">
        <span class="status" class:active>{active ? 'Active' : 'Inactive'}</span>
        {#each tags as t (t)}<span class="chip">{t}</span>{/each}
        {#if updatedAt}<span class="updated" title={updatedAt}>updated {new Date(updatedAt).toLocaleString()}</span>{/if}
        <a class="manage-scope" href="/library/workflows">Manage scope →</a>
      </div>
    </div>
    <div class="layout-toggle" role="group" aria-label="Layout">
      <button
        type="button"
        class:on={layoutMode === 'dagre'}
        onclick={() => setLayout('dagre')}
        title="Auto-tidy with dagre"
      >Tidy</button>
      <button
        type="button"
        class:on={layoutMode === 'n8n'}
        onclick={() => setLayout('n8n')}
        title="Use the positions stored in n8n"
      >Original</button>
      <button
        type="button"
        class:on={layoutMode === 'auto'}
        onclick={() => setLayout('auto')}
        title="Auto: tidy only when overlap is detected"
      >Auto</button>
    </div>
    <div class="nav-buttons">
      {#if data.workflowsError}
        <!-- The catalogue read failed, so prev/next has no list to walk. Two
             permanently disabled buttons look like a bug; say what happened. -->
        <span class="nav-unavailable" title={data.workflowsError}>Prev/next unavailable</span>
      {:else}
        <button type="button" disabled={!prev} onclick={() => nav(prev)} title={prev?.name ?? ''}>← Prev</button>
        <button type="button" disabled={!next} onclick={() => nav(next)} title={next?.name ?? ''}>Next →</button>
      {/if}
    </div>
  </header>
  {#if data.workflowsStale}
    <!--
      Same banner as the index page (shape copied from ArchitectureView's
      "Showing the last stored report (as of …)"), scoped honestly: the CANVAS
      is live — `handleGet` has no cache — but the prev/next catalogue came out
      of the backend's cache and can be up to an hour old.
    -->
    <div class="stale-banner" role="status" data-testid="workflows-stale-banner">
      <span aria-hidden="true">⚠️</span>
      <span>
        Showing a cached workflow catalogue{data.staleAsOf
          ? ` (as of ${new Date(data.staleAsOf).toLocaleString()})`
          : ''} — n8n is not responding, so prev/next may be out of date.
      </span>
    </div>
  {/if}
  <div class="canvas-host">
    <WorkflowCanvas
      workflow={data.workflow!}
      layout={layoutMode}
      onNodeSelect={(n) => (selectedNode = n)}
    />
  </div>
  <NodeParameterPanel node={selectedNode} onClose={() => (selectedNode = null)} />
</div>
{/if}

<style>
  .detail-page {
    display: flex;
    flex-direction: column;
    height: calc(100vh - 64px);
    min-height: 480px;
  }
  .bar {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--color-border);
    background: var(--color-bg);
  }
  .back {
    color: var(--color-text-muted);
    text-decoration: none;
    font-size: 13px;
  }
  .back:hover { color: var(--color-accent); }
  .load-error {
    padding: 20px;
    max-width: 46rem;
  }
  .nav-unavailable {
    font-size: 12px;
    color: var(--color-danger);
    white-space: nowrap;
  }
  .title-block { flex: 1 1 auto; min-width: 0; }
  .title {
    font-weight: 700;
    font-size: 16px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    margin-top: 2px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    font-size: 12px;
    color: var(--color-text-muted);
  }
  .status {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--color-surface-strong);
  }
  .status.active {
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
    color: var(--color-success);
  }
  .chip {
    padding: 1px 8px;
    border-radius: 999px;
    background: var(--color-surface-strong);
    color: var(--color-text);
  }
  .updated { font-style: italic; }
  .manage-scope {
    margin-left: auto;
    color: var(--color-accent);
    text-decoration: none;
  }
  .manage-scope:hover { text-decoration: underline; }
  .nav-buttons { display: flex; gap: 8px; }
  .nav-buttons button {
    padding: 6px 12px;
    font-size: 13px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    cursor: pointer;
  }
  .nav-buttons button:disabled {
    opacity: 0.4;
    cursor: not-allowed;
  }
  .layout-toggle {
    display: inline-flex;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    overflow: hidden;
  }
  .layout-toggle button {
    padding: 6px 10px;
    font-size: 12px;
    border: 0;
    border-right: 1px solid var(--color-border);
    background: var(--color-bg);
    color: var(--color-text);
    cursor: pointer;
  }
  .layout-toggle button:last-child {
    border-right: 0;
  }
  .layout-toggle button.on {
    background: var(--color-accent);
    color: var(--color-on-primary);
  }
  .canvas-host {
    flex: 1 1 auto;
    min-height: 0;
  }
  .stale-banner {
    display: flex;
    align-items: center;
    gap: 8px;
    flex: 0 0 auto;
    padding: 8px 20px;
    border-bottom: 1px solid var(--color-warning-border);
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    font-size: 13px;
  }
</style>
