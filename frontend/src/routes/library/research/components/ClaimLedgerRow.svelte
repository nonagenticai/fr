<!--
  ClaimLedgerRow — one row of the claim-verification ledger: a claim, its
  Chain-of-Verification verdict, and the count of contradictions found around the
  backing entity. Presentational; the parent runs the verification and passes the
  results down.
-->
<script lang="ts">
  import type { CoveResponse, CoveQuestion, ContradictionResponse } from '$lib/api/research';
  import { netSupportLabel } from './crossPaperContradictions';

  // Per-question verdict word: prefer the live `verdict`, fall back to the
  // deprecated boolean `supported`, else 'unknown'.
  function coveVerdictWord(qq: CoveQuestion): string {
    if (qq.verdict) return qq.verdict;
    if (qq.supported === true) return 'supported';
    if (qq.supported === false) return 'unsupported';
    return 'unknown';
  }
  // Chip colour keyed off the verdict word (only the two known outcomes get a
  // semantic colour; anything else stays neutral).
  function coveChipClass(word: string): string {
    return word === 'supported'
      ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]'
      : word === 'unsupported'
        ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
        : 'bg-[var(--color-surface)]';
  }

  interface Props {
    claim: string;
    cove?: CoveResponse | null;
    contradictions?: ContradictionResponse | null;
    running?: boolean;
    error?: string | null;
  }
  const {
    claim,
    cove = null,
    contradictions = null,
    running = false,
    error = null,
  }: Props = $props();

  // Upstream emits `overall_verdict` ("verified" | "disputed" | "inconclusive");
  // `supported`/`verdict` are legacy read-fallbacks that upstream never populates.
  const supported = $derived(
    cove?.overall_verdict === 'verified'
      ? true
      : cove?.overall_verdict === 'disputed'
        ? false
        : cove?.overall_verdict != null
          ? undefined
          : cove?.supported,
  );
  // Human label: prefer the live overall_verdict string, then legacy verdict,
  // then the supported-derived word.
  const verdictLabel = $derived(
    cove?.overall_verdict ??
      cove?.verdict ??
      (supported === true ? 'supported' : supported === false ? 'unsupported' : 'inconclusive'),
  );
  // The verdict badge shares the same colour logic in both its toggle and
  // plain forms; extract it so the two branches stay in lock-step.
  const verdictBadgeClass = $derived(
    `rounded px-1.5 py-0.5 border ${
      supported === true
        ? 'bg-[var(--color-success-bg)] text-[var(--color-success-text)]'
        : supported === false
          ? 'bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]'
          : 'bg-[var(--color-surface)]'
    }`,
  );
  // Optional inline suffixes on the verdict badge.
  const confidencePct = $derived(
    typeof cove?.confidence === 'number' ? `${(cove.confidence * 100).toFixed(0)}%` : null,
  );
  const evidenceLabel = $derived(
    typeof cove?.supporting_evidence === 'number' || typeof cove?.refuting_evidence === 'number'
      ? `${cove?.supporting_evidence ?? 0}✓ / ${cove?.refuting_evidence ?? 0}✗`
      : null,
  );
  // The verdict badge doubles as a disclosure toggle for the per-question CoVe
  // drilldown — independent of the contradiction toggle below. Only a toggle
  // when there are questions to reveal.
  const questions = $derived(cove?.questions ?? []);
  const canExpandCove = $derived(questions.length > 0);
  let coveExpanded = $state(false);

  const contradictionPairs = $derived(contradictions?.contradiction_pairs ?? []);
  // The larger of the two, NOT `pairs?.length ?? total`.
  //
  // `??` falls through on null/undefined only, and `[].length` is `0` — which
  // is not nullish — so the old expression made `total_contradictions`
  // unreachable for every response carrying the key with an EMPTY array. That
  // is a shape the service really returns (summary-only, or a truncated pair
  // list), and the badge then said "0 contradictions" in neutral grey about a
  // claim the topology service had just reported as disputed. A false clean
  // bill of health, in the ledger a lead adjudicates from.
  //
  // `Math.max` rather than a preference for `total`: a truncated response
  // returns fewer pairs than it counts, and a response that omits `total`
  // still has its pairs. Neither may shrink the other, and an honest empty
  // response (both zero) still reports zero — see the negative control in
  // ClaimLedgerRow.test.ts.
  const contradictionCount = $derived(
    Math.max(contradictionPairs.length, contradictions?.total_contradictions ?? 0),
  );
  // The count badge doubles as a disclosure toggle for the per-pair breakdown;
  // only expandable when we actually have pair rows to show.
  let expanded = $state(false);
  const canExpand = $derived(contradictionPairs.length > 0);
</script>

{#snippet verdictBadge(withCaret: boolean)}{verdictLabel}{#if confidencePct}
    · {confidencePct}{/if}{#if evidenceLabel}
    · {evidenceLabel}{/if}{#if withCaret}
    {coveExpanded ? '▾' : '▸'}{/if}{/snippet}

<li
  class="flex flex-col gap-1 border-t pt-1 first:border-t-0 first:pt-0 text-sm"
  data-testid="claim-ledger-row"
>
  <span class="truncate" title={claim}>{claim}</span>
  <div class="flex flex-wrap items-center gap-2 text-xs">
    {#if running}
      <span class="text-[var(--color-text-muted)]" data-testid="claim-running">verifying…</span>
    {:else if cove}
      {#if canExpandCove}
        <button
          type="button"
          class={`${verdictBadgeClass} cursor-pointer`}
          data-testid="claim-cove-verdict"
          aria-expanded={coveExpanded}
          onclick={() => (coveExpanded = !coveExpanded)}>{@render verdictBadge(true)}</button
        >
      {:else}
        <span class={verdictBadgeClass} data-testid="claim-cove-verdict"
          >{@render verdictBadge(false)}</span
        >
      {/if}
    {/if}
    {#if contradictions}
      <button
        type="button"
        class={`rounded px-1.5 py-0.5 border ${
          contradictionCount > 0
            ? 'bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'
            : 'bg-[var(--color-surface)] text-[var(--color-text-muted)]'
        } ${canExpand ? 'cursor-pointer' : 'cursor-default'}`}
        data-testid="claim-contradictions"
        aria-expanded={canExpand ? expanded : undefined}
        disabled={!canExpand}
        onclick={() => (expanded = !expanded)}
        >{contradictionCount}
        {contradictionCount === 1 ? 'contradiction' : 'contradictions'}{#if canExpand}
          {expanded ? '▾' : '▸'}{/if}</button
      >
    {/if}
    {#if error}
      <span class="text-[var(--color-danger)]" data-testid="claim-error">{error}</span>
    {/if}
  </div>
  {#if expanded && canExpand}
    <ul
      class="flex flex-col gap-0.5 pl-2 text-xs text-[var(--color-text-muted)]"
      data-testid="claim-contradiction-detail"
    >
      {#each contradictionPairs as pair, i (pair.target_id ?? i)}
        <li class="flex flex-wrap items-center gap-1">
          <span class="truncate max-w-xs" title={pair.target_label ?? pair.target_id}
            >{pair.target_label ?? pair.target_id ?? 'unknown target'}</span
          >
          <span class="text-[var(--color-text-subtle)]"
            >· {netSupportLabel(pair.net_support_score)}</span
          >
        </li>
      {/each}
    </ul>
  {/if}
  {#if coveExpanded && canExpandCove}
    <ul
      class="flex flex-col gap-1 pl-2 text-xs text-[var(--color-text-muted)]"
      data-testid="claim-cove-questions"
    >
      {#each questions as qq, i (i)}
        {@const word = coveVerdictWord(qq)}
        <li class="flex flex-col gap-0.5" data-testid={`claim-cove-question-${i}`}>
          <div class="flex flex-wrap items-center gap-1">
            <span class="truncate max-w-xs text-[var(--color-text)]" title={qq.question}
              >{qq.question}</span
            >
            <span
              class={`rounded px-1 py-0.5 ${coveChipClass(word)}`}
              data-testid={`claim-cove-question-verdict-${i}`}>{word}</span
            >
            {#if qq.source_node_ids && qq.source_node_ids.length > 0}
              <span data-testid={`claim-cove-question-evidence-${i}`}
                >{`${qq.source_node_ids.length} ${
                  qq.source_node_ids.length === 1 ? 'source' : 'sources'
                }`}</span
              >
            {/if}
          </div>
          {#if qq.answer}
            <span class="truncate max-w-xs" title={qq.answer}>{qq.answer}</span>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</li>
