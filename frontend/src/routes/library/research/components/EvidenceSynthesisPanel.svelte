<!--
  EvidenceSynthesisPanel — Stage 6's "Evidence synthesis" deliverable: the one
  thing the per-paper verification engine can't do — pool results ACROSS papers
  into a single estimate (the heart of a systematic review).

  The curated corpus gives us the paper LIST (used to pre-fill study labels), but
  not the extracted statistics — effect size / standard error / sample size live
  in each paper's methods/results, which fr does not parse. So this is the honest
  meta-analyst workflow: enter the extracted study results in a grid, then:
    1. meta-analysis (`researchApi.metaAnalysis`) → pooled effect + CI +
       heterogeneity (Q, I²) + per-study weights, drawn as a forest plot;
    2. a confidence-interval mini-tool (`researchApi.confidenceInterval`) for a
       plain list of values.

  Self-contained: the host passes only the corpus paper labels; all fetching and
  state live here so the component is unit-testable in isolation.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { AssetError } from '$lib/api/assets';
  import {
    researchApi,
    type StudyResult,
    type MetaAnalysisResponse,
    type ConfidenceIntervalResponse,
  } from '$lib/api/research';

  interface Props {
    /** Pushed-corpus paper titles — pre-fill the study rows' labels. */
    studyLabels?: string[];
  }
  const { studyLabels = [] }: Props = $props();

  function errMsg(e: unknown): string {
    if (e instanceof AssetError) return e.message;
    return e instanceof Error ? e.message : String(e);
  }
  function fmt(n: number | undefined, d = 3): string {
    return typeof n === 'number' && Number.isFinite(n) ? n.toFixed(d) : '—';
  }

  // ---- Meta-analysis: an editable grid of extracted study results ----
  interface StudyRow {
    label: string;
    effect: string;
    se: string;
    n: string;
  }
  function blankRow(label = ''): StudyRow {
    return { label, effect: '', se: '', n: '' };
  }
  // Snapshot the corpus labels once at mount (the grid is user-editable after);
  // untrack documents that this is a deliberate one-time pre-fill, not a binding.
  let rows = $state<StudyRow[]>(
    untrack(() =>
      studyLabels.length > 0
        ? studyLabels.slice(0, 12).map((l) => blankRow(l))
        : [blankRow(), blankRow()],
    ),
  );
  let method = $state<'random' | 'fixed'>('random');

  // Rows that parse to a complete, valid study (se > 0, n > 0).
  const validStudies = $derived(
    rows.reduce<StudyResult[]>((acc, r) => {
      const effect_size = Number(r.effect);
      const standard_error = Number(r.se);
      const sample_size = Number(r.n);
      const filled = r.effect.trim() && r.se.trim() && r.n.trim();
      if (
        filled &&
        Number.isFinite(effect_size) &&
        Number.isFinite(standard_error) &&
        Number.isFinite(sample_size) &&
        standard_error > 0 &&
        sample_size > 0
      ) {
        acc.push({
          effect_size,
          standard_error,
          sample_size,
          label: r.label.trim() || null,
        });
      }
      return acc;
    }, []),
  );

  let running = $state(false);
  let error = $state('');
  let result = $state<MetaAnalysisResponse | null>(null);
  // The studies that produced `result` — frozen at run time so the forest plot
  // stays aligned with `study_weights` even if the grid is edited afterwards.
  let analysed = $state<StudyResult[]>([]);

  function addRow(): void {
    rows = [...rows, blankRow()];
  }
  function removeRow(i: number): void {
    rows = rows.filter((_, idx) => idx !== i);
  }

  async function runMeta(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const studies = validStudies;
    if (studies.length < 2) {
      error =
        'Enter at least 2 complete studies (effect size, standard error > 0, sample size).';
      result = null;
      return;
    }
    running = true;
    error = '';
    result = null;
    try {
      result = await researchApi.metaAnalysis({ studies, method });
      analysed = studies;
    } catch (err) {
      error = errMsg(err);
    } finally {
      running = false;
    }
  }

  // ---- Forest-plot geometry (study CIs + pooled CI share one x-scale) ----
  interface Plotted {
    label: string;
    effect: number;
    lo: number;
    hi: number;
    weight: number | null;
  }
  const plotted = $derived.by<Plotted[]>(() => {
    if (!result) return [];
    const weights = result.study_weights ?? [];
    return analysed.map((s, i) => ({
      label: s.label || `Study ${i + 1}`,
      effect: s.effect_size,
      lo: s.effect_size - 1.96 * s.standard_error,
      hi: s.effect_size + 1.96 * s.standard_error,
      weight: typeof weights[i] === 'number' ? weights[i] : null,
    }));
  });
  const domain = $derived.by<{ min: number; max: number }>(() => {
    const xs: number[] = [0];
    for (const p of plotted) {
      xs.push(p.lo, p.hi);
    }
    if (result) {
      if (typeof result.ci_lower === 'number') xs.push(result.ci_lower);
      if (typeof result.ci_upper === 'number') xs.push(result.ci_upper);
    }
    let min = Math.min(...xs);
    let max = Math.max(...xs);
    if (!Number.isFinite(min) || !Number.isFinite(max) || min === max) {
      min -= 1;
      max += 1;
    }
    const pad = (max - min) * 0.08;
    return { min: min - pad, max: max + pad };
  });
  function pct(x: number): number {
    const { min, max } = domain;
    return ((x - min) / (max - min)) * 100;
  }
  // Marker size scales with the study's weight (visual emphasis only).
  // NB: `weight` must already be on the 0–100 percent scale (see `weightScale`),
  // so `w / 100` stays correct regardless of the upstream response scale.
  function markerPct(weight: number | null): number {
    const w = weight ?? 0;
    return Math.max(6, Math.min(16, 6 + (w / 100) * 10));
  }

  // ---- Axis furniture: null-effect reference line + scale ticks ----
  // Reuse the SAME shared x-scale as the markers (`pct` over `domain`). `domain`
  // always brackets 0 with padding, so 0 sits strictly inside [min,max]; clamp is
  // defensive only. Ticks are the domain endpoints plus the null-effect mark.
  function clampPct(x: number): number {
    return Math.max(0, Math.min(100, pct(x)));
  }
  const axisTicks = $derived.by<number[]>(() => {
    const { min, max } = domain;
    return [min, 0, max];
  });

  // ---- Scale-robust display of heterogeneity + weights ----
  // I²'s scale IS verifiable, in the emitter rather than in this repo: the
  // Scientific Processor computes `max(0.0, (q - (k-1)) / q)`
  // (knowledge/scientific_processor/src/services/stats_service.py:40) and fr's
  // backend proxies it verbatim, so it arrives as a 0–1 FRACTION and the ×100
  // below is required, not defensive. See the field's doc in
  // $lib/api/research.ts for the full citation — it used to claim 0–100, and a
  // reader who believed it would delete this function and render a severe
  // I²=0.8 as a homogeneous "0.8%".
  //
  // The >1 passthrough stays as a guard for a future upstream that switches to
  // percent, and per-study weights genuinely DO vary by upstream (raw
  // inverse-variance weights come back >1 and unnormalized), so that heuristic
  // below is doing real work.

  // I²: a finite value in [0,1] is a fraction → ×100 to a percentage; anything
  // >1 is already a percentage and passes through. NaN/undefined passes through
  // untouched so `fmt` renders the em-dash.
  function displayI2(i2: number | undefined): number | undefined {
    return Number.isFinite(i2) && (i2 as number) >= 0 && (i2 as number) <= 1
      ? (i2 as number) * 100
      : i2;
  }

  // Per-study weights: decide the scale ONCE per render over the finite weights.
  // Only treat weights as fractions (factor 100, applied to BOTH the `%` label
  // and `markerPct`) when we're confident: ≥2 studies, every finite weight ≤1,
  // and they sum to ≈1 (within 0.02). This deliberately excludes the degenerate
  // single-study case (weight=1.0 genuinely means 100%, must not become 1%).
  const weightScale = $derived.by<number>(() => {
    if (plotted.length < 2) return 1;
    const ws = plotted
      .map((p) => p.weight)
      .filter((w): w is number => typeof w === 'number' && Number.isFinite(w));
    if (ws.length < 2) return 1;
    const allLeq1 = ws.every((w) => w <= 1);
    const sum = ws.reduce((a, b) => a + b, 0);
    const sumApprox1 = Math.abs(sum - 1) <= 0.02;
    return allLeq1 && sumApprox1 ? 100 : 1;
  });
  // A study's weight rescaled to the 0–100 percent scale (or null if absent).
  function scaledWeight(weight: number | null): number | null {
    return weight === null ? null : weight * weightScale;
  }

  // ---- Confidence-interval mini-tool over a plain list of values ----
  let ciInput = $state('');
  let ciRunning = $state(false);
  let ciError = $state('');
  let ciResult = $state<ConfidenceIntervalResponse | null>(null);
  const ciValues = $derived(
    ciInput
      .split(/[\s,]+/)
      .map((t) => Number(t))
      .filter((n) => Number.isFinite(n)),
  );

  async function runCi(e?: SubmitEvent): Promise<void> {
    e?.preventDefault();
    const values = ciValues;
    if (values.length < 2) {
      ciError = 'Enter at least 2 numeric values (comma- or space-separated).';
      ciResult = null;
      return;
    }
    ciRunning = true;
    ciError = '';
    ciResult = null;
    try {
      ciResult = await researchApi.confidenceInterval({ values });
    } catch (err) {
      ciError = errMsg(err);
    } finally {
      ciRunning = false;
    }
  }
</script>

<div class="flex flex-col gap-4" data-testid="evidence-panel">
  <div class="flex flex-col gap-1">
    <h2 class="text-sm font-semibold">Evidence synthesis</h2>
    <p class="text-xs text-[var(--color-text-muted)]">
      Pool results <em>across</em> the corpus into one estimate. Enter each study's
      extracted effect size, standard error and sample size — labels are pre-filled
      from your pushed papers.
    </p>
  </div>

  <!-- Meta-analysis grid -->
  <form class="flex flex-col gap-2" onsubmit={runMeta}>
    <div class="overflow-x-auto">
      <table class="w-full text-xs">
        <thead class="text-[var(--color-text-muted)]">
          <tr class="text-left">
            <th class="py-1 pr-2 font-medium">Study</th>
            <th class="py-1 px-2 font-medium">Effect size</th>
            <th class="py-1 px-2 font-medium">Std. error</th>
            <th class="py-1 px-2 font-medium">N</th>
            <th class="py-1 pl-2"></th>
          </tr>
        </thead>
        <tbody>
          {#each rows as row, i (i)}
            <tr data-testid={`evidence-row-${i}`}>
              <td class="py-1 pr-2">
                <input
                  data-testid={`evidence-label-${i}`}
                  bind:value={row.label}
                  placeholder={`Study ${i + 1}`}
                  class="w-40 rounded border bg-[var(--color-surface)] px-2 py-1"
                />
              </td>
              <td class="py-1 px-2">
                <input
                  data-testid={`evidence-effect-${i}`}
                  bind:value={row.effect}
                  inputmode="decimal"
                  placeholder="0.0"
                  class="w-20 rounded border bg-[var(--color-surface)] px-2 py-1"
                />
              </td>
              <td class="py-1 px-2">
                <input
                  data-testid={`evidence-se-${i}`}
                  bind:value={row.se}
                  inputmode="decimal"
                  placeholder="0.0"
                  class="w-20 rounded border bg-[var(--color-surface)] px-2 py-1"
                />
              </td>
              <td class="py-1 px-2">
                <input
                  data-testid={`evidence-n-${i}`}
                  bind:value={row.n}
                  inputmode="numeric"
                  placeholder="0"
                  class="w-16 rounded border bg-[var(--color-surface)] px-2 py-1"
                />
              </td>
              <td class="py-1 pl-2">
                {#if rows.length > 1}
                  <button
                    type="button"
                    data-testid={`evidence-remove-${i}`}
                    onclick={() => removeRow(i)}
                    class="rounded px-2 py-1 text-[var(--color-text-muted)] hover:text-[var(--color-danger)]"
                    aria-label="Remove study">×</button
                  >
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
    </div>

    <div class="flex flex-wrap items-center gap-2">
      <button
        type="button"
        data-testid="evidence-add-row"
        onclick={addRow}
        class="rounded border px-2 py-1 text-xs">+ Add study</button
      >
      <label class="flex items-center gap-1 text-xs">
        <span class="text-[var(--color-text-muted)]">Model</span>
        <select
          data-testid="evidence-method"
          bind:value={method}
          class="rounded border bg-[var(--color-surface)] px-2 py-1"
        >
          <option value="random">Random effects</option>
          <option value="fixed">Fixed effect</option>
        </select>
      </label>
      <button
        type="submit"
        data-testid="evidence-run"
        disabled={running || validStudies.length < 2}
        class="rounded bg-[var(--color-accent)] px-3 py-1 text-xs text-[var(--color-on-primary)] disabled:opacity-50"
        >{running ? 'Pooling…' : 'Run meta-analysis'}</button
      >
      <span class="text-xs text-[var(--color-text-muted)]"
        >{validStudies.length} complete</span
      >
    </div>
  </form>

  {#if error}
    <p class="text-xs text-[var(--color-danger)]" data-testid="evidence-error">
      {error}
    </p>
  {/if}

  {#if result}
    <div class="flex flex-col gap-2" data-testid="evidence-result">
      <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm">
        <span data-testid="evidence-pooled">
          <span class="text-[var(--color-text-muted)]">Pooled effect</span>
          <strong>{fmt(result.pooled_effect)}</strong>
          <span class="text-[var(--color-text-muted)]"
            >[{fmt(result.ci_lower)}, {fmt(result.ci_upper)}]</span
          >
          {#if typeof result.pooled_se === 'number'}
            <span
              class="text-[var(--color-text-muted)]"
              data-testid="evidence-pooled-se">SE {fmt(result.pooled_se)}</span
            >
          {/if}
        </span>
        <span data-testid="evidence-i2" class="text-xs text-[var(--color-text-muted)]">
          I² {fmt(displayI2(result.heterogeneity_i_squared), 1)}% · Q {fmt(
            result.heterogeneity_q,
            2,
          )} · {result.method ?? method} effects
        </span>
      </div>

      <!-- Forest plot: each study's effect ± 95% CI on a shared scale -->
      <div class="flex flex-col gap-1" data-testid="evidence-forest">
        <!--
          Plot-rows wrapper: `relative` so the null-effect reference line can span
          the full height of the study + pooled rows. The overlay's horizontal
          inset (left/right) matches the fixed label + numeric columns below
          (w-40 + gap-2 on the left; w-28 + w-12 + two gap-2 on the right), so the
          overlay's coordinate space is exactly the rows' flex-1 plot area and
          `pct()` maps identically for the line, the markers and the ticks.
        -->
        <div class="relative flex flex-col gap-1">
          <div
            class="pointer-events-none absolute inset-y-0"
            style="left:10.5rem;right:11rem"
            aria-hidden="true"
          >
            <div
              data-testid="forest-zero-line"
              class="absolute inset-y-0 w-px bg-[var(--color-border)]"
              style={`left:${clampPct(0)}%`}
            ></div>
          </div>
        {#each plotted as p, i (i)}
          <div class="flex items-center gap-2 text-xs" data-testid={`evidence-study-${i}`}>
            <span class="w-40 shrink-0 truncate" title={p.label}>{p.label}</span>
            <div class="relative h-4 flex-1">
              <div
                class="absolute top-1/2 h-px -translate-y-1/2 bg-[var(--color-border)]"
                style={`left:${pct(p.lo)}%;width:${Math.max(0, pct(p.hi) - pct(p.lo))}%`}
              ></div>
              <div
                class="absolute top-1/2 -translate-x-1/2 -translate-y-1/2 bg-[var(--color-accent)]"
                style={`left:${pct(p.effect)}%;width:${markerPct(scaledWeight(p.weight))}px;height:${markerPct(scaledWeight(p.weight))}px`}
              ></div>
            </div>
            <span class="w-28 shrink-0 text-right text-[var(--color-text-muted)]">
              {fmt(p.effect, 2)} [{fmt(p.lo, 2)}, {fmt(p.hi, 2)}]
            </span>
            <span class="w-12 shrink-0 text-right text-[var(--color-text-muted)]">
              {p.weight === null ? '' : `${fmt(p.weight * weightScale, 1)}%`}
            </span>
          </div>
        {/each}
        <!-- Pooled diamond row -->
        <div class="flex items-center gap-2 text-xs" data-testid="evidence-forest-pooled">
          <span class="w-40 shrink-0 font-semibold">Pooled ({result.method ?? method})</span>
          <div class="relative h-4 flex-1">
            {#if typeof result.ci_lower === 'number' && typeof result.ci_upper === 'number'}
              <div
                class="absolute top-1/2 h-2 -translate-y-1/2 rotate-0 bg-[var(--color-accent)] opacity-80"
                style={`left:${pct(result.ci_lower)}%;width:${Math.max(2, pct(result.ci_upper) - pct(result.ci_lower))}%;clip-path:polygon(0 50%,50% 0,100% 50%,50% 100%)`}
              ></div>
            {/if}
          </div>
          <span class="w-28 shrink-0 text-right font-semibold">
            {fmt(result.pooled_effect, 2)}
          </span>
          <span class="w-12 shrink-0"></span>
        </div>
        </div>

        <!--
          X-axis: tick labels along the shared scale. Same column layout as a
          study row (w-40 spacer · flex-1 plot area · w-28 · w-12 spacers) so the
          flex-1 tick area lines up pixel-for-pixel with the rows' plot area and
          `pct()` maps identically.
        -->
        <div class="flex items-center gap-2 text-xs" data-testid="evidence-forest-axis-row">
          <span class="w-40 shrink-0"></span>
          <div class="relative h-4 flex-1" data-testid="forest-axis">
            {#each axisTicks as t, i (i)}
              <span
                class="absolute top-0 -translate-x-1/2 text-[10px] text-[var(--color-text-muted)]"
                style={`left:${clampPct(t)}%`}>{fmt(t, 2)}</span
              >
            {/each}
          </div>
          <span class="w-28 shrink-0"></span>
          <span class="w-12 shrink-0"></span>
        </div>
        <div class="flex items-center gap-2 text-[10px]">
          <span class="w-40 shrink-0"></span>
          <span class="flex-1 text-center text-[var(--color-text-muted)]">effect size</span>
          <span class="w-28 shrink-0"></span>
          <span class="w-12 shrink-0"></span>
        </div>
      </div>
    </div>
  {/if}

  <!-- Confidence-interval mini-tool -->
  <form class="flex flex-col gap-1 border-t pt-3" onsubmit={runCi}>
    <label class="text-xs font-medium" for="evidence-ci-values">
      Confidence interval over a list of values
    </label>
    <div class="flex flex-wrap items-start gap-2">
      <textarea
        id="evidence-ci-values"
        data-testid="evidence-ci-values"
        bind:value={ciInput}
        rows="2"
        placeholder="e.g. 0.42, 0.51, 0.38, 0.47"
        class="min-w-60 flex-1 rounded border bg-[var(--color-surface)] px-2 py-1 text-xs"
      ></textarea>
      <button
        type="submit"
        data-testid="evidence-ci-run"
        disabled={ciRunning || ciValues.length < 2}
        class="rounded border px-3 py-1 text-xs disabled:opacity-50"
        >{ciRunning ? 'Computing…' : 'Compute CI'}</button
      >
    </div>
    {#if ciError}
      <p class="text-xs text-[var(--color-danger)]" data-testid="evidence-ci-error">
        {ciError}
      </p>
    {/if}
    {#if ciResult}
      <p class="text-xs" data-testid="evidence-ci-result">
        <span class="text-[var(--color-text-muted)]">Mean</span>
        <strong>{fmt(ciResult.mean)}</strong>
        <span class="text-[var(--color-text-muted)]"
          >[{fmt(ciResult.ci_lower)}, {fmt(ciResult.ci_upper)}] at {fmt(
            (ciResult.confidence_level ?? 0.95) * 100,
            0,
          )}%</span
        >
      </p>
    {/if}
  </form>
</div>
