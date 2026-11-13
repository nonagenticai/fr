<!--
  CrossPaperContradictions (P3-R2) — over a discovery session's pushed papers,
  find where two of the researcher's OWN papers disagree ("paper A and paper B
  disagree on X"). Runs the already-wired per-entity `topologyContradictions`
  across every entity the session contributed, then reduces the pairs to the ones
  linking two DIFFERENT session papers (crossPaperContradictions.ts). Read-only;
  lazy on click. Honest empty / loading / error states.
-->
<script lang="ts">
  import { researchApi, type ContradictionResponse } from '$lib/api/research';
  import { AssetError } from '$lib/api/assets';
  import {
    findCrossPaperDisagreements,
    countExternalContradictions,
    netSupportLabel,
    type SessionPaper,
    type EntityContradictions,
    type CrossPaperDisagreement,
  } from './crossPaperContradictions';

  interface Props {
    papers: SessionPaper[];
  }
  const { papers }: Props = $props();

  // Bound the fan-out: at most this many distinct entity queries per run.
  const MAX_ENTITIES = 60;

  let running = $state(false);
  let error = $state('');
  let ran = $state(false);
  let disagreements = $state<CrossPaperDisagreement[]>([]);
  let externalCount = $state(0);
  let truncated = $state(false);
  // How much of the corpus the last run actually managed to look at.
  //
  // "No cross-paper disagreements found among the pushed papers" is a claim
  // about the CORPUS, and `run()` only ever raised an error when EVERY request
  // rejected. Each individual rejection became `{ response: null }` and was
  // skipped by the reducer in silence, so 59 failures out of 60 lookups printed
  // the same affirmative sentence as a clean, complete run. These two numbers
  // are what makes the difference visible, and they are reset per run.
  let attempted = $state(0);
  let failed = $state(0);

  const entityIds = $derived.by<string[]>(() => {
    const seen = new Set<string>();
    for (const p of papers) for (const e of p.entityIds) if (e) seen.add(e);
    return [...seen];
  });
  const canRun = $derived(papers.length >= 2 && entityIds.length > 0);

  async function run(): Promise<void> {
    if (!canRun || running) return;
    running = true;
    error = '';
    ran = true;
    disagreements = [];
    externalCount = 0;
    attempted = 0;
    failed = 0;
    const ids = entityIds.slice(0, MAX_ENTITIES);
    truncated = entityIds.length > ids.length;
    attempted = ids.length;
    try {
      const settled = await Promise.allSettled(
        ids.map((entityId) =>
          researchApi
            .topologyContradictions({ entity_id: entityId })
            .then((response): EntityContradictions => ({ entityId, response })),
        ),
      );
      const results: EntityContradictions[] = settled.map((s, i) =>
        s.status === 'fulfilled'
          ? s.value
          : { entityId: ids[i], response: null as ContradictionResponse | null },
      );
      failed = settled.filter((s) => s.status === 'rejected').length;
      if (settled.every((s) => s.status === 'rejected')) {
        const first = settled.find((s) => s.status === 'rejected');
        const reason = first && first.status === 'rejected' ? first.reason : undefined;
        error = reason instanceof AssetError ? reason.message : reason instanceof Error ? reason.message : 'Contradiction lookup failed.';
      }
      disagreements = findCrossPaperDisagreements(papers, results);
      externalCount = countExternalContradictions(papers, results);
    } finally {
      running = false;
    }
  }
</script>

<section class="rounded border border-[var(--color-border)] p-3" data-testid="research-cross-contradictions">
  <div class="flex flex-wrap items-center gap-2">
    <h3 class="text-sm font-semibold">Cross-paper disagreements</h3>
    <button
      type="button"
      data-testid="research-cross-contradictions-run"
      disabled={!canRun || running}
      onclick={() => void run()}
      class="ml-auto rounded border border-[var(--color-border-strong)] px-3 py-1 text-xs text-[var(--color-accent)] hover:border-[var(--color-accent)] disabled:opacity-50 disabled:cursor-not-allowed"
      title={canRun ? '' : 'Push at least two papers with graph entities first.'}
    >
      {running ? 'Analysing…' : 'Find disagreements'}
    </button>
  </div>
  <p class="mt-1 text-xs text-[var(--color-text-muted)]">
    Where two of your pushed papers make conflicting claims about the same entity.
  </p>

  {#if !canRun}
    <p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="research-cross-contradictions-need">
      Push at least two papers (with graph entities) into this session to compare them.
    </p>
  {:else if error}
    <p class="mt-2 text-xs text-[var(--color-danger)]" data-testid="research-cross-contradictions-error">{error}</p>
  {:else if ran && !running}
    {#if disagreements.length > 0}
      <ul class="mt-2 space-y-2" data-testid="research-cross-contradictions-list">
        {#each disagreements as d (d.paperAId + d.paperBId + d.topic)}
          <li class="rounded border border-[var(--color-border)] p-2 text-xs" data-testid="research-cross-contradiction">
            <div>
              <span class="font-medium">{d.paperATitle}</span>
              <span class="text-[var(--color-danger)]"> ⚔ </span>
              <span class="font-medium">{d.paperBTitle}</span>
            </div>
            <div class="text-[var(--color-text-muted)]">
              disagree on <span class="font-mono">{d.topic}</span>
              {#if d.netSupportScore !== undefined} · {netSupportLabel(d.netSupportScore)}{/if}
            </div>
          </li>
        {/each}
      </ul>
    {:else if failed === 0}
      <p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="research-cross-contradictions-none">
        No cross-paper disagreements found among the pushed papers.
      </p>
    {/if}
    <!--
      What was actually checked, whenever it was not everything.

      Rendered OUTSIDE the found/none branch on purpose: a partial run that DID
      surface a disagreement is the worse case, not the better one — the
      reviewer reads a list built from a fraction of the corpus as the complete
      set of conflicts in it. So the list and the coverage line appear together.
    -->
    {#if failed > 0}
      <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid="research-cross-contradictions-coverage">
        Checked {attempted - failed} of {attempted}
        {attempted === 1 ? 'entity' : 'entities'} — {failed}
        {failed === 1 ? 'lookup' : 'lookups'} failed, so this is not a complete answer
        for the corpus.
      </p>
    {/if}
    {#if externalCount > 0}
      <p class="mt-2 text-[10px] text-[var(--color-text-muted)]" data-testid="research-cross-contradictions-external">
        {externalCount} additional contradiction{externalCount === 1 ? '' : 's'} against evidence outside this session.
      </p>
    {/if}
    {#if truncated}
      <p class="mt-1 text-[10px] text-[var(--color-text-muted)]" data-testid="research-cross-contradictions-truncated">
        Analysed the first {MAX_ENTITIES} entities; some papers' entities were not compared.
      </p>
    {/if}
  {/if}
</section>
