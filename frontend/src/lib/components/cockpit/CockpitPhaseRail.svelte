<script lang="ts">
  // The customer mantra phase rail: Readying · Doing · Inspecting · Publishing,
  // each enriched with an in-flight count, oldest-card age, and a readiness
  // state (active / needs-you gate / clear). Driven by the read model's
  // phase_rail block — this is the board-mantra axis, distinct from the project
  // lifecycle rail.
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { PhaseColumn, CockpitCard } from '$lib/types/cockpit';
  import { deriveRailState, readinessWord, type RailColumnState } from './railState';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  interface Props {
    rail: Panel<PhaseColumn[]>;
    blockedCards: CockpitCard[];
  }
  let { rail, blockedCards }: Props = $props();

  const columns = $derived(hasData(rail) ? deriveRailState(rail.data, blockedCards) : []);

  const PHASE_LABEL: Record<string, string> = {
    // Named after the Board's columns so the two screens read the same
    // (UI review 2026-10-07: "Publishing 7 / Other 21" vs "DONE 7 / BLOCKED 21").
    READYING: 'To do / Ready',
    DOING: 'Doing',
    INSPECTING: 'QA',
    PUBLISHING: 'Done',
    BLOCKED: 'Blocked',
    OTHER: 'Other lists',
  };

  function stateClasses(state: RailColumnState): string {
    switch (state) {
      case 'active':
        return 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)]';
      case 'gate':
        return 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)]';
      default:
        return 'border-[var(--color-border)] bg-[var(--color-surface)]';
    }
  }
</script>

{#if hasData(rail)}
  <section
    class="grid grid-cols-2 gap-2 border-b border-[var(--color-border)] bg-[var(--color-bg)] p-3 md:grid-cols-4"
    aria-label="Project phase rail"
    data-testid="cockpit-phase-rail"
  >
    {#each columns as col (col.phase)}
      <div class={`rounded-lg border px-3 py-2 ${stateClasses(col.state)}`}>
        <div class="flex items-baseline justify-between gap-2">
          <span class="text-sm font-semibold text-[var(--color-text)]">
            {PHASE_LABEL[col.phase] ?? col.phase}
          </span>
          <span class="text-[11px] font-medium text-[var(--color-text-muted)]"
            >{readinessWord(col.state)}</span
          >
        </div>
        <div class="mt-1 flex items-baseline gap-2">
          <span class="text-xl font-bold text-[var(--color-text)]">{col.count}</span>
          {#if col.age_label}
            <span class="text-[11px] text-[var(--color-text-muted)]">oldest {col.age_label}</span>
          {/if}
        </div>
      </div>
    {/each}
  </section>
{:else}
  <div class="border-b border-[var(--color-border)] bg-[var(--color-bg)] p-3">
    <PanelNote panel={rail} title="Phase rail" />
  </div>
{/if}
