<!--
  DeliverableTabs — Stage 6's six research deliverables behind a simple tab bar:
  (a) verified answer + citations, (b) annotated literature review, (c) the
  claim-verification ledger, (d) the curated corpus, (e) the interactive
  knowledge graph of the pushed corpus, (f) evidence synthesis (pooled estimate
  across the corpus). Each panel is a snippet supplied by the page (so the
  deliverables close over the live session state); this component only owns the
  active-tab switch.
-->
<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    answer: Snippet;
    review: Snippet;
    ledger: Snippet;
    corpus: Snippet;
    graph: Snippet;
    synthesis: Snippet;
  }
  const { answer, review, ledger, corpus, graph, synthesis }: Props = $props();

  const TABS = [
    { id: 'answer', label: 'Answer' },
    { id: 'review', label: 'Literature review' },
    { id: 'ledger', label: 'Claim ledger' },
    { id: 'corpus', label: 'Curated corpus' },
    { id: 'graph', label: 'Knowledge graph' },
    { id: 'synthesis', label: 'Evidence synthesis' },
  ] as const;
  type TabId = (typeof TABS)[number]['id'];
  let active = $state<TabId>('answer');
</script>

<div class="flex flex-col gap-2" data-testid="deliverable-tabs">
  <div class="flex flex-wrap gap-1 border-b" role="tablist">
    {#each TABS as t (t.id)}
      <button
        type="button"
        role="tab"
        aria-selected={active === t.id}
        data-testid={`deliverable-tab-${t.id}`}
        onclick={() => (active = t.id)}
        class={`rounded-t px-3 py-1 text-sm ${
          active === t.id
            ? 'bg-[var(--color-accent)] text-[var(--color-on-primary)]'
            : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'
        }`}
      >
        {t.label}
      </button>
    {/each}
  </div>
  <div data-testid="deliverable-panel">
    {#if active === 'answer'}{@render answer()}
    {:else if active === 'review'}{@render review()}
    {:else if active === 'ledger'}{@render ledger()}
    {:else if active === 'corpus'}{@render corpus()}
    {:else if active === 'graph'}{@render graph()}
    {:else if active === 'synthesis'}{@render synthesis()}
    {/if}
  </div>
</div>
