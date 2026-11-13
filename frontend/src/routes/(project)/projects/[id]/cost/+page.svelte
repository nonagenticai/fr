<!--
  /projects/[id]/cost — the project's Cost page (R6, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3/§5;
  cockpit C7). Spend against budget, settled vs today, by phase / capability / card.

  ONE read: GET /api/projects/:id/cockpit carries `project_costs` (billing's A1 answer, priced
  through the caller's lens) with every by-card row annotated by the card's OWN phase and the RM
  capability of its card type (R-CK6 — derived on the server, never guessed here), plus the spine
  (the phase switcher) and the board (card names).

  ⛔ HONESTY RULES, all visible in the states below:
    - A budget line is drawn ONLY when RM holds a budget (R-CK3). No budget is "[budget not set]",
      never "$0". RM that could not be read is "[budget unavailable]": UNKNOWN is not "none".
    - The board's state is named as the CAUSE of un-attributed rows, in all three states: a board
      that could not be read (`board_state: 'unavailable'`, or an older `board_available: false`) is
      a read failure, 'no_board' is a fact about the project (not a failure), and only a readable
      board lets a missing card read as "no longer on the board". An answer carrying NEITHER field
      (pre-R6) says the annotation was not recorded — never "not recorded" as if the cards said so.
    - An amount billing could not price is "unavailable", never $0.00.
    - A project whose spend was never attributed to this workspace (billing cannot name it) says so;
      that is a gap, not a zero.
    - Day totals cannot be split by phase (billing records no per-phase day series), so the two
      day charts are labelled "whole project" and only the by-card stacks follow the phase filter.
-->
<script lang="ts">
  import { page } from '$app/stores';
  import { fetchProjectCockpit, CockpitNotFoundError } from '$lib/api/cockpit';
  import { hasData, type Panel } from '$lib/types/panel';
  import type { CockpitProjectCosts, CostBoardState, ProjectCockpit } from '$lib/types/cockpit';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import PhaseSpine from '$lib/components/cockpit/PhaseSpine.svelte';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import SettledProvisionalChart from '$lib/components/cost/SettledProvisionalChart.svelte';
  import BurnBudgetChart from '$lib/components/cost/BurnBudgetChart.svelte';
  import CostStackedBar from '$lib/components/cost/CostStackedBar.svelte';
  import {
    ALL_PHASES,
    asOfWords,
    basisWords,
    cardLines,
    costPhaseShown,
    groupByCapability,
    groupByPhase,
    phaseSummary,
    rowsInPhase,
    spendSummary,
    unannotatedWords,
    type CostPhase,
  } from '$lib/components/cost/cost';
  import { moneyWords } from '$lib/projects/cockpit-status';

  const projectId = $derived($page.params.id ?? '');

  let cockpit = $state<ProjectCockpit | null>(null);
  let loaded = $state(false);
  let notFound = $state(false);
  /** The cockpit read failed: nothing on this page is known. */
  let unreadable = $state(false);
  /** null = follow the current phase. */
  let chosen = $state<string | null>(null);

  async function load(id: string): Promise<void> {
    try {
      // PROJECT-READ-WAIVER: primary-load — the cost page is the cockpit read model's
      // `project_costs` + `spine` + `board` panels; loadProject does not carry them. A failed read
      // renders data-testid="project-unreadable" below, never an empty or $0 cost page.
      const c = await fetchProjectCockpit(id);
      if (id !== projectId) return;
      cockpit = c;
      notFound = false;
      unreadable = false;
    } catch (e) {
      if (id !== projectId) return;
      if (e instanceof CockpitNotFoundError) notFound = true;
      else {
        console.error('[projects/cost] cockpit read failed', e);
        unreadable = true;
      }
    } finally {
      if (id === projectId) loaded = true;
    }
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    cockpit = null;
    loaded = false;
    chosen = null;
    void load(id);
  });

  const spinePanel = $derived(cockpit?.spine ?? null);
  const spine = $derived(spinePanel && hasData(spinePanel) ? spinePanel.data : null);
  const phases = $derived<CostPhase[]>(
    spine ? spine.phases.map((p) => ({ name: p.name, label: p.label })) : [],
  );
  const currentPhase = $derived(
    cockpit?.overview && hasData(cockpit.overview)
      ? cockpit.overview.data.current_phase
      : (cockpit?.status.data?.current_phase ?? null),
  );
  const costsPanel = $derived<Panel<CockpitProjectCosts> | null>(cockpit?.project_costs ?? null);
  const costs = $derived(costsPanel && hasData(costsPanel) ? costsPanel.data : null);
  /** The project cannot be named on a billing event, so billing holds no figure — a gap, not $0. */
  const notAttributable = $derived(costsPanel?.detail_code === 'billing_project_not_attributable');
  const costsFailed = $derived(!!costsPanel && costsPanel.health !== 'ok' && !costs && !notAttributable);
  /**
   * The board's state behind the rows (R6 tri-state). `board_state` is the truth; an older backend
   * only carries `board_available`, whose `false` means "could not be read" (⇒ 'unavailable').
   * 'no_board' is a FACT about the project — the project has no board — and is worded as such,
   * never as a read failure.
   */
  const boardState = $derived<CostBoardState>(
    costs?.board_state ?? (costs?.board_available === false ? 'unavailable' : 'ok'),
  );
  /** The board is not usable, so no cost row can be tied to a card/phase/capability. */
  const boardUnavailable = $derived(boardState !== 'ok');
  /**
   * Whether the rows carry the `phase` FIELD at all (R6). Only an R6 backend annotates rows with
   * it; a pre-R6 answer has no key, so an absent phase there says nothing about what the board
   * records — it must not be worded as "the card records no phase" or "no longer on the board"
   * (the same guard the Plan page uses).
   */
  const phaseFieldRecorded = $derived(costs ? costs.by_card.every((r) => 'phase' in r) : false);
  /**
   * No row carries a usable annotation: the board is not usable, or the answer (when it serves
   * rows at all) predates the annotation. Either way a null phase/capability is NOT the card's own
   * record.
   */
  const unannotated = $derived(boardUnavailable || (costs !== null && !phaseFieldRecorded));
  /** What an unannotated row/bucket says then — the CAUSE, never "not recorded" as a card property. */
  const UNANNOTATED_LABEL = $derived(unannotatedWords(boardState, phaseFieldRecorded) ?? 'Unknown');

  /**
   * With no usable annotation, NO row records a phase: a phase filter could only hide spend behind
   * a phase the page cannot verify, so every row is shown instead (and the filter is not rendered).
   */
  const shown = $derived(unannotated ? ALL_PHASES : costPhaseShown(phases, currentPhase, chosen));
  const shownPhase = $derived(phases.find((p) => p.name === shown) ?? null);

  const currency = $derived(costs?.currency || cockpit?.project.data?.currency || 'USD');
  const budget = $derived.by(() => {
    const b = cockpit?.project.data?.budget;
    return typeof b === 'number' && Number.isFinite(b) ? b : null;
  });
  const budgetCurrency = $derived(cockpit?.project.data?.currency || currency);
  /**
   * R6: TWO different absences. `budget_known === false` ⇒ RM could not be read, so a null budget is
   * UNKNOWN ("[budget unavailable]"); otherwise a null budget is the fact "no budget is set".
   * Absent on an older backend ⇒ treat as known (the pre-R6 behaviour, no invented claim).
   */
  const budgetKnown = $derived(cockpit?.project.data?.budget_known !== false);

  const rows = $derived(costs ? rowsInPhase(costs.by_card, shown) : []);
  const unphasedRows = $derived(costs ? costs.by_card.filter((r) => r.phase == null) : []);
  const cardNames = $derived(
    new Map(
      (cockpit?.board && hasData(cockpit.board) ? cockpit.board.data.cards : [])
        .map((c) => [c.id, c.name] as const),
    ),
  );
  const phaseGroups = $derived(
    groupByPhase(rows, phases).map((g) =>
      unannotated && g.key === '__none__' ? { ...g, label: UNANNOTATED_LABEL } : g,
    ),
  );
  const capabilityGroups = $derived(
    groupByCapability(rows).map((g) =>
      unannotated && g.key === '__none__' ? { ...g, label: UNANNOTATED_LABEL } : g,
    ),
  );
  const cards = $derived(cardLines(rows, cardNames, phases, boardState, phaseFieldRecorded));
  const amountsKnown = $derived(costs !== null && costs.cost_basis !== 'unavailable' && costs.totals.cost !== null);
  const asOf = $derived(asOfWords(costs?.as_of));
  const basis = $derived(costs ? basisWords(costs.cost_basis) : null);
  const capabilityNamesRead = $derived(costs?.capability_source !== 'unavailable');

  const filterBtn = (on: boolean) =>
    `min-h-[2.25rem] rounded-full border px-3 text-xs font-semibold ${on ? 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-text)]' : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`;
</script>

<ProjectInspectHeader
  {projectId}
  title="Cost"
  subtitle="What this project's model calls have cost, against its budget. Billing's figures; a budget here is for reporting and does not stop work."
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void load(projectId)}
      class="rounded-[var(--radius-md)] bg-[var(--color-surface-strong)] px-3 py-1.5 text-sm font-semibold text-[var(--color-text)]"
      data-testid="cost-refresh"
    >
      Refresh
    </button>
  {/snippet}
</ProjectInspectHeader>

<div class="flex flex-col gap-4 p-6" data-testid="project-cost">
  {#if !loaded}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-loading">Loading the cost figures…</p>
  {:else if notFound}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-not-found">
      This project was not found, or you do not have access to it.
    </p>
  {:else if unreadable && !cockpit}
    <p class="text-sm text-[var(--color-warning-text)]" data-testid="project-unreadable">
      The cost figures could not be read right now, so nothing about this project's spend is known. This is NOT a $0
      reading. Retry, and report this if it persists.
    </p>
  {:else if cockpit}
    {#if spinePanel}
      <PhaseSpine
        panel={spinePanel}
        selectedPhase={shown === ALL_PHASES ? null : shown}
        onSelectPhase={(p) => (chosen = p ?? null)}
      />
    {/if}

    {#if !costsPanel}
      <p class="text-sm text-[var(--color-warning-text)]" data-testid="cost-not-served">The cost figures are not available from this server yet.</p>
    {:else if costsFailed}
      <div data-testid="cost-unreadable">
        <PanelNote panel={costsPanel} title="The cost figures" />
      </div>
    {:else if notAttributable}
      <p class="text-sm text-[var(--color-warning-text)]" data-testid="cost-not-attributable">
        This project's spend cannot be attributed to it, so billing has no figure to show. That is a gap in the record,
        not a $0 reading: the calls may have happened, but none carried this project's id.
      </p>
    {:else if costs}
      <!-- The filter lives in the state that HAS card spend, so a panel that failed, is not
           served, or is not attributable never draws a filter over no data. -->
      {#if !unannotated}
        <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Spend shown" data-testid="cost-filter">
          <span class="text-sm font-semibold text-[var(--color-text)]" data-testid="cost-filter-label">
            Showing: {shownPhase ? shownPhase.label : 'All phases'}
          </span>
          <button type="button" class={filterBtn(shown === ALL_PHASES)} aria-pressed={shown === ALL_PHASES} data-testid="cost-filter-all" onclick={() => (chosen = ALL_PHASES)}>
            All phases
          </button>
          <span class="text-xs text-[var(--color-text-muted)]">
            The phase filter narrows the card spend below. The day charts cover the whole project — billing records no per-phase day series.
          </span>
        </div>
      {/if}

      {#if costsPanel.health !== 'ok'}
        <PanelNote panel={costsPanel} title="The cost figures" />
      {/if}

      <section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="cost-summary">
        {#if amountsKnown}
          <p class="text-xl font-bold tabular-nums text-[var(--color-text)]" data-testid="cost-total">
            {spendSummary(costs, budget, budgetCurrency, budgetKnown)}
          </p>
        {:else}
          <p class="text-xl font-bold text-[var(--color-warning-text)]" data-testid="cost-total">
            Spend unavailable ({costs.totals.calls.toLocaleString('en-US')} model call{costs.totals.calls === 1 ? '' : 's'})
            {#if budget !== null}· of {moneyWords(budget, budgetCurrency)} budget{:else}· {budgetKnown ? '[budget not set]' : '[budget unavailable]'}{/if}
          </p>
          <p class="mt-1 text-xs text-[var(--color-warning-text)]" data-testid="cost-amounts-unavailable">
            Your workspace's pricing could not be read, so no amount is shown. This is not $0.
          </p>
        {/if}
        {#if shownPhase && costs.by_card.length > 0}
          <p class="mt-1 text-sm text-[var(--color-text)]" data-testid="cost-phase-total">
            {phaseSummary(rows, shownPhase.label, currency, unphasedRows, unannotated ? `with phase ${UNANNOTATED_LABEL.toLowerCase()}` : undefined)}
          </p>
        {/if}
        <p class="mt-1 flex flex-wrap items-baseline gap-x-3 text-xs text-[var(--color-text-muted)]">
          {#if asOf}<span data-testid="cost-as-of">{asOf}</span>{/if}
          {#if basis}<span data-testid="cost-basis">{basis}</span>{/if}
        </p>
        {#if costs.by_card.length > 0 && costs.by_card_since}
          <p class="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="cost-by-card-since">
            Card-level figures below cover spend recorded since {costs.by_card_since}; the total above covers the whole project.
          </p>
        {/if}
        {#if !budgetKnown}
          <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid="cost-budget-unavailable">
            This project's budget could not be read from requirements management, so it is unknown here. That is NOT
            the same as the project having no budget.
          </p>
        {/if}
      </section>

      {#if boardState === 'unavailable'}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="cost-board-unavailable" data-board-state={boardState}>
          The project's board could not be read, so no card is known and spend cannot be tied to a phase or a
          capability. The rows and chart legends below say the board was unreadable where a phase or capability would
          be — which is NOT the same as the cards recording nothing.
        </p>
      {:else if boardState === 'no_board'}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="cost-board-no-board" data-board-state={boardState}>
          This project has no board, so no card is known and spend cannot be tied to a phase or a capability. The
          rows and chart legends below say so where a phase or capability would be — which is NOT the same as the
          cards recording nothing.
        </p>
      {/if}

      {#if amountsKnown}
        <div class="grid gap-3 xl:grid-cols-2">
          <SettledProvisionalChart {costs} />
          <BurnBudgetChart {costs} {budget} {budgetKnown} currency={budgetCurrency} />
        </div>

        {#if shown === ALL_PHASES}
          <CostStackedBar
            title="By phase"
            groups={phaseGroups}
            currency={currency}
            emptyWords="No card spend is recorded for this project yet."
            testid="cost-by-phase"
          />
        {/if}
        {#if capabilityNamesRead}
          <CostStackedBar
            title={shownPhase ? `By capability in ${shownPhase.label}` : 'By capability'}
            groups={capabilityGroups}
            currency={currency}
            emptyWords="No card spend is recorded for this project yet."
            testid="cost-by-capability"
          />
        {:else}
          <p class="text-xs text-[var(--color-warning-text)]" data-testid="cost-capability-unreadable">
            The capability names could not be read, so spend is not grouped by capability. The amounts elsewhere are
            unaffected.
          </p>
        {/if}

        <section class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3" data-testid="cost-by-card">
          <h3 class="mb-2 text-sm font-semibold text-[var(--color-text)]">By card</h3>
          {#if cards.length === 0}
            <p class="text-xs text-[var(--color-text-muted)]" data-testid="cost-by-card-empty">No card spend is recorded for this selection.</p>
          {:else}
            <div class="overflow-x-auto rounded border border-[var(--color-border)]">
              <table class="w-full min-w-[42rem] text-left text-xs" data-testid="cost-by-card-table">
                <thead class="text-[11px] text-[var(--color-text-muted)]">
                  <tr>
                    <th scope="col" class="px-2 py-1">Card</th>
                    <th scope="col" class="px-2 py-1">Phase</th>
                    <th scope="col" class="px-2 py-1">Capability</th>
                    <th scope="col" class="px-2 py-1">Spend</th>
                    <th scope="col" class="px-2 py-1">Model calls</th>
                  </tr>
                </thead>
                <tbody>
                  {#each cards as c (c.key)}
                    <tr class="border-t border-[var(--color-border)]" data-testid="cost-by-card-row">
                      <th scope="row" class="max-w-[18rem] px-2 py-1 font-medium text-[var(--color-text)]">{c.name}</th>
                      <td class="px-2 py-1 text-[var(--color-text)]">{c.phaseLabel ?? (unannotated ? UNANNOTATED_LABEL : 'Not tied to a phase')}</td>
                      <td class="px-2 py-1 text-[var(--color-text)]">{c.capability ?? (unannotated ? UNANNOTATED_LABEL : 'Not recorded')}</td>
                      <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">
                        {moneyWords(c.cost, currency) ?? 'Not available'}{c.partial ? ' (floor)' : ''}
                      </td>
                      <td class="px-2 py-1 tabular-nums text-[var(--color-text)]">{c.calls.toLocaleString('en-US')}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>
      {/if}
    {/if}
  {/if}
</div>
