<!--
  ProjectNeedsYou — R4 (FR-PROJECT-HOME-REDESIGN §3, §5 R4). The project's ONE place for what it
  needs from people: every open question, sign-off and review, OLDEST FIRST and answerable inline,
  then the decided history, newest first. Replaces the separate project Approvals and Threads pages
  (both 308 here).

  Where each row comes from (no new backend route):
    * Open list  = the cockpit's C2 `actions` panel — server-ordered oldest first, each item tagged
                   with its card's EXACT phase (none ⇒ no tag). The rail badge counts the same list
                   (`needs_you` / `actions.length`, $lib/stores/projectCockpit).
    * Decide     = the SHARED `ApprovalDecisionSurface` over the WHOLE approval row
                   (GET /api/projects/:id/approvals), through `recordDecision` → PUT /api/approvals/:id
                   — the decide endpoint every surface uses. Who may decide is the server's rule
                   (`resolveDecideEligibility`); the surface only mirrors it (`canActOnApproval`). A
                   sign-off shows its plan (`ApprovalPlanText`) above the decision bar.
    * Reviews    = artifact items link to the in-app reader (R3), where the review is decided.
    * History    = the cockpit's C8 `decisions` panel, decided rows: who decided and when.
    * Threads    = the caller's own agent conversations bound to this project. A thread has no
                   "waiting for you" state in the data model, so they are LISTED in their own
                   section, never counted as asks.
-->
<script lang="ts">
  import { untrack } from 'svelte';
  import { apiClient } from '$lib/api/unified-client';
  import { fetchProjectCockpit, CockpitNotFoundError } from '$lib/api/cockpit';
  import { auth } from '$lib/stores/auth.svelte';
  import { toast } from '$lib/stores/toast.svelte';
  import { toastDecisionNotice } from '$lib/approvals/toast-notice';
  import { navCounts } from '$lib/stores/navCounts.svelte';
  import { projectCockpit, actionsCount } from '$lib/stores/projectCockpit.svelte';
  import { onInvalidate } from '$lib/agent/invalidation';
  import { recordDecision, type Decision } from '../../../routes/approvals/[id]/page-helpers';
  import { answerRequired, hasStatedQuestion } from '$lib/approvals/question';
  import { headlineGist, isSignoffAsk, summaryRepeatsQuestion } from '$lib/approvals/plan-text';
  import {
    markUnreadableProducerOutput,
    producerRationale,
    isNoRationaleSupplied,
    NO_RATIONALE_SHORT,
  } from '$lib/approvals/rationale';
  import ApprovalDecisionSurface from '$lib/components/approval/ApprovalDecisionSurface.svelte';
  import ApprovalPlanText from '$lib/components/approval/ApprovalPlanText.svelte';
  import ProjectThreadsList from './ProjectThreadsList.svelte';
  import PanelNote from '$lib/components/blocks/PanelNote.svelte';
  import { ACTION_TYPE_WORD } from '$lib/components/cockpit/actionStrip';
  import { actorWords, shortTime } from '$lib/components/cockpit/spine';
  import { decideHref } from '$lib/components/conveyor-history/view';
  import { ageWords } from '$lib/projects/cockpit-status';
  import { hasData } from '$lib/types/panel';
  import type { DecisionNotice } from '$lib/approvals/decision-callback';
  import type { Approval } from '$lib/types/api';
  import type { CockpitActionItem, ProjectCockpit } from '$lib/types/cockpit';
  import { historyRows, openItems, outcomeWords, phaseTag, readerHref } from './needsYou';

  interface Props {
    projectId: string;
  }
  let {
    projectId,
  }: Props = $props();

  let cockpit = $state<ProjectCockpit | null>(null);
  let cockpitError = $state<string | null>(null);
  let loading = $state(true);
  /** Whole approval rows by id — the decision surface needs `metadata`, never a projection. */
  let rows = $state<Record<string, Approval>>({});
  let rowsFailed = $state(false);

  /** Decided here and not yet re-read: hidden from the open list at once so no second press lands. */
  let decidedHere = $state<Set<string>>(new Set());
  /** The outcome of each decision taken here, kept on screen until dismissed (never only a toast). */
  let receipts = $state<{ key: string; title: string; notice: DecisionNotice }[]>([]);
  let busy = $state<Record<string, boolean>>({});
  /**
   * A REFUSED decision (403 not yours / 422 no longer decidable, or any other failure), kept ON THE
   * ITEM with the server's own message until the next attempt. A toast alone fades, and the item
   * then reads as if nothing had happened.
   */
  let refusals = $state<Record<string, { status: number | null; message: string }>>({});

  function refusalLead(status: number | null): string {
    if (status === 403) return 'You may not decide this.';
    if (status === 409 || status === 422) return 'The server refused this decision.';
    return 'The decision was not recorded.';
  }

  let seq = 0;
  async function load(id: string): Promise<void> {
    const mine = ++seq;
    loading = cockpit === null;
    const [c, r] = await Promise.allSettled([fetchProjectCockpit(id), apiClient.approvals.list(id)]);
    if (mine !== seq) return;
    if (c.status === 'fulfilled') {
      cockpit = c.value;
      cockpitError = null;
      projectCockpit.publish(id, c.value.project, c.value.status);
      projectCockpit.publishNeedsYou(id, actionsCount(c.value.actions));
      decidedHere = new Set();
    } else {
      cockpitError =
        c.reason instanceof CockpitNotFoundError
          ? 'This project was not found, or you cannot see it.'
          : c.reason instanceof Error
            ? c.reason.message
            : 'The project could not be read.';
    }
    if (r.status === 'fulfilled') {
      const next: Record<string, Approval> = {};
      for (const a of r.value?.items ?? []) next[a.id] = a;
      rows = next;
      rowsFailed = false;
    } else {
      rowsFailed = true;
    }
    loading = false;
  }

  // ⛔ `untrack`: load() READS `cockpit` (first-paint spinner) and then WRITES it — tracked, this
  // effect would re-run on its own write, forever.
  $effect(() => {
    const id = projectId;
    if (!id) return;
    untrack(() => void load(id));
  });

  // fr-agui SPEC §5.3: a decision or write elsewhere (the agent rail, another tab) re-reads.
  $effect(() => {
    const id = projectId;
    if (!id) return;
    return onInvalidate([`approvals:${id}`, 'approvals:me', `board:${id}`], () => untrack(() => void load(id)));
  });

  const actions = $derived(cockpit?.actions ?? null);
  const open = $derived(actions && hasData(actions) ? openItems(actions.data, decidedHere) : []);
  const overview = $derived(cockpit?.overview && hasData(cockpit.overview) ? cockpit.overview.data : null);
  const phaseLabels = $derived(new Map((overview?.phases ?? []).map((p) => [p.name, p.label] as const)));
  const history = $derived(cockpit?.decisions && hasData(cockpit.decisions) ? historyRows(cockpit.decisions.data) : []);
  const blocked = $derived(cockpit?.blocked_cards && hasData(cockpit.blocked_cards) ? cockpit.blocked_cards.data : []);

  async function decide(
    item: CockpitActionItem,
    row: Approval,
    kind: Decision,
    comment: string,
    overrideReason?: string,
    reclassify?: { newCardType: string },
    coverage?: { rejectedCriterionIds: string[] },
  ): Promise<void> {
    if (busy[item.key]) return;
    busy = { ...busy, [item.key]: true };
    const { [item.key]: _cleared, ...rest } = refusals;
    refusals = rest;
    try {
      // `answerRequired` (not `isQuestion`): the server's own predicate — an answerless approve on a
      // row that asks something is refused BEFORE the request, so the doomed 422 is never spent.
      const outcome = await recordDecision(
        row.id,
        kind,
        comment,
        {
          isQuestion: answerRequired(row, 'approved'),
          answerRequiredOnReclassify: answerRequired(row, 'approved', 'RECLASSIFY'),
        },
        overrideReason,
        reclassify,
        coverage,
      );
      receipts = [...receipts.filter((x) => x.key !== item.key), { key: item.key, title: headlineGist(item.title), notice: outcome.notice }];
      decidedHere = new Set(decidedHere).add(item.key);
      toastDecisionNotice(outcome.notice);
      navCounts.nudge();
      void load(projectId);
    } catch (e) {
      const message = e instanceof Error && e.message ? e.message : 'The decision could not be recorded.';
      const status = typeof (e as { status?: unknown })?.status === 'number' ? (e as { status: number }).status : null;
      refusals = { ...refusals, [item.key]: { status, message } };
      toast.error(message);
    } finally {
      busy = { ...busy, [item.key]: false };
    }
  }

  const TONE: Record<CockpitActionItem['type'], string> = {
    ask: 'border-l-[var(--color-info)]',
    signoff: 'border-l-[var(--color-warning)]',
    review: 'border-l-[var(--color-accent)]',
  };
  const NOTICE_TONE: Record<DecisionNotice['tone'], string> = {
    success: 'border-[var(--color-success)] bg-[var(--color-success-bg)] text-[var(--color-success-text)]',
    error: 'border-[var(--color-danger)] bg-[var(--color-danger-bg)] text-[var(--color-danger-text)]',
    info: 'border-[var(--color-border-strong)] bg-[var(--color-surface)] text-[var(--color-text)]',
    warning: 'border-[var(--color-warning)] bg-[var(--color-warning-bg)] text-[var(--color-warning-text)]',
  };
</script>

<div class="mx-auto max-w-3xl space-y-6 p-6" data-testid="project-needs-you">
  {#if loading}
    <p class="text-sm text-[var(--color-text-muted)]">Loading what this project needs from you…</p>
  {:else if !cockpit}
    <p class="text-sm text-[var(--color-warning-text)]" role="alert" data-testid="needs-you-error">
      {cockpitError ?? 'The project could not be read.'} This does NOT mean nothing needs you.
    </p>
  {:else}
    {#if cockpitError}
      <p class="text-xs text-[var(--color-warning-text)]" role="alert">Refreshing failed ({cockpitError}); showing the last read.</p>
    {/if}

    <!-- ── OPEN: every ask, sign-off and review, oldest first ── -->
    <section aria-labelledby="needs-you-open" data-testid="needs-you-open">
      <h2 id="needs-you-open" class="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        Waiting on you{#if actions && hasData(actions)}<span data-testid="needs-you-count"> ({open.length})</span>{/if}
      </h2>

      {#each receipts as r (r.key)}
        <div
          class={`mb-2 rounded border-l-4 px-3 py-2 text-xs ${NOTICE_TONE[r.notice.tone]}`}
          data-testid="needs-you-receipt"
          data-callback-delivered={r.notice.delivered ? 'true' : 'false'}
          role={r.notice.tone === 'error' ? 'alert' : 'status'}
        >
          <p class="font-medium">{markUnreadableProducerOutput(r.title)}</p>
          <p class="mt-1">{r.notice.message}</p>
          <button type="button" class="mt-1 text-[11px] underline" onclick={() => (receipts = receipts.filter((x) => x.key !== r.key))}>Dismiss</button>
        </div>
      {/each}

      {#if !actions || !hasData(actions)}
        <PanelNote panel={actions ?? { data: null, as_of: null, health: 'down', detail_code: 'not_served' }} title="What needs you" />
      {:else}
        {#if actions.health !== 'ok'}<PanelNote panel={actions} title="What needs you" class="mb-2" />{/if}
        {#if open.length === 0}
          <p class="text-sm text-[var(--color-text-muted)]" data-testid="needs-you-empty">
            {actions.health === 'ok' ? 'Nothing needs you on this project.' : 'Nothing readable needs you; part of the list could not be read.'}
          </p>
        {:else}
          <ol class="space-y-3" data-testid="needs-you-items">
            {#each open as item (item.key)}
              {@const tag = phaseTag(item.phase, phaseLabels)}
              {@const age = ageWords(item.created_at, Date.now())}
              {@const row = item.approval_id ? rows[item.approval_id] : undefined}
              {@const heading = row && row.status === 'pending' && (hasStatedQuestion(row) || isSignoffAsk(row)) ? headlineGist(item.title) : item.title}
              <li
                class={`rounded-lg border border-l-4 border-[var(--color-border)] bg-[var(--color-surface)] p-3 ${TONE[item.type]}`}
                data-testid="needs-you-item"
                data-type={item.type}
                data-key={item.key}
              >
                <div class="flex flex-wrap items-baseline gap-2 text-[11px] text-[var(--color-text-muted)]">
                  <span class="font-semibold uppercase tracking-wide">{ACTION_TYPE_WORD[item.type]}</span>
                  {#if tag}<span class="rounded bg-[var(--color-surface-strong)] px-1.5 py-px" data-testid="needs-you-phase">{tag}</span>{/if}
                  {#if item.card_name}<span class="truncate">Card: {item.card_name}</span>{/if}
                  {#if age}<span class="ml-auto" data-testid="needs-you-age">{age}</span>{/if}
                </div>
                <!-- The heading NAMES the item: when the full text is shown below (a stated question in the
                     "Question for you" box, a sign-off's plan), only its first sentence; else all of it. -->
                <p class="mt-1 text-sm text-[var(--color-text)]" data-testid="needs-you-title">{markUnreadableProducerOutput(heading)}</p>

                {#if refusals[item.key]}
                  {@const r = refusals[item.key]}
                  <div
                    class="mt-2 rounded border-l-4 border-[var(--color-danger)] bg-[var(--color-danger-bg)] px-3 py-2 text-xs text-[var(--color-danger-text)]"
                    role="alert"
                    data-testid="needs-you-refusal"
                    data-status={r.status ?? ''}
                  >
                    <p class="font-medium">{refusalLead(r.status)}</p>
                    <p class="mt-1" data-testid="needs-you-refusal-message">{r.message}</p>
                  </div>
                {/if}

                {#if item.type === 'review' && item.artifact_id}
                  <a
                    class="mt-2 inline-block text-xs font-semibold text-[var(--color-link)] hover:underline"
                    href={readerHref(projectId, item.artifact_id)}
                    data-testid="needs-you-read">Read and review →</a
                  >
                {:else if item.approval_id}
                  {#if row && row.status === 'pending'}
                    <div class="mt-2 space-y-2">
                      {#if isSignoffAsk(row)}
                        <ApprovalPlanText approval={row} />
                      {:else if producerRationale(row.change_summary) && !summaryRepeatsQuestion(row)}
                        <!-- Three states (see $lib/approvals/rationale): producer text verbatim, a marked
                             absence in one short line, legacy NULL/'' nothing. -->
                        <p class="text-xs text-[var(--color-text-muted)]">{markUnreadableProducerOutput(row.change_summary)}</p>
                      {:else if isNoRationaleSupplied(row.change_summary)}
                        <p class="text-xs italic text-[var(--color-text-muted)]" data-testid="needs-you-no-rationale">{NO_RATIONALE_SHORT}</p>
                      {/if}
                      <ApprovalDecisionSurface
                        approval={row}
                        user={auth.user}
                        canOverrideBrokenGate={auth.isSuperAdmin}
                        canVoid={auth.isSuperAdmin}
                        busy={busy[item.key]}
                        question={item.type === 'ask' ? 'Your answer' : 'Your decision'}
                        onDecide={(kind, comment, overrideReason, reclassify, coverage) =>
                          decide(item, row, kind, comment, overrideReason, reclassify, coverage)}
                      />
                    </div>
                  {:else}
                    <!-- No whole row ⇒ this page cannot predict what approving does: no buttons, say so. -->
                    <p class="mt-2 text-xs text-[var(--color-warning-text)]" data-testid="needs-you-context-missing">
                      {rowsFailed
                        ? 'What this asks could not be loaded, so it cannot be decided here. Open it to decide.'
                        : 'This item changed since the list was read. Open it to see where it stands.'}
                    </p>
                  {/if}
                  <a
                    class="mt-2 inline-block text-xs text-[var(--color-link)] hover:underline"
                    href={decideHref(projectId, item.approval_id)}
                    data-testid="needs-you-open-detail">Open the full review →</a
                  >
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      {/if}
    </section>

    {#if blocked.length > 0}
      <!-- Not an ask: listed so a blocked card is never invisible here, but not counted. -->
      <section aria-labelledby="needs-you-blocked" data-testid="needs-you-blocked">
        <h2 id="needs-you-blocked" class="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">Blocked cards ({blocked.length})</h2>
        <ul class="space-y-1 text-sm">
          {#each blocked as c (c.id)}
            <li>
              <a class="text-[var(--color-link)] hover:underline" href={`/projects/${encodeURIComponent(projectId)}/board?card=${encodeURIComponent(c.id)}`}>{c.name}</a>
              {#if c.blocked_reason}<span class="text-xs text-[var(--color-text-muted)]"> — {c.blocked_reason}</span>{/if}
            </li>
          {/each}
        </ul>
      </section>
    {/if}

    <!-- ── THREADS: listed, never counted (a thread has no "waiting for you" state) ── -->
    <ProjectThreadsList {projectId} />

    <!-- ── HISTORY: decided and answered, newest first, who and when ── -->
    <section aria-labelledby="needs-you-history" data-testid="needs-you-history">
      <h2 id="needs-you-history" class="mb-2 text-xs font-bold uppercase tracking-wider text-[var(--color-text-muted)]">
        History{cockpit.decisions && hasData(cockpit.decisions) ? ` (${history.length})` : ''}
      </h2>
      {#if !cockpit.decisions || !hasData(cockpit.decisions)}
        <PanelNote panel={cockpit.decisions ?? { data: null, as_of: null, health: 'down', detail_code: 'not_served' }} title="The history" />
      {:else if history.length === 0}
        <p class="text-xs text-[var(--color-text-muted)]" data-testid="needs-you-history-empty">Nothing has been decided or answered on this project yet.</p>
      {:else}
        {#if cockpit.decisions.health !== 'ok'}<PanelNote panel={cockpit.decisions} title="The history" class="mb-2" />{/if}
        <ol class="divide-y divide-[var(--color-border)] rounded border border-[var(--color-border)] bg-[var(--color-surface)]" data-testid="needs-you-history-rows">
          {#each history as d (d.approval_id)}
            {@const tag = phaseTag(d.phase, phaseLabels)}
            <li class="px-3 py-2 text-xs" data-testid="needs-you-history-row" data-approval={d.approval_id}>
              <div class="flex flex-wrap items-baseline gap-2">
                <a class="font-semibold text-[var(--color-text)] hover:underline" href={decideHref(projectId, d.approval_id)}>{d.subject}</a>
                {#if tag}<span class="rounded bg-[var(--color-surface-strong)] px-1.5 py-px text-[11px] text-[var(--color-text-muted)]" data-testid="needs-you-phase">{tag}</span>{/if}
              </div>
              <p class="mt-0.5 truncate text-[var(--color-text-muted)]">{outcomeWords(d)}</p>
              <p class="mt-0.5 text-[11px] text-[var(--color-text-muted)]" data-testid="needs-you-history-who">
                {actorWords(d.actor_kind, d.actor_name)}{#if d.decided_at} · <time datetime={d.decided_at}>{shortTime(d.decided_at)}</time>{/if}
              </p>
            </li>
          {/each}
        </ol>
      {/if}
    </section>
  {/if}
</div>
