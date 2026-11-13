<!--
  ProjectRegisters — the project's Registers (REG-3, FR-PROJECT-HOME-REDESIGN-2026-10-26 §7.3–7.5):
  Risks · Criteria · Decisions, each with its count, one phase filter (All + the project's phases),
  sortable columns, a table that scrolls inside its own box, and Export CSV for the register shown
  (honouring the phase filter).

  Sources, never mixed up:
    - Risks and criteria: GET /api/projects/:id/registers (RM's registers, proxied by fr).
    - Decisions: RM `decisions` when it has rows; until the conveyor writes them, the C8 decision
      log (approvals and answers) with a one-line note saying so.
  A row's phase is the one RM / the read model RECORDED; a row without one is listed under "All".
  States are never collapsed: reading, could not be read, not run by the conveyor, listed.
-->
<script lang="ts">
  import { shortTime } from '$lib/components/cockpit/spine';
  import type { RegistersView } from '$lib/components/overview/overview';
  import {
    ALL_PHASES,
    REGISTER_KEYS,
    REGISTER_NAMES,
    cardNameMap,
    criteriaCsv,
    criterionRows,
    csvFileName,
    displayCriteria,
    decisionsCsv,
    inPhase,
    logDecisionRows,
    nextSort,
    phaseOptions,
    registerDecisionRows,
    riskRows,
    risksCsv,
    sortCriteria,
    sortDecisions,
    sortRisks,
    type CriterionSortKey,
    type DecisionLogView,
    type DecisionSortKey,
    type RegisterKey,
    type RiskSortKey,
    type SortState,
  } from './registers';

  let {
    projectId,
    view,
    log,
    phases = null,
    cards = null,
  }: {
    projectId: string;
    view: RegistersView;
    log: DecisionLogView;
    /** R2's phase model (the spine's phases, Closure included); null = the default set. */
    phases?: readonly { name: string; label: string }[] | null;
    /** The project's Planka board cards (spine), to name the card a row was raised on. */
    cards?: readonly { id: string; name: string }[] | null;
  } = $props();

  let register = $state<RegisterKey>('risks');
  let phase = $state<string>(ALL_PHASES);
  let riskSort = $state<SortState<RiskSortKey>>({ key: 'score', dir: 'desc' });
  let criterionSort = $state<SortState<CriterionSortKey> | null>(null);
  let decisionSort = $state<SortState<DecisionSortKey>>({ key: 'when', dir: 'desc' });

  const options = $derived(phaseOptions(phases));
  const names = $derived(cardNameMap(cards));
  const data = $derived(view.kind === 'loaded' && view.data.available ? view.data : null);

  const risks = $derived(
    data ? sortRisks(riskRows(data.risks, options, names).filter((r) => inPhase(r.phase, phase)), riskSort) : [],
  );
  // Criteria belong to the brief, which has no phase: the filter never hides one.
  const criteria = $derived(data ? sortCriteria(criterionRows(displayCriteria(data.criteria)), criterionSort) : []);
  const fromRegister = $derived(!!data && data.decisions.length > 0);
  const decisions = $derived.by(() => {
    if (!data) return [];
    const rows = fromRegister
      ? registerDecisionRows(data.decisions, options, names)
      : log.kind === 'loaded'
        ? logDecisionRows(log.rows, options)
        : [];
    return sortDecisions(rows.filter((d) => inPhase(d.phase, phase)), decisionSort);
  });
  const decisionsUnread = $derived(!fromRegister && log.kind !== 'loaded');

  const counts = $derived<Record<RegisterKey, number | null>>({
    risks: data ? risks.length : null,
    criteria: data ? criteria.length : null,
    decisions: data && !decisionsUnread ? decisions.length : null,
  });
  /** Only acceptance criteria carry a check; success criteria are stated intent, not a test. */
  const checkable = $derived(criteria.filter((c) => c.checkable));
  const metCount = $derived(checkable.filter((c) => c.met).length);
  const notScored = $derived(criteria.length - checkable.length);
  const phaseName = $derived(options.find((o) => o.name === phase)?.label ?? 'All');

  function exportCsv(): void {
    const csv = register === 'risks' ? risksCsv(risks) : register === 'criteria' ? criteriaCsv(criteria) : decisionsCsv(decisions);
    const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = csvFileName(projectId, register, phase);
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  const arrow = (on: boolean, dir: 'asc' | 'desc') => (on ? (dir === 'asc' ? '▲' : '▼') : '');
  const ariaSort = (on: boolean, dir: 'asc' | 'desc') => (on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
  const thBtn = 'inline-flex min-h-[2rem] items-center gap-1 font-bold uppercase tracking-wider hover:text-[var(--color-text)]';
  const th = 'whitespace-nowrap border-b border-[var(--color-border)] px-3 py-2 text-left text-[11px] text-[var(--color-text-muted)]';
  const td = 'border-b border-[var(--color-border)] px-3 py-3 align-top';
</script>

<section data-testid="project-registers" aria-label="Registers">
  <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
    <div class="min-w-0">
      <h1 class="text-lg font-semibold text-[var(--color-text)]">Registers</h1>
      <p class="text-sm text-[var(--color-text-muted)]">What could go wrong, what counts as done, and what was decided.</p>
    </div>
    {#if data}
      <button
        type="button"
        class="inline-flex min-h-[2.5rem] items-center rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-4 text-sm font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface-strong)] disabled:opacity-50"
        data-testid="registers-export"
        disabled={register === 'decisions' && decisionsUnread}
        onclick={exportCsv}>Export CSV</button
      >
    {/if}
  </div>

  {#if view.kind === 'reading'}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="registers-reading">Reading the registers…</p>
  {:else if view.kind === 'failed'}
    <p class="text-sm text-[var(--color-warning-text)]" role="alert" data-testid="registers-failed">
      The registers could not be read, so nothing is known about this project's risks, criteria or decisions right now.
    </p>
  {:else if !data}
    <div class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-6 text-center" data-testid="registers-unavailable">
      <p class="text-sm font-semibold text-[var(--color-text)]">This project keeps no registers</p>
      <p class="mt-1 text-sm text-[var(--color-text-muted)]">
        Registers are kept for projects the conveyor runs. This one is not linked to a conveyor project, so there are no risks,
        criteria or decisions to show.
      </p>
    </div>
  {:else}
    <div class="mb-3 flex flex-wrap border-b border-[var(--color-border)]" role="tablist" aria-label="Register">
      {#each REGISTER_KEYS as key (key)}
        <button
          type="button"
          role="tab"
          id={`register-${key}`}
          aria-selected={register === key}
          aria-controls="register-panel"
          data-testid={`register-${key}`}
          class={`-mb-px min-h-[2.75rem] border-b-[3px] px-4 text-sm font-semibold ${register === key ? 'border-[var(--color-accent)] text-[var(--color-text)]' : 'border-transparent text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
          onclick={() => (register = key)}
          >{REGISTER_NAMES[key]}{counts[key] !== null ? ` (${counts[key]})` : ''}</button
        >
      {/each}
    </div>

    <div class="mb-3 flex flex-wrap items-center gap-2" role="group" aria-label="Phase" data-testid="registers-phase-filter">
      <span class="text-xs font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">Phase</span>
      {#each options as o (o.name)}
        <button
          type="button"
          aria-pressed={phase === o.name}
          data-testid={`registers-phase-${o.name}`}
          class={`min-h-[2.25rem] rounded-full border px-3 text-xs font-semibold ${phase === o.name ? 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-text)]' : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`}
          onclick={() => (phase = o.name)}>{o.label}</button
        >
      {/each}
    </div>

    <div id="register-panel" role="tabpanel" aria-labelledby={`register-${register}`}>
      {#if register === 'risks'}
        {#if risks.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="registers-risks-empty">
            {phase === ALL_PHASES ? 'No risks are recorded for this project.' : `No risks are recorded for the ${phaseName} phase.`}
            {#if phase !== ALL_PHASES && data.risks.some((r) => !r.phase)}
              {data.risks.filter((r) => !r.phase).length} risk{data.risks.filter((r) => !r.phase).length === 1 ? ' has' : 's have'} no recorded phase and
              {data.risks.filter((r) => !r.phase).length === 1 ? 'is' : 'are'} listed under All.
            {/if}
          </p>
        {:else}
          <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]" data-testid="registers-table-box">
            <table class="w-full min-w-[56rem] text-sm" data-testid="registers-risks-table">
              <thead>
                <tr>
                  <th class={th} aria-sort={ariaSort(riskSort.key === 'score', riskSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (riskSort = nextSort(riskSort, 'score', 'desc'))}>Score {arrow(riskSort.key === 'score', riskSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(riskSort.key === 'title', riskSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (riskSort = nextSort(riskSort, 'title'))}>Risk {arrow(riskSort.key === 'title', riskSort.dir)}</button>
                  </th>
                  <th class={th}>Response</th>
                  <th class={th} aria-sort={ariaSort(riskSort.key === 'owner', riskSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (riskSort = nextSort(riskSort, 'owner'))}>Owner {arrow(riskSort.key === 'owner', riskSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(riskSort.key === 'raised', riskSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (riskSort = nextSort(riskSort, 'raised', 'desc'))}>Raised {arrow(riskSort.key === 'raised', riskSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(riskSort.key === 'status', riskSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (riskSort = nextSort(riskSort, 'status'))}>Status {arrow(riskSort.key === 'status', riskSort.dir)}</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each risks as r (r.id)}
                  <tr data-testid="registers-risk-row">
                    <td class={td}>
                      <span class="font-bold tabular-nums text-[var(--color-text)]" data-testid="risk-score">{r.scoreText}</span>
                      {#if r.factors}<span class="block text-xs tabular-nums text-[var(--color-text-muted)]" title="probability × impact">{r.factors}</span>{/if}
                    </td>
                    <td class={`${td} min-w-[12rem]`}>
                      <span class="font-semibold text-[var(--color-text)]">{r.title}</span>
                      {#if r.category}<span class="block text-xs text-[var(--color-text-muted)]">{r.category}</span>{/if}
                    </td>
                    <td class={`${td} min-w-[16rem] text-[var(--color-text)]`}>{r.plan ?? 'No response plan recorded.'}</td>
                    <td class={`${td} whitespace-nowrap text-[var(--color-text)]`} data-testid="risk-owner">{r.owner}</td>
                    <td class={`${td} text-[var(--color-text)]`} data-testid="risk-raised">
                      <span class="block whitespace-nowrap">{r.phaseLabel ?? 'Phase not recorded'}</span>
                      <span class="block whitespace-nowrap text-xs text-[var(--color-text-muted)]">{[shortTime(r.raisedAt), r.cardName].filter(Boolean).join(' · ')}</span>
                    </td>
                    <td class={`${td} whitespace-nowrap`}>
                      <span class="rounded-full border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-0.5 text-xs font-semibold text-[var(--color-text)]">{r.status}</span>
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
          <p class="mt-2 text-xs text-[var(--color-text-muted)]">
            Score = probability × impact. Until the conveyor records a person or role, the owner is the agent that raised the risk.
          </p>
        {/if}
      {:else if register === 'criteria'}
        {#if criteria.length > 0}
          <p class="mb-2 text-sm text-[var(--color-text)]" data-testid="registers-criteria-summary">
            {#if checkable.length > 0}
              <span class="font-bold">{metCount} of {checkable.length}</span> acceptance criteria met
            {:else}
              No acceptance criteria
            {/if}{#if notScored > 0} · {notScored} success criterion{notScored === 1 ? '' : 'a'} not scored{/if} · from the project brief{phase !== ALL_PHASES ? ' (criteria have no phase, so the filter does not narrow them)' : ''}
          </p>
        {/if}
        {#if criteria.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="registers-criteria-empty">The brief names no success or acceptance criteria yet.</p>
        {:else}
          <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table class="w-full min-w-[40rem] text-sm" data-testid="registers-criteria-table">
              <thead>
                <tr>
                  <th class={th} aria-sort={ariaSort(criterionSort?.key === 'text', criterionSort?.dir ?? 'asc')}>
                    <button type="button" class={thBtn} onclick={() => (criterionSort = nextSort(criterionSort, 'text'))}>Criterion {arrow(criterionSort?.key === 'text', criterionSort?.dir ?? 'asc')}</button>
                  </th>
                  <th class={th}>Evidence</th>
                  <th class={th} aria-sort={ariaSort(criterionSort?.key === 'status', criterionSort?.dir ?? 'asc')}>
                    <button type="button" class={thBtn} onclick={() => (criterionSort = nextSort(criterionSort, 'status'))}>Status {arrow(criterionSort?.key === 'status', criterionSort?.dir ?? 'asc')}</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each criteria as c (c.id)}
                  <tr data-testid="registers-criterion-row">
                    <td class={`${td} min-w-[20rem]`}>
                      <span class="text-[var(--color-text)]">{c.text}</span>
                      <span class="block text-xs text-[var(--color-text-muted)]">{c.kindLabel}</span>
                    </td>
                    <td class={`${td} min-w-[12rem] text-[var(--color-text)]`}>
                      {#if c.evidence.length === 0}
                        <span class="text-[var(--color-text-muted)]">None yet</span>
                      {:else}
                        <ul class="space-y-0.5">
                          {#each c.evidence as e, n (n)}
                            <li class="break-words">
                              {e.label}:
                              {#if e.href}<a class="text-[var(--color-link)] underline" href={e.href} target="_blank" rel="noopener noreferrer">{e.ref}</a>{:else}{e.ref}{/if}
                            </li>
                          {/each}
                        </ul>
                      {/if}
                    </td>
                    <td class={`${td} whitespace-nowrap`}>
                      <span
                        data-testid="criterion-status"
                        class={`rounded-full border px-2 py-0.5 text-xs font-semibold ${!c.checkable ? 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]' : c.met ? 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]' : 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]'}`}
                        >{c.statusLabel}</span
                      >
                    </td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {:else}
        {#if !fromRegister}
          <p class="mb-2 text-sm text-[var(--color-text-muted)]" data-testid="registers-decisions-note">
            No design or scope decisions are recorded for this project yet. Below: approvals and answers, from the decision log.
          </p>
        {/if}
        {#if decisionsUnread}
          {#if log.kind === 'reading'}
            <p class="text-sm text-[var(--color-text-muted)]">Reading the decision log…</p>
          {:else}
            <p class="text-sm text-[var(--color-warning-text)]" role="alert" data-testid="registers-decisions-failed">The decision log could not be read.</p>
          {/if}
        {:else if decisions.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="registers-decisions-empty">
            {phase === ALL_PHASES ? 'Nothing has been decided yet.' : `Nothing recorded as decided in the ${phaseName} phase.`}
          </p>
        {:else}
          <div class="overflow-x-auto rounded-lg border border-[var(--color-border)]">
            <table class="w-full min-w-[44rem] text-sm" data-testid="registers-decisions-table" data-source={fromRegister ? 'register' : 'log'}>
              <thead>
                <tr>
                  <th class={th} aria-sort={ariaSort(decisionSort.key === 'when', decisionSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (decisionSort = nextSort(decisionSort, 'when', 'desc'))}>When {arrow(decisionSort.key === 'when', decisionSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(decisionSort.key === 'text', decisionSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (decisionSort = nextSort(decisionSort, 'text'))}>Decision {arrow(decisionSort.key === 'text', decisionSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(decisionSort.key === 'by', decisionSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (decisionSort = nextSort(decisionSort, 'by'))}>Decided by {arrow(decisionSort.key === 'by', decisionSort.dir)}</button>
                  </th>
                  <th class={th} aria-sort={ariaSort(decisionSort.key === 'phase', decisionSort.dir)}>
                    <button type="button" class={thBtn} onclick={() => (decisionSort = nextSort(decisionSort, 'phase'))}>Phase {arrow(decisionSort.key === 'phase', decisionSort.dir)}</button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {#each decisions as d (d.id)}
                  <tr data-testid="registers-decision-row">
                    <td class={`${td} whitespace-nowrap text-[var(--color-text-muted)]`}>{shortTime(d.at) || '—'}</td>
                    <td class={`${td} min-w-[20rem] text-[var(--color-text)]`}>
                      {d.text}
                      {#if d.cardName}<span class="block text-xs text-[var(--color-text-muted)]">Card: {d.cardName}</span>{/if}
                    </td>
                    <td class={`${td} whitespace-nowrap text-[var(--color-text)]`}>{d.by}</td>
                    <td class={`${td} whitespace-nowrap text-[var(--color-text)]`}>{d.phaseLabel ?? 'Not tied to a phase'}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        {/if}
      {/if}
    </div>
  {/if}
</section>
