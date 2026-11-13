<!--
  ContextualPane — Plan 3 follow-up §T12.

  Reads the rightPane store and renders the matching extracted view.
  Visibility is now gated at the ThreePaneLayout level (it only renders
  this component when rightPaneStore.isOpen() is true), so we never
  show a "Select an item…" placeholder — the whole rail collapses to
  zero width when empty.

  Every view is `let { id } = $props()` + `onMount(load)` with no `$effect`,
  so a SECOND item of the same kind would keep the first record's body while
  the header id changed. The `{#key}` below remounts on every (kind, id), so
  `onMount(load)` re-runs. Chosen over per-view `$effect` because it is
  uniform across all five views and inherently race-free: the old instance is
  destroyed, so a late in-flight response cannot overwrite the new record.
-->
<script lang="ts">
  import { rightPane, paneKey, type RightPaneKind } from '$lib/stores/rightPane.svelte';
  import {
    KagSessionView,
    N8nExecutionView,
    CodingJobView,
    BridgeDraftView,
    KanbanCardView,
  } from '$lib/components/contextual';

  const RENDERED_KINDS: readonly RightPaneKind[] = [
    'kag-session',
    'n8n-execution',
    'coding-job',
    'bridge-draft',
    'kanban-card',
  ];

  // The store is written from deep links and agent tool results, so a kind
  // with no view really can arrive at runtime. Users get a calm sentence;
  // the kind stays visible to developers in the console.
  $effect(() => {
    const kind = rightPane.kind;
    if (kind !== null && !RENDERED_KINDS.includes(kind)) {
      console.warn(`[ContextualPane] no view registered for kind: ${kind}`);
    }
  });
</script>

{#if rightPane.isOpen() && rightPane.id !== null}
  <div class="border-l border-[var(--color-border)] h-full overflow-auto bg-[var(--color-surface)]">
    {#key paneKey(rightPane.kind, rightPane.id, rightPane.meta)}
      {#if rightPane.kind === 'kag-session'}
        <KagSessionView id={rightPane.id} />
      {:else if rightPane.kind === 'n8n-execution'}
        <N8nExecutionView id={rightPane.id} />
      {:else if rightPane.kind === 'coding-job'}
        <CodingJobView id={rightPane.id} />
      {:else if rightPane.kind === 'bridge-draft'}
        <BridgeDraftView id={rightPane.id} />
      {:else if rightPane.kind === 'kanban-card'}
        <KanbanCardView id={rightPane.id} />
      {:else}
        <div class="p-4 text-xs text-[var(--color-text-muted)]">
          There's no detail view for this item.
        </div>
      {/if}
    {/key}
  </div>
{/if}
