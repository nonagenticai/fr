<script lang="ts">
  // C1 — the project's status header (cockpit spec C1, R-CK4), on every page of the project shell.
  // It sits above the shell's only scroller, so it stays in view while the page scrolls.
  //
  // Shows (FR-PROJECT-HOME-REDESIGN §4): the project's name and type (in words), ONE state chip
  // (Running · Waiting on you · Blocked · Paused · Completed · Cancelled — a word and an icon, never
  // colour alone), "Phase N of 4: X", when it started and how long it has run, the cost to date,
  // and "Ask about this project", which opens Copilot as the right-hand drawer (D7; closed by
  // default, on every project page). No health dots (D4): the Overview shows a problem line only
  // when something is wrong now.
  //
  // ⭐ ONE source: the cockpit read model's `project` + `status` panels. The overview page publishes
  // its full read into `projectCockpit`; on every other page this header reads `?scope=header`.
  // The state is DERIVED by the server (R-CK4); this component words it and decides nothing.
  // A failed read is "Status unknown", never a state.
  import { page } from '$app/state';
  import { untrack } from 'svelte';
  import Play from 'lucide-svelte/icons/play';
  import Hourglass from 'lucide-svelte/icons/hourglass';
  import OctagonAlert from 'lucide-svelte/icons/octagon-alert';
  import CircleCheck from 'lucide-svelte/icons/circle-check';
  import Pause from 'lucide-svelte/icons/pause';
  import Ban from 'lucide-svelte/icons/ban';
  import MessageCircle from 'lucide-svelte/icons/message-circle';
  import { agentRail } from '$lib/stores/agentRail.svelte';
  import { projectCockpit } from '$lib/stores/projectCockpit.svelte';
  import { phaseTitles } from '$lib/projects/phaseTitles.svelte';
  import { projectHalt } from '$lib/stores/projectHalt.svelte';
  import { HALT_TEXT } from '$lib/projects/project-halt';
  import { activeProject } from '$lib/stores/activeProject.svelte';
  import {
    STATE_META,
    elapsedWords,
    isFinished,
    phaseOfWords,
    startedWords,
    stateExplanation,
    type Tone,
  } from '$lib/projects/cockpit-status';
  import { spendLine } from '$lib/components/cost/cost';
  import type { CockpitState } from '$lib/types/cockpit';

  /** Header poll: slower than the overview page's 15 s, and skipped while a fresh read is here. */
  const POLL_MS = 30_000;

  const projectId = $derived(page.params?.id ?? '');
  const view = $derived(projectId ? projectCockpit.for(projectId) : null);
  const project = $derived(view?.project.data ?? null);
  const status = $derived(view?.status.data ?? null);

  let now = $state(Date.now());

  $effect(() => {
    const id = projectId;
    if (!id) return;
    void phaseTitles.ensureLoaded();
    void projectCockpit.refresh(id);
    const t = setInterval(() => {
      now = Date.now();
      void projectCockpit.refresh(id);
    }, POLL_MS);
    return () => clearInterval(t);
  });

  // The project's NAME (never the shortened id) in the switcher.
  $effect(() => {
    const id = projectId;
    const name = project?.name;
    if (!id || !name) return;
    const st = project?.status ?? null;
    const ph = project?.project_phase ?? null;
    // untrack: this WRITES the store it would otherwise read (an effect loop).
    untrack(() => {
      activeProject.note({ id, name, status: st, phase: ph });
    });
  });

  // The hold as the halt store last read it (it follows a pause and its release live, faster
  // than this header's poll). A paused, open project reads Paused at once.
  const halted = $derived(projectHalt.projectId === projectId && projectHalt.view?.engaged === true);
  const chipState = $derived<CockpitState | null>(
    halted && !isFinished(status?.state) ? 'paused' : (status?.state ?? null),
  );
  /** The live pause is the cause: the chip words it as the halt banner does. */
  const haltWorded = $derived(halted && chipState === 'paused');
  const meta = $derived(chipState ? STATE_META[chipState] : null);
  const explanation = $derived(
    haltWorded
      ? 'Work is paused on this project until it continues.'
      : status && chipState
        ? stateExplanation(status)
        : '',
  );
  const typeLabel = $derived(phaseTitles.typeLabel(status?.project_type ?? project?.project_type ?? null));
  const phaseLabel = $derived(
    status ? (phaseOfWords(status) ?? (status.phase ? phaseTitles.label(status.phase) : 'Not started')) : '',
  );
  const started = $derived(status ? startedWords(status.started_at) : null);
  const elapsed = $derived(status ? elapsedWords(status, now) : null);
  /**
   * R6 (D8): the ONE-line spend, in the same words as the Cost page's header (confirmed R0 format),
   * linking there. A budget appears only when RM holds one (R-CK3); no budget is "[budget not set]",
   * never "$0" — and when RM itself could not be read the budget is UNKNOWN ("[budget unavailable]"),
   * not "not set" (`budget_known === false`). The cost page itself carries the full picture.
   */
  const spend = $derived.by(() => {
    const c = status?.cost;
    if (!c) return null;
    const cur = c.currency || project?.currency || 'USD';
    const b = project?.budget;
    const budget = typeof b === 'number' && Number.isFinite(b) ? b : null;
    const budgetKnown = project?.budget_known !== false;
    return {
      text: spendLine(c.total, c.calls, budget, cur, budgetKnown),
      href: `/projects/${encodeURIComponent(projectId)}/cost`,
    };
  });

  function askCopilot(): void {
    agentRail.openAgentTab();
  }

  const TONE: Record<Tone, string> = {
    neutral: 'border-[var(--color-border-strong)] bg-[var(--color-surface-muted)] text-[var(--color-text)]',
    accent: 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-accent-text)]',
    success: 'border-[var(--color-success-border)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
    warning: 'border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
    danger: 'border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
  };
</script>

<header
  data-testid="project-shell-header"
  class="flex flex-wrap items-center gap-x-4 gap-y-1.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-6 py-2"
  aria-label="Project status"
>
  <div class="min-w-0 flex-1 basis-48">
    <div class="text-[10px] uppercase tracking-wider text-[var(--color-text-muted)]" data-testid="project-shell-type">
      Project{typeLabel ? ` · ${typeLabel}` : ''}
    </div>
    <div class="truncate text-base font-bold text-[var(--color-text)]" title={project?.name ?? ''} data-testid="project-shell-name">
      {project?.name ?? (projectCockpit.unreadable ? 'Project' : 'Loading project…')}
    </div>
  </div>

  {#if chipState && meta}
    <span
      class={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs font-semibold ${TONE[meta.tone]}`}
      data-testid="cockpit-state-chip"
      data-state={chipState}
      title={explanation}
      role="status"
    >
      {#if chipState === 'running'}<Play size={13} aria-hidden="true" />
      {:else if chipState === 'waiting_on_you'}<Hourglass size={13} aria-hidden="true" />
      {:else if chipState === 'blocked'}<OctagonAlert size={13} aria-hidden="true" />
      {:else if chipState === 'paused'}<Pause size={13} aria-hidden="true" />
      {:else if chipState === 'completed'}<CircleCheck size={13} aria-hidden="true" />
      {:else}<Ban size={13} aria-hidden="true" />{/if}
      {#if haltWorded}<span data-testid="project-andon-chip">{HALT_TEXT.badge}</span>{:else}{meta.word}{/if}
      <span class="sr-only">— {explanation}</span>
    </span>
  {:else if projectCockpit.unreadable && !status}
    <span class="text-xs text-[var(--color-text-muted)]" data-testid="cockpit-state-chip" data-state="unknown">
      Status unknown
    </span>
  {/if}

  {#if status}
    <dl class="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-xs text-[var(--color-text-muted)]" data-testid="cockpit-status-facts">
      <div class="flex gap-1">
        <dt class="sr-only">Phase</dt>
        <dd class="font-semibold text-[var(--color-text)]" data-testid="cockpit-phase">{phaseLabel}</dd>
      </div>
      {#if started || elapsed}
        <div class="flex gap-1">
          <dt class="sr-only">Time</dt>
          <dd data-testid="cockpit-elapsed">{[started, elapsed].filter(Boolean).join(' · ')}</dd>
        </div>
      {/if}
      {#if spend}
        <div class="flex gap-1">
          <dt class="sr-only">Cost</dt>
          <dd><a class="text-[var(--color-link)] hover:underline" data-testid="cockpit-cost" href={spend.href}>{spend.text}</a></dd>
        </div>
      {/if}
    </dl>
  {/if}

  <button
    type="button"
    class="ml-auto inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-accent-border)] bg-[var(--color-surface)] px-2.5 py-1 text-xs font-semibold text-[var(--color-accent-strong)] hover:bg-[var(--color-accent-bg)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent-strong)]"
    data-testid="ask-about-project"
    aria-expanded={agentRail.isOpen && agentRail.tab === 'agent'}
    onclick={askCopilot}
  >
    <MessageCircle size={13} aria-hidden="true" />
    Ask about this project
  </button>
</header>
