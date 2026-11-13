<script lang="ts">
  // The live system timeline — the cockpit's center of gravity. Renders the flat
  // backend timeline_events (phase transitions, inferences, typed actions, QA
  // verdicts, decisions, memory writes) with an evidence-pill footer per row.
  // The event-type filter is URL-synced (shareable / reload-safe) via the shared
  // urlState helpers. Data + polling are owned by the page; this is a pure
  // renderer of the events block it's handed.
  import { page } from '$app/state';
  import type { Panel } from '$lib/types/panel';
  import { hasData } from '$lib/types/panel';
  import type { TimelineEvent } from '$lib/types/cockpit';
  import { eventKicker, filterEvents, TIMELINE_FILTERS, type TimelineFilter } from './timeline';
  import { setSearchParams, parseEnumParam } from '$lib/nav/urlState';
  import Tabs from '$lib/asset-workspace/tabs/Tabs.svelte';
  import type { TabDef } from '$lib/asset-workspace/tabs/types';
  import EvidencePillRow from '$lib/components/evidence/EvidencePillRow.svelte';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';

  interface Props {
    events: Panel<TimelineEvent[]>;
    /** LLM calls billing attributed to the project — explains an empty timeline. */
    llmCalls?: number | null;
  }
  let { events, llmCalls = null }: Props = $props();

  const FILTER_LABELS: Record<TimelineFilter, string> = {
    all: 'All',
    phase_transition: 'Phases',
    worker_inference: 'Model calls',
    typed_action: 'Actions',
    qa_verdict: 'QA',
    decision_write: 'Decisions',
    kag_write: 'Memory',
  };
  const tabs: TabDef[] = TIMELINE_FILTERS.map((id) => ({ id, label: FILTER_LABELS[id] }));

  const activeFilter = $derived(
    parseEnumParam(page.url.searchParams, 'ev', TIMELINE_FILTERS, 'all'),
  );
  const shown = $derived(hasData(events) ? filterEvents(events.data, activeFilter) : []);

  function selectFilter(id: string): void {
    void setSearchParams(page.url, { ev: id === 'all' ? null : id });
  }

  function eventTime(at: string): string {
    const d = new Date(at);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
  }
</script>

<section
  class="flex h-full min-h-0 flex-1 flex-col rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)]"
  data-testid="live-execution-timeline"
>
  <div class="border-b border-[var(--color-border)] p-4">
    <h2 class="text-sm font-bold text-[var(--color-text)]">What happened, in order</h2>
    <p class="mt-0.5 text-xs text-[var(--color-text-muted)]">
      Observable autonomous work. Every row links to the card, asset, execution, or artifact behind it.
    </p>
    <div class="mt-3">
      <Tabs {tabs} active={activeFilter} onSelect={selectFilter} />
    </div>
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto p-4">
    {#if hasData(events)}
      {#if events.health !== 'ok'}
        <div class="mb-3" data-testid="timeline-note"><PanelNote panel={events} title="The timeline" /></div>
      {/if}
      {#if shown.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="timeline-empty">
          No events for this filter yet.
          {#if activeFilter === 'all' && llmCalls}
            <span class="mt-1 block text-xs">
              {llmCalls} LLM call{llmCalls === 1 ? ' was' : 's were'} billed to this project, but no
              workflow run is linked to it — runs appear here only when their workflow records the project.
            </span>
          {/if}
        </p>
      {:else}
        <ol class="space-y-3">
          {#each shown as event (event.id)}
            <li
              class="rounded-lg border border-[var(--color-border)] bg-[var(--color-bg)] p-3"
              data-testid="timeline-event"
            >
              <div class="flex items-baseline justify-between gap-2">
                <span
                  class="text-[11px] font-semibold uppercase tracking-wider text-[var(--color-text-muted)]"
                >
                  {eventKicker(event.type)}
                </span>
                {#if eventTime(event.at)}
                  <time datetime={event.at} class="text-[11px] text-[var(--color-text-muted)]">{eventTime(event.at)}</time>
                {/if}
              </div>
              <p class="mt-0.5 text-sm text-[var(--color-text)]">{event.title}</p>
              {#if event.pills.length > 0}
                <EvidencePillRow pills={event.pills} class="mt-2" />
              {/if}
            </li>
          {/each}
        </ol>
      {/if}
    {:else}
      <PanelNote panel={events} title="Live timeline" />
    {/if}
  </div>
</section>
