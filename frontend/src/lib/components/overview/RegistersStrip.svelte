<!--
  RegistersStrip — "Registers at a glance" (FR-PROJECT-HOME-REDESIGN §7.3): open risks (count and
  the top 3 by score with owner), the last 3 decisions (what, by whom, when) and acceptance
  criteria met x/y (success criteria carry no check, so they are counted apart, never as unmet).
  Renders the page's one read of GET /api/projects/:id/registers (RM's registers, proxied by fr). Until the conveyor writes
  RM `decisions`, the decisions come from the decision log (§7.5) and say so.
  Four states, never collapsed: reading, could not be read, not run by the conveyor, listed.
-->
<script lang="ts">
  import type { CockpitDecision } from '$lib/types/cockpit';
  import { shortTime } from '$lib/components/cockpit/spine';
  import { registersGlance, scoreWords, type RegistersView } from './overview';

  let {
    view,
    decisions = [],
  }: {
    /** The page's one registers read (GET /api/projects/:id/registers). */
    view: RegistersView;
    /** The C8 decision log (the fallback for the decisions until RM's register has rows). */
    decisions?: readonly CockpitDecision[];
  } = $props();

  const glance = $derived(view.kind === 'loaded' && view.data.available ? registersGlance(view.data, decisions) : null);
</script>

<section data-testid="registers-glance" aria-label="Registers at a glance">
  <h3 class="mb-2 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Registers at a glance</h3>
  {#if view.kind === 'reading'}
    <p class="text-xs text-[var(--color-text-muted)]">Reading the registers…</p>
  {:else if view.kind === 'failed'}
    <p class="text-xs text-[var(--color-warning-text)]" data-testid="registers-failed">
      The registers could not be read, so nothing is known about risks or criteria right now.
    </p>
  {:else if !glance}
    <p class="text-xs text-[var(--color-text-muted)]" data-testid="registers-none">This project keeps no registers.</p>
  {:else}
    <div class="grid gap-3 md:grid-cols-3">
      <div class="min-w-0" data-testid="registers-risks">
        <p class="text-sm text-[var(--color-text)]"><span class="text-lg font-bold">{glance.risksOpen}</span> open risk{glance.risksOpen === 1 ? '' : 's'}{glance.topRisks.length > 0 ? ' · top 3' : ''}</p>
        <ul class="mt-1 space-y-0.5">
          {#each glance.topRisks as r (r.id)}
            <li class="flex gap-2 text-xs" data-testid="registers-risk">
              <span class="w-8 shrink-0 text-right font-semibold tabular-nums text-[var(--color-text)]" title="Score: probability × impact">{scoreWords(r.score)}</span>
              <span class="min-w-0 truncate text-[var(--color-text)]" title={r.response_plan ?? r.title}>{r.title}{r.owner ? ` · ${r.owner}` : ''}</span>
            </li>
          {/each}
        </ul>
      </div>
      <div class="min-w-0" data-testid="registers-criteria">
        {#if glance.criteriaTotal > 0}
          <p class="text-sm text-[var(--color-text)]">
            <span class="text-lg font-bold">{glance.criteriaMet} of {glance.criteriaTotal}</span> acceptance criteria met{#if glance.criteriaNotScored > 0}<span class="text-[var(--color-text-muted)]"> · {glance.criteriaNotScored} success criterion{glance.criteriaNotScored === 1 ? '' : 'a'} not scored</span>{/if}
          </p>
        {:else if glance.criteriaNotScored > 0}
          <p class="text-sm text-[var(--color-text)]"><span class="text-lg font-bold">{glance.criteriaNotScored}</span> success criterion{glance.criteriaNotScored === 1 ? '' : 'a'} <span class="text-[var(--color-text-muted)]">· not scored</span></p>
        {:else}
          <p class="text-sm text-[var(--color-text-muted)]">No criteria yet</p>
        {/if}
        {#if glance.requirements > 0}<p class="text-xs text-[var(--color-text-muted)]">{glance.requirements} requirement{glance.requirements === 1 ? '' : 's'}</p>{/if}
      </div>
      <div class="min-w-0" data-testid="registers-decisions" data-source={glance.decisionsSource}>
        <p class="text-sm text-[var(--color-text)]"><span class="text-lg font-bold">{glance.decisionsTotal}</span> decision{glance.decisionsTotal === 1 ? '' : 's'}{glance.decisions.length > 0 ? ' · last 3' : ''}</p>
        <ul class="mt-1 space-y-0.5">
          {#each glance.decisions as d (d.id)}
            <li class="flex gap-2 text-xs" data-testid="registers-decision">
              <span class="w-24 shrink-0 text-[var(--color-text-muted)]">{shortTime(d.at)}</span>
              <span class="min-w-0 truncate text-[var(--color-text)]" title={d.text}>{d.text}{d.by ? ` · ${d.by}` : ''}</span>
            </li>
          {/each}
        </ul>
      </div>
    </div>
  {/if}
</section>
