<!--
  CardDrawer (C9, FR-PROJECT-HOME-REDESIGN-2026-10-26 §3 Board) — ONE drawer for a board card:
  where it is and for how long, why it is blocked, its column history, the flow runs n8n's hook
  recorded for it (with n8n's own status), its comments, the decisions on it (C8 log rows), what it
  produced (the R3 document trail, linking to the reader) and its cost.

  The cockpit read model is passed in (flows, decisions, costs: no second read). The drawer reads
  only what is the card's own: GET /api/cards/:id (column history) and GET /api/kanban/cards/:id
  (comments + their authors), plus the project's outputs once per board page (`outputs`).
  Every part degrades on its own and says so; a failed read is never shown as "none".
-->
<script lang="ts">
  import { onMount, tick } from 'svelte';
  import { authFetch } from '$lib/api/auth-fetch';
  import { apiClient } from '$lib/api/unified-client';
  import type { BoardCard, CockpitDecision, CockpitFlowRun, CockpitProjectCosts } from '$lib/types/cockpit';
  import type { CardDetail } from '$lib/cards/types';
  import type { PlankaComment, PlankaUser } from '$lib/types/api';
  import PhaseJourneySection from '$lib/cards/sections/PhaseJourneySection.svelte';
  import { decideHref } from '$lib/components/conveyor-history/view';
  import { actorWords, shortTime } from '$lib/components/cockpit/spine';
  import { moneyWords } from '$lib/projects/cockpit-status';
  import { displayName } from '$lib/utils/displayName';
  import { shortId } from '$lib/utils/shortId';
  import {
    blockedWords,
    cardCost,
    isFailedRun,
    mergeFlowRuns,
    runDurationWords,
    runStatusWords,
    sortFlowRuns,
    timeInColumnWords,
    type DrawerOutputs,
  } from './board';

  let {
    projectId,
    card,
    phaseLabel,
    flowRuns,
    flowRunsTruncated = false,
    decisions,
    costs,
    outputs,
    now,
    onClose,
  }: {
    projectId: string;
    card: BoardCard;
    /** The card's phase in words; null = not tied to a phase. */
    phaseLabel: string | null;
    /** The project's flow runs (cockpit `flows.runs`); null = the flow record could not be read. */
    flowRuns: CockpitFlowRun[] | null;
    flowRunsTruncated?: boolean;
    /** The C8 log (cockpit `decisions`); null = it could not be read. */
    decisions: CockpitDecision[] | null;
    /** billing's per-project costs (cockpit `project_costs`); null = billing could not be read. */
    costs: CockpitProjectCosts | null;
    outputs: DrawerOutputs;
    now: number;
    onClose: () => void;
  } = $props();

  type Read<T> = { kind: 'reading' } | { kind: 'failed'; message: string } | { kind: 'loaded'; data: T };

  let journey = $state<Read<CardDetail>>({ kind: 'reading' });
  let comments = $state<Read<{ comments: PlankaComment[]; users: PlankaUser[] }>>({ kind: 'reading' });
  let heading: HTMLHeadingElement | undefined = $state();

  async function loadJourney(id: string): Promise<void> {
    journey = { kind: 'reading' };
    try {
      const r = await authFetch(`/api/cards/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as CardDetail;
      if (id === card.id) journey = { kind: 'loaded', data };
    } catch (e) {
      console.error('[board/drawer] card history read failed', e);
      if (id === card.id) journey = { kind: 'failed', message: 'The card\'s history could not be read right now.' };
    }
  }

  async function loadComments(id: string): Promise<void> {
    comments = { kind: 'reading' };
    try {
      const d = await apiClient.kanban.getCard(id);
      if (id === card.id) comments = { kind: 'loaded', data: { comments: d.comments ?? [], users: d.users ?? [] } };
    } catch (e) {
      console.error('[board/drawer] comments read failed', e);
      if (id === card.id) comments = { kind: 'failed', message: 'The comments could not be read right now.' };
    }
  }

  $effect(() => {
    const id = card.id;
    void loadJourney(id);
    void loadComments(id);
  });

  onMount(() => {
    void tick().then(() => heading?.focus());
  });

  function onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape') onClose();
  }

  const runs = $derived(
    flowRuns === null ? null : sortFlowRuns(mergeFlowRuns(flowRuns.filter((r) => r.card_id === card.id), []), false),
  );
  const cardDecisions = $derived(decisions === null ? null : decisions.filter((d) => d.card_id === card.id));
  const cardDocs = $derived(outputs.kind === 'loaded' ? outputs.documents.filter((d) => d.card_id === card.id) : []);
  const cardPrs = $derived(
    outputs.kind === 'loaded' ? outputs.pullRequests.filter((p) => p.card_name !== null && p.card_name === card.name) : [],
  );
  const cost = $derived(cardCost(costs, card.id));
  const usersById = $derived(
    comments.kind === 'loaded' ? new Map(comments.data.users.map((u) => [u.id, u] as const)) : new Map<string, PlankaUser>(),
  );
  function author(userId: string): string {
    const u = usersById.get(userId);
    return u ? displayName(u.name, displayName(u.username, shortId(userId))) : shortId(userId);
  }

  const sectionH = 'mb-1.5 text-[11px] font-bold uppercase tracking-wider text-[var(--color-text-muted)]';
  const muted = 'text-sm text-[var(--color-text-muted)]';
</script>

<svelte:window onkeydown={onKey} />

<div class="fixed inset-0 z-40 flex justify-end" data-testid="card-drawer-layer">
  <button
    type="button"
    class="absolute inset-0 cursor-default bg-black/20"
    aria-label="Close the card"
    tabindex="-1"
    onclick={onClose}
  ></button>
  <div
    class="relative flex h-full w-full max-w-[28rem] flex-col overflow-y-auto border-l border-[var(--color-border)] bg-[var(--color-surface)] shadow-xl"
    aria-labelledby="card-drawer-title"
    role="dialog"
    aria-modal="true"
    tabindex="-1"
    data-testid="card-drawer"
    data-card-id={card.id}
  >
    <header class="flex items-start justify-between gap-3 border-b border-[var(--color-border)] px-5 py-4">
      <div class="min-w-0">
        <h2
          id="card-drawer-title"
          bind:this={heading}
          tabindex="-1"
          class="text-lg font-semibold leading-snug text-[var(--color-text)] outline-none"
        >
          {card.name}
        </h2>
        <p class="mt-0.5 text-sm text-[var(--color-text-muted)]" data-testid="card-drawer-status">
          {timeInColumnWords(card, now)} · {phaseLabel ?? 'Not tied to a phase'}
        </p>
      </div>
      <button
        type="button"
        class="min-h-[2.75rem] min-w-[2.75rem] text-xl text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
        aria-label="Close the card"
        data-testid="card-drawer-close"
        onclick={onClose}>×</button
      >
    </header>

    <div class="flex flex-col gap-5 px-5 py-4">
      {#if card.blocked}
        <section
          class="rounded-[var(--radius-md)] border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2"
          data-testid="card-drawer-blocked"
        >
          <p class="text-sm font-semibold text-[var(--color-danger-text)]">{blockedWords(card)}</p>
        </section>
      {/if}
      {#if card.waiting_on}
        <section class="rounded-[var(--radius-md)] border border-[var(--color-warning-border)] bg-[var(--color-warning-bg)] px-3 py-2" data-testid="card-drawer-waiting">
          <p class="text-sm text-[var(--color-warning-text)]">Waiting for a decision: {card.waiting_on.description}</p>
          <a class="text-sm font-semibold text-[var(--color-accent)] hover:underline" href={decideHref(projectId, card.waiting_on.approval_id)}>Open the decision</a>
        </section>
      {/if}

      <section data-testid="card-drawer-history">
        <h3 class={sectionH}>Column history</h3>
        {#if journey.kind === 'reading'}
          <p class={muted}>Reading…</p>
        {:else if journey.kind === 'failed'}
          <p class="text-sm text-[var(--color-warning-text)]">{journey.message}</p>
        {:else}
          <PhaseJourneySection
            journey={journey.data.phase_journey}
            currentListName={journey.data.list_name}
            blockReasonText={card.block_reason}
          />
        {/if}
      </section>

      <section data-testid="card-drawer-flow-runs">
        <h3 class={sectionH}>Flow runs</h3>
        {#if runs === null}
          <p class="text-sm text-[var(--color-warning-text)]">The flow runs could not be read right now — this is not "none".</p>
        {:else if runs.length === 0}
          <p class={muted}>No flow run was recorded for this card{flowRunsTruncated ? ' among the newest runs read' : ''}.</p>
        {:else}
          <ul class="space-y-1.5">
            {#each runs as r (r.key)}
              <li class="text-sm" data-testid="card-drawer-flow-run" data-status={r.status}>
                <span class="font-medium {isFailedRun(r) ? 'text-[var(--color-danger-text)]' : 'text-[var(--color-text)]'}">{runStatusWords(r)}</span>
                <span class="text-[var(--color-text)]"> · {r.flow ?? 'Flow not named'}</span>
                <span class="block text-xs text-[var(--color-text-muted)]">
                  {shortTime(r.started_at) || 'start not recorded'} · {runDurationWords(r.duration_ms)} · n8n: {r.n8n_status ?? 'not reported'}{r.failed_node
                    ? ` · failed at "${r.failed_node}"`
                    : ''}
                </span>
              </li>
            {/each}
          </ul>
          {#if flowRunsTruncated}
            <p class="mt-1 text-xs text-[var(--color-text-muted)]">Only the project's newest runs were read; older runs are on Flow runs.</p>
          {/if}
        {/if}
      </section>

      <section data-testid="card-drawer-comments">
        <h3 class={sectionH}>Comments</h3>
        {#if comments.kind === 'reading'}
          <p class={muted}>Reading…</p>
        {:else if comments.kind === 'failed'}
          <p class="text-sm text-[var(--color-warning-text)]">{comments.message}</p>
        {:else if comments.data.comments.length === 0}
          <p class={muted}>No comments on this card.</p>
        {:else}
          <ul class="space-y-2">
            {#each comments.data.comments as c (c.id)}
              <li class="text-sm" data-testid="card-drawer-comment">
                <span class="text-xs text-[var(--color-text-muted)]">{author(c.userId)} · {shortTime(c.createdAt)}</span>
                <p class="whitespace-pre-wrap break-words text-[var(--color-text)]">{c.text}</p>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section data-testid="card-drawer-decisions">
        <h3 class={sectionH}>Decisions</h3>
        {#if cardDecisions === null}
          <p class="text-sm text-[var(--color-warning-text)]">The decisions could not be read right now.</p>
        {:else if cardDecisions.length === 0}
          <p class={muted}>No question or sign-off on this card.</p>
        {:else}
          <ul class="space-y-1.5">
            {#each cardDecisions as d (d.approval_id)}
              <li class="text-sm" data-testid="card-drawer-decision">
                <span class="text-[var(--color-text)]">{d.subject}</span>
                <span class="block text-xs text-[var(--color-text-muted)]">
                  {#if d.open}
                    Open since {shortTime(d.asked_at)} ·
                    <a class="text-[var(--color-accent)] hover:underline" href={decideHref(projectId, d.approval_id)}>Decide</a>
                  {:else}
                    {d.answer ?? d.decision ?? 'Decided'} — {actorWords(d.actor_kind, d.actor_name)}, {shortTime(d.decided_at)}
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section data-testid="card-drawer-outputs">
        <h3 class={sectionH}>Outputs</h3>
        {#if outputs.kind === 'reading'}
          <p class={muted}>Reading…</p>
        {:else if outputs.kind === 'failed'}
          <p class="text-sm text-[var(--color-warning-text)]">The outputs could not be read right now.</p>
        {:else if cardDocs.length === 0 && cardPrs.length === 0}
          <p class={muted}>Nothing produced by this card yet.</p>
        {:else}
          <ul class="space-y-1.5">
            {#each cardDocs as d (d.key)}
              <li class="text-sm" data-testid="card-drawer-output">
                <a class="font-medium text-[var(--color-accent)] hover:underline" href={`/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(d.artifact_id)}`}>{d.title}</a>
                <span class="block text-xs text-[var(--color-text-muted)]">{d.type_label}{d.status ? ` · ${d.status === 'in_review' ? 'in review' : d.status}` : ''}{d.at ? ` · ${shortTime(d.at)}` : ''}</span>
              </li>
            {/each}
            {#each cardPrs as p (p.url)}
              <li class="text-sm" data-testid="card-drawer-output-pr">
                <a class="font-medium text-[var(--color-accent)] hover:underline" href={p.url} target="_blank" rel="noopener noreferrer">{p.title}</a>
                <span class="block text-xs text-[var(--color-text-muted)]">Pull request{p.state ? ` · ${p.state}` : ''}</span>
              </li>
            {/each}
          </ul>
        {/if}
      </section>

      <section data-testid="card-drawer-cost" data-kind={cost.kind}>
        <h3 class={sectionH}>Cost</h3>
        {#if cost.kind === 'amount'}
          <p class="text-sm text-[var(--color-text)]">
            {moneyWords(cost.cost, cost.currency) ?? 'Amount not shown'} · {cost.calls} model call{cost.calls === 1 ? '' : 's'}
          </p>
        {:else if cost.kind === 'not_attributed'}
          <p class={muted}>
            Cost per card is not recorded yet: this project's model calls carry no card, so its spend cannot be split by card.
            The project total is on the Overview.
          </p>
        {:else if cost.kind === 'none_recorded'}
          <p class={muted}>No model call was recorded against this card{cost.since ? ` since ${shortTime(cost.since)}` : ''}.</p>
        {:else}
          <p class="text-sm text-[var(--color-warning-text)]">The cost could not be read right now.</p>
        {/if}
      </section>

      <a
        class="text-sm font-semibold text-[var(--color-accent)] hover:underline"
        href={`/projects/${encodeURIComponent(projectId)}/cards/${encodeURIComponent(card.id)}`}
        data-testid="card-drawer-full">Open the full card</a
      >
    </div>
  </div>
</div>
