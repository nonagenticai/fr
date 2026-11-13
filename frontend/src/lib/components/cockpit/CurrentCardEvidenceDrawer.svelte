<script lang="ts">
  // Evidence drawer for a selected card — customer-safe by construction: it
  // shows the card's identity, status, and its own timeline activity, but NEVER
  // worker/model names, policy hashes, or raw correlation ids (those are the
  // super-admin surfaces, not the customer cockpit).
  import InspectorDrawer from '$lib/components/inspector/InspectorDrawer.svelte';
  import KvBlock, { type KvRow } from '$lib/components/inspector/KvBlock.svelte';
  import EvidencePillRow from '$lib/components/evidence/EvidencePillRow.svelte';
  import { eventKicker } from './timeline';
  import { formatAge } from './railState';
  import type { CockpitCard, TimelineEvent } from '$lib/types/cockpit';

  interface Props {
    // Nullable on purpose: the cockpit clears the selection (inspector.close(),
    // route teardown) and Svelte 5 can re-run these deriveds/template
    // expressions with the cleared value before the parent `{#if}` removes the
    // drawer. Every read below is null-safe; with a card present the output is
    // unchanged.
    card: CockpitCard | null | undefined;
    events: TimelineEvent[];
    onclose?: () => void;
  }
  let { card, events, onclose }: Props = $props();

  const rows = $derived<KvRow[]>(
    card
      ? [
          { label: 'Phase', value: (card.phase ?? '').toLowerCase() },
          { label: 'List', value: card.list_name ?? '—' },
          { label: 'Status', value: card.blocked ? (card.blocked_reason ?? 'blocked') : 'in progress' },
          (card.labels ?? []).length > 0 ? { label: 'Labels', value: (card.labels ?? []).join(', ') } : null,
          formatAge(card.age_in_phase_ms)
            ? { label: 'Time in phase', value: formatAge(card.age_in_phase_ms) as string }
            : null,
        ].filter((r): r is KvRow => r !== null)
      : [],
  );

  // Only this card's own activity (phase transitions, decisions carry card_id).
  const cardId = $derived(card?.id ?? null);
  const cardEvents = $derived(cardId === null ? [] : (events ?? []).filter((e) => e.card_id === cardId));
  const status = $derived(card?.blocked ? (card.blocked_reason ?? 'blocked') : 'in progress');
</script>

<InspectorDrawer
  tag="Card"
  title={card?.name ?? ''}
  subtitle={status}
  {onclose}
>
  <section>
    <h4 class="mb-2 text-sm font-semibold text-[var(--color-text)]">Details</h4>
    <KvBlock {rows} />
  </section>

  <section>
    <h4 class="mb-2 text-sm font-semibold text-[var(--color-text)]">Activity</h4>
    {#if cardEvents.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">No recorded activity for this card yet.</p>
    {:else}
      <ol class="space-y-2">
        {#each cardEvents as event (event.id)}
          <li class="rounded border border-[var(--color-border)] p-2">
            <div class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]">
              {eventKicker(event.type)}
            </div>
            <p class="mt-0.5 text-sm text-[var(--color-text)]">{event.title}</p>
            {#if event.pills.length > 0}
              <EvidencePillRow pills={event.pills} class="mt-1.5" />
            {/if}
          </li>
        {/each}
      </ol>
    {/if}
  </section>
</InspectorDrawer>
