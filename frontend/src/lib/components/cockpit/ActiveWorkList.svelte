<script lang="ts">
  // Active work — the cards currently moving (DOING/INSPECTING), grouped by card
  // (the backend already groups by card, not by raw n8n run). Each row opens the
  // evidence drawer. We render only what CockpitCard actually carries — name,
  // phase, labels, age — and never fabricate card_type / correlation.
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { CockpitCard, PhaseColumn } from '$lib/types/cockpit';
  import { formatAge } from './railState';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import Tag from '$lib/components/ui/Tag.svelte';

  interface Props {
    cards: Panel<CockpitCard[]>;
    onOpenEvidence: (card: CockpitCard) => void;
    /** The phase rail, so an empty list can say where the cards ARE. */
    rail?: PhaseColumn[] | null;
  }
  let { cards, onOpenEvidence, rail = null }: Props = $props();

  // "No cards moving" next to a Board with 29 cards read as a contradiction
  // (UI review 2026-10-07). This list is DOING/QA only; say where the rest are.
  const elsewhere = $derived(
    (rail ?? [])
      .filter((c) => c.count > 0 && c.phase !== 'DOING' && c.phase !== 'INSPECTING')
      .map((c) => `${c.count} ${WHERE[c.phase] ?? c.phase.toLowerCase()}`),
  );
  const WHERE: Record<string, string> = {
    READYING: 'to do / ready',
    PUBLISHING: 'done',
    BLOCKED: 'blocked',
    OTHER: 'in other lists',
  };
</script>

{#if hasData(cards)}
  {#if cards.data.length === 0}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="active-work-empty">
      Nothing in Doing or QA right now{elsewhere.length > 0 ? ` — ${elsewhere.join(', ')}` : ''}.
    </p>
  {:else}
    <ul class="space-y-2" data-testid="active-work-list">
      {#each cards.data as card (card.id)}
        <li class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
          <div class="text-sm font-semibold text-[var(--color-text)]">{card.name}</div>
          <div class="mt-1 flex flex-wrap items-center gap-1.5">
            <Tag tone="accent">{card.phase.toLowerCase()}</Tag>
            {#each card.labels as label (label)}
              <Tag tone="neutral">{label}</Tag>
            {/each}
            {#if formatAge(card.age_in_phase_ms)}
              <span class="text-[11px] text-[var(--color-text-muted)]"
                >in phase {formatAge(card.age_in_phase_ms)}</span
              >
            {/if}
          </div>
          <button
            type="button"
            onclick={() => onOpenEvidence(card)}
            class="mt-2 text-xs font-semibold text-[var(--color-accent-strong)] hover:underline"
            data-testid="active-work-evidence"
          >
            Open evidence →
          </button>
        </li>
      {/each}
    </ul>
  {/if}
{:else}
  <PanelNote panel={cards} title="Active work" />
{/if}
