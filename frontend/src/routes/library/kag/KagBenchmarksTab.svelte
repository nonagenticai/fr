<!--
  KAG "Retrieval quality" tab — a customer-facing view of the independent
  retrieval-quality benchmark (HotpotQA, judged). Renders the ablation ladder,
  the H1 result, and the honest paired graph-bridge Δ + 95% CI from the
  harness-generated contract served at /api/assets/kag/benchmarks. `n` comes
  from the contract, never from this comment.

  Self-contained: all fetching lives here so the tab composes onto AssetTabs.
  Numbers are NOT hardcoded — the component renders whatever the endpoint
  returns (regenerate the eval → redeploy → this updates). Internal detail
  (root-cause PRs, roadmap) is intentionally omitted; this is the quality story.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import {
    fetchKagBenchmarks,
    type BenchmarkResult,
    type BenchmarkSummary,
    type LadderRow,
    type BridgeAttribution,
  } from '$lib/api/kag-benchmarks';


  // ⚠️ CORRECTED — this paragraph used to open "The heading claims 'Measured
  // retrieval quality' in the PRESENT TENSE", describing a defect it then
  // declined to fix ("an affordance, not a fix"). The heading no longer does:
  // it reads "Retrieval quality measured on N multi-hop questions — snapshot of
  // <generated_at>", so the sentence carries its own date UNCONDITIONALLY,
  // including inside the 30-day window where the badge below stays silent. The
  // badge still escalates once the snapshot is stale; it is not the disclosure.
  //
  // The rest of this note is unchanged and still true: the numbers come from a
  // COMMITTED FIXTURE (`backend/src/data/kag-benchmarks/hotpotqa-n50.json`).
  // Its predecessor (`hotpotqa-n150.json`, `generated_at` 2026-07-09) had
  // exactly ONE commit in its entire history and was 57 days stale when it was
  // replaced. Nothing in this repo regenerates it: grepping .github/**,
  // scripts/**, Makefile and package.json for the fixture or the harness
  // returns zero hits.
  //
  // The date WAS disclosed — in an 11px mono footer, below the fold of the claim.
  // A reader who does not scroll to it sees a live quality assertion. This badge
  // puts the staleness where the claim is. It does not replace the footer; it
  // makes the disclosure survive not reading the footer.
  //
  // ⛔ This is an affordance, not a fix — it makes the staleness visible, it does
  // not refresh anything. To refresh: regenerate in kag (`make bench-baseline`,
  // eval/report.py --emit-json), copy the summary over
  // backend/src/data/kag-benchmarks/hotpotqa-n50.json, commit + deploy — the tab
  // reads the committed fixture per-deploy. ⚠️ The kag run ingests into the live
  // fr-test tenant and is judged by a real LLM: an operator decision with a
  // corpus cost, not a button.
  const STALE_AFTER_DAYS = 30;
  const snapshotAgeDays = $derived.by<number | null>(() => {
    const raw = summary?.generated_at;
    if (typeof raw !== 'string' || !raw) return null;
    const t = Date.parse(raw);
    if (Number.isNaN(t)) return null;
    return Math.floor((Date.now() - t) / 86_400_000);
  });

  let summary = $state<BenchmarkSummary | null>(null);
  let loading = $state(false);
  let error = $state('');

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }
  const f3 = (v: number | null | undefined): string =>
    typeof v === 'number' && Number.isFinite(v) ? v.toFixed(3) : '—';
  const signed = (v: number | null | undefined): string =>
    typeof v === 'number' && Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${v.toFixed(3)}` : '—';

  // Human labels for the ablation rungs.
  const MODE_LABEL: Record<string, string> = {
    dense: 'Dense (naive RAG)',
    hybrid: 'Hybrid (+ lexical)',
    hybrid_rerank: 'Hybrid + rerank',
    full_nobridge: 'Full − graph bridge',
    full: 'Full (+ graph bridge)',
  };

  const result = $derived<BenchmarkResult | null>(
    summary?.benchmarks?.find((b) => b.benchmark === 'hotpotqa') ??
      summary?.benchmarks?.[0] ??
      null,
  );
  const ladder = $derived<LadderRow[]>(result?.ladder ?? []);

  // ⛔ MODES THAT WERE DELIBERATELY NOT PUBLISHED. Rendered as rungs with no
  // numbers, never as an absence.
  //
  // The shipped case: `hybrid_rerank` is kag's server default AND this UI's
  // default, and until 2026-09-04 the tab showed FOUR modes, none of them the
  // one a customer's queries actually run — while `MODE_LABEL` carried a
  // `Hybrid + rerank` label with no data behind it. The fix is not to publish
  // the row we have: the n50-20260902 run measured that mode at 2026-09-02
  // 20:43Z and kag #168 merged 73 minutes later, changing that exact mode's
  // near-dup collapse (live as `KAG_NEAR_DUP_COLLAPSE_RERANK=1`). The number
  // describes code that no longer runs.
  //
  // ⛔ There is NO interpolation, no "approximately", no nearest-rung stand-in.
  // The repo's rule for a value it does not have is a bare `unavailable`, and a
  // guessed benchmark figure on a customer-facing quality claim is the worst
  // possible place to break it. Defensively filtered against `ladder` so a
  // contract that both measures and declares a mode never double-renders it.
  const unmeasuredModes = $derived<string[]>(
    (summary?.unmeasured_modes ?? []).filter((m) => !ladder.some((r) => r.mode === m)),
  );
  const unmeasuredReason = $derived<string>(summary?.unmeasured_reason?.trim() ?? '');
  const unmeasuredLabels = $derived<string>(
    unmeasuredModes.map((m) => MODE_LABEL[m] ?? m).join(', '),
  );
  const attribution = $derived<BridgeAttribution[]>(result?.bridge_attribution ?? []);
  const judgeAttr = $derived<BridgeAttribution | undefined>(
    attribution.find((a) => a.metric === 'judge_correct'),
  );
  const fullRow = $derived<LadderRow | undefined>(ladder.find((r) => r.mode === 'full'));

  // ⛔ THE BRIDGE VERDICT IS DERIVED, NEVER WRITTEN DOWN. It used to be the literal
  //    string `non-harmful` in `--color-success`, beside a header promising "Numbers
  //    are NOT hardcoded". Regenerating the eval with a SIGNIFICANT negative Δ left the
  //    tile reading green `non-harmful` — a verdict that cannot go red is not a verdict.
  //
  //    "no significant effect" is also the honest wording where "non-harmful" was not:
  //    on the n50-20260902 contract every metric has `significant: false`, and the
  //    cover-EM point estimate is NEGATIVE (Δ −0.02, CI [−0.1084, 0.0684]) — it was
  //    recall@5 (Δ −0.0135) on the 2026-07-09 run, which is exactly why the metric is
  //    named from the data and never written down here. "Never degrades" claimed
  //    something the data does not show; failing to detect a difference is not proof of
  //    no difference, and it is certainly not a green tick.
  const bridgeVerdict = $derived.by(() => {
    if (attribution.length === 0) return { label: 'not measured', tone: 'muted' as const };
    const sig = attribution.filter((a) => a.significant === true);
    const harmful = sig.filter((a) => typeof a.delta === 'number' && a.delta < 0);
    if (harmful.length > 0) {
      return {
        label: 'degrades quality',
        tone: 'bad' as const,
        detail: `significant negative Δ on ${harmful.map((a) => a.metric).join(', ')}`,
      };
    }
    if (sig.length > 0) {
      return {
        label: 'improves quality',
        tone: 'good' as const,
        detail: `significant positive Δ on ${sig.map((a) => a.metric).join(', ')}`,
      };
    }
    const negatives = attribution.filter((a) => typeof a.delta === 'number' && a.delta < 0);
    return {
      label: 'no significant effect',
      tone: 'muted' as const,
      detail: negatives.length
        ? `every 95% CI straddles zero; the point estimate is negative on ${negatives
            .map((a) => a.metric)
            .join(', ')}`
        : 'every 95% CI straddles zero',
    };
  });
  const verdictColour = $derived(
    bridgeVerdict.tone === 'bad'
      ? 'var(--color-danger)'
      : bridgeVerdict.tone === 'good'
        ? 'var(--color-success)'
        : 'var(--color-text)',
  );

  // The ladder is NOT guaranteed monotonic and the copy must not claim it is: on the
  // shipped n50-20260902 contract `hybrid` scores BELOW `dense` on both judge_correct
  // (0.40 vs 0.56) and recall@5 (0.61 vs 0.77). Derive the shape instead of asserting it.
  //
  // `>` and not `>=`, so a TIE keeps the FIRST maximum — the simpler rung. On this
  // contract `full_nobridge` and `full` tie at 0.78 and the label therefore reads
  // "Full − graph bridge". That direction is deliberate: on equal evidence the copy must
  // not credit the more elaborate configuration. The tie is adjudicated by the paired Δ
  // and its CI in the rows below the table, not by this label.
  const bestRow = $derived<LadderRow | undefined>(
    ladder.filter((r) => typeof r.judge_correct === 'number').length
      ? ladder
          .filter((r) => typeof r.judge_correct === 'number')
          .reduce((a, b) => ((b.judge_correct as number) > (a.judge_correct as number) ? b : a))
      : undefined,
  );
  // Monotonic over the rungs we ACTUALLY MEASURED. Says nothing about a rung
  // that has no number.
  const measuredIsMonotonic = $derived.by(() => {
    const v = ladder.map((r) => r.judge_correct).filter((x): x is number => typeof x === 'number');
    return v.length > 1 && v.every((x, i) => i === 0 || x >= v[i - 1]);
  });
  // ⛔ A GAP IS NOT A CLIMB. An unmeasured mode is absent from the comparison,
  // not a value in it — so with one withheld the ladder cannot be asserted to
  // climb "from naive dense retrieval to the full pipeline", because the rung
  // the customer's own queries run was never in the sequence. Closing over the
  // gap and calling the remainder monotonic is exactly the interpolation this
  // change exists to refuse.
  const ladderIsMonotonic = $derived(measuredIsMonotonic && unmeasuredModes.length === 0);
  const nobridgeRow = $derived<LadderRow | undefined>(
    ladder.find((r) => r.mode === 'full_nobridge'),
  );
  const attrBy = $derived<Record<string, BridgeAttribution>>(
    Object.fromEntries(attribution.map((a) => [a.metric, a])),
  );

  async function load(): Promise<void> {
    loading = true;
    error = '';
    try {
      summary = await fetchKagBenchmarks();
    } catch (e) {
      error = errMsg(e);
    } finally {
      loading = false;
    }
  }

  onMount(() => {
    void load();
  });
</script>

<div class="flex flex-col gap-6" data-testid="kag-benchmarks">
  {#if loading && !summary}
    <p class="text-sm text-[var(--color-text-muted)]">Loading benchmark…</p>
  {:else if error}
    <div class="flex items-center gap-3">
      <p class="text-sm text-[var(--color-danger)]" data-testid="kag-benchmarks-error">{error}</p>
      <button
        type="button"
        onclick={() => void load()}
        class="rounded border px-2 py-1 text-xs disabled:opacity-50"
        disabled={loading}>Retry</button
      >
    </div>
  {:else if result}
    <!-- Header -->
    <header class="flex flex-col gap-3">
      <p
        class="font-mono text-xs uppercase tracking-[0.18em] text-[var(--color-accent)]"
      >
        Retrieval quality · independent benchmark
      </p>
      <!--
        ⚠️ The tense is the claim. "Measured retrieval quality on N questions"
        is present-tense and reads as a live property of the deployed stack;
        the numbers below it come from a COMMITTED FIXTURE that nothing in this
        repo regenerates. The staleness badge only appeared past
        STALE_AFTER_DAYS, so for the first 30 days the heading asserted a live
        measurement with no qualifier at all — exactly the window in which a
        reader is most likely to quote it.

        The date is now IN the sentence, unconditionally, so the claim carries
        its own provenance whether or not it is old enough to warn about. The
        badge stays: it escalates, it does not disclose.
      -->
      <h2 class="text-xl font-semibold leading-snug">
        Retrieval quality measured on {result.n} multi-hop questions —
        <span data-testid="kag-benchmarks-snapshot-label" class="font-normal">
          {#if summary?.generated_at}
            snapshot of {summary.generated_at}
          {:else}
            snapshot, date not recorded
          {/if}
        </span>{#if snapshotAgeDays !== null && snapshotAgeDays >= STALE_AFTER_DAYS}<span
            class="ml-2 rounded bg-[var(--color-warning-bg,#4a3a00)] px-1.5 py-0.5 align-middle text-[11px] font-normal text-[var(--color-warning,#e8b923)]"
            data-testid="kag-benchmarks-stale"
            title="This snapshot is a committed fixture; nothing in this repo regenerates it."
            >snapshot is {snapshotAgeDays} days old</span
          >{/if}
      </h2>
      <p class="max-w-[68ch] text-sm text-[var(--color-text-muted)]">
        We benchmark the full KAG pipeline (HyDE query expansion, lexical + vector fusion,
        cross-encoder rerank, HiRAG near-duplicate collapse, and a KARMA knowledge-graph
        bridge) against naive vector search on HotpotQA, scored by an LLM judge. The full
        stack answers correctly on <strong class="text-[var(--color-text)]"
          >{f3(result.h1?.full)}</strong
        >
        of questions versus <strong class="text-[var(--color-text)]">{f3(result.h1?.dense)}</strong>
        for naive dense retrieval. We also isolate the graph bridge's own contribution with a
        paired ablation — and report it honestly, confidence interval and all.{#if unmeasuredModes.length > 0}
          One rung is missing from this run and we say so rather than filling it in:
          <strong class="text-[var(--color-text)]">{unmeasuredLabels}</strong>, the mode this
          product serves by default, is not measured here — see the ladder below.
        {/if}
      </p>
    </header>

    <!-- Headline stats -->
    <div class="grid gap-3 sm:grid-cols-3" data-testid="kag-benchmarks-stats">
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div class="font-mono text-2xl font-bold text-[var(--color-success)]">
          {f3(result.h1?.full)}
        </div>
        <div class="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
          vs dense {f3(result.h1?.dense)} · Δ {signed(result.h1?.delta)} · H1 {result.h1?.verdict ??
            '—'}
        </div>
        <div class="mt-1 text-xs text-[var(--color-text-muted)]">
          Judge-correct rate, full pipeline vs naive vector RAG.
        </div>
      </div>
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div class="font-mono text-2xl font-bold text-[var(--color-text)]">
          {signed(judgeAttr?.delta)}
        </div>
        <div class="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
          95% CI [{signed(judgeAttr?.ci_low)}, {signed(judgeAttr?.ci_high)}] ·
          {judgeAttr?.significant ? 'significant' : 'n.s.'} · paired n={judgeAttr?.paired_n ?? '—'}
        </div>
        <div class="mt-1 text-xs text-[var(--color-text-muted)]">
          Graph bridge's own judge Δ — measured, with its confidence interval.
        </div>
      </div>
      <div class="rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)] p-4">
        <div class="font-mono text-2xl font-bold" style={`color:${verdictColour}`}>
          {bridgeVerdict.label}
        </div>
        <div class="mt-1 font-mono text-xs text-[var(--color-text-muted)]">
          bridge fires {fullRow?.bridge_fires ?? '—'}/{result.n} · ≤{fullRow?.chunks_per_q ?? '—'} chunks/q
        </div>
        <div class="mt-1 text-xs text-[var(--color-text-muted)]">
          Graph-bridge effect, derived from the paired Δ and its 95% CI — {bridgeVerdict.detail}.
        </div>
      </div>
    </div>

    <!-- Ablation ladder -->
    <section class="flex flex-col gap-2">
      <h3 class="text-sm font-semibold">Ablation ladder</h3>
      <div
        class="overflow-x-auto rounded-xl border border-[var(--color-border)] bg-[var(--color-surface)]"
      >
        <table class="w-full min-w-[560px] font-mono text-xs">
          <thead>
            <tr class="text-[var(--color-text-muted)]">
              <th class="px-3 py-2 text-left font-semibold">mode</th>
              <th class="px-3 py-2 text-right font-semibold">recall@5</th>
              <th class="px-3 py-2 text-right font-semibold">cover-EM</th>
              <th class="px-3 py-2 text-right font-semibold">judge✓</th>
              <th class="px-3 py-2 text-right font-semibold">abstain</th>
              <th class="px-3 py-2 text-right font-semibold">bridge fires</th>
            </tr>
          </thead>
          <tbody>
            {#each ladder as row (row.mode)}
              <tr class="border-t border-[var(--color-border)]">
                <td class="px-3 py-2 text-left font-sans">{MODE_LABEL[row.mode] ?? row.mode}</td>
                <td class="px-3 py-2 text-right">{f3(row.recall_at_5)}</td>
                <td class="px-3 py-2 text-right">{f3(row.cover_em)}</td>
                <td class="px-3 py-2 text-right">{f3(row.judge_correct)}</td>
                <td class="px-3 py-2 text-right">{f3(row.abstain_rate)}</td>
                <td
                  class="px-3 py-2 text-right {row.bridge_fires > 0
                    ? 'text-[var(--color-accent)]'
                    : 'text-[var(--color-text-muted)]'}">{row.bridge_fires}</td
                >
              </tr>
            {/each}
            <!--
              Withheld rungs, AFTER the measured ones. Every metric cell is a
              bare em dash and the last cell says "not measured" in words: no
              number is invented, interpolated, or borrowed from a neighbouring
              rung. The row exists so the mode is visibly ON the ladder and
              visibly unquantified, rather than silently missing from it — the
              state this tab shipped in until 2026-09-04.
            -->
            {#each unmeasuredModes as mode (mode)}
              <tr
                class="border-t border-[var(--color-border)] text-[var(--color-text-muted)]"
                data-testid="kag-benchmarks-mode-unmeasured"
              >
                <td class="px-3 py-2 text-left font-sans">{MODE_LABEL[mode] ?? mode}</td>
                <td class="px-3 py-2 text-right">—</td>
                <td class="px-3 py-2 text-right">—</td>
                <td class="px-3 py-2 text-right">—</td>
                <td class="px-3 py-2 text-right">—</td>
                <td class="px-3 py-2 text-right font-sans italic">not measured</td>
              </tr>
            {/each}
            {#if fullRow && nobridgeRow}
              <tr class="border-t border-[var(--color-accent-border)] text-[var(--color-text)]">
                <td class="px-3 py-2 text-left font-sans font-semibold"
                  >Δ graph bridge (full − ablation)</td
                >
                <td class="px-3 py-2 text-right">{signed(attrBy['recall_at_5']?.delta)}</td>
                <td class="px-3 py-2 text-right">{signed(attrBy['cover_em']?.delta)}</td>
                <td class="px-3 py-2 text-right">{signed(attrBy['judge_correct']?.delta)}</td>
                <td class="px-3 py-2 text-right text-[var(--color-text-muted)]">—</td>
                <td class="px-3 py-2 text-right">+{fullRow.bridge_fires}</td>
              </tr>
              <tr class="text-[var(--color-text-muted)]">
                <td class="px-3 py-2 text-left font-sans">95% CI on Δ</td>
                <td class="px-3 py-2 text-right"
                  >[{signed(attrBy['recall_at_5']?.ci_low)}, {signed(
                    attrBy['recall_at_5']?.ci_high,
                  )}]</td
                >
                <td class="px-3 py-2 text-right"
                  >[{signed(attrBy['cover_em']?.ci_low)}, {signed(attrBy['cover_em']?.ci_high)}]</td
                >
                <td class="px-3 py-2 text-right"
                  >[{signed(attrBy['judge_correct']?.ci_low)}, {signed(
                    attrBy['judge_correct']?.ci_high,
                  )}]</td
                >
                <td class="px-3 py-2 text-right">—</td>
                <td class="px-3 py-2 text-right">—</td>
              </tr>
            {/if}
          </tbody>
        </table>
      </div>
      {#if unmeasuredModes.length > 0}
        <p
          class="max-w-[72ch] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs text-[var(--color-text-muted)]"
          data-testid="kag-benchmarks-unmeasured-note"
        >
          <strong class="text-[var(--color-text)]"
            >{unmeasuredLabels}
            {unmeasuredModes.length === 1 ? 'is the mode' : 'are modes'} this product runs by default,
            and this snapshot does not measure {unmeasuredModes.length === 1 ? 'it' : 'them'}.</strong
          >
          {unmeasuredReason} We would rather show you a row with no numbers in it than a number we
          know is out of date.
        </p>
      {/if}
      <p class="max-w-[72ch] text-xs text-[var(--color-text-muted)]">
        {#if ladderIsMonotonic}
          Quality climbs monotonically from naive dense retrieval to the full pipeline.
        {:else}
          {#if unmeasuredModes.length > 0}
            We make <strong class="text-[var(--color-text)]">no</strong> monotonic claim across this
            ladder: {unmeasuredLabels} has no measurement on this run, and a gap is not a rung. The
            best-scoring rung <em>among those measured</em> is
            <strong class="text-[var(--color-text)]"
              >{MODE_LABEL[bestRow?.mode ?? ''] ?? bestRow?.mode ?? '—'}</strong
            >.
          {:else}
            Quality does <strong class="text-[var(--color-text)]">not</strong> climb monotonically
            across the ladder — the best-scoring rung on this run is
            <strong class="text-[var(--color-text)]"
              >{MODE_LABEL[bestRow?.mode ?? ''] ?? bestRow?.mode ?? '—'}</strong
            >, and at least one intermediate rung scores below the one before it.
          {/if}
          {#if !measuredIsMonotonic && unmeasuredModes.length > 0}
            Among the measured rungs it does not climb monotonically either — at least one scores
            below the one before it.
          {/if}
          Read the table, not a slogan.
        {/if}
        The graph bridge's own contribution (bottom rows) is isolated by re-running the identical
        pipeline with only the bridge removed. On this run we report it as
        <strong class="text-[var(--color-text)]">{bridgeVerdict.label}</strong> —
        {bridgeVerdict.detail}. Failing to detect a difference is not the same as showing there is
        none. That transparency is the point.
      </p>
    </section>

    <!-- How we measure -->
    <section class="flex flex-col gap-1">
      <h3 class="text-sm font-semibold">How we measure</h3>
      <p class="max-w-[72ch] text-xs text-[var(--color-text-muted)]">
        {result.n} HotpotQA multi-hop questions, {result.scored} scored answers across the ablation
        ladder. Each answer is graded by an LLM judge for correctness against gold answers;
        <em>recall@5</em> and <em>cover-EM</em> measure retrieval and answer coverage. The graph-bridge
        Δ is a per-question paired difference with a normal-approximation 95% confidence interval.
      </p>
      {#if unmeasuredModes.length > 0}
        <!--
          The disclosure is repeated here on purpose. The reason string is the
          only place the withholding is explained, and a reader who lands on
          "How we measure" without having read the ladder note would otherwise
          take the four published rungs for the whole ladder.
        -->
        <p class="max-w-[72ch] text-xs text-[var(--color-text-muted)]">
          <strong class="text-[var(--color-text)]">Not measured on this run:</strong>
          {unmeasuredLabels}. {unmeasuredReason} It will reappear on the ladder the next time the
          eval is run against the code that is actually deployed; we publish no placeholder for it
          in the meantime.
        </p>
      {/if}
    </section>

    <footer
      class="flex flex-wrap gap-x-5 gap-y-1 border-t border-[var(--color-border)] pt-3 font-mono text-[11px] text-[var(--color-text-muted)]"
    >
      <span>benchmark: HotpotQA · judged · n={result.n}</span>
      {#if summary?.generated_at}<span>as of {summary.generated_at}</span>{/if}
      {#if summary?.gate}<span>gate: {summary.gate}</span>{/if}
      <!--
        The withheld mode belongs in the provenance line too, not only in the
        prose above it: this footer is what a reader screenshots or quotes.
      -->
      {#if unmeasuredModes.length > 0}<span data-testid="kag-benchmarks-unmeasured-footer"
          >not measured: {unmeasuredModes.join(', ')} (shipped default; superseded by kag #168)</span
        >{/if}
    </footer>
  {:else}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="kag-benchmarks-empty">
      No benchmark data available.
    </p>
  {/if}
</div>
