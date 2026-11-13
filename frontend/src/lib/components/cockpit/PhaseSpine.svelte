<!--
  PhaseSpine (C3) — each phase of the project as one segment of a track, its width proportional
  to the time spent in it (RM phase events). Between segments a diamond marks the gate: who
  signed it and when. Inside each segment, one dot per card in that phase (state in the dot's
  shape AND its text, never colour alone) and a thin bar splitting machine time from time waiting
  on people (R-CK1: an Approval-agent decision is machine time).

  Clicking a phase selects it (`onSelectPhase`): the page filters the board and the flow monitor
  with `cardIdsInPhase` (./spine.ts). Clicking it again clears the filter. Every segment is a
  button (Tab, Enter/Space; ←/→ move between phases). "Show as table" gives the same facts as rows.

  Standalone: renders the cockpit read model's `spine` panel; it fetches nothing.
-->
<script lang="ts">
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import { hasData, type Panel } from '$lib/types/panel';
  import type { CockpitSpine, SpineCardState, SpineGate } from '$lib/types/cockpit';
  import { durationWords } from '$lib/projects/cockpit-status';
  import {
    actorWords,
    CARD_STATE_WORDS,
    PHASE_STATE_WORDS,
    phaseTimeWords,
    segmentWidths,
    shortTime,
    waitSplit,
  } from './spine';

  let {
    panel,
    selectedPhase = null,
    onSelectPhase = undefined,
  }: {
    panel: Panel<CockpitSpine>;
    selectedPhase?: string | null;
    onSelectPhase?: (phase: string | null) => void;
  } = $props();

  let asTable = $state(false);

  const spine = $derived(hasData(panel) ? panel.data : null);
  const widths = $derived(spine ? segmentWidths(spine.phases) : []);
  const gateOf = $derived(new Map((spine?.gates ?? []).map((g) => [g.phase, g] as const)));
  const cardsOf = $derived.by(() => {
    const m = new Map<string, CockpitSpine['cards']>();
    for (const c of spine?.cards ?? []) {
      if (!c.phase) continue;
      const arr = m.get(c.phase) ?? [];
      arr.push(c);
      m.set(c.phase, arr);
    }
    return m;
  });
  const unplaced = $derived((spine?.cards ?? []).filter((c) => !c.phase));

  function select(name: string): void {
    onSelectPhase?.(selectedPhase === name ? null : name);
  }

  let buttons: HTMLButtonElement[] = $state([]);
  function onKey(e: KeyboardEvent, i: number): void {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    e.preventDefault();
    const n = buttons.length;
    if (n === 0) return;
    buttons[(i + (e.key === 'ArrowRight' ? 1 : n - 1)) % n]?.focus();
  }

  function gateWords(g: SpineGate): string {
    if (g.state === 'waiting') return 'Gate: waiting for a sign-off';
    if (g.state === 'ahead') return 'Gate ahead: not reached yet';
    if (!g.signed_by_kind) return `Gate passed ${shortTime(g.at)}; no sign-off was recorded`;
    return `Gate signed by ${actorWords(g.signed_by_kind, g.signed_by_name)} ${shortTime(g.signed_at)}`;
  }

  const DOT: Record<SpineCardState, string> = {
    todo: 'border border-[var(--color-text-muted)] bg-transparent',
    doing: 'bg-[var(--color-accent)]',
    qa: 'bg-[var(--color-info)]',
    done: 'bg-[var(--color-success)]',
    blocked: 'bg-[var(--color-danger)] rotate-45 rounded-none',
  };
  function segClasses(state: string, selected: boolean): string {
    const base =
      state === 'done'
        ? 'border-[var(--color-success-border)] bg-[var(--color-success-bg)]'
        : state === 'active'
          ? 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)]'
          : 'border-dashed border-[var(--color-border)] bg-[var(--color-surface)]';
    return `${base} ${selected ? 'ring-2 ring-[var(--color-accent-strong)]' : ''}`;
  }
</script>

<section data-testid="phase-spine" aria-label="Phases of this project">
  <div class="mb-2 flex items-baseline gap-3">
    <h3 class="text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Phases</h3>
    {#if spine}
      <span class="text-[11px] text-[var(--color-text-muted)]" data-testid="phase-spine-totals">
        {durationWords(spine.totals.duration_ms)} in all · waiting on people {durationWords(spine.totals.human_wait_ms)}
      </span>
      <button
        type="button"
        class="ml-auto text-[11px] text-[var(--color-accent-strong)] underline"
        aria-pressed={asTable}
        data-testid="phase-spine-table-toggle"
        onclick={() => (asTable = !asTable)}>{asTable ? 'Show as chart' : 'Show as table'}</button
      >
    {/if}
  </div>

  {#if !spine}
    <PanelNote {panel} title="The phases" />
  {:else if spine.phases.length === 0}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="phase-spine-empty">This project has no phases yet.</p>
  {:else}
    {#if panel.health !== 'ok'}<PanelNote {panel} title="The phases" class="mb-1" />{/if}
    {#if asTable}
      <div class="overflow-x-auto">
      <table class="w-full min-w-[36rem] text-left text-xs" data-testid="phase-spine-table">
        <thead class="text-[11px] text-[var(--color-text-muted)]">
          <tr>
            <th scope="col" class="py-1 pr-2">Phase</th>
            <th scope="col" class="py-1 pr-2">State</th>
            <th scope="col" class="py-1 pr-2">Time spent</th>
            <th scope="col" class="py-1 pr-2">Machine</th>
            <th scope="col" class="py-1 pr-2">Waiting on people</th>
            <th scope="col" class="py-1 pr-2">Cards</th>
            <th scope="col" class="py-1">Gate</th>
          </tr>
        </thead>
        <tbody>
          {#each spine.phases as p (p.name)}
            {@const g = gateOf.get(p.name)}
            <tr class="border-t border-[var(--color-border)]" data-testid="phase-spine-row" data-phase={p.name}>
              <th scope="row" class="py-1 pr-2 font-medium">{p.label}</th>
              <td class="py-1 pr-2">{PHASE_STATE_WORDS[p.state]}</td>
              <td class="py-1 pr-2">{phaseTimeWords(p)}</td>
              <td class="py-1 pr-2">{p.duration_ms === null ? '—' : durationWords(p.machine_ms)}</td>
              <td class="py-1 pr-2">{p.duration_ms === null ? '—' : durationWords(p.human_wait_ms)}</td>
              <td class="py-1 pr-2">{p.card_ids.length}</td>
              <td class="py-1">{g ? gateWords(g) : p.has_gate ? 'Gate ahead: not reached yet' : 'No gate'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
      </div>
    {:else}
      <ol class="flex w-full items-stretch" data-testid="phase-spine-track">
        {#each spine.phases as p, i (p.name)}
          {@const g = gateOf.get(p.name)}
          {@const split = waitSplit(p)}
          {@const cards = cardsOf.get(p.name) ?? []}
          <li class="relative flex min-w-0 items-stretch" style={`width:${widths[i]}%`}>
            <button
              type="button"
              bind:this={buttons[i]}
              class={`flex min-w-0 flex-1 flex-col gap-1 rounded-[var(--radius-md)] border p-2 text-left text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-strong)] ${segClasses(p.state, selectedPhase === p.name)}`}
              aria-pressed={selectedPhase === p.name}
              aria-label={`${p.label}: ${PHASE_STATE_WORDS[p.state]}, ${phaseTimeWords(p)}, ${cards.length} card${cards.length === 1 ? '' : 's'}. ${selectedPhase === p.name ? 'Showing only this phase; press to show all.' : 'Press to show only this phase.'}`}
              data-testid="phase-spine-segment"
              data-phase={p.name}
              data-state={p.state}
              onclick={() => select(p.name)}
              onkeydown={(e) => onKey(e, i)}
            >
              <span class="truncate font-semibold text-[var(--color-text)]">{p.label}</span>
              <span class="truncate text-[11px] text-[var(--color-text-muted)]">{phaseTimeWords(p)}</span>
              {#if cards.length > 0}
                <span class="flex flex-wrap gap-1" aria-hidden="true" data-testid="phase-spine-dots">
                  {#each cards as c (c.id)}
                    <span class={`inline-block h-2 w-2 rounded-full ${DOT[c.state]}`} title={`${c.name}: ${CARD_STATE_WORDS[c.state]}`} data-testid="phase-spine-dot" data-state={c.state}></span>
                  {/each}
                </span>
              {/if}
              {#if p.duration_ms}
                <span
                  class="flex h-1 w-full overflow-hidden rounded-full bg-[var(--color-surface-strong)]"
                  aria-hidden="true"
                  title={`Machine ${durationWords(p.machine_ms)} · waiting on people ${durationWords(p.human_wait_ms)}`}
                  data-testid="phase-spine-wait-bar"
                >
                  <span class="h-full bg-[var(--color-text-muted)]" style={`width:${split.machine}%`}></span>
                  <span class="h-full bg-[var(--color-warning)]" style={`width:${split.people}%`} data-testid="phase-spine-people"></span>
                </span>
              {/if}
            </button>
            {#if g || p.has_gate}
              <span
                class={`z-10 mx-[-6px] mt-3 inline-block h-3 w-3 shrink-0 rotate-45 border ${g?.state === 'passed' ? 'border-[var(--color-success-border)] bg-[var(--color-success)]' : g?.state === 'waiting' ? 'border-[var(--color-warning-border)] bg-[var(--color-warning)]' : 'border-[var(--color-border-strong)] bg-[var(--color-surface)]'}`}
                role="img"
                aria-label={g ? gateWords(g) : 'Gate ahead: not reached yet'}
                title={g ? `${gateWords(g)}${g.subject ? ` — ${g.subject}` : ''}` : 'Gate ahead: not reached yet'}
                data-testid="phase-spine-gate"
                data-gate-state={g?.state ?? 'ahead'}
              ></span>
            {/if}
          </li>
        {/each}
      </ol>
      <p class="mt-1 text-[11px] text-[var(--color-text-muted)]">
        Grey bar: machine time · amber: waiting on people. Dots: one per card (hollow to do, filled done, diamond blocked).
      </p>
    {/if}
    {#if unplaced.length > 0}
      <p class="mt-1 text-[11px] text-[var(--color-text-muted)]" data-testid="phase-spine-unplaced">
        {unplaced.length} card{unplaced.length === 1 ? ' is' : 's are'} not tied to a phase.
      </p>
    {/if}
  {/if}
</section>
