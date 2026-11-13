<!--
  /projects/[id]/board — the project's Board (R5, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3; cockpit C4/C9).

  One Planka board per project; the page FILTERS it by phase (§2b, George 2026-10-26): the phase bar
  (R2's PhaseSpine) selects a phase, and the board shows the cards whose EXACT phase is that one —
  the card's own `phase` field, Closure = card type `project_closure`. Cards with neither are under
  "Not tied to a phase"; "All cards" shows the whole board. Default: the current phase.

  Columns are the board's own lists in Planka order. Each card says how long it has been in its
  column; a blocked card has a red edge and its reason. A card opens the card drawer (C9).

  Reads: GET /api/projects/:id/cockpit (one call: the board panel, spine, flows, decisions, costs)
  and, the first time a drawer opens, GET /api/projects/:id/outputs. Moving and adding cards stays
  available under "Move or add cards" (the Planka board); it mounts only
  when opened, so the page does not read the board twice.

  `?card=<id>` opens that card's drawer (the cockpit's deep links).
-->
<script lang="ts">
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { setPageTitle } from '$lib/layout/pageTitle.svelte';
  import { onInvalidate } from '$lib/agent/invalidation';
  import { askAgentAbout } from '$lib/agent/ask';
  import { fetchProjectCockpit, CockpitNotFoundError } from '$lib/api/cockpit';
  import { fetchProjectOutputs } from '$lib/api/project-outputs';
  import { fetchProjectWip, type ProjectWip } from '$lib/api/project-execution';
  import { projectCockpit } from '$lib/stores/projectCockpit.svelte';
  import { hasData } from '$lib/types/panel';
  import type { BoardCard, ProjectCockpit } from '$lib/types/cockpit';
  import ProjectInspectHeader from '$lib/components/cockpit/ProjectInspectHeader.svelte';
  import PhaseSpine from '$lib/components/cockpit/PhaseSpine.svelte';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import KanbanProjectPanel from '$lib/components/kanban/KanbanProjectPanel.svelte';
  import CardDrawer from '$lib/components/board/CardDrawer.svelte';
  import {
    ALL_CARDS,
    UNPLACED,
    blockedWords,
    boardFilterShown,
    cardsInFilter,
    columnsWithCards,
    timeInColumnWords,
    FLOW_RUNS_SHOWN_CAP,
    type BoardFilter,
    type DrawerOutputs,
  } from '$lib/components/board/board';

  const projectId = $derived(page.params.id ?? '');

  let cockpit = $state<ProjectCockpit | null>(null);
  let loaded = $state(false);
  let notFound = $state(false);
  /** The cockpit read failed (not a 404): nothing on the board is known. */
  let unreadable = $state(false);
  let now = $state(Date.now());
  let chosen = $state<BoardFilter | null>(null);
  let openCardId = $state<string | null>(null);
  let outputs = $state<DrawerOutputs>({ kind: 'reading' });
  let outputsRequested = false;
  let wip = $state<ProjectWip | null>(null);
  let editOpen = $state(false);

  async function load(id: string): Promise<void> {
    try {
      // PROJECT-READ-WAIVER: primary-load — the board is the cockpit read model's `board` panel (with the
      // spine, flows, decisions and costs the drawer needs); loadProject does not carry it. A failed read
      // renders data-testid="project-unreadable" below, never an empty board.
      const c = await fetchProjectCockpit(id);
      if (id !== projectId) return;
      cockpit = c;
      projectCockpit.publish(id, c.project, c.status);
      notFound = false;
      unreadable = false;
      now = Date.now();
    } catch (e) {
      if (id !== projectId) return;
      if (e instanceof CockpitNotFoundError) notFound = true;
      else {
        console.error('[projects/board] cockpit read failed', e);
        unreadable = true;
      }
    } finally {
      if (id === projectId) loaded = true;
    }
  }

  async function loadWip(id: string): Promise<void> {
    try {
      // quiet: the WIP line is a footnote; a failed read leaves it out (warned below), never an app error.
      const w = await fetchProjectWip(id, { quiet: true });
      if (id === projectId) wip = w;
    } catch (e) {
      // The WIP line is a footnote of the board: it is left out, and the board still shows.
      console.warn('[projects/board] WIP read failed; the WIP line is left out', e);
      if (id === projectId) wip = null;
    }
  }

  async function loadOutputs(id: string): Promise<void> {
    outputs = { kind: 'reading' };
    try {
      const o = await fetchProjectOutputs(id);
      if (id !== projectId) return;
      outputs = o.available
        ? {
            kind: 'loaded',
            documents: [
              ...(o.final_report ? [o.final_report] : []),
              ...o.phases.flatMap((p) => p.documents),
              ...o.unassigned.documents,
            ],
            pullRequests: [...o.phases.flatMap((p) => p.pull_requests), ...o.unassigned.pull_requests],
          }
        : { kind: 'loaded', documents: [], pullRequests: [] };
    } catch (e) {
      console.error('[projects/board] outputs read failed', e);
      if (id === projectId) outputs = { kind: 'failed' };
    }
  }

  $effect(() => {
    const id = projectId;
    if (!id) return;
    cockpit = null;
    loaded = false;
    chosen = null;
    outputsRequested = false;
    void load(id);
    void loadWip(id);
  });

  $effect(() => {
    const id = projectId;
    if (!id) return;
    return onInvalidate([`board:${id}`, `project:${id}`], () => {
      void load(id);
      if (outputsRequested) void loadOutputs(id);
    });
  });

  // ?card=<id> → open that card's drawer.
  $effect(() => {
    const fromUrl = page.url.searchParams.get('card');
    if (fromUrl) openCardId = fromUrl;
  });
  $effect(() => {
    if (openCardId && !outputsRequested && projectId) {
      outputsRequested = true;
      void loadOutputs(projectId);
    }
  });

  function openCard(id: string): void {
    openCardId = id;
  }
  function closeCard(): void {
    openCardId = null;
    if (page.url.searchParams.has('card')) {
      const u = new URL(page.url.href);
      u.searchParams.delete('card');
      void goto(`${u.pathname}${u.search}`, { replaceState: true, reset: false });
    }
  }

  const boardPanel = $derived(cockpit?.board ?? null);
  const board = $derived(boardPanel && hasData(boardPanel) ? boardPanel.data : null);
  const spinePanel = $derived(cockpit?.spine ?? null);
  const spine = $derived(spinePanel && hasData(spinePanel) ? spinePanel.data : null);
  const phases = $derived(spine?.phases ?? []);
  const phaseLabel = $derived(new Map(phases.map((p) => [p.name, p.label] as const)));
  const currentPhase = $derived(
    cockpit?.overview && hasData(cockpit.overview) ? cockpit.overview.data.current_phase : (cockpit?.status.data?.current_phase ?? null),
  );
  const filter = $derived(boardFilterShown(phases, currentPhase, chosen));
  const shownCards = $derived(board ? cardsInFilter(board.cards, filter) : []);
  const columns = $derived(board ? columnsWithCards(board, shownCards) : []);
  const filterLabel = $derived(
    filter === ALL_CARDS ? 'All cards' : filter === UNPLACED ? 'Not tied to a phase' : (phaseLabel.get(filter) ?? filter),
  );
  const filterPhase = $derived(phases.find((p) => p.name === filter) ?? null);
  const openCard_ = $derived<BoardCard | null>(board?.cards.find((c) => c.id === openCardId) ?? null);
  const flowsPanel = $derived(cockpit?.flows ?? null);
  const flowRuns = $derived(flowsPanel && hasData(flowsPanel) ? flowsPanel.data.runs : null);
  const decisions = $derived(cockpit?.decisions && hasData(cockpit.decisions) ? cockpit.decisions.data : null);
  const costs = $derived(cockpit?.project_costs && hasData(cockpit.project_costs) ? cockpit.project_costs.data : null);
  const wipLine = $derived.by(() => {
    if (!wip || !wip.board_count.available || typeof wip.board_count.doing !== 'number') return null;
    const limit = wip.limit.available ? (wip.limit.effective_wip_limit ?? null) : null;
    return limit === null ? `${wip.board_count.doing} in Doing` : `${wip.board_count.doing} in Doing of a limit of ${limit}`;
  });

  // The Execution hub's "Ask the agent" drafts that belong to the board (pre-fill only; the person sends).
  const blockedCards = $derived((board?.cards ?? []).filter((c) => c.blocked));
  function names(list: Array<{ name: string }>, max = 5): string {
    const shown = list.slice(0, max).map((c) => `"${c.name}"`);
    return list.length > max ? `${shown.join(', ')} and ${list.length - max} more` : shown.join(', ');
  }
  const askBlocked = () =>
    askAgentAbout(
      blockedCards.length > 0
        ? `Why are these cards blocked, and what would unblock them: ${names(blockedCards)}?`
        : 'Is anything blocked in this project right now?',
    );
  const askWip = () => askAgentAbout('How close is this project to its WIP limit?');

  $effect(() => {
    setPageTitle(page.url.pathname, cockpit?.project?.data?.name ?? null);
  });

  const filterBtn = (on: boolean) =>
    `min-h-[2.25rem] rounded-full border px-3 text-xs font-semibold ${on ? 'border-[var(--color-accent-border)] bg-[var(--color-accent-bg)] text-[var(--color-text)]' : 'border-[var(--color-border)] bg-[var(--color-bg)] text-[var(--color-text-muted)] hover:text-[var(--color-text)]'}`;
</script>

<ProjectInspectHeader {projectId} title="Board" subtitle="The cards of this project, by phase. Select a card to see its runs, comments, decisions, outputs and cost.">
  {#snippet actions()}
    <button
      type="button"
      onclick={() => void load(projectId)}
      class="rounded-[var(--radius-md)] bg-[var(--color-surface-strong)] px-3 py-1.5 text-sm font-semibold text-[var(--color-text)]"
      data-testid="board-refresh"
    >
      Refresh
    </button>
  {/snippet}
</ProjectInspectHeader>

<div class="flex flex-col gap-4 p-6" data-testid="project-board">
  {#if !loaded}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-loading">Loading the board…</p>
  {:else if notFound}
    <p class="text-sm text-[var(--color-text-muted)]" data-testid="project-not-found">
      This project was not found, or you do not have access to it.
    </p>
  {:else if unreadable && !cockpit}
    <!-- Never an empty board, and never "not linked to a board": the read failed, nothing is known. -->
    <p class="text-sm text-[var(--color-warning-text)]" data-testid="project-unreadable">
      The board could not be read right now. The project is NOT known to be without a board. Retry, and report this if
      it persists.
    </p>
  {:else if cockpit}
    {#if spinePanel}
      <PhaseSpine panel={spinePanel} selectedPhase={filterPhase ? filter : null} onSelectPhase={(p) => (chosen = p ?? currentPhase)} />
    {/if}
    <div class="flex flex-wrap items-center gap-2" role="group" aria-label="Cards shown" data-testid="board-filter">
      <span class="text-sm font-semibold text-[var(--color-text)]" data-testid="board-filter-label">Showing: {filterLabel}</span>
      <button type="button" class={filterBtn(filter === ALL_CARDS)} aria-pressed={filter === ALL_CARDS} data-testid="board-filter-all" onclick={() => (chosen = ALL_CARDS)}
        >All cards{board ? ` (${board.cards.length})` : ''}</button
      >
      <button type="button" class={filterBtn(filter === UNPLACED)} aria-pressed={filter === UNPLACED} data-testid="board-filter-unplaced" onclick={() => (chosen = UNPLACED)}
        >Not tied to a phase{board ? ` (${board.unplaced})` : ''}</button
      >
      <span class="ml-auto flex items-center gap-3">
        {#if wipLine}<span class="text-xs text-[var(--color-text-muted)]" data-testid="board-wip">{wipLine}</span>{/if}
        <button type="button" data-testid="ask-agent-blocked" data-agent-surface="ask" aria-label="Ask the agent about blocked cards" onclick={askBlocked} class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Ask the agent about blocked cards</button>
        <button type="button" data-testid="ask-agent-wip" data-agent-surface="ask" aria-label="Ask the agent about WIP" onclick={askWip} class="text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]">Ask about WIP</button>
      </span>
    </div>

    {#if boardPanel && boardPanel.health !== 'ok'}
      <PanelNote panel={boardPanel} title="The board" />
    {/if}

    {#if !board}
      {#if !boardPanel}
        <p class="text-sm text-[var(--color-warning-text)]" data-testid="board-not-served">The board is not available from this server yet.</p>
      {:else if boardPanel.health === 'ok'}
        <!-- Not applicable (no board linked): said plainly, never "re-create the project". -->
        <p class="text-sm text-[var(--color-text-muted)]" data-testid="board-none">This project has no board yet.</p>
      {/if}
    {:else if board.columns.length === 0}
      <p class="text-sm text-[var(--color-text-muted)]" data-testid="board-no-columns">This board has no columns.</p>
    {:else}
      {#if shownCards.length === 0}
        <p
          class="rounded-[var(--radius-md)] border border-dashed border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-3 text-sm text-[var(--color-text-muted)]"
          data-testid="board-filter-empty"
        >
          {#if filter === UNPLACED}
            Every card on this board is tied to a phase.
          {:else if filter === ALL_CARDS}
            This board has no cards yet.
          {:else if filterPhase && (filterPhase.state === 'upcoming' || filterPhase.state === 'not_run')}
            {filterLabel} has not started, so it has no cards yet.
          {:else}
            No card on this board is tied to {filterLabel}.
          {/if}
        </p>
      {/if}
      <div class="overflow-x-auto" data-testid="board-columns">
        <div class="grid gap-3" style={`grid-template-columns: repeat(${columns.length}, minmax(11rem, 1fr)); min-width: ${columns.length * 11.5}rem`}>
          {#each columns as col (col.column.id)}
            <section
              class="flex min-h-[16rem] flex-col gap-2 rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-bg)] p-2.5"
              data-testid="board-column"
              data-column={col.column.name}
              aria-label={`${col.column.name}: ${col.cards.length}`}
            >
              <h2 class="flex justify-between px-1 text-xs font-bold text-[var(--color-text-muted)]">
                <span>{col.column.name}</span><span data-testid="board-column-count">{col.cards.length}</span>
              </h2>
              {#each col.cards as c (c.id)}
                <button
                  type="button"
                  class={`flex flex-col gap-1 rounded-[var(--radius-md)] border bg-[var(--color-surface)] px-2.5 py-2 text-left hover:border-[var(--color-accent-border)] ${c.blocked ? 'border-[var(--color-border)] border-l-4 border-l-[var(--color-danger)]' : 'border-[var(--color-border)]'} ${openCardId === c.id ? 'ring-2 ring-[var(--color-accent)]' : ''}`}
                  aria-pressed={openCardId === c.id}
                  data-testid="board-card"
                  data-card-id={c.id}
                  data-blocked={c.blocked ? 'true' : 'false'}
                  onclick={() => openCard(c.id)}
                >
                  <span class="text-sm font-semibold leading-snug text-[var(--color-text)]">{c.name}</span>
                  <span class="text-xs text-[var(--color-text-muted)]" data-testid="board-card-time">{timeInColumnWords(c, now)}</span>
                  {#if c.blocked}
                    <span class="text-xs font-medium text-[var(--color-danger-text)]" data-testid="board-card-blocked">{blockedWords(c)}</span>
                  {/if}
                  {#if c.waiting_on}
                    <span class="text-xs text-[var(--color-warning-text)]" data-testid="board-card-waiting">Waiting for a decision</span>
                  {/if}
                  {#if filter === ALL_CARDS}
                    <span class="text-[11px] text-[var(--color-text-muted)]">{c.phase ? (phaseLabel.get(c.phase) ?? c.phase) : 'Not tied to a phase'}</span>
                  {/if}
                  {#if c.comment_count}
                    <span class="text-[11px] text-[var(--color-text-muted)]">{c.comment_count} comment{c.comment_count === 1 ? '' : 's'}</span>
                  {/if}
                </button>
              {:else}
                <p class="px-1 text-xs text-[var(--color-text-muted)]">Nothing here</p>
              {/each}
            </section>
          {/each}
        </div>
      </div>
    {/if}

    <details class="rounded-[var(--radius-lg)] border border-[var(--color-border)] bg-[var(--color-surface)]" bind:open={editOpen} data-testid="board-edit">
      <summary class="cursor-pointer px-4 py-2.5 text-sm font-semibold text-[var(--color-text)]">Move or add cards</summary>
      {#if editOpen}
        <div class="border-t border-[var(--color-border)] p-4">
          <KanbanProjectPanel boardId={cockpit.project.data?.planka_board_id ?? null} />
        </div>
      {/if}
    </details>
  {/if}
</div>

{#if openCardId && cockpit}
  {#if openCard_}
    <CardDrawer
      {projectId}
      card={openCard_}
      phaseLabel={openCard_.phase ? (phaseLabel.get(openCard_.phase) ?? openCard_.phase) : null}
      {flowRuns}
      flowRunsTruncated={(flowRuns?.length ?? 0) >= FLOW_RUNS_SHOWN_CAP}
      {decisions}
      {costs}
      {outputs}
      {now}
      onClose={closeCard}
    />
  {:else if board}
    <div class="fixed bottom-4 right-4 z-40 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-surface)] px-4 py-3 text-sm shadow-lg" data-testid="card-drawer-missing">
      This card is not on the project's board.
      <a class="ml-1 text-[var(--color-accent)] hover:underline" href={`/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(openCardId)}`}>Open the card</a>
      <button type="button" class="ml-2 text-[var(--color-text-muted)]" onclick={closeCard}>Close</button>
    </div>
  {/if}
{/if}
