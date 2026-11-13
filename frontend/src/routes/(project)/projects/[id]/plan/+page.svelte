<!--
  /projects/[id]/plan — Plan & scope (R6, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3/§5).
  Replaces the Project brief page (which now 308s here) and the old "Project plan" view.

  Four sections, in the design's order:
    1. Brief — RM's current brief, its version list, and the diff between versions (BriefSection).
    2. Acceptance criteria — status + evidence per criterion, from RM's registers (the same rows the
       Registers page shows).
    3. Capabilities — the capabilities each phase's cards record (grouped by the card's OWN phase,
       from the same per-card rows the Cost page reads), then the PM's selection and its history.
    4. Milestones & risks — the approved scope's milestones (C10 states follow the project) and
       compact risks from RM's register, with a link to Registers.

  THREE reads, each degrading on its own: the cockpit (capabilities, per-card rows, milestones,
  phase labels), the registers (criteria, risks) and the brief (inside BriefSection). A failed
  cockpit never hides the brief or the criteria; a failed register never hides the brief. Nothing is
  faked: a phase is the one the card records (never inferred), a board that could not be read says
  so instead of "not recorded", and a milestone on a closed project says how its state was derived.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { fetchProjectCockpit, CockpitNotFoundError } from '$lib/api/cockpit';
  import { fetchProjectRegisters } from '$lib/api/project-registers';
  import { hasData } from '$lib/types/panel';
  import type { CostBoardState, ProjectCockpit, ProjectRegisters, RegisterCriterion } from '$lib/types/cockpit';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import BriefSection from '$lib/components/plan/BriefSection.svelte';
  import ProjectCapabilities from '$lib/components/projects/ProjectCapabilities.svelte';
  import { displayCriteria, phaseOptions, riskRows, type PhaseOption } from '$lib/components/registers/registers';
  import { MILESTONE_BASIS_WORDS, capabilitiesByPhase, milestoneView } from '$lib/components/plan/plan';
  import { isFinished } from '$lib/projects/cockpit-status';
  import { isClosedProjectStatus } from '$lib/projects/project-status';

  const projectId = $derived(page.params.id ?? '');

  let cockpit = $state<ProjectCockpit | null>(null);
  let cockpitLoaded = $state(false);
  let notFound = $state(false);
  /** The cockpit read failed: capabilities + milestones are unknown (said so), the rest still shows. */
  let cockpitUnreadable = $state(false);

  type RegistersView =
    | { kind: 'reading' }
    | { kind: 'failed' }
    | { kind: 'loaded'; data: ProjectRegisters };
  let registers = $state<RegistersView>({ kind: 'reading' });

  async function loadCockpit(id: string): Promise<void> {
    try {
      // PROJECT-READ-WAIVER: primary-load — Plan & scope needs the cockpit's capabilities,
      // milestones and phase names; loadProject does not carry them. A failed read renders
      // data-testid="project-unreadable" below and the brief/criteria sections still render.
      const c = await fetchProjectCockpit(id);
      if (id !== projectId) return;
      cockpit = c;
      notFound = false;
      cockpitUnreadable = false;
    } catch (e) {
      if (id !== projectId) return;
      if (e instanceof CockpitNotFoundError) notFound = true;
      else {
        console.error('[projects/plan] cockpit read failed', e);
        cockpitUnreadable = true;
      }
    } finally {
      if (id === projectId) cockpitLoaded = true;
    }
  }

  async function loadRegisters(id: string): Promise<void> {
    registers = { kind: 'reading' };
    try {
      const data = await fetchProjectRegisters(id, null);
      if (id === projectId) registers = { kind: 'loaded', data };
    } catch (e) {
      console.error('[projects/plan] registers read failed', e);
      if (id === projectId) registers = { kind: 'failed' };
    }
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    cockpit = null;
    cockpitLoaded = false;
    void loadCockpit(id);
    void loadRegisters(id);
  });

  const closed = $derived(
    isFinished(cockpit?.status.data?.state) ||
      isClosedProjectStatus(cockpit?.project.data?.status ?? null, cockpit?.project.data?.rm_status ?? null),
  );
  const closedOn = $derived(
    cockpit?.status.data?.ended_at ?? cockpit?.project.data?.delivered_at ?? null,
  );

  const spine = $derived(cockpit?.spine && hasData(cockpit.spine) ? cockpit.spine.data : null);
  const phases = $derived<PhaseOption[]>(
    spine ? spine.phases.map((p) => ({ name: p.name, label: p.label })) : [],
  );
  const cardNames = $derived(
    new Map(
      (cockpit?.board && hasData(cockpit.board) ? cockpit.board.data.cards : []).map((c) => [c.id, c.name] as const),
    ),
  );

  const loadedRegisters = $derived(registers.kind === 'loaded' && registers.data.available ? registers.data : null);

  // ── 2. Acceptance criteria ──
  const criteria = $derived<RegisterCriterion[]>(loadedRegisters ? displayCriteria(loadedRegisters.criteria ?? []) : []);
  const checkable = $derived(criteria.filter((c) => c.kind === 'acceptance'));
  const metCount = $derived(checkable.filter((c) => (c.status ?? '').toLowerCase() === 'met').length);

  function criterionStatus(c: RegisterCriterion): { words: string; cls: string } {
    if (c.kind !== 'acceptance') {
      return { words: 'Success criterion, not checked', cls: 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]' };
    }
    const s = (c.status ?? '').toLowerCase();
    if (s === 'met') return { words: 'Met', cls: 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]' };
    if (s === 'not_met') return { words: 'Not met', cls: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]' };
    return { words: 'Not checked yet', cls: 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]' };
  }

  // ── 3. Capabilities ──
  // TWO honest sources, kept apart:
  //  - PER PHASE (the design's §3 content): the by-card cost rows the cockpit already annotates with
  //    the card's OWN phase and the RM capability of its card_type — the same rows the Cost page
  //    reads. Its two failure modes are carried on the same data: `board_available === false` (no
  //    card could be read, so nothing may read as "no capabilities") and
  //    `capability_source === 'unavailable'` (the catalogue could not name them).
  //  - The SELECTION history: RM records what was selected and when, but NOT the phase it was
  //    selected in, so that list stays one list and says so — the per-phase view above does not
  //    depend on it.
  const capabilityPanel = $derived(cockpit?.capabilities ?? null);
  const costsPanel = $derived(cockpit?.project_costs ?? null);
  const costsLoaded = $derived(costsPanel !== null && hasData(costsPanel) ? costsPanel.data : null);
  /**
   * The board's state behind the per-card rows (R6 tri-state). `no_board` is a FACT about the
   * project (it has no board), never a read failure — the two are worded differently below.
   * An older backend carries only `board_available` (false ⇒ could not be read).
   */
  const boardState = $derived<CostBoardState>(
    costsLoaded?.board_state ?? (costsLoaded?.board_available === false ? 'unavailable' : 'ok'),
  );
  /** The board could not be read: no cost row resolves a card, so no phase/capability may be claimed. */
  const boardUnreadable = $derived(boardState === 'unavailable');
  /** The project has no board at all: same consequence, different (and non-alarming) cause. */
  const boardMissing = $derived(boardState === 'no_board');
  /**
   * Whether the rows carry the `phase` FIELD at all. Only an R6 backend annotates rows with it; a
   * pre-R6 answer has no key, so an absent phase there says nothing about what the board records —
   * it must not be worded as "the board records no phase".
   */
  const phaseFieldRecorded = $derived(costsLoaded ? costsLoaded.by_card.every((r) => 'phase' in r) : false);
  /** The catalogue could not name the card types: the phase still holds, the capability NAME is unknown. */
  const capabilityNamesUnreadable = $derived(costsLoaded?.capability_source === 'unavailable');
  const phaseCapabilities = $derived(
    costsLoaded ? capabilitiesByPhase(costsLoaded.by_card, phases) : [],
  );

  // ── 4. Milestones & risks ──
  const scopePanel = $derived(cockpit?.deliverables ?? null);
  const milestones = $derived(scopePanel && hasData(scopePanel) ? (scopePanel.data.milestones ?? []) : []);
  const risks = $derived(
    loadedRegisters ? riskRows(loadedRegisters.risks ?? [], phaseOptions(phases), cardNames) : [],
  );
  const riskClosed = (status: string): boolean => /^(closed|occurred|resolved|mitigated)$/i.test(status.trim());

  function evidenceHref(ref: string): string | null {
    return /^https?:\/\//i.test(ref) ? ref : null;
  }
</script>

<ProjectInspectHeader
  {projectId}
  title="Plan & scope"
  subtitle="What this project was asked for, how it will be judged, the capabilities it uses, and its milestones and risks."
/>

<div class="flex flex-col gap-5 p-6" data-testid="project-plan-scope">
  {#if !cockpitLoaded}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="plan-loading">Loading the plan…</p>
  {:else if notFound}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-not-found">
      This project was not found, or you do not have access to it.
    </p>
  {:else}
    {#if cockpitUnreadable && !cockpit}
      <p class="text-sm text-[var(--color-warning-text)]" data-testid="project-unreadable">
        This project's capabilities, milestones and phase names could not be read right now. The brief and the acceptance
        criteria below are read separately and still shown; the missing parts are NOT shown to be empty.
      </p>
    {/if}

    <!-- 1. BRIEF -->
    <section aria-labelledby="plan-brief-heading" data-testid="plan-section-brief">
      <h2 id="plan-brief-heading" class="mb-1 text-sm font-bold text-[var(--color-text)]">Brief</h2>
      <p class="mb-2 text-xs text-[var(--color-text-muted)]">
        The brief this project was asked for, as versions in requirements management. Version 1 is the request; later
        versions come from the conveyor. Read-only.
      </p>
      {#if projectId}
        <BriefSection {projectId} />
      {/if}
    </section>

    <!-- 2. ACCEPTANCE CRITERIA -->
    <section aria-labelledby="plan-criteria-heading" data-testid="plan-section-criteria">
      <div class="mb-1 flex flex-wrap items-baseline gap-2">
        <h2 id="plan-criteria-heading" class="text-sm font-bold text-[var(--color-text)]">Acceptance criteria</h2>
        <a class="text-xs text-[var(--color-link)] hover:underline" href={`/projects/${encodeURIComponent(projectId)}/registers`}>
          Open the full registers
        </a>
      </div>
      {#if registers.kind === 'reading'}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-criteria-reading">Reading the acceptance criteria…</p>
      {:else if registers.kind === 'failed'}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-criteria-failed">
          The acceptance criteria could not be read right now — this is not "none recorded".
        </p>
      {:else if !loadedRegisters}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-criteria-no-register">
          This project is not run by the conveyor, so it keeps no acceptance criteria.
        </p>
      {:else}
        <p class="mb-2 text-xs text-[var(--color-text)]" data-testid="plan-criteria-summary">
          {#if checkable.length > 0}
            <span class="font-bold">{metCount} of {checkable.length}</span> acceptance criteria met
          {:else}
            No acceptance criteria
          {/if}
          {#if criteria.length > checkable.length}· {criteria.length - checkable.length} success criterion{criteria.length - checkable.length === 1 ? '' : 'a'} stated (not checked){/if}
        </p>
        {#if criteria.length === 0}
          <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-criteria-empty">
            The brief names no success or acceptance criteria yet.
          </p>
        {:else}
          <div class="overflow-x-auto rounded-[var(--radius-md)] border border-[var(--color-border)]">
            <table class="w-full min-w-[40rem] text-left text-sm" data-testid="plan-criteria-table">
              <thead class="text-[11px] text-[var(--color-text-muted)]">
                <tr>
                  <th scope="col" class="px-2 py-1">Criterion</th>
                  <th scope="col" class="px-2 py-1">Status</th>
                  <th scope="col" class="px-2 py-1">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {#each criteria as c, i (c.id ?? `${c.kind}-${i}`)}
                  {@const st = criterionStatus(c)}
                  <tr class="border-t border-[var(--color-border)]" data-testid="plan-criterion-row">
                    <td class="px-2 py-1.5 text-[var(--color-text)]">
                      {c.text}
                      <span class="block text-[11px] text-[var(--color-text-muted)]">
                        {c.kind === 'acceptance' ? 'Acceptance criterion' : 'Success criterion'}
                      </span>
                    </td>
                    <td class="px-2 py-1.5">
                      <span class={`whitespace-nowrap rounded-full border px-2 py-0.5 text-xs font-semibold ${st.cls}`} data-testid="plan-criterion-status">{st.words}</span>
                    </td>
                    <td class="px-2 py-1.5 text-xs text-[var(--color-text)]">
                      {#if (c.evidence ?? []).length === 0}
                        <span class="text-[var(--color-text-muted)]">None yet</span>
                      {:else}
                        <ul class="space-y-0.5">
                          {#each c.evidence ?? [] as e, n (n)}
                            <li class="break-words">
                              {e.kind ? `${e.kind}: ` : ''}
                              {#if e.ref && evidenceHref(e.ref)}
                                <a class="text-[var(--color-link)] underline" href={evidenceHref(e.ref) ?? undefined} target="_blank" rel="noopener noreferrer">{e.ref}</a>
                              {:else}
                                {e.ref ?? '—'}
                              {/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </section>

    <!-- 3. CAPABILITIES -->
    <section aria-labelledby="plan-capabilities-heading" data-testid="plan-section-capabilities">
      <h2 id="plan-capabilities-heading" class="mb-1 text-sm font-bold text-[var(--color-text)]">Capabilities</h2>

      <h3 class="mt-1 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Per phase</h3>
      <p class="mb-2 text-xs text-[var(--color-text-muted)]">
        The capabilities of the cards each phase records — from the same per-card rows the Cost page reads, so a card
        with no spend yet is not in this list. A phase is the one the card itself records, never one inferred from a
        date.
      </p>
      {#if !costsPanel}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-phase-unavailable">
          The per-card rows are not available from this server yet.
        </p>
      {:else if boardUnreadable}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-phase-board-unreadable">
          The project's board could not be read, so no card is known and its capabilities cannot be tied to a phase.
          This is NOT "no capabilities in any phase".
        </p>
      {:else if boardMissing}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-phase-no-board">
          This project has no board, so no card is known and its capabilities cannot be tied to a phase. This is NOT
          "no capabilities in any phase".
        </p>
      {:else if costsPanel.detail_code === 'billing_project_not_attributable'}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-phase-not-attributable">
          This project's spend cannot be attributed to it, so its cards cannot be named here — a gap in the record,
          not "no capabilities".
        </p>
      {:else if !costsLoaded}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-phase-failed">
          The per-card rows could not be read right now — this is not "no capabilities".
        </p>
      {:else if capabilityNamesUnreadable}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-phase-names-unreadable">
          The capability names could not be read from the catalogue, so the cards cannot be listed by capability. The
          selection below is read separately and is unaffected.
        </p>
      {:else if phaseCapabilities.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-phase-none">
          No card carrying spend is recorded yet, so no capability is tied to a phase.
        </p>
      {:else}
        {#if phaseCapabilities.every((g) => g.name === null)}
          {#if boardState === 'ok' && phaseFieldRecorded}
            <p class="mb-1 text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-phase-recorded-none">
              The board records no phase on the cards that carry spend, so they are listed without one. That is the
              board's own record — not a phase this page failed to show.
            </p>
          {:else}
            <p class="mb-1 text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-phase-unphased">
              These card rows carry no phase, so the cards are listed without one. This page cannot say whether the
              board records a phase — no phase was read for them.
            </p>
          {/if}
        {/if}
        <ul class="space-y-1.5" data-testid="plan-capabilities-phase-list">
          {#each phaseCapabilities as g (g.name ?? '__none__')}
            <li class="flex flex-wrap items-baseline gap-2 text-sm" data-testid="plan-capabilities-phase" data-phase={g.name ?? ''}>
              <span class="min-w-[7rem] font-semibold text-[var(--color-text)]">{g.label}</span>
              {#each g.capabilities as cap (cap)}
                <span
                  class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs text-[var(--color-text)]"
                  data-testid="plan-capability">{cap}</span
                >
              {/each}
              {#if g.capabilities.length === 0}
                <span class="text-xs text-[var(--color-text-muted)]">No capability recorded on this phase's cards</span>
              {/if}
              {#if g.capabilities.length > 0 && g.cardsWithoutCapability > 0}
                <span class="text-[11px] text-[var(--color-text-muted)]">
                  {g.cardsWithoutCapability} of {g.cards} card{g.cards === 1 ? '' : 's'} name no capability
                </span>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}

      <h3 class="mt-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        Selected and how it was chosen
      </h3>
      <p class="mb-2 text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-no-phase">
        Requirements management records WHAT was selected and when, but not the phase it was selected in, so that
        history is one list rather than one per phase — the per-phase view above does not depend on it. The current
        selection is what the project is using now.
      </p>
      {#if capabilityPanel}
        <ProjectCapabilities {projectId} panel={capabilityPanel} />
      {:else if cockpitUnreadable}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-capabilities-unreadable">
          The capability selection could not be read — this is not "none selected".
        </p>
      {:else}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-capabilities-unavailable">
          Capability selection is not available from this server yet.
        </p>
      {/if}
    </section>

    <!-- 4. MILESTONES & RISKS -->
    <section aria-labelledby="plan-milestones-heading" data-testid="plan-section-milestones">
      <h2 id="plan-milestones-heading" class="mb-1 text-sm font-bold text-[var(--color-text)]">Milestones and risks</h2>

      <h3 class="mt-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Milestones</h3>
      {#if closed}
        <p class="mb-1 text-[11px] text-[var(--color-text-muted)]" data-testid="plan-milestone-basis">{MILESTONE_BASIS_WORDS}</p>
      {/if}
      {#if !scopePanel}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-milestones-unreadable">
          The milestones could not be read — this is not "none recorded".
        </p>
      {:else if !hasData(scopePanel)}
        <PanelNote panel={scopePanel} title="The milestones" />
      {:else if milestones.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-milestones-empty">
          The approved scope records no milestones.
        </p>
      {:else}
        <ol class="space-y-1" data-testid="plan-milestone-list">
          {#each [...milestones].sort((a, b) => a.position - b.position) as m (m.position)}
            {@const view = milestoneView(m, closed, closedOn)}
            <li class="flex flex-wrap items-baseline gap-2 text-sm" data-testid="plan-milestone" data-state={view.state}>
              <span class="font-semibold text-[var(--color-text)]">{m.name}</span>
              <span
                class={view.state === 'reached' ? 'text-[var(--color-success-text)]' : view.state === 'missed' ? 'text-[var(--color-warning-text)]' : 'text-[var(--color-text-muted)]'}
                data-testid="plan-milestone-words">{view.words}</span
              >
            </li>
          {/each}
        </ol>
      {/if}

      <div class="mb-1 mt-4 flex flex-wrap items-baseline gap-2">
        <h3 class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Risks</h3>
        <a class="text-xs text-[var(--color-link)] hover:underline" href={`/projects/${encodeURIComponent(projectId)}/registers`}>
          Open the full register
        </a>
      </div>
      {#if registers.kind === 'reading'}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-risks-reading">Reading the risks…</p>
      {:else if registers.kind === 'failed'}
        <p class="text-xs text-[var(--color-warning-text)]" data-testid="plan-risks-failed">
          The risks could not be read right now — this is not "none recorded".
        </p>
      {:else if !loadedRegisters}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-risks-no-register">
          This project is not run by the conveyor, so it keeps no risk register.
        </p>
      {:else if risks.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="plan-risks-empty">No risks are recorded for this project.</p>
      {:else}
        <ul class="space-y-1.5" data-testid="plan-risk-list">
          {#each risks as r (r.id)}
            <li class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-2.5 py-1.5 text-xs" data-testid="plan-risk-row">
              <div class="flex flex-wrap items-baseline gap-2">
                <span class="font-semibold text-[var(--color-text)]">{r.title}</span>
                <span class="tabular-nums text-[var(--color-text)]" title="probability × impact">score {r.scoreText}{r.factors ? ` (${r.factors})` : ''}</span>
                <span class="rounded-full border border-[var(--color-border)] px-1.5 text-[var(--color-text-muted)]">{r.status}</span>
                <span class="text-[var(--color-text-muted)]">{r.owner}</span>
                {#if r.phaseLabel}<span class="text-[var(--color-text-muted)]">· {r.phaseLabel}</span>{/if}
              </div>
              {#if r.plan}<p class="mt-0.5 text-[var(--color-text)]">Response: {r.plan}</p>{/if}
              {#if closed && !riskClosed(r.status)}
                <p class="mt-0.5 text-[11px] text-[var(--color-warning-text)]" data-testid="plan-risk-closed-note">
                  The project is closed; the register still records this risk as {r.status.toLowerCase()}.
                </p>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  {/if}
</div>
