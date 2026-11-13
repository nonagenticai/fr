<script lang="ts">
  // George 2026-10-31 — "Start again" as a real RESTART of any active project: the whole project,
  // or one phase. R349 (George 2026-11-04): the phase is the current one OR an earlier one (where
  // the member found the problem began), with an optional comment to steer that run, prefilled with
  // the comment given when that phase's start was signed off (`default_comment`). Every card in
  // the chosen scope runs again, finished ones included, and the conveyor's open questions on this
  // project, plus open requests about its cards, are withdrawn. The backend offers it (GET
  // conveyor-notices `restart`) and refuses what it does not offer; this panel shows the offer,
  // asks the member to choose, confirms, and sends it (POST conveyor-start/retry with
  // `{scope, phase?, comment?}`).
  import {
    fetchProjectConveyorNotices,
    retryProjectConveyorStart,
    type ConveyorRestartOffer,
    type ConveyorRestartScope
  } from '$lib/api/project-execution';
  import {
    RESTART_TEXT,
    phaseLabel,
    restartConfirmText,
    restartErrorText,
    restartNotOfferedText
  } from '$lib/projects/start-again';

  let { projectId }: { projectId: string } = $props();

  let restart = $state<ConveyorRestartOffer | null>(null);
  let readFailed = $state(false);
  let scope = $state<ConveyorRestartScope>('project');
  /** The phase chosen for a phase restart ('' until the offer is read: then the current phase). */
  let chosenPhase = $state('');
  let comment = $state('');
  let busy = $state(false);
  let message = $state<{ ok: boolean; text: string } | null>(null);

  async function load(id: string): Promise<void> {
    try {
      const n = await fetchProjectConveyorNotices(id, { quiet: true });
      if (id !== projectId) return;
      restart = n.restart ?? null;
      readFailed = false;
      // Keep the member's choice across a re-read while it is still offered; else the current phase.
      const names = (restart?.phases ?? []).map((p) => p.name);
      // No phase is offered any more: never leave 'phase' selected, so a submit cannot silently change scope.
      if (names.length === 0 && scope === 'phase') pickScope('project');
      if (!names.includes(chosenPhase)) pickPhase(restart?.phase && names.includes(restart.phase) ? restart.phase : (names.at(-1) ?? ''));
    } catch (e) {
      console.warn('[restart] could not read the restart offer', e);
      if (id === projectId) {
        restart = null;
        readFailed = true;
      }
    }
  }

  $effect(() => {
    const id = projectId;
    restart = null;
    message = null;
    scope = 'project';
    chosenPhase = '';
    comment = '';
    if (id) void load(id);
  });

  /** Choose a phase; for a phase restart, prefill the comment with that phase's sign-off comment. */
  function pickPhase(name: string): void {
    chosenPhase = name;
    if (scope === 'phase') comment = (restart?.phases ?? []).find((p) => p.name === name)?.default_comment ?? '';
  }

  /** Switching scope resets the comment: a phase restart starts from its sign-off comment, a project restart empty. */
  function pickScope(next: ConveyorRestartScope): void {
    scope = next;
    if (next === 'phase') pickPhase(chosenPhase);
    else comment = '';
  }

  const phases = $derived(restart?.phases ?? []);
  const phase = $derived(phases.some((p) => p.name === chosenPhase) ? chosenPhase : null);
  const phaseTitle = $derived(phases.find((p) => p.name === phase)?.title ?? null);
  const offered = $derived(restart?.available === true);
  const notOffered = $derived(restartNotOfferedText(restart));

  async function startAgain(): Promise<void> {
    if (busy || !offered) return;
    const chosen: ConveyorRestartScope = scope === 'phase' && phase ? 'phase' : 'project';
    if (!confirm(restartConfirmText(chosen, phase, phaseTitle))) return;
    const id = projectId;
    const note = comment.trim();
    busy = true;
    message = null;
    try {
      await retryProjectConveyorStart(id, {
        ...(chosen === 'phase' && phase ? { scope: 'phase' as const, phase } : { scope: 'project' as const }),
        ...(note ? { comment: note } : {})
      });
      message = { ok: true, text: RESTART_TEXT.sent };
    } catch (e) {
      message = { ok: false, text: restartErrorText(e) };
    } finally {
      busy = false;
      await load(id);
    }
  }
</script>

{#if restart || message || readFailed}
  <section
    class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4"
    data-testid="project-restart"
  >
    <h2 class="text-sm font-semibold text-[var(--color-text)]">{RESTART_TEXT.heading}</h2>
    <p class="mt-1 text-xs text-[var(--color-text-muted)]">{RESTART_TEXT.body}</p>
    {#if readFailed}
      <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid="project-restart-unreadable">
        Whether this project can be started again could not be read right now. Refresh the page to try again.
      </p>
    {:else if offered}
      <fieldset class="mt-3 space-y-1.5" disabled={busy}>
        <legend class="sr-only">What to start again</legend>
        <label class="flex items-center gap-2 text-sm text-[var(--color-text)]">
          <input
            type="radio"
            name="restart-scope"
            value="project"
            checked={scope === 'project'}
            onchange={() => pickScope('project')}
            data-testid="project-restart-scope-project"
          />
          {RESTART_TEXT.projectOption}
        </label>
        <label class="flex items-center gap-2 text-sm {phase ? 'text-[var(--color-text)]' : 'text-[var(--color-text-muted)]'}">
          <input
            type="radio"
            name="restart-scope"
            value="phase"
            checked={scope === 'phase'}
            onchange={() => pickScope('phase')}
            disabled={!phase}
            data-testid="project-restart-scope-phase"
          />
          {RESTART_TEXT.phaseOption}
        </label>
        {#if !phase}
          <p class="text-xs text-[var(--color-text-muted)]">{RESTART_TEXT.phaseUnknown}</p>
        {:else if scope === 'phase'}
          <label class="ml-6 flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
            {RESTART_TEXT.phaseSelect}
            <select
              class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)]"
              value={chosenPhase}
              onchange={(e) => pickPhase((e.currentTarget as HTMLSelectElement).value)}
              data-testid="project-restart-phase"
            >
              {#each phases as p (p.name)}
                <option value={p.name}>{p.title || phaseLabel(p.name)}{p.name === restart?.phase ? RESTART_TEXT.currentSuffix : ''}</option>
              {/each}
            </select>
          </label>
        {/if}
        <label class="mt-2 flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
          {RESTART_TEXT.commentLabel}
          <textarea
            class="rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1 text-sm text-[var(--color-text)]"
            rows="3"
            maxlength="2000"
            bind:value={comment}
            data-testid="project-restart-comment"
          ></textarea>
          {#if scope === 'phase' && phase}
            <span>{RESTART_TEXT.commentHint}</span>
          {/if}
        </label>
      </fieldset>
      <button
        type="button"
        class="mt-3 rounded-md bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-50"
        disabled={busy}
        onclick={() => void startAgain()}
        data-testid="project-restart-button"
      >
        {busy ? RESTART_TEXT.busy : RESTART_TEXT.button}
      </button>
    {:else if notOffered}
      <p class="mt-2 text-xs text-[var(--color-text-muted)]" data-testid="project-restart-not-offered">{notOffered}</p>
    {/if}
    {#if message}
      <p
        class="mt-2 text-sm {message.ok ? 'text-[var(--color-text)]' : 'text-[var(--color-danger)]'}"
        data-testid="project-restart-message"
      >
        {message.text}
      </p>
    {/if}
  </section>
{/if}
