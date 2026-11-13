<script lang="ts">
  // The per-project PLAN (CONVEYOR-TAXONOMY §3 B, fr#1483).
  //
  // mode="live": GET /api/projects/:id/plan — the plan's phases in order, each
  // with its exit gate (kinds + approved?), its deliverables (cardinality,
  // minter, deferred, minted count, attached cards per list) and its exit facts
  // (exit-ready + blockers) from the server's read model (display only — n8n is
  // the only phase writer). A conveyor project (RM-linked, no template) renders
  // ConveyorPlanView. A template-less project with no RM link says "legacy, no plan".
  //
  // ⛔ NO CLIENT PROJECTION. Every phase, gate, completion and count below is a
  // server value. This component never derives a phase list from the spine or a
  // phase from a card type (D8).
  //
  // mode="proposed" (fr#1484): the outline's stored phase_plan as the server
  // built it (`plan_view` on GET /api/project-requests/:id/outlines) — phases,
  // exit gates, deliverables with cardinality/minter, and the card count the
  // approval will mint (PSD AT6, computed server-side). The S4 plan checks do
  // not exist yet, so it says "checks pending" — it never shows a pass.
  import type { ProjectPlanResponse, PlanPhaseFact, ProposedPlanView } from '$lib/types/plan';
  import PlanFactsPanel from './PlanFactsPanel.svelte';
  import ConveyorPlanView from './ConveyorPlanView.svelte';

  type Props =
    | { mode: 'live'; plan: ProjectPlanResponse; proposed?: undefined }
    | { mode: 'proposed'; proposed: ProposedPlanView; plan?: undefined };
  let props: Props = $props();
  const mode = $derived(props.mode);
  const plan = $derived(props.plan);
  const proposed = $derived(props.proposed);

  function phaseClasses(state: PlanPhaseFact['state']): string {
    switch (state) {
      case 'done':
        return 'border-[var(--color-success-border)] bg-[var(--color-success-bg)]';
      case 'active':
        return 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)]';
      default:
        return 'border-[var(--color-border)] bg-[var(--color-surface)]';
    }
  }
  const completeCount = (p: PlanPhaseFact) => p.deliverables.filter((d) => d.complete).length;
</script>

<section class="flex flex-col gap-3" data-testid="project-plan-view" data-mode={mode}>
  {#if proposed}
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
      <span class="font-semibold" data-testid="plan-proposed-template" title={proposed.template.hash}>
        Plan {proposed.template.id}
      </span>
      <span data-testid="plan-card-count">
        {#if proposed.card_count_at_commit === null}
          Cards minted on approval: not stated (the plan lists no deliverables)
        {:else}
          Approving creates {proposed.deliverable_count} deliverables and mints {proposed.card_count_at_commit}
          {proposed.card_count_at_commit === 1 ? 'card' : 'cards'} now; the rest are minted as their phases run.
        {/if}
      </span>
      {#if proposed.checks === null}
        <span class="rounded px-1.5 py-0.5 bg-[var(--color-surface-strong)] text-[var(--color-text-muted)]" data-testid="plan-checks-pending">
          Plan checks pending
        </span>
      {:else}
        <span data-testid="plan-checks">
          {proposed.checks.filter((c) => c.passed).length}/{proposed.checks.length} plan checks passed
        </span>
      {/if}
    </div>
    <ol class="flex flex-col gap-2" data-testid="plan-phases">
      {#each proposed.phases as p, i (p.phase)}
        <li class="rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-xs" data-testid="plan-phase" data-phase={p.phase}>
          <span class="text-sm font-semibold">{i + 1}. {p.label}</span>
          {#if p.gate_kinds.length > 0}
            <div class="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]" data-testid="plan-gate">
              Gate at exit: {p.gate_kinds.join(' + ')}
            </div>
          {/if}
          <ul class="mt-2 flex flex-col gap-1">
            {#each p.deliverables as d (d.plan_deliverable_id)}
              <li class="rounded border border-[var(--color-border)] px-2 py-1" data-testid="plan-deliverable">
                <span class="font-medium">{d.plan_deliverable_id}</span>
                <span class="ml-2 text-[var(--color-text-muted)]">{d.card_types.join(', ')} · {d.cardinality} · minter {d.minter}</span>
                <span class="ml-2" data-testid="plan-deliverable-at-commit">{d.cards_at_commit > 0 ? `${d.cards_at_commit} at approval` : 'minted later'}</span>
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ol>
  {:else if !plan}
    <!-- unreachable by the Props type; rendered honestly rather than as an empty plan -->
    <p class="text-sm text-[var(--color-text-muted)]">No plan data.</p>
  {:else if plan.kind === 'conveyor'}
    <ConveyorPlanView {plan} />
  {:else if plan.legacy}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="plan-legacy">
      Legacy, no plan — this project was not started from a template, so it has no computed phase plan.
    </p>
  {:else}
    <PlanFactsPanel template={plan.template} phasePlanHash={plan.phase_plan_hash} facts={plan.facts} />
    <ol class="flex flex-col gap-2" data-testid="plan-phases">
      {#each plan.phases as p (p.phase)}
        <li
          class={`rounded-[var(--radius-md)] border p-3 text-xs ${phaseClasses(p.state)}`}
          data-testid="plan-phase"
          data-phase={p.phase}
          data-state={p.state}
          aria-current={p.state === 'active' ? 'step' : undefined}
        >
          <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span class="text-sm font-semibold">{p.label}</span>
            {#if p.state === 'active'}
              <span class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-[var(--color-accent-bg)]" data-testid="plan-phase-current">current</span>
            {/if}
            <span class="text-[var(--color-text-muted)]" data-testid="plan-phase-exit">
              Exit: {completeCount(p)}/{p.deliverables.length} deliverables complete{p.gate ? `, gate ${p.gate.satisfied ? 'approved' : 'not approved'}` : ''}{p.next_phase ? '' : ' (final phase)'}
            </span>
          </div>
          {#if p.gate}
            <div
              class="mt-1 inline-block rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]"
              data-testid="plan-gate"
              data-satisfied={String(p.gate.satisfied)}
            >
              Gate at exit: {p.gate.kinds.join(' + ')} — {p.gate.satisfied ? 'approved' : 'awaiting approval'}
            </div>
          {/if}
          <ul class="mt-2 flex flex-col gap-1">
            {#each p.deliverables as d (d.plan_deliverable_id)}
              <li class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" data-testid="plan-deliverable" data-complete={String(d.complete)}>
                <span class="font-medium">{d.title ?? d.plan_deliverable_id}</span>
                <span class="ml-2 text-[var(--color-text-muted)]">{d.card_types.join(', ')} · {d.cardinality} · minter {d.minter}{d.deferred ? ' · deferred' : ''}</span>
                {#if d.deferred}
                  <span class="ml-2" data-testid="plan-deliverable-minted">{d.minted_at === null ? 'not minted yet' : `minted ${d.minted_count}`}</span>
                {/if}
                <span class="ml-2" data-testid="plan-deliverable-cards">
                  cards {d.cards.done}/{d.cards.total} done{#each Object.entries(d.cards.by_list) as [list, n] (list)}<span class="ml-1 text-[var(--color-text-muted)]">{list}: {n}</span>{/each}
                </span>
                {#if !d.complete && d.incomplete_reason}
                  <span class="ml-2 text-[var(--color-text-muted)]">({d.incomplete_reason})</span>
                {/if}
              </li>
            {/each}
          </ul>
          {#if p.state === 'active' && p.blockers.length > 0}
            <ul class="mt-2 list-disc pl-5 text-[var(--color-text-muted)]" data-testid="plan-phase-blockers">
              {#each p.blockers as b (b)}<li>{b}</li>{/each}
            </ul>
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
