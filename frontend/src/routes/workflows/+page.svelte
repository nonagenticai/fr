<!--
  /workflows index — multi-select faceted sidebar + text search over the
  workflow list. Workflows filter by four orthogonal facets (domain /
  purpose / stage / trigger) plus a non-namespaced "other tags" bucket:
  multi-select OR within a facet, AND across facets. Selection lives in
  the URL as one CSV query param per facet, so it is shareable and the
  detail page reuses it verbatim for prev/next nav.

  The list is the only authoritative read of the n8n catalog.
-->
<script lang="ts">
  import { goto, invalidateAll } from '$app/navigation';
  import { page } from '$app/state';
  import TagTree from '$lib/workflows/TagTree.svelte';
  import ErrorMessage from '$lib/components/ErrorMessage.svelte';
  import type { WorkflowSummary } from '$lib/api/workflows';
  import {
    FACETS,
    type FacetKey,
    parseFacetSelection,
    selectionToParams,
    selectionIsEmpty,
    matchesFacets,
    effectiveFacets,
    facetLabel,
  } from '$lib/workflows/facets';
  import type { PageData } from './$types';

  const { data }: { data: PageData } = $props();

  let query = $state('');

  // Selection is derived straight from the URL — the page never holds
  // filter state of its own, so reload / back-forward / shared links all
  // restore the same view.
  const selection = $derived(parseFacetSelection(page.url.searchParams));
  const hasFacetSelection = $derived(!selectionIsEmpty(selection));

  // Primary domain / purpose for a workflow card, as display labels.
  function primaryDomainLabel(w: WorkflowSummary): string {
    const slug = effectiveFacets(w).domains[0];
    return slug ? facetLabel('domain', slug) : 'General';
  }
  function purposeSlug(w: WorkflowSummary): string {
    return effectiveFacets(w).purposes[0] ?? 'operational';
  }

  const filtered = $derived.by(() => {
    const q = query.trim().toLowerCase();
    return data.workflows.filter((w) => {
      if (!matchesFacets(w, selection)) return false;
      if (q) {
        if (w.name.toLowerCase().includes(q)) return true;
        if (w.tags.some((t) => t.toLowerCase().includes(q))) return true;
        return false;
      }
      return true;
    });
  });

  // Apply a patch of query-string params in one shot. Two separate
  // goto() calls would race: the second reads page.url before the
  // first navigation lands and ends up overwriting the first patch.
  function setParams(patch: Record<string, string | null>) {
    const url = new URL(page.url.href);
    for (const [name, value] of Object.entries(patch)) {
      if (value === null) url.searchParams.delete(name);
      else url.searchParams.set(name, value);
    }
    goto(url.pathname + url.search, { replaceState: true, reset: false });
  }

  // Toggle one slug in one facet's set, then write the whole selection
  // back to the URL as CSV-per-facet params.
  function toggleFacet(key: FacetKey, slug: string) {
    const next = parseFacetSelection(page.url.searchParams);
    if (next[key].has(slug)) next[key].delete(slug);
    else next[key].add(slug);
    setParams(selectionToParams(next));
  }

  function clearAll() {
    query = '';
    const cleared: Record<string, string | null> = {};
    for (const f of FACETS) cleared[f.key] = null;
    setParams(cleared);
  }

  // A compact "domain: a, b · purpose: x" summary of the active facets.
  const selectionSummary = $derived.by(() => {
    const parts: string[] = [];
    for (const f of FACETS) {
      const slugs = [...selection[f.key]];
      if (slugs.length === 0) continue;
      const labels = slugs.map((s) =>
        f.key === 'tag' ? s : facetLabel(f.key, s),
      );
      parts.push(`${f.label.toLowerCase()}: ${labels.join(', ')}`);
    }
    return parts;
  });

  function relativeUpdated(iso: string): string {
    if (!iso) return '';
    const ms = Date.now() - new Date(iso).getTime();
    if (Number.isNaN(ms)) return '';
    const s = Math.max(0, Math.floor(ms / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    return `${Math.floor(s / 86400)}d ago`;
  }

  function buildHref(id: string): string {
    return `/workflows/${id}${page.url.search}`;
  }

  // The catalogue read failed. `data.workflows` is [] in that case, but it
  // means "we don't know", NOT "there are none" — so the whole list region is
  // replaced by an explicit error instead of the "No workflows yet." empty
  // state. See +page.ts for the measured 500 this replaces.
  const catalogueFailed = $derived(data.workflowsError !== null);

  function retry() {
    void invalidateAll();
  }
</script>

<div class="workflows-page">
  <aside class="sidebar">
    {#if data.tagsError}
      <!-- Facets degrade on their own: the list is the content, the sidebar
           is a filter aid over it. An all-zero TagTree would read as "no tags
           exist", so say what actually happened instead. -->
      <p class="sidebar-error">Filters unavailable — {data.tagsError}</p>
    {/if}
    <TagTree
      tags={data.tags}
      {selection}
      onToggle={toggleFacet}
      onClearAll={clearAll}
      totalWorkflows={data.workflows.length}
    />
  </aside>
  <section class="content">
    {#if data.workflowsStale}
      <!--
        Cache-served catalogue. Shape copied from the existing precedent in
        `components/architecture/ArchitectureView.svelte` ("Showing the last
        stored report (as of …)"): warning tokens, role="status", the fetch
        timestamp spelled out. Without this the backend's degraded envelope was
        discarded by the client and up-to-an-hour-old data drew as live.
      -->
      <div class="stale-banner" role="status" data-testid="workflows-stale-banner">
        <span aria-hidden="true">⚠️</span>
        <span>
          Showing a cached workflow catalogue{data.staleAsOf
            ? ` (as of ${new Date(data.staleAsOf).toLocaleString()})`
            : ''} — n8n is not responding, so this may be out of date.
        </span>
      </div>
    {/if}
    <header class="page-head">
      <div class="title-row">
        <h1>Workflows</h1>
        <div class="search-wrap">
          <input
            type="search"
            placeholder="Search by name or tag…"
            bind:value={query}
            aria-label="Search workflows"
          />
          {#if query || hasFacetSelection}
            <button type="button" class="clear" onclick={clearAll}>Clear</button>
          {/if}
        </div>
      </div>
      {#if catalogueFailed}
        <p class="lede">Workflow count unavailable.</p>
      {:else}
        <p class="lede">
          {filtered.length} of {data.workflows.length} workflow{data.workflows.length === 1 ? '' : 's'}
          {#each selectionSummary as part (part)}
            · {part}
          {/each}
          {#if query.trim()}
            · matching <strong>"{query.trim()}"</strong>
          {/if}
        </p>
      {/if}
    </header>
    {#if catalogueFailed}
      <div class="load-error">
        <ErrorMessage
          title="Couldn't load workflows"
          message={`The workflow catalogue could not be read from n8n, so this page cannot show the fleet. This is not an empty catalogue — it is an unknown one. ${data.workflowsError}`}
          dismissible={false}
          onRetry={retry}
        />
      </div>
    {:else if filtered.length === 0}
      <p class="empty">
        {#if query.trim()}
          No workflows match "{query.trim()}".
        {:else if hasFacetSelection}
          No workflows match the selected facets.
        {:else}
          No workflows yet.
        {/if}
      </p>
    {:else}
      <ul class="workflow-grid">
        {#each filtered as wf (wf.id)}
          <li>
            <a class="card" href={buildHref(wf.id)}>
              <div class="card-head">
                <span class="card-name">{wf.name}</span>
                <span class="card-status" class:active={wf.active}>
                  {wf.active ? 'Active' : 'Inactive'}
                </span>
              </div>
              <div class="card-meta">
                <span class="card-domain">{primaryDomainLabel(wf)}</span>
                <span class="card-purpose purpose-{purposeSlug(wf)}">
                  {facetLabel('purpose', purposeSlug(wf))}
                </span>
                <span>•</span>
                <span>{wf.nodeCount} nodes</span>
                {#if wf.updatedAt}<span>•</span><span title={wf.updatedAt}>{relativeUpdated(wf.updatedAt)}</span>{/if}
              </div>
              {#if wf.tags.length > 0}
                <div class="card-tags">
                  {#each wf.tags.slice(0, 4) as t (t)}
                    <span class="chip">{t}</span>
                  {/each}
                  {#if wf.tags.length > 4}<span class="chip more">+{wf.tags.length - 4}</span>{/if}
                </div>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>

<style>
  .workflows-page {
    display: grid;
    grid-template-columns: 280px 1fr;
    gap: 0;
    height: 100%;
    min-height: calc(100vh - 64px);
  }
  .sidebar {
    border-right: 1px solid var(--color-border);
    background: var(--color-surface);
    overflow: auto;
  }
  .content {
    padding: 24px 32px;
    overflow: auto;
  }
  .page-head h1 {
    margin: 0;
    font-size: 22px;
    font-weight: 700;
  }
  .title-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    flex-wrap: wrap;
  }
  .search-wrap {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .search-wrap input[type='search'] {
    width: 280px;
    max-width: 100%;
    padding: 7px 10px;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    background: var(--color-bg);
    color: var(--color-text);
    font-size: 13px;
  }
  .search-wrap input[type='search']:focus {
    outline: 2px solid var(--color-accent);
    outline-offset: -1px;
    border-color: transparent;
  }
  .clear {
    background: transparent;
    border: 1px solid var(--color-border);
    border-radius: 6px;
    padding: 6px 10px;
    font-size: 12px;
    color: var(--color-text);
    cursor: pointer;
  }
  .clear:hover {
    background: var(--color-surface-strong);
  }
  .page-head .lede {
    margin: 4px 0 20px;
    color: var(--color-text-muted);
    font-size: 13px;
  }
  .workflow-grid {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: 12px;
  }
  .card {
    display: block;
    padding: 14px 16px;
    background: var(--color-bg);
    border: 1px solid var(--color-border);
    border-radius: 8px;
    text-decoration: none;
    color: inherit;
    transition: border-color 120ms ease, transform 120ms ease;
  }
  .card:hover {
    border-color: var(--color-accent);
    transform: translateY(-1px);
  }
  .card-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  .card-name {
    font-weight: 600;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .card-status {
    flex: 0 0 auto;
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--color-surface-strong);
    color: var(--color-text-muted);
  }
  .card-status.active {
    background: color-mix(in srgb, var(--color-success) 14%, transparent);
    color: var(--color-success);
  }
  .card-meta {
    margin-top: 6px;
    display: flex;
    align-items: center;
    gap: 8px;
    flex-wrap: wrap;
    color: var(--color-text-muted);
    font-size: 12px;
  }
  .card-domain {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-surface-strong);
    color: var(--color-text);
  }
  .card-purpose {
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 999px;
    background: var(--color-surface-strong);
    color: var(--color-text);
  }
  .card-purpose.purpose-improvement {
    background: color-mix(in srgb, var(--color-accent) 14%, transparent);
    color: var(--color-accent);
  }
  .card-purpose.purpose-pattern {
    background: color-mix(in srgb, var(--color-info, #0ea5e9) 14%, transparent);
    color: var(--color-info, #0369a1);
  }
  .card-purpose.purpose-authoring {
    background: color-mix(in srgb, var(--color-success, #16a34a) 14%, transparent);
    color: var(--color-success, #16a34a);
  }
  .card-purpose.purpose-demo,
  .card-purpose.purpose-test-monitoring {
    background: color-mix(in srgb, var(--color-warning, #f59e0b) 16%, transparent);
    color: var(--color-warning, #b45309);
  }
  .card-tags {
    margin-top: 10px;
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
  }
  .chip {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--color-surface-strong);
    color: var(--color-text);
  }
  .chip.more {
    background: transparent;
    color: var(--color-text-muted);
  }
  .empty {
    color: var(--color-text-muted);
  }

  .load-error {
    max-width: 46rem;
  }

  .sidebar-error {
    margin: 0 0 0.75rem;
    font-size: 0.8125rem;
    color: var(--color-danger);
  }

  .stale-banner {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin-bottom: 1rem;
    padding: 0.5rem 1rem;
    border: 1px solid var(--color-warning-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    font-size: 0.875rem;
  }
</style>
