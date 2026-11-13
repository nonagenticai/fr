<!--
  TagTree.svelte — multi-select faceted sidebar for /workflows.

  Top: "All workflows" reset.
  Then five count-bearing facet sections:
    · Domain   — which subsystem the flow operates on
    · Purpose  — what the flow is for
    · Stage    — card / authoring lifecycle stage (incl. a "(none)" row)
    · Trigger  — how the flow starts
    · Other tags — any non-namespaced tag still on a workflow

  Every row is a checkbox-style toggle: multi-select OR *within* a facet,
  AND *across* facets. Selection lives in the URL (one CSV query param per
  facet) and is owned by the page; this component just renders it and
  fires `onToggle`. Counts come from the backend's faceted `/tags`
  response — the backend already drops zero-count rows.
-->
<script lang="ts">
  import type { FacetedTags } from '$lib/api/workflows';
  import {
    type FacetSelection,
    type FacetKey,
    selectionIsEmpty,
  } from '$lib/workflows/facets';

  interface Props {
    tags: FacetedTags;
    selection: FacetSelection;
    onToggle: (key: FacetKey, slug: string) => void;
    onClearAll: () => void;
    totalWorkflows: number;
  }
  const { tags, selection, onToggle, onClearAll, totalWorkflows }: Props =
    $props();

  // The four namespaced facets, in sidebar order. `other` is rendered
  // separately below because its rows carry `tag` instead of `slug`.
  const facetSections = $derived(
    [
      { key: 'domain' as const, label: 'Domain', rows: tags.domain },
      { key: 'purpose' as const, label: 'Purpose', rows: tags.purpose },
      { key: 'stage' as const, label: 'Stage', rows: tags.stage },
      { key: 'trigger' as const, label: 'Trigger', rows: tags.trigger },
    ].filter((s) => s.rows.length > 0),
  );

  const nothingSelected = $derived(selectionIsEmpty(selection));
</script>

<nav class="tag-tree" aria-label="Workflow facets">
  <button
    type="button"
    class="tag-row all"
    class:active={nothingSelected}
    onclick={onClearAll}
  >
    <span class="tag-name">All workflows</span>
    <span class="tag-count">{totalWorkflows}</span>
  </button>

  {#each facetSections as section (section.key)}
    <div class="category">
      <div class="category-label">{section.label}</div>
      {#each section.rows as row (row.slug)}
        {@const checked = selection[section.key].has(row.slug)}
        <button
          type="button"
          class="tag-row"
          class:active={checked}
          aria-pressed={checked}
          onclick={() => onToggle(section.key, row.slug)}
          title={row.label}
        >
          <span class="check" class:checked aria-hidden="true"></span>
          <span class="tag-name">{row.label}</span>
          <span class="tag-count">{row.workflowCount}</span>
        </button>
      {/each}
    </div>
  {/each}

  {#if tags.other.length > 0}
    <div class="category">
      <div class="category-label">Other tags</div>
      {#each tags.other as row (row.tag)}
        {@const checked = selection.tag.has(row.tag)}
        <button
          type="button"
          class="tag-row"
          class:active={checked}
          aria-pressed={checked}
          onclick={() => onToggle('tag', row.tag)}
          title={row.tag}
        >
          <span class="check" class:checked aria-hidden="true"></span>
          <span class="tag-name">{row.tag}</span>
          <span class="tag-count">{row.workflowCount}</span>
        </button>
      {/each}
    </div>
  {/if}
</nav>

<style>
  .tag-tree {
    display: flex;
    flex-direction: column;
    gap: 14px;
    padding: 12px 8px;
    overflow: auto;
  }
  .category {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .category-label {
    padding: 4px 8px;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-muted);
  }
  .tag-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    padding: 6px 8px;
    border: 0;
    border-radius: 6px;
    background: transparent;
    color: var(--color-text);
    font-size: 13px;
    text-align: left;
    cursor: pointer;
  }
  .tag-row:hover {
    background: var(--color-surface-strong);
  }
  .tag-row.active {
    background: var(--color-accent-bg);
    color: var(--color-accent-text);
    font-weight: 600;
  }
  .tag-row.all {
    margin-bottom: 4px;
  }
  /* Checkbox affordance — the facets are multi-select. */
  .check {
    flex: 0 0 auto;
    width: 13px;
    height: 13px;
    border: 1.5px solid var(--color-border-strong);
    border-radius: 3px;
    background: var(--color-bg);
  }
  .check.checked {
    border-color: var(--color-accent);
    background: var(--color-accent);
  }
  .check.checked::after {
    content: '';
    display: block;
    width: 3px;
    height: 6px;
    margin: 1px auto 0;
    border: solid var(--color-on-primary);
    border-width: 0 1.5px 1.5px 0;
    transform: rotate(45deg);
  }
  .tag-name {
    flex: 1 1 auto;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .tag-count {
    flex: 0 0 auto;
    font-size: 11px;
    color: var(--color-text-muted);
    background: var(--color-surface-strong);
    padding: 1px 6px;
    border-radius: 999px;
  }
  .tag-row.active .tag-count {
    background: var(--color-accent-border);
    color: inherit;
  }
</style>
