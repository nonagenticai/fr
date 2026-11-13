<!--
  PhaseDetail — one phase of the project as a mini-project (FR-PROJECT-HOME-REDESIGN §2b): its
  timing and cost, what it delivered and who signed it off (a past phase), the progress sentence,
  its board in one line plus its cards, its outputs and its decisions. Everything here is scoped by
  the read model's EXACT phase placement; this component filters nothing itself.
-->
<script lang="ts">
  import DecisionLog from '$lib/components/cockpit/DecisionLog.svelte';
  import type { CockpitDecision, CockpitSpine, OverviewPhase } from '$lib/types/cockpit';
  import type { Panel } from '$lib/types/panel';
  import { shortTime } from '$lib/components/cockpit/spine';
  import { boardLine, cardStateWord, outputHref, outputMeta, phaseCostWords, phaseTiming, progressSentence, signoffWords } from './overview';

  let {
    projectId,
    phase,
    currency = null,
    decisions,
    spine = null,
  }: {
    projectId: string;
    phase: OverviewPhase;
    currency?: string | null;
    decisions: Panel<CockpitDecision[]>;
    spine?: CockpitSpine | null;
  } = $props();

  const cost = $derived(phaseCostWords(phase, currency));
  const signed = $derived(signoffWords(phase));
  const boardHref = $derived(`/projects/${encodeURIComponent(projectId)}/board`);
</script>

<section
  class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-3"
  data-testid="phase-detail"
  data-phase={phase.name}
  aria-label={`Phase ${phase.label}`}
>
  <header class="mb-2 flex flex-wrap items-baseline gap-x-3 gap-y-1">
    <h2 class="text-sm font-bold text-[var(--color-text)]">{phase.label}</h2>
    <span class="text-xs text-[var(--color-text-muted)]" data-testid="phase-timing">{phaseTiming(phase)}</span>
    {#if cost}<span class="text-xs text-[var(--color-text-muted)]" data-testid="phase-cost">{cost}</span>{/if}
  </header>

  {#if phase.state === 'done'}
    <dl class="mb-2 grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[8rem_minmax(0,1fr)]" data-testid="phase-delivered">
      <dt class="text-[var(--color-text-muted)]">Delivered</dt>
      <dd class="text-[var(--color-text)]">
        {#if phase.delivered.length > 0}
          {phase.delivered.map((d) => d.title).join('; ')}
        {:else}
          Nothing published was recorded for this phase.
        {/if}
      </dd>
      <dt class="text-[var(--color-text-muted)]">Signed off by</dt>
      <dd class="text-[var(--color-text)]" data-testid="phase-signed-by">{signed ?? 'No sign-off was recorded on this phase’s cards.'}</dd>
    </dl>
  {/if}

  <p class="mb-2 text-sm text-[var(--color-text)]" data-testid="phase-progress">{progressSentence(phase)}</p>

  <div class="grid gap-3 lg:grid-cols-2">
    <div class="min-w-0">
      <div class="mb-1 flex items-baseline gap-2">
        <h3 class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">This phase’s board</h3>
        <a class="ml-auto text-xs text-[var(--color-link)] hover:underline" href={boardHref}>Open board</a>
      </div>
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="phase-board-line">{boardLine(phase.cards.by_state)}</p>
      {#if phase.cards.items.length > 0}
        <ul class="mt-1 space-y-0.5" data-testid="phase-cards">
          {#each phase.cards.items as c (c.id)}
            <li class="flex gap-2 text-xs" data-testid="phase-card" data-state={c.state}>
              <span class={`w-16 shrink-0 ${c.state === 'blocked' ? 'font-semibold text-[var(--color-danger-text)]' : 'text-[var(--color-text-muted)]'}`}>{cardStateWord(c.state)}</span>
              <span class="min-w-0 truncate text-[var(--color-text)]" title={c.name}>{c.name}</span>
            </li>
          {/each}
        </ul>
      {/if}

      <h3 class="mb-1 mt-3 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Outputs</h3>
      {#if phase.outputs.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="phase-outputs-none">None yet.</p>
      {:else}
        <ul class="space-y-1" data-testid="phase-outputs">
          {#each phase.outputs as o (o.id)}
            <li class="text-xs" data-testid="phase-output" data-kind={o.kind}>
              <a class="font-semibold text-[var(--color-link)] hover:underline" href={outputHref(projectId, o)} target={o.url ? '_blank' : undefined} rel={o.url ? 'noopener noreferrer' : undefined}>{o.title}</a>
              <span class="block text-[var(--color-text-muted)]">{outputMeta(o)}</span>
              {#if o.summary}<span class="block text-[var(--color-text)]">{o.summary}</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
    <div class="min-w-0">
      <DecisionLog {projectId} panel={decisions} {spine} phase={phase.name} open />
      {#if phase.signoff?.subject}
        <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">Gate: {phase.signoff.subject}{phase.signoff.at ? `, ${shortTime(phase.signoff.at)}` : ''}</p>
      {/if}
    </div>
  </div>
</section>
