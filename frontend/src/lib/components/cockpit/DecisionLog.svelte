<!--
  DecisionLog (C8) — every question and sign-off on the project as ONE compact row: when, what it
  was about (the gate or card, in a plain sentence), the question in one line, the answer in one
  line, and who decided (a person, the Approval agent, or a rule). Collapsed by default; opening a
  row shows the full question and answer. An open item links to the existing decide page.

  Replaces the long "Conversation with the conveyor" wall and the subject-less timeline rows.
  Standalone: renders the cockpit read model's `decisions` panel; it fetches nothing.
  `phase` (from the spine) narrows the rows to one phase.
-->
<script lang="ts">
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import { hasData, type Panel } from '$lib/types/panel';
  import type { CockpitDecision, CockpitSpine } from '$lib/types/cockpit';
  import { actorWords, decisionsInPhase, shortTime } from './spine';
  import { decideHref } from '$lib/components/conveyor-history/view';

  let {
    projectId,
    panel,
    spine = null,
    phase = null,
    open: startOpen = false,
  }: {
    projectId: string;
    panel: Panel<CockpitDecision[]>;
    spine?: CockpitSpine | null;
    phase?: string | null;
    /** Start expanded (a closed project's audit view). */
    open?: boolean;
  } = $props();

  const all = $derived(hasData(panel) ? panel.data : []);
  const rows = $derived(decisionsInPhase(all, spine, phase));
  const KIND_TONE: Record<CockpitDecision['kind'], string> = {
    question: 'text-[var(--color-info-text)]',
    signoff: 'text-[var(--color-success-text)]',
    request: 'text-[var(--color-text-muted)]',
  };
</script>

<section data-testid="decision-log">
  <details open={startOpen} class="group">
    <summary
      class="cursor-pointer list-none text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-strong)]"
      data-testid="decision-log-summary"
    >
      <span aria-hidden="true" class="mr-1 inline-block transition-transform group-open:rotate-90">›</span>
      Decisions{hasData(panel) ? ` · ${rows.length}` : ''}{phase ? ' in this phase' : ''}
    </summary>
    <div class="mt-2">
      {#if !hasData(panel)}
        <PanelNote {panel} title="The decisions" />
      {:else if rows.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="decision-log-empty">
          {phase ? 'Nothing was asked or signed off in this phase.' : 'Nothing has been asked or signed off on this project yet.'}
        </p>
      {:else}
        {#if panel.health !== 'ok'}<PanelNote {panel} title="The decisions" class="mb-1" />{/if}
        <ol class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface)]">
          {#each rows as r (r.approval_id)}
            <li data-testid="decision-row" data-approval={r.approval_id} data-open={r.open}>
              <details>
                <summary
                  class="grid cursor-pointer list-none grid-cols-[7rem_minmax(0,1fr)_8rem] items-baseline gap-x-2 px-2 py-1.5 text-xs focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-strong)]"
                >
                  <time class="text-[11px] text-[var(--color-text-muted)]" datetime={r.decided_at ?? r.asked_at ?? undefined}
                    >{shortTime(r.decided_at ?? r.asked_at)}</time
                  >
                  <span class="min-w-0">
                    <span class={`font-semibold ${KIND_TONE[r.kind]}`} data-testid="decision-subject">{r.subject}</span>
                    <span class="block truncate text-[var(--color-text)]" data-testid="decision-question">Q: {r.question}</span>
                    {#if r.answer}
                      <span class="block truncate text-[var(--color-text-muted)]" data-testid="decision-answer">A: {r.answer}</span>
                    {:else}
                      <span class="block text-[var(--color-warning-text)]" data-testid="decision-answer">Waiting for an answer</span>
                    {/if}
                  </span>
                  <span class="text-right text-[11px] text-[var(--color-text-muted)]" data-testid="decision-actor" data-kind={r.actor_kind ?? 'open'}
                    >{actorWords(r.actor_kind, r.actor_name)}</span
                  >
                </summary>
                <div class="space-y-1 border-t border-[var(--color-border)] px-2 py-2 text-xs" data-testid="decision-detail">
                  <p class="whitespace-pre-wrap break-words text-[var(--color-text)]"><span class="font-semibold">Asked{r.asked_at ? ` ${shortTime(r.asked_at)}` : ''}:</span> {r.question_full}</p>
                  {#if r.answer_full}
                    <p class="whitespace-pre-wrap break-words text-[var(--color-text)]"><span class="font-semibold">Answer:</span> {r.answer_full}</p>
                  {/if}
                  {#if r.open}
                    <a class="font-semibold text-[var(--color-accent-strong)] underline" href={decideHref(projectId, r.approval_id)} data-testid="decision-decide">Answer or decide</a>
                  {/if}
                </div>
              </details>
            </li>
          {/each}
        </ol>
      {/if}
    </div>
  </details>
</section>
