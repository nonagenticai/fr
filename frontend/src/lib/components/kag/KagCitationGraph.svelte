<!--
  KagCitationGraph (P3-R1) — renders a snowball/discovery paper set as an
  interactive citation network via KagGraph: nodes = papers (coloured by trust
  score), edges = cites (forward) / references (backward). Auto-loads the first
  hop for the seed papers, then clicking any node expands it (pulls that paper's
  citations + references and merges the next hop). All read-only
  (`researchApi.getPaperRelated`). Honest loading / error / empty states.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { researchApi, type PaperResult } from '$lib/api/research';
  import { AssetError } from '$lib/api/assets';
  import KagGraph from '$lib/components/kag/KagGraph.svelte';
  import {
    seedGraph,
    mergeHop,
    relatedRows,
    trustColor,
    type CitationGraph,
  } from '$lib/components/kag/kagCitationGraph';

  interface Props {
    papers: PaperResult[];
    /** Papers to auto-expand on mount (usually the snowball seeds). Bounded by the caller. */
    seedIds?: string[];
  }
  const { papers, seedIds = [] }: Props = $props();

  // Seeded once from the initial papers; the panel remounts fresh each time it's
  // opened, so a later `papers` change doesn't need to reseed (and must not clobber
  // the user's expansions). untrack marks the initial-only capture as intentional.
  let graph = $state<CitationGraph>(untrack(() => seedGraph(papers)));
  let expanded = $state<Set<string>>(new Set());
  let expanding = $state<Set<string>>(new Set());
  let error = $state('');
  let selectedTitle = $state<string | null>(null);

  // Expand a paper: pull citations + references, merge the next hop. Idempotent —
  // a node already expanded is skipped. Each direction settles independently.
  async function expand(paperId: string): Promise<void> {
    if (!paperId || expanded.has(paperId) || expanding.has(paperId)) return;
    expanding = new Set(expanding).add(paperId);
    error = '';
    try {
      const results = await Promise.allSettled([
        researchApi.getPaperRelated(paperId, 'citations'),
        researchApi.getPaperRelated(paperId, 'references'),
      ]);
      let next = graph;
      const [cit, ref] = results;
      if (cit.status === 'fulfilled') next = mergeHop(next, paperId, 'citations', relatedRows(cit.value));
      if (ref.status === 'fulfilled') next = mergeHop(next, paperId, 'references', relatedRows(ref.value));
      graph = next;
      // Only mark the node expanded when at least one hop landed. If BOTH failed
      // we surface the error but leave it un-expanded so a second click retries
      // (expand() early-returns on already-expanded nodes → otherwise locked out).
      if (cit.status === 'fulfilled' || ref.status === 'fulfilled') {
        expanded = new Set(expanded).add(paperId);
      } else {
        const e = cit.reason;
        error = e instanceof AssetError ? e.message : e instanceof Error ? e.message : String(e);
      }
    } finally {
      const nextExpanding = new Set(expanding);
      nextExpanding.delete(paperId);
      expanding = nextExpanding;
    }
  }

  function onSelect(node: Record<string, unknown> | null): void {
    if (!node) {
      selectedTitle = null;
      return;
    }
    selectedTitle = typeof node.title === 'string' ? node.title : null;
    const id = typeof node.id === 'string' ? node.id : '';
    void expand(id);
  }

  // Auto-load the first hop for the seed papers (bounded by the caller's seedIds).
  // untrack so this fires once on mount and does NOT re-subscribe to the state
  // expand() touches (expanded/expanding/error) — otherwise a seed whose expand
  // failed (now deliberately left un-expanded so it can be retried) would loop the
  // effect forever. The panel remounts fresh, so a one-shot seed hop is correct.
  $effect(() => {
    untrack(() => {
      for (const id of seedIds) void expand(id);
    });
  });

  const nodeColor = (raw: Record<string, unknown>): string | undefined =>
    trustColor(typeof raw.trust_score === 'number' ? raw.trust_score : null);
</script>

<div data-testid="kag-citation-graph">
  <div class="mb-2 flex flex-wrap items-center gap-3 text-xs text-[var(--color-text-muted)]">
    <span>{graph.nodes.length} papers · {graph.edges.length} citation links</span>
    {#if expanding.size > 0}
      <span data-testid="kag-citation-graph-loading">Expanding…</span>
    {/if}
    <span class="flex items-center gap-1">
      <span class="inline-block h-2 w-2 rounded-full" style="background: var(--color-success)"></span> high trust
      <span class="ml-2 inline-block h-2 w-2 rounded-full" style="background: var(--color-warning)"></span> medium
      <span class="ml-2 inline-block h-2 w-2 rounded-full" style="background: var(--color-danger)"></span> low
    </span>
  </div>

  {#if error}
    <p class="mb-2 text-xs text-[var(--color-danger)]" data-testid="kag-citation-graph-error">{error}</p>
  {/if}

  {#if graph.nodes.length === 0}
    <p class="py-6 text-center text-sm text-[var(--color-text-muted)]" data-testid="kag-citation-graph-empty">
      No papers to graph yet.
    </p>
  {:else}
    <KagGraph nodes={graph.nodes} relationships={graph.edges} {nodeColor} {onSelect} />
    <p class="mt-1 text-[10px] text-[var(--color-text-muted)]">
      Click a paper to expand its citations + references (the next hop).
    </p>
    {#if selectedTitle}
      <p class="mt-1 text-xs" data-testid="kag-citation-graph-selected">Selected: {selectedTitle}</p>
    {/if}
  {/if}
</div>
