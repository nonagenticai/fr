<!--
  THE PRISMA 2020 FLOW DIAGRAM — the deliverable the ledger was always for.

  Evidence Review has derived per-stage flow since PR #63 (`flow_derivation.py`)
  and fr rendered it as two `<dl>` lists of numbers. A list of numbers is not a
  flow diagram: PRISMA's whole content is WHICH POPULATION each number counts
  and WHERE it went, and that is carried by the boxes and the arrows, not by the
  integers. A reader handed `reached 412 / settled_exclude 380` has to already
  know the standard to transcribe it, and a reader who does not know it will
  subtract across stages — which, here, is wrong (see below).

  ## Boxes and arrows, in HTML and inline SVG, by decision

  No LayerChart and no `@xyflow/svelte`. A PRISMA diagram is a fixed vertical
  spine with side branches; it has no layout to solve, no interaction, and no
  data-driven geometry. What it does have is variable-length TEXT — stage names
  and exclusion-reason codes come from a protocol vocabulary — and text in a
  fixed-viewBox SVG either overflows its box or has to be measured and wrapped
  by hand. So the boxes are HTML (they reflow, they wrap, they are selectable
  and readable by a screen reader in document order) and only the connectors are
  SVG, where being a fixed shape is the point.

  ## The three boxes that must stay EMPTY

  PRISMA 2020 has boxes this service cannot fill, and the failure mode to avoid
  is rendering them as `0`:

   1. IDENTIFICATION BY SOURCE — "records identified from databases (n), from
      registers (n)", and separately from websites, organisations, citation
      searching. The flow ledger has `identified_total` and no source
      attribution at all; `import_batches` carries a `source_kind`, but it is
      per-batch provenance, not the per-database counts PRISMA asks for.
   2. REPORTS SOUGHT FOR RETRIEVAL / REPORTS NOT RETRIEVED. This is a
      full-text-acquisition step that happens between two screening stages and
      leaves no trace in this system: nothing records that a PDF was requested,
      and nothing records that one could not be obtained. A record that was
      never retrieved and a record that was retrieved and then not yet screened
      are the same row.
   3. STUDIES vs REPORTS. PRISMA counts "studies included" and "reports of
      included studies" separately, because several reports can describe one
      study. Evidence Review counts review RECORDS. `included` is a report-ish
      count, and no grouping into studies exists anywhere in the data.

  Zero is a claim — "we looked, there were none" — and every one of these would
  be a false one. They render as an explicit unknown, which is also what a
  journal needs: the reviewer has to supply them, and cannot supply what the
  diagram never told them was missing.

  ## Why the arrows are NOT arithmetic

  `stage.reached` is "has at least one reviewer decision at this stage", not
  "was assessed for eligibility": at a two-reviewer stage, a record waiting on
  its second reviewer is already counted. And a record can settle at one stage
  as an include and simply never be worked at the next, so
  `reached − settled_exclude` need not equal the next stage's `reached`. Both
  facts are stated on the diagram rather than in a code comment, because the
  reader transcribing it into a manuscript is the person who needs them.
-->
<script lang="ts">
  import type { Flow, FlowStageCounts } from '$lib/api/reviews';

  interface Props {
    flow: Flow | null;
  }

  const { flow }: Props = $props();

  const counts = $derived(flow?.counts ?? null);

  /**
   * Stages in protocol order — `stage_order`, with `stage_key` breaking a tie
   * the schema permits.
   *
   * Sorted here and not trusted from the wire for the same reason the panel's
   * list is: the diagram is read top to bottom, and an array-order render would
   * silently draw the full-text screen above the title/abstract screen and
   * reverse the review. Nothing on screen would look wrong.
   */
  const stages = $derived<FlowStageCounts[]>(
    [...(flow?.counts_by_stage ?? [])].sort(
      (a, b) => a.stage_order - b.stage_order || a.stage_key.localeCompare(b.stage_key),
    ),
  );

  function sortReasons(reasons: Record<string, number> | undefined): Array<[string, number]> {
    return Object.entries(reasons ?? {}).sort(
      (a, b) => b[1] - a[1] || a[0].localeCompare(b[0]),
    );
  }

  /**
   * The merged histogram, used ONLY when the service serves no per-stage split.
   *
   * PRISMA reports full-text exclusions on their own, so the merge is
   * transcribable for a single-stage review and misleading for any other. The
   * degraded tier below says which it is.
   */
  const mergedReasons = $derived(sortReasons(counts?.exclusion_reasons));
</script>

{#if counts}
  <figure class="prisma" data-testid="prisma-flow" aria-label="PRISMA 2020 flow of information">
    <figcaption>
      PRISMA 2020 flow. Three boxes of the standard are marked <em>not recorded</em> — this
      system holds no data for them, and a zero there would be a false claim rather than a
      missing one. Fill them in by hand before publication.
    </figcaption>

    {#snippet arrowDown()}
      <svg class="arrow-down" viewBox="0 0 12 26" aria-hidden="true" focusable="false">
        <line x1="6" y1="0" x2="6" y2="19" />
        <polygon points="6,26 2,18 10,18" />
      </svg>
    {/snippet}

    {#snippet arrowRight()}
      <svg class="arrow-right" viewBox="0 0 34 12" aria-hidden="true" focusable="false">
        <line x1="0" y1="6" x2="27" y2="6" />
        <polygon points="34,6 26,2 26,10" />
      </svg>
    {/snippet}

    <!-- ── IDENTIFICATION ─────────────────────────────────────────────── -->
    <div class="tier">
      <div class="box" data-testid="prisma-box-identification">
        <h6>Records identified</h6>
        <p class="n" data-testid="prisma-identified">{counts.identified_total}</p>
        <p class="unknown" data-testid="prisma-unknown-sources">
          Breakdown by source (databases, registers, websites, citation searching):
          <strong>not recorded</strong> — the ledger holds only this total.
        </p>
      </div>
      {@render arrowRight()}
      <div class="box aside" data-testid="prisma-box-removed">
        <h6>Records removed before screening</h6>
        <dl class="pairs">
          <div><dt>Duplicates removed</dt><dd data-testid="prisma-removed-duplicates">{counts.duplicates_removed}</dd></div>
          <div><dt>Quarantined on import</dt><dd data-testid="prisma-removed-quarantined">{counts.quarantined}</dd></div>
          <div><dt>Rejected on import</dt><dd data-testid="prisma-removed-rejected">{counts.rejected}</dd></div>
        </dl>
      </div>
    </div>

    {@render arrowDown()}

    <div class="tier">
      <div class="box" data-testid="prisma-box-after-removal">
        <h6>Records after removals</h6>
        <p class="n" data-testid="prisma-records-total">{counts.records_total}</p>
      </div>
    </div>

    <!-- ── SCREENING, ONE TIER PER STAGE ──────────────────────────────── -->
    {#if stages.length}
      {#each stages as stage, i (stage.stage_key)}
        <!--
          The retrieval step sits BETWEEN screening and eligibility, so it is
          drawn before every stage after the first — and it is drawn empty. It
          is the one PRISMA box that is not a count this system declined to
          make, but a fact it never observed: nothing here records that a
          full text was sought, and nothing records that one could not be got.
        -->
        {#if i > 0}
          {@render arrowDown()}
          <div class="tier">
            <div class="box unknown-box" data-testid="prisma-unknown-retrieval">
              <h6>Reports sought for retrieval · Reports not retrieved</h6>
              <p class="unknown">
                <strong>Not recorded.</strong> Full-text acquisition leaves no trace in this
                review: a report nobody could obtain and a report nobody has screened yet are
                the same row. Both numbers must be supplied by hand.
              </p>
            </div>
          </div>
        {/if}

        {@render arrowDown()}
        <div class="tier" data-testid="prisma-stage-{stage.stage_key}" data-stage-order={stage.stage_order}>
          <div class="box">
            <h6>{i === 0 ? 'Records screened' : 'Reports assessed for eligibility'} — {stage.name}</h6>
            <p class="n" data-testid="prisma-stage-{stage.stage_key}-reached">{stage.reached}</p>
            <p class="caveat">
              Records with at least one reviewer decision at this stage — not every record
              assessed. One still waiting on a second reviewer is already counted.
            </p>
          </div>
          {@render arrowRight()}
          <div class="box aside">
            <h6>{i === 0 ? 'Records excluded' : 'Reports excluded, with reasons'}</h6>
            <p class="n" data-testid="prisma-stage-{stage.stage_key}-excluded">{stage.settled_exclude}</p>
            {#if sortReasons(stage.exclusion_reasons).length}
              <dl class="pairs" data-testid="prisma-stage-{stage.stage_key}-reasons">
                {#each sortReasons(stage.exclusion_reasons) as [code, n] (code)}
                  <div>
                    <dt>{code}</dt>
                    <dd data-testid="prisma-stage-{stage.stage_key}-reason-{code}">{n}</dd>
                  </div>
                {/each}
              </dl>
            {:else}
              <p class="caveat" data-testid="prisma-stage-{stage.stage_key}-no-reasons">
                No exclusions settled at this stage.
              </p>
            {/if}
          </div>
        </div>
      {/each}
    {:else}
      <!--
        NO PER-STAGE SPLIT ON THE WIRE. A deployment of Evidence Review that
        predates `counts_by_stage` answers without the key, and fr deploys
        independently of it — so this is a real state, not an error.

        Drawn as ONE merged tier, and labelled as merged. The alternative was to
        draw the standard's two screening tiers and put the same merged number
        in both, which is a diagram that is wrong in a way nothing on it admits.
      -->
      {@render arrowDown()}
      <div class="tier" data-testid="prisma-merged-tier">
        <div class="box">
          <h6>Records screened — all stages merged</h6>
          <p class="n" data-testid="prisma-records-screened">{counts.records_screened}</p>
          <p class="caveat" data-testid="prisma-no-stage-split">
            This service reported no per-stage flow, so the standard's two screening tiers
            cannot be separated. PRISMA 2020 requires full-text exclusions to be reported on
            their own; the figure below is transcribable only for a single-stage review.
          </p>
        </div>
        {@render arrowRight()}
        <div class="box aside">
          <h6>Excluded, with reasons — merged</h6>
          <p class="n" data-testid="prisma-excluded-merged">{counts.excluded}</p>
          {#if mergedReasons.length}
            <dl class="pairs" data-testid="prisma-merged-reasons">
              {#each mergedReasons as [code, n] (code)}
                <div><dt>{code}</dt><dd data-testid="prisma-merged-reason-{code}">{n}</dd></div>
              {/each}
            </dl>
          {/if}
        </div>
      </div>
    {/if}

    {@render arrowDown()}

    <!-- ── INCLUDED ───────────────────────────────────────────────────── -->
    <div class="tier">
      <div class="box included" data-testid="prisma-box-included">
        <h6>Included in the review</h6>
        <p class="n" data-testid="prisma-included">{counts.included}</p>
        <p class="unknown" data-testid="prisma-unknown-studies-vs-reports">
          Split into <em>studies included</em> and <em>reports of included studies</em>:
          <strong>not recorded</strong> — this review counts records, and nothing here groups
          several reports of one study together.
        </p>
      </div>
    </div>

    <!--
      NOT A PRISMA BOX, and on the diagram anyway.

      `not_yet_screened` and `uncertain` are records the review has not settled.
      PRISMA has nowhere to put them because a completed review has none — and
      that is exactly why they belong on screen: `not_yet_screened > 0` is what
      makes the inclusion export refuse permanently (`flow.py:736`), and a
      reader looking at a diagram whose boxes all rendered has no other way to
      learn the review is not finished.
    -->
    {#if counts.not_yet_screened > 0 || counts.uncertain > 0}
      <p class="outstanding" data-testid="prisma-outstanding">
        Not settled, and outside the diagram:
        <strong data-testid="prisma-not-yet-screened">{counts.not_yet_screened}</strong> not yet
        screened, <strong data-testid="prisma-uncertain">{counts.uncertain}</strong> uncertain.
        PRISMA has no box for these because a finished review has none — while
        <em>not yet screened</em> is above zero the inclusion export is refused.
      </p>
    {/if}

    <p class="caveat spine" data-testid="prisma-no-subtraction">
      Do not subtract across tiers. A stage's reached minus its exclusions need not equal the
      next stage's reached: a record can settle at one stage and never be worked at the next.
    </p>
  </figure>
{/if}

<style>
  .prisma {
    margin: 0.75rem 0 0;
    padding: 0.75rem;
    border: 1px solid var(--color-border);
    border-radius: 8px;
    background: var(--color-surface-muted);
    display: flex;
    flex-direction: column;
    align-items: center;
  }
  figcaption {
    margin: 0 0 0.6rem;
    font-size: 0.78rem;
    line-height: 1.45;
    color: var(--color-text-muted);
    align-self: stretch;
  }
  /* One row of the spine: the main box, its connector, and the side box that
     the connector points at. Wraps rather than squeezing on a narrow viewport —
     the reading order (main, then what left the flow here) survives the wrap. */
  .tier {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.35rem;
    flex-wrap: wrap;
    width: 100%;
  }
  .box {
    border: 1px solid var(--color-border-strong);
    border-radius: 6px;
    background: var(--color-bg);
    padding: 0.5rem 0.7rem;
    min-width: 0;
    flex: 1 1 16rem;
    max-width: 26rem;
  }
  .box.aside {
    background: var(--color-surface);
  }
  .box.included {
    border-color: var(--color-accent-border);
    background: var(--color-accent-bg);
  }
  .box.unknown-box {
    border-style: dashed;
    background: var(--color-surface);
  }
  h6 {
    margin: 0;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.03em;
    color: var(--color-text-muted);
  }
  .n {
    margin: 0.15rem 0 0;
    font-size: 1.35rem;
    font-weight: 600;
    line-height: 1.1;
  }
  .caveat,
  .unknown {
    margin: 0.3rem 0 0;
    font-size: 0.72rem;
    line-height: 1.4;
    color: var(--color-text-muted);
  }
  /* An unknown has to be visually distinguishable from a caveat at a glance —
     it is the difference between "read this number carefully" and "there is no
     number here and you must supply one". */
  .unknown {
    border-left: 2px dashed var(--color-border-strong);
    padding-left: 0.4rem;
  }
  .caveat.spine {
    align-self: stretch;
    margin-top: 0.6rem;
  }
  .outstanding {
    align-self: stretch;
    margin: 0.6rem 0 0;
    padding: 0.4rem 0.6rem;
    border: 1px solid var(--color-warning-border);
    background: var(--color-warning-bg);
    color: var(--color-warning-text);
    border-radius: 6px;
    font-size: 0.76rem;
    line-height: 1.45;
  }
  .pairs {
    margin: 0.25rem 0 0;
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 0.1rem 0.6rem;
  }
  .pairs div {
    display: contents;
  }
  .pairs dt {
    font-size: 0.72rem;
    color: var(--color-text-muted);
    overflow-wrap: anywhere;
  }
  .pairs dd {
    margin: 0;
    font-size: 0.78rem;
    font-weight: 600;
    text-align: right;
  }
  /* Connectors. Decorative — every number they join is text in a box, in
     reading order, so a screen reader loses nothing by skipping them. */
  .arrow-down {
    width: 12px;
    height: 26px;
    flex: 0 0 auto;
  }
  .arrow-right {
    width: 34px;
    height: 12px;
    flex: 0 0 auto;
  }
  .arrow-down line,
  .arrow-right line {
    stroke: var(--color-border-strong);
    stroke-width: 1.5;
  }
  .arrow-down polygon,
  .arrow-right polygon {
    fill: var(--color-border-strong);
  }
  /* Stacked, the horizontal connector points at nothing. */
  @media (max-width: 40rem) {
    .arrow-right {
      display: none;
    }
  }
</style>
