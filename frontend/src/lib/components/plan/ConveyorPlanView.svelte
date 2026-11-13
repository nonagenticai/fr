<script lang="ts">
  // The CONVEYOR plan (FR-PROJECT-PAGE-CONVEYOR G1): GET /api/projects/:id/plan
  // for a project the conveyor runs (RM-linked, no template). Server facts only —
  // phases (with entered/left), each phase's cards, the selected capabilities
  // and risks. A source the server could not
  // read is shown as "Unavailable: <reason>", never as an empty list.
  import type { ConveyorPlan, ConveyorPhaseState } from '$lib/types/plan';
  import { humanizeEnum, listNameLabel } from '$lib/utils/humanizeEnum';
  import { unavailableReason, withoutRuleRefs } from '$lib/utils/planCopy';

  let { plan }: { plan: ConveyorPlan } = $props();

  function when(iso: string | null): string {
    if (!iso) return '';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }

  const STATE_LABEL: Record<ConveyorPhaseState, string> = {
    done: 'Done',
    active: 'Current',
    upcoming: 'Upcoming',
    not_run: 'Not run',
  };

  function phaseClasses(state: ConveyorPhaseState): string {
    switch (state) {
      case 'done':
        return 'border-[var(--color-success-border)] bg-[var(--color-success-bg)]';
      case 'active':
        return 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)]';
      default:
        return 'border-[var(--color-border)] bg-[var(--color-surface)]';
    }
  }

  function capabilityLabel(name: string, title: string | null): string {
    return title ?? humanizeEnum(name);
  }
</script>

<section class="flex flex-col gap-4 text-xs" data-testid="conveyor-plan">
  {#if !plan.available}
    <p class="text-sm text-[var(--color-danger-text)]" role="alert" data-testid="conveyor-plan-unavailable">
      Plan unavailable: {unavailableReason(plan.reason)}.
    </p>
  {:else}
    <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1" data-testid="conveyor-plan-header">
      {#if plan.project_type.name}
        <span class="font-semibold" data-testid="conveyor-plan-type">{humanizeEnum(plan.project_type.name)} project</span>
      {/if}
      {#if plan.closed}
        <span class="rounded px-1.5 py-0.5 bg-[var(--color-success-bg)]" data-testid="conveyor-plan-status">Closed</span>
      {:else if plan.current_phase}
        <span data-testid="conveyor-plan-status">In {humanizeEnum(plan.current_phase)}{plan.phase_updated_at ? ` since ${when(plan.phase_updated_at)}` : ''}</span>
      {:else}
        <span data-testid="conveyor-plan-status">Not started</span>
      {/if}
    </div>

    <!-- phases -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">Phases</h2>
      {#if !plan.phases.available}
        <p class="text-[var(--color-text-muted)]" data-testid="conveyor-phases-unavailable">Unavailable: {unavailableReason(plan.phases.reason)}.</p>
      {:else}
        {#if !plan.phase_history.available}
          <p class="mb-1 text-[var(--color-text-muted)]" data-testid="conveyor-phase-history-unavailable">
            Phase dates unavailable: {unavailableReason(plan.phase_history.reason)}.
          </p>
        {/if}
        {#if !plan.cards.available}
          <p class="mb-1 text-[var(--color-text-muted)]" data-testid="conveyor-cards-unavailable">
            Cards unavailable: {unavailableReason(plan.cards.reason)}.
          </p>
        {/if}
        <ol class="flex flex-col gap-2" data-testid="conveyor-phases">
          {#each plan.phases.items as p (p.name)}
            <li
              class={`rounded-[var(--radius-md)] border p-3 ${phaseClasses(p.state)}`}
              data-testid="conveyor-phase"
              data-phase={p.name}
              data-state={p.state}
              aria-current={p.state === 'active' ? 'step' : undefined}
            >
              <div class="flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span class="text-sm font-semibold">{p.position + 1}. {p.title}</span>
                <span class="rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wide bg-[var(--color-surface-strong)]" data-testid="conveyor-phase-state">{STATE_LABEL[p.state]}</span>
                {#if p.has_gate}<span class="text-[var(--color-text-muted)]">sign-off at exit</span>{/if}
                <span class="text-[var(--color-text-muted)]" data-testid="conveyor-phase-dates">
                  {#if p.entered_at}Entered {when(p.entered_at)}{#if p.left_at} · left {when(p.left_at)}{/if}{:else}Not entered{/if}
                </span>
              </div>
              {#if plan.cards.available}
                {#if p.cards.length === 0}
                  <p class="mt-2 text-[var(--color-text-muted)]" data-testid="conveyor-phase-no-cards">No cards in this phase.</p>
                {:else}
                  <ul class="mt-2 flex flex-col gap-1" data-testid="conveyor-phase-cards">
                    {#each p.cards as c (c.id)}
                      <li class="flex flex-wrap items-baseline gap-x-2 rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" data-testid="conveyor-card">
                        <span class="font-medium">{c.name}</span>
                        {#if c.card_type}<span class="text-[var(--color-text-muted)]" data-testid="conveyor-card-type">{c.card_type_title ?? humanizeEnum(c.card_type)}</span>{/if}
                        <span data-testid="conveyor-card-list">{c.list ? listNameLabel(c.list) : 'No list'}</span>
                        {#if c.last_moved_at}<span class="text-[var(--color-text-muted)]">moved {when(c.last_moved_at)}</span>{/if}
                      </li>
                    {/each}
                  </ul>
                {/if}
              {/if}
            </li>
          {/each}
        </ol>
        {#if plan.cards.available && plan.cards.unplaced.length > 0}
          <div class="mt-2" data-testid="conveyor-unplaced-cards">
            <p class="text-[var(--color-text-muted)]">Cards not tied to a phase</p>
            <ul class="mt-1 flex flex-col gap-1">
              {#each plan.cards.unplaced as c (c.id)}
                <li class="rounded border border-[var(--color-border)] px-2 py-1">
                  <span class="font-medium">{c.name}</span>
                  <span class="ml-2">{c.list ? listNameLabel(c.list) : 'No list'}</span>
                </li>
              {/each}
            </ul>
          </div>
        {/if}
      {/if}
    </div>

    <!-- capabilities -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">Capabilities</h2>
      {#if !plan.capabilities.available}
        <p class="text-[var(--color-text-muted)]" data-testid="conveyor-capabilities-unavailable">Unavailable: {unavailableReason(plan.capabilities.reason)}.</p>
      {:else if plan.capabilities.selected.length === 0}
        <p class="text-[var(--color-text-muted)]" data-testid="conveyor-capabilities-none">No capabilities selected yet.</p>
      {:else}
        <ul class="flex flex-col gap-2" data-testid="conveyor-capabilities">
          {#each plan.capabilities.selected as cap (cap.name)}
            <li class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] p-2" data-testid="conveyor-capability" data-capability={cap.name}>
              <div class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                <span class="font-semibold">{capabilityLabel(cap.name, cap.title)}</span>
                {#if cap.involvement}<span class="rounded border border-[var(--color-border)] px-1 text-[10px]">involvement {cap.involvement}</span>{/if}
                {#if cap.rigor}<span class="rounded border border-[var(--color-border)] px-1 text-[10px]">rigor {cap.rigor}</span>{/if}
                {#if cap.complexity}<span class="rounded border border-[var(--color-border)] px-1 text-[10px]">complexity {cap.complexity}</span>{/if}
                {#if cap.order_after.length > 0}
                  <span class="text-[var(--color-text-muted)]" data-testid="conveyor-capability-after">after {cap.order_after.map((n) => humanizeEnum(n)).join(', ')}</span>
                {/if}
              </div>
              {#if cap.purpose}
                <p class="mt-1" data-testid="conveyor-capability-purpose">{withoutRuleRefs(cap.purpose)}</p>
              {/if}
              {#if cap.reason}
                <details class="mt-1" data-testid="conveyor-capability-why">
                  <summary class="cursor-pointer text-[var(--color-text-muted)]">Why</summary>
                  <p class="mt-1 text-[var(--color-text-muted)]">{withoutRuleRefs(cap.reason)}</p>
                </details>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <!-- risks -->
    <div>
      <h2 class="mb-2 text-sm font-semibold">Risks</h2>
      {#if !plan.risks.available}
        <p class="text-[var(--color-text-muted)]" data-testid="conveyor-risks-unavailable">Unavailable: {unavailableReason(plan.risks.reason)}.</p>
      {:else if plan.risks.items.length === 0}
        <p class="text-[var(--color-text-muted)]" data-testid="conveyor-risks-none">No risks recorded.</p>
      {:else}
        <ul class="flex flex-col gap-1" data-testid="conveyor-risks">
          {#each plan.risks.items as r (r.id)}
            <li class="rounded border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1" data-testid="conveyor-risk">
              <span class="font-medium">{r.title}</span>
              {#if r.status}<span class="ml-2">{humanizeEnum(r.status)}</span>{/if}
              {#if r.category}<span class="ml-2 text-[var(--color-text-muted)]">{humanizeEnum(r.category)}</span>{/if}
              {#if r.probability !== null && r.impact_score !== null}
                <span class="ml-2 text-[var(--color-text-muted)]">likelihood {Math.round(r.probability * 100)}% · impact {r.impact_score}/5</span>
              {/if}
              {#if r.response_strategy}<span class="ml-2">response: {humanizeEnum(r.response_strategy)}{r.response_plan ? ` — ${withoutRuleRefs(r.response_plan)}` : ''}</span>{/if}
              {#if r.description}<p class="mt-0.5 text-[var(--color-text-muted)]">{withoutRuleRefs(r.description)}</p>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}
</section>
