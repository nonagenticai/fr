<script lang="ts">
  // The project objective card — name + goal-coverage % + open-gate count. Two
  // blocks feed it (project identity, goal coverage); each degrades on its own.
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { ProjectSummary, CockpitGoal } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  interface Props {
    project: Panel<ProjectSummary>;
    goal: Panel<CockpitGoal>;
  }
  let { project, goal }: Props = $props();
</script>

<div
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
  data-testid="objective-card"
>
  {#if hasData(project)}
    <h1 class="text-lg font-bold text-[var(--color-text)]">{project.data.name}</h1>
  {:else}
    <PanelNote panel={project} title="Objective" />
  {/if}

  {#if hasData(goal)}
    <div class="mt-3 grid grid-cols-2 gap-3">
      <div class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <!-- Named for what it measures: DONE cards ÷ all cards. It used to say
             "Goal coverage" while the Goal-integrity page (correctly) says no
             goal roll-up is measured — UI review 2026-10-07. -->
        <div
          class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
          title="Cards in Done as a share of all cards on the board. Not a goal roll-up."
        >
          Cards done
        </div>
        <!-- ⛔ null is NOT 0. `coverage_pct` is derived from the phase rail, and a
             rail that could not be read yields null — rendering that as "0%" would
             state a measured floor over an unknown, which is the defect this whole
             block was fixed for. `open_gates` beside it comes from the APPROVALS
             read, a different source, so it stays a real number even here: the two
             tiles can legitimately disagree about whether they know something. -->
        <div class="mt-0.5 text-xl font-bold text-[var(--color-text)]">
          {#if goal.data.coverage_pct === null}
            <span class="text-[var(--color-text-muted)]" data-testid="coverage-unknown"
              >— <span class="text-xs font-normal">not readable</span></span
            >
          {:else}
            {goal.data.coverage_pct}%
          {/if}
        </div>
      </div>
      <div class="rounded border border-[var(--color-border)] bg-[var(--color-bg)] px-3 py-2">
        <div class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
          Open gates
        </div>
        <div class="mt-0.5 text-xl font-bold text-[var(--color-text)]">{goal.data.open_gates}</div>
      </div>
    </div>
  {:else}
    <div class="mt-3">
      <PanelNote panel={goal} title="Goal coverage" />
    </div>
  {/if}
</div>
