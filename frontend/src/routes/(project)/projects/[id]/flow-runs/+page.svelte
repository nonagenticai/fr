<!--
  /projects/[id]/flow-runs — every run of this project's flows in ONE list (R5, cockpit C5;
  FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 Details: "Execution hub + Project executions → one Flow runs").
  The two old pages 308 here.

  One row per n8n execution: status, flow, card, start, duration and n8n's own status. While the
  project runs, failed runs come first; once it is finished the list is newest first. A failure's
  step and error class show on the row, the raw message only behind "Details".

  Sources, each read on its own (one failing never hides another, and says so):
    GET /api/projects/:id/flow-runs           n8n's execution hook (conveyor_flow_runs; the main source)
    GET /api/projects/:id/executions          the runs members started from fr (with who started them)
    GET /api/tools/n8n/executions?projectId=  the same runs' workflow ids
    GET /api/projects/:id/cockpit             the project's state (running or finished) and its card names
  Below the list, kept from the Execution hub: the conveyor's failure notices with the start retry
  (POST /api/projects/:id/conveyor-start/retry, only when a member clicks it) and the agent's activity.
  The hub's blocked cards and WIP now live on the Board; its phase rail on the Overview.
-->
<script lang="ts">
  import { page } from '$app/state';
  import { onInvalidate } from '$lib/agent/invalidation';
  import { askAgentAbout } from '$lib/agent/ask';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import { fetchProjectFlowRuns, type FlowRunsPayload } from '$lib/api/flow-runs';
  import { listExecutions, type ScopedExecution } from '$lib/api/n8n';
  import { fetchProjectCockpit } from '$lib/api/cockpit';
  import { hasData } from '$lib/types/panel';
  import {
    fetchProjectAgentActions,
    fetchProjectConveyorNotices,
    fetchProjectRuns,
    retryProjectConveyorStart,
    CONVEYOR_NOTICE_TEXT,
    conveyorRetryText,
    type ProjectAgentActions,
    type ProjectConveyorNotices,
    type ProjectRuns,
  } from '$lib/api/project-execution';
  import { isFinished } from '$lib/projects/cockpit-status';
  import { shortTime } from '$lib/components/cockpit/spine';
  import {
    isFailedRun,
    mergeFlowRuns,
    runDurationWords,
    runStatusWords,
    sortFlowRuns,
    FLOW_RUNS_SHOWN_CAP,
    type MemberRunIn,
  } from '$lib/components/board/board';

  const projectId = $derived(page.params.id ?? '');

  type Read<T> = { state: 'loading' } | { state: 'ready'; data: T } | { state: 'error'; message: string };
  const loading = { state: 'loading' } as const;

  let hook = $state<Read<FlowRunsPayload>>(loading);
  let member = $state<Read<ProjectRuns>>(loading);
  let scoped = $state<Read<ScopedExecution[]>>(loading);
  let finished = $state<boolean | null>(null);
  let projectName = $state<string | null>(null);
  let cardNames = $state<Map<string, string>>(new Map());
  /** The cockpit read failed: the project's state and card names are unknown (said so on the page). */
  let cockpitUnreadable = $state(false);
  let notices = $state<Read<ProjectConveyorNotices>>(loading);
  let actions = $state<Read<ProjectAgentActions>>(loading);
  let retrying = $state(false);
  let retryMessage = $state<{ ok: boolean; text: string } | null>(null);
  let onlyFailures = $state(false);

  async function settle<T>(p: Promise<T>, set: (v: Read<T>) => void, what: string): Promise<void> {
    try {
      set({ state: 'ready', data: await p });
    } catch (e) {
      console.error(`[projects/flow-runs] ${what} read failed`, e);
      set({ state: 'error', message: e instanceof Error ? e.message : 'read failed' });
    }
  }

  async function loadHeader(id: string): Promise<void> {
    try {
      // PROJECT-READ-WAIVER: primary-load — the project's state and its board's card names come from the
      // cockpit read model, which loadProject does not carry. A failed read is said on the page (the
      // order line) and cards show as "Open the card"; the run list itself does not depend on it.
      const c = await fetchProjectCockpit(id);
      if (id !== projectId) return;
      finished = c.status.data ? isFinished(c.status.data.state) : null;
      projectName = c.project.data?.name ?? null;
      const names = new Map<string, string>();
      for (const k of c.board && hasData(c.board) ? c.board.data.cards : []) names.set(k.id, k.name);
      for (const k of c.spine && hasData(c.spine) ? c.spine.data.cards : []) if (!names.has(k.id)) names.set(k.id, k.name);
      cardNames = names;
      cockpitUnreadable = false;
    } catch (e) {
      // Without the state the list puts failures first (the running order): said on the page.
      console.error('[projects/flow-runs] project state read failed', e);
      if (id === projectId) {
        finished = null;
        cockpitUnreadable = true;
      }
    }
  }

  function loadAll(id: string): void {
    hook = member = scoped = notices = actions = loading;
    void settle(fetchProjectFlowRuns(id), (v) => (hook = v), 'flow runs');
    void settle(fetchProjectRuns(id), (v) => (member = v), 'member runs');
    void settle(
      listExecutions({ projectId: id, limit: 100 }).then((r) => r.data),
      (v) => (scoped = v),
      'executions',
    );
    void settle(fetchProjectConveyorNotices(id), (v) => (notices = v), 'conveyor notices');
    void settle(fetchProjectAgentActions(id), (v) => (actions = v), 'agent activity');
    void loadHeader(id);
  }

  $effect(() => {
    if (projectId) loadAll(projectId);
  });
  $effect(() => {
    const id = projectId;
    if (!id) return;
    return onInvalidate([`board:${id}`, `project:${id}`], () => loadAll(id));
  });
  $effect(() => {
    setPageTitle(page.url.pathname, projectName);
  });

  const memberRuns = $derived.by((): MemberRunIn[] => {
    if (member.state !== 'ready') return [];
    const wf = new Map(scoped.state === 'ready' ? scoped.data.map((s) => [s.id, s.workflow_id ?? null] as const) : []);
    const own = member.data.runs;
    const extra = scoped.state === 'ready' ? scoped.data.filter((s) => !own.some((r) => r.id === s.id)) : [];
    return [
      ...own.map((r) => ({
        id: r.id,
        status: r.status,
        workflow_id: wf.get(r.id) ?? null,
        started_at: r.started_at ?? null,
        stopped_at: r.stopped_at ?? null,
        duration_ms: r.duration_ms ?? null,
        triggered_at: r.triggered_at,
        started_by: r.initiated_by_me ? 'you' : (r.initiated_by ?? 'a member'),
      })),
      ...extra.map((s) => ({
        id: s.id,
        status: s.status ?? null,
        workflow_id: s.workflow_id ?? null,
        started_at: s.started_at ?? null,
        stopped_at: s.stopped_at ?? null,
        duration_ms: s.duration_ms ?? null,
        started_by: 'a member',
      })),
    ];
  });
  const hookRuns = $derived(hook.state === 'ready' ? hook.data.runs : []);
  const failuresFirst = $derived(finished !== true);
  const rows = $derived(sortFlowRuns(mergeFlowRuns(hookRuns, memberRuns), failuresFirst));
  const shown = $derived(onlyFailures ? rows.filter(isFailedRun) : rows);
  const failedCount = $derived(rows.filter(isFailedRun).length);
  const anyRead = $derived(hook.state === 'ready' || member.state === 'ready' || scoped.state === 'ready');
  const allSettled = $derived(hook.state !== 'loading' && member.state !== 'loading' && scoped.state !== 'loading');
  const failedSources = $derived(
    [
      hook.state === 'error' ? 'the conveyor flow record' : null,
      member.state === 'error' ? 'the runs members started' : null,
      scoped.state === 'error' ? 'the workflow names of those runs' : null,
    ].filter((s): s is string => s !== null),
  );

  function cardHref(cardId: string): string {
    return `/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(cardId)}`;
  }

  async function retryStart(): Promise<void> {
    retrying = true;
    retryMessage = null;
    try {
      const r = await retryProjectConveyorStart(projectId);
      retryMessage = { ok: true, text: `Start retry ${r.attempt_n} sent. Refresh to see its outcome.` };
    } catch (e) {
      retryMessage = { ok: false, text: e instanceof Error ? e.message : 'The retry failed.' };
    } finally {
      retrying = false;
      void settle(fetchProjectConveyorNotices(projectId), (v) => (notices = v), 'conveyor notices');
    }
  }

  const askRuns = () => askAgentAbout('What ran in this project recently, and did anything fail?');
  const askNotices = () => askAgentAbout('What did the conveyor report went wrong in this project, and what can I do about it?');
  const askActions = () => askAgentAbout('What has the agent done in this project recently, and for whom?');

  const th = 'px-3 py-2 font-semibold';
  const td = 'px-3 py-2 align-top';
</script>

{#snippet ask(label: string, onclick: () => unknown, testid: string)}
  <button
    type="button"
    data-testid={testid}
    data-agent-surface="ask"
    aria-label={`Ask the agent about ${label}`}
    {onclick}
    class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
  >
    Ask the agent
  </button>
{/snippet}

<ProjectInspectHeader
  {projectId}
  title="Flow runs"
  subtitle="Every run of this project's flows: what ran, for which card, when, for how long, and how it ended."
>
  {#snippet actions()}
    <button
      type="button"
      onclick={() => loadAll(projectId)}
      class="rounded-[var(--radius-md)] bg-[var(--color-surface-strong)] px-3 py-1.5 text-sm font-semibold text-[var(--color-text)]"
      data-testid="flow-runs-refresh"
    >
      Refresh
    </button>
  {/snippet}
</ProjectInspectHeader>

<div class="flex flex-col gap-6 p-6" data-testid="flow-runs-page">
  {#if cockpitUnreadable}
    <p class="text-xs text-[var(--color-warning-text)]" data-testid="project-unreadable">
      This project's state and card names could not be read right now, so failed runs are listed first and cards are
      not named.
    </p>
  {/if}
  <section data-testid="flow-runs">
    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
      <h2 class="text-sm font-bold text-[var(--color-text)]">
        Runs{allSettled && anyRead ? ` (${rows.length}${failedCount ? `, ${failedCount} failed` : ''})` : ''}
      </h2>
      <div class="flex items-center gap-3">
        {#if failedCount > 0}
          <label class="flex items-center gap-1 text-xs text-[var(--color-text-muted)]">
            <input type="checkbox" bind:checked={onlyFailures} data-testid="flow-runs-only-failures" />
            Only failed runs
          </label>
        {/if}
        {@render ask('the runs', askRuns, 'ask-agent-runs')}
      </div>
    </div>
    {#if allSettled && anyRead}
      <p class="mb-2 text-xs text-[var(--color-text-muted)]" data-testid="flow-runs-order">
        {finished === true
          ? 'The project is finished: newest first.'
          : finished === false
            ? 'The project is running: failed runs first, then newest first.'
            : "The project's state could not be read: failed runs first, then newest first."}
      </p>
    {/if}
    {#if failedSources.length > 0}
      <p class="mb-2 text-sm text-[var(--color-warning-text)]" data-testid="flow-runs-partial">
        Could not read {failedSources.join(' and ')} — the list may be missing runs; this is not "none".
      </p>
    {/if}
    {#if !allSettled}
      <p class="text-sm text-[var(--color-text-muted)]">Loading runs…</p>
    {:else if !anyRead}
      <p class="text-sm text-[var(--color-danger)]" data-testid="flow-runs-failed">The runs could not be read right now. Retry.</p>
    {:else if rows.length === 0}
      <div class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]" data-testid="flow-runs-empty">
        No run of this project's flows has been recorded yet.
        {#if hook.state === 'ready' && !hook.data.available}
          <p class="mt-1 text-xs">n8n's execution hook has not reported a run for this project.</p>
        {/if}
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full min-w-[48rem] rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] text-sm">
          <thead class="text-left text-xs text-[var(--color-text-muted)]">
            <tr>
              <th class={th}>Status</th>
              <th class={th}>Flow</th>
              <th class={th}>Card</th>
              <th class={th}>Started</th>
              <th class={th}>Duration</th>
              <th class={th}>n8n status</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-[var(--color-border)]">
            {#each shown as r (r.key)}
              <tr data-testid="flow-run-row" data-status={r.status} data-execution-id={r.execution_id}>
                <td class={`${td} font-medium ${isFailedRun(r) ? 'text-[var(--color-danger-text)]' : r.status === 'success' ? 'text-[var(--color-success-text)]' : 'text-[var(--color-text)]'}`}>
                  {runStatusWords(r)}
                  {#if isFailedRun(r) && (r.failed_node || r.error_class || r.error_message)}
                    <span class="block text-xs font-normal text-[var(--color-text-muted)]">
                      {r.failed_node ? `at "${r.failed_node}"` : ''}{r.failed_node && r.error_class ? ' · ' : ''}{r.error_class ?? ''}
                    </span>
                    {#if r.error_message}
                      <details class="text-xs font-normal text-[var(--color-text-muted)]">
                        <summary class="cursor-pointer">Details</summary>
                        <p class="whitespace-pre-wrap break-words" data-testid="flow-run-error">{r.error_message}</p>
                      </details>
                    {/if}
                  {/if}
                </td>
                <td class={td}>
                  {r.flow ?? 'Flow not named'}
                  {#if r.started_by}<span class="block text-xs text-[var(--color-text-muted)]">started by {r.started_by}</span>{/if}
                </td>
                <td class={td}>
                  {#if r.card_id}
                    <a class="text-[var(--color-accent)] hover:underline" href={cardHref(r.card_id)} data-testid="flow-run-card">{cardNames.get(r.card_id) ?? 'Open the card'}</a>
                  {:else}
                    <span class="text-[var(--color-text-muted)]">No card</span>
                  {/if}
                </td>
                <td class={td}><time datetime={r.started_at ?? undefined}>{shortTime(r.started_at) || '—'}</time></td>
                <td class={td}>{runDurationWords(r.duration_ms)}</td>
                <td class={`${td} text-[var(--color-text-muted)]`}>{r.n8n_status ?? 'not reported'}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      {#if hookRuns.length >= FLOW_RUNS_SHOWN_CAP}
        <p class="mt-1 text-xs text-[var(--color-text-muted)]" data-testid="flow-runs-capped">
          Showing the newest {FLOW_RUNS_SHOWN_CAP} runs n8n's hook reported; older runs are not listed here.
        </p>
      {/if}
    {/if}
  </section>

  <!-- Kept from the Execution hub (R311): what the conveyor reported went wrong, and the start retry. -->
  <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="hub-conveyor-notices">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold">Conveyor failures</h2>
      {@render ask('conveyor failures', askNotices, 'ask-agent-notices')}
    </div>
    {#if notices.state === 'loading'}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if notices.state === 'error'}
      <p class="text-sm text-[var(--color-danger)]" data-testid="hub-notices-error">Could not read this: {notices.message}</p>
    {:else}
      <div class="mb-3 flex flex-wrap items-center justify-between gap-2" data-testid="hub-conveyor-retry">
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="hub-conveyor-retry-reason">{conveyorRetryText(notices.data.retry)}</p>
        {#if notices.data.retry.available}
          <button
            type="button"
            data-testid="hub-conveyor-retry-button"
            disabled={retrying}
            onclick={retryStart}
            class="rounded-[var(--radius-md)] bg-[var(--color-accent)] px-3 py-1.5 text-sm font-semibold text-[var(--color-on-primary)] disabled:opacity-60"
          >
            {retrying ? 'Retrying…' : notices.data.retry.reason === 'no_progress' || notices.data.retry.reason === 'stalled' ? 'Start again' : 'Retry the conveyor start'}
          </button>
        {/if}
      </div>
      {#if retryMessage}
        <p class="mb-2 text-sm {retryMessage.ok ? 'text-[var(--color-text)]' : 'text-[var(--color-danger)]'}" data-testid="hub-conveyor-retry-message">{retryMessage.text}</p>
      {/if}
      {#if notices.data.notices.length === 0}
        <p class="text-sm text-[var(--color-text-muted)]">The conveyor has reported no failure for this project.</p>
      {:else}
        <ul class="space-y-2 text-sm">
          {#each notices.data.notices as n (n.id)}
            <li data-testid="hub-conveyor-notice" data-kind={n.kind}>
              <p class="font-medium" data-testid="hub-conveyor-notice-title">
                {CONVEYOR_NOTICE_TEXT[n.kind]?.title ?? CONVEYOR_NOTICE_TEXT.start_failed.title}
                <span class="text-xs font-normal text-[var(--color-text-muted)]">· {shortTime(n.created_at)}</span>
              </p>
              <p class="text-xs text-[var(--color-text-muted)]" data-testid="hub-conveyor-notice-member-text">
                {CONVEYOR_NOTICE_TEXT[n.kind]?.text ?? CONVEYOR_NOTICE_TEXT.start_failed.text}
              </p>
              <details class="text-xs text-[var(--color-text-muted)]">
                <summary class="cursor-pointer">Details for support</summary>
                <p class="font-mono">{[n.card_id, n.flow, n.node, n.error_class].filter(Boolean).join(' · ') || '—'}</p>
                <p data-testid="hub-conveyor-notice-text">{n.error_text}</p>
              </details>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>

  <section class="rounded-lg border border-[var(--color-border)] bg-[var(--color-surface)] p-4" data-testid="hub-agent-activity">
    <div class="mb-2 flex items-center justify-between">
      <h2 class="text-sm font-semibold">Agent activity</h2>
      {@render ask('agent activity', askActions, 'ask-agent-activity')}
    </div>
    {#if actions.state === 'loading'}
      <p class="text-sm text-[var(--color-text-muted)]">Loading…</p>
    {:else if actions.state === 'error'}
      <p class="text-sm text-[var(--color-danger)]" data-testid="hub-actions-error">Could not read this: {actions.message}</p>
    {:else if actions.data.actions.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]">The agent has not acted in this project yet.</p>
    {:else}
      <ul class="space-y-1 text-sm">
        {#each actions.data.actions as a, i (i)}
          <li class="flex flex-wrap justify-between gap-2" data-testid="hub-agent-action">
            <span class="font-mono text-xs">{a.capability ?? 'unknown capability'}</span>
            <span>{a.outcome}{a.http_status ? ` (${a.http_status})` : ''}</span>
            <span class="text-xs text-[var(--color-text-muted)]">{a.by_me ? 'you' : (a.actor ?? 'a member')} · {shortTime(a.at)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
</div>
