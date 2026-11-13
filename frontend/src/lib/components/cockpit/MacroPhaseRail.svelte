<script lang="ts">
  // The MACRO project lifecycle rail: Request → Preliminary analysis → Contract
  // → … → Feature development, with the contract node marked as the human gate.
  //
  // ⚠️ DISTINCT FROM `CockpitPhaseRail.svelte`, which sits directly below this
  // one and is the MICRO board-mantra axis (Readying · Doing · Inspecting ·
  // Publishing) derived from Planka list names. Two rails, two axes, no overlap:
  // this one is where the PROJECT is in its lifecycle, that one is where its
  // CARDS are in theirs.
  //
  // Driven entirely by the read-model's `lifecycle_rail` block — the server
  // projects the nodes and the next gate from `backend/src/lib/project-phase.ts`,
  // the same projection `GET /api/projects/:id/phase` uses. This component does
  // NOT fetch and does NOT re-derive.
  //
  // ⛔ THE UNAVAILABLE BRANCH RENDERS NO PROGRESS, AND THAT IS THE POINT OF THIS
  // FILE: a rail the server could not read emits NO node list, NO "n of 9", NO
  // percentage and NO progressbar — only the honest sentence.
  // `MacroPhaseRail.test.ts` asserts the absence of all four.
  //
  // RM OWNS THE PHASE (George 2026-10-13; n8n is its only writer). A project n8n
  // has not started reads `phase: null`: the server sends every node PENDING
  // (none done or active), and the header says "Not started" — no node is
  // highlighted, so nothing reads as progress.
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { LifecycleRail, LifecycleRailNodeState } from '$lib/types/cockpit';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  interface Props {
    rail: Panel<LifecycleRail>;
    /** Used for the plan link on a PLAN project; absent ⇒ the link has no href. */
    projectId?: string;
  }
  let { rail, projectId }: Props = $props();

  const railData = $derived(hasData(rail) ? rail.data : null);

  // 2026-10-09 (owner ruling): the "Request contract sign-off" button and its
  // backend gate-request route were REMOVED. Phase exit is
  // computed from the project's own plan (lib/plan-phase-exit.ts), so a minted
  // gate sign-off no longer advanced anything — the button did nothing. The rail
  // only SHOWS the next gate now; it offers no control for it.

  function nodeClasses(state: LifecycleRailNodeState): string {
    switch (state) {
      case 'done':
        return 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]';
      case 'active':
        return 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-text)] font-semibold';
      case 'gate':
        return 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]';
      default:
        return 'border-[var(--color-border)] bg-[var(--color-surface)] text-[var(--color-text-muted)]';
    }
  }

  function stampLabel(iso: string | null): string {
    if (!iso) return 'no stamp recorded';
    const t = Date.parse(iso);
    return Number.isFinite(t) ? new Date(t).toLocaleString() : iso;
  }
</script>

<section
  class="border-b border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3"
  data-testid="macro-phase-rail"
  aria-label="Project lifecycle"
>
  {#if !railData}
    <!-- ⛔ Nothing here may imply a position on the spine. See the header. -->
    <PanelNote panel={rail} title="Project lifecycle" />
  {:else}
    <div class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h2
        class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]"
      >
        Project lifecycle
      </h2>
      <span class="text-[11px] text-[var(--color-text-muted)]" data-testid="macro-phase-stamp">
        {#if railData.phase === null}
          Not started — no phase set yet
        {:else}
          Phase last recorded {stampLabel(railData.phase_updated_at)}
        {/if}
      </span>
      {#if railData.plan}
        <!-- fr#1482: a PLAN project's rail — the server sent only the plan's phases. -->
        <a
          href={projectId ? `/projects/${projectId}/plan` : undefined}
          class="rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-accent-bg)] text-[var(--color-text)]"
          data-testid="macro-phase-plan"
        >
          Plan {railData.plan.template_id}
        </a>
      {/if}
      {#if railData.next_gate}
        <span
          class="rounded px-1.5 py-0.5 text-[11px] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]"
          data-testid="macro-phase-next-gate"
        >
          Next human gate: {railData.plan ? `at the exit of ${railData.next_gate}` : railData.next_gate}
        </span>
      {:else}
        <span class="text-[11px] text-[var(--color-text-muted)]" data-testid="macro-phase-next-gate">
          No sign-off ahead
        </span>
      {/if}
    </div>

    <ol class="flex flex-wrap items-stretch gap-1.5" data-testid="macro-phase-nodes">
      {#each railData.nodes as n (n.phase)}
        <li
          class={`rounded-[var(--radius-md)] border px-2.5 py-1.5 text-xs ${nodeClasses(n.state)}`}
          data-testid="macro-phase-node"
          data-phase={n.phase}
          data-state={n.state}
        >
          <span>{n.label}</span>
          {#if n.isGate}
            <span class="ml-1 text-[10px] uppercase tracking-wide">gate</span>
            {#if n.gate_kinds && n.gate_kinds.length > 0}
              <span class="ml-1 text-[10px]" data-testid="macro-phase-gate-kinds">at exit: {n.gate_kinds.join(' + ')}</span>
            {/if}
          {/if}
        </li>
      {/each}
    </ol>
  {/if}
</section>
