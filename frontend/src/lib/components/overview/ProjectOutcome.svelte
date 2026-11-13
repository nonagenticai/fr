<!--
  ProjectOutcome — a finished project is an OUTCOME page, not a cockpit (FR-PROJECT-HOME-REDESIGN
  §4, D6, D8): what was delivered (the final report's summary paragraph, its link, the pull
  requests), the acceptance criteria met / not met, then one sentence per phase. No asks, no
  drafts, no running indicators — the read model already dropped them.
-->
<script lang="ts">
  import type { ProjectOverview } from '$lib/types/cockpit';
  import { shortTime } from '$lib/components/cockpit/spine';
  import { displayCriteria } from '$lib/components/registers/registers';
  import { outputHref, outputMeta, progressSentence, type RegistersView } from './overview';

  let {
    projectId,
    overview,
    registers,
  }: {
    projectId: string;
    overview: ProjectOverview;
    registers: RegistersView;
  } = $props();

  const outcome = $derived(overview.outcome);
  const criteria = $derived(registers.kind === 'loaded' && registers.data.available ? registers.data.criteria : null);
  /** One row per statement: the setup flow copies success criteria verbatim into acceptance criteria (R-CK9). */
  const shown = $derived(criteria ? displayCriteria(criteria) : null);
  // Only acceptance criteria carry a check; success criteria are stated intent, not a test.
  const acceptance = $derived(shown ? shown.filter((c) => c.kind === 'acceptance') : null);
  const notScored = $derived(shown && acceptance ? shown.length - acceptance.length : 0);
  const met = $derived(acceptance ? acceptance.filter((c) => c.status === 'met').length : 0);
  /** A success criterion carries no check; an acceptance one is met / not met / not yet checked. */
  const statusWord = (c: { kind: string; status: string | null }): string =>
    c.kind === 'success' ? 'Not scored' : c.status === 'met' ? 'Met' : c.status === 'not_met' ? 'Not met' : 'Not yet met';
</script>

{#if outcome}
  <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="project-outcome" data-state={outcome.state}>
    <h2 class="mb-2 text-sm font-bold text-[var(--color-text)]">
      {outcome.state === 'cancelled' ? 'Where it stopped' : 'What was delivered'}
    </h2>
    {#if outcome.summary}
      <p class="text-sm text-[var(--color-text)]" data-testid="outcome-summary">{outcome.summary}</p>
    {:else if outcome.final_report}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="outcome-summary-missing">The final report carries no summary paragraph; open it to read what was delivered.</p>
    {:else}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="outcome-no-report">No final report was published for this project.</p>
    {/if}
    {#if outcome.final_report}
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        From the final report, published {shortTime(outcome.final_report.at)} ·
        <a class="font-semibold text-[var(--color-link)] hover:underline" href={outputHref(projectId, outcome.final_report)} data-testid="outcome-final-report">Read the final report</a>
      </p>
    {/if}
    {#if outcome.pull_requests.length > 0}
      <ul class="mt-2 space-y-0.5" data-testid="outcome-prs">
        {#each outcome.pull_requests as pr (pr.id)}
          <li class="text-xs">
            <a class="font-semibold text-[var(--color-link)] hover:underline" href={pr.url ?? undefined} target="_blank" rel="noopener noreferrer">{pr.title}</a>
            <span class="text-[var(--color-text-muted)]"> · {outputMeta(pr)}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <h3 class="mb-1 mt-4 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Criteria</h3>
    {#if registers.kind === 'reading'}
      <p class="text-xs text-[var(--color-text-muted)]">Reading the criteria…</p>
    {:else if registers.kind === 'failed'}
      <p class="text-xs text-[var(--color-warning-text)]" data-testid="outcome-criteria-failed">The criteria could not be read, so whether they were met is not known here.</p>
    {:else if !shown || shown.length === 0}
      <p class="text-xs text-[var(--color-text-muted)]" data-testid="outcome-criteria-none">No criteria were recorded for this project.</p>
    {:else}
      <p class="text-sm font-semibold text-[var(--color-text)]" data-testid="outcome-criteria-count">
        {#if acceptance && acceptance.length > 0}{met} of {acceptance.length} acceptance criteria met{:else}No acceptance criteria{/if}{#if notScored > 0}<span class="font-normal text-[var(--color-text-muted)]"> · {notScored} success criterion{notScored === 1 ? '' : 'a'} not scored</span>{/if}
      </p>
      <ul class="mt-1 space-y-1" data-testid="outcome-criteria">
        {#each shown as c, i (c.id ?? `s${i}`)}
          <li class="flex gap-2 text-xs" data-testid="outcome-criterion" data-status={c.status ?? 'none'}>
            <span class={`w-20 shrink-0 font-semibold ${c.status === 'met' ? 'text-[var(--color-success-text)]' : c.status === 'not_met' ? 'text-[var(--color-danger-text)]' : 'text-[var(--color-text-muted)]'}`}>{statusWord(c)}</span>
            <span class="min-w-0 text-[var(--color-text)]">{c.text}</span>
          </li>
        {/each}
      </ul>
    {/if}

    <h3 class="mb-1 mt-4 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Phase by phase</h3>
    <ol class="space-y-1" data-testid="outcome-phases">
      {#each overview.phases as p (p.name)}
        <li class="text-xs text-[var(--color-text)]" data-testid="outcome-phase" data-phase={p.name}><span class="font-semibold">{p.label}</span> — {progressSentence(p)}</li>
      {/each}
    </ol>
  </section>
{/if}
