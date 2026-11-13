<!--
  /projects/[id]/approve/[approvalId] — the Approval Review (the surface the UI
  exists for). Left = the agent-gathered dossier (AgentSummary → DecisionBar →
  DossierSections, each deeplinking to its Inspect view). Right = the docked
  copilot holding the approval context. Reuses the B approval/ primitives + the
  live approvals API; phase advance is owned by the n8n callback, not this page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { apiClient } from '$lib/api/unified-client';
  import { toast } from '$lib/stores/toast.svelte';
  import { threads } from '$lib/stores/threads.svelte';
  import MessageList from '$lib/components/chat/MessageList.svelte';
  import ChatInput from '$lib/components/chat/ChatInput.svelte';
  import AgentSummary from '$lib/components/approval/AgentSummary.svelte';
  import ApprovalDecisionSurface from '$lib/components/approval/ApprovalDecisionSurface.svelte';
  import DossierSection from '$lib/components/approval/DossierSection.svelte';
  import { projectNavHref } from '$lib/layout/navConfig';
  import { auth } from '$lib/stores/auth.svelte';
  // ⛔ `markUnreadableProducerOutput` is REUSED from the shared module, never
  // re-implemented and never loosened here. This page is one CLICK from
  // `NeedsYouQueue`, which already marks these same two columns — an approver who
  // saw `[marker]` in the queue and a raw `[object Object]` here would reasonably
  // conclude the queue had rewritten the producer's words.
  import { producerRationale, markUnreadableProducerOutput } from '$lib/approvals/rationale';
  import { changeSummaryGist, isSignoffAsk } from '$lib/approvals/plan-text';
  import ApprovalPlanText from '$lib/components/approval/ApprovalPlanText.svelte';
  import { answerRequired } from '$lib/approvals/question';
  import { recordDecision, type Decision } from '../../../../../approvals/[id]/page-helpers';
  import { toastDecisionNotice } from '$lib/approvals/toast-notice';
  import { approvalUserLabel } from '$lib/approvals/user-label';
  import type { Approval } from '$lib/types/api';

  const projectId = $derived(page.params.id ?? '');
  const approvalId = $derived(page.params.approvalId ?? '');

  let approval = $state<Approval | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let decided = $state<{ kind: Decision; message: string } | null>(null);

  onMount(async () => {
    if (!approvalId) {
      loading = false;
      return;
    }
    try {
      approval = await apiClient.approvals.get(approvalId);
      // If it's already resolved, reflect the outcome up front.
      if (approval.status === 'approved') decided = { kind: 'approve', message: 'Approved.' };
      else if (approval.status === 'rejected') decided = { kind: 'reject', message: 'Rejected.' };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load approval';
    } finally {
      loading = false;
    }
    // Surface this project's threads so the docked copilot opens scoped.
    threads.pendingProjectId = projectId;
    await threads.list().catch(() => {});
  });

  // ⛔ THE GATE, AND EVERY OTHER DECISION RULE, NOW LIVES IN
  // `ApprovalDecisionSurface`. What stood here was a SECOND implementation of the
  // wiring `/approvals/[id]` already had, and it had drifted badly:
  //
  //   - the gate was `isRequiredApprover` ALONE — no `!alreadyDecided`, no
  //     `isPending` — so a rostered approver opening a row that is decided,
  //     voided or expired got a live Approve / Reject / Request-changes bar whose
  //     every button PUTs and comes back `422 Approval is no longer pending`,
  //     with nothing recoverable on screen and the `{:else}` branch telling them
  //     instead that they were "not an assigned approver", which they were.
  //   - it forwarded no `brokenGateTerms`, no `canOverrideBrokenGate` and no
  //     `approveConsequence`, and it never rendered `questionInfo.questions` at
  //     all — so the one surface the NEEDS YOU queue links to as "Review →"
  //     showed the answer box without ever showing the question.
  //
  // Porting those four fixes here would have made a THIRD copy of the same
  // wiring, which is how the second one got out of date. The surface is shared
  // instead; this page keeps only what is genuinely its own (the project
  // deeplinks and the docked copilot).
  //
  // The one derivation that stays is the second barrier's argument:
  // `recordDecision` refuses an answerless approve BEFORE the request, and it
  // takes `{ isQuestion }` as a required named field precisely so a call site
  // cannot omit it. ⛔ `answerRequired`, NOT `isQuestion` — the union of "typed
  // QUESTION" and "the row STATES a question", the same predicate the server
  // refuses on (`deblock-actions.ts :: classifyAnswerDemand`). Bound to
  // `isQuestion` this page demanded an answer on exactly the rows that state
  // nothing and withheld it from the only rows that ask something.
  const isQuestionApproval = $derived(approval ? answerRequired(approval, 'approved') : false);

  // The agent's gist: synthesised from the typed fields the approval carries.
  //
  // ⛔ Branches on `producerRationale(...)`, not truthiness — and this page is the
  // one the NEEDS YOU queue links to ("Review →"), so leaving it on truthiness
  // while fixing its `/approvals/[id]` twin would fix the alias nobody arrives
  // through. Since 2026-09-03 the backend writes a marked ABSENCE rather than
  // NULL when a producer supplies no rationale, which makes these fields always
  // truthy; `producerRationale` is true only for text a human actually wrote, so
  // the headline is not padded with the absence sentence and the approver is not
  // told to review an impact analysis that says there isn't one. The absence
  // still renders in the dossier sections below — seen, but not mistaken for
  // content. See $lib/approvals/rationale.ts.
  const summary = $derived(
    approval
      ? `<strong>${escapeHtml(markUnreadableProducerOutput(approval.description))}</strong>${
          producerRationale(approval.change_summary)
            ? ` — ${escapeHtml(markUnreadableProducerOutput(changeSummaryGist(approval.change_summary ?? '')))}`
            : ''
        }`
      : '',
  );
  const recommendation = $derived(
    producerRationale(approval?.impact_analysis)
      ? '✦ Review the impact analysis below before deciding.'
      : null,
  );

  function escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, (c) =>
      c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;',
    );
  }

  async function decide(
    kind: Decision,
    comment: string,
    overrideReason?: string,
    reclassify?: { newCardType: string },
    coverage?: { rejectedCriterionIds: string[] },
  ) {
    if (!approval || busy) return;
    busy = true;
    try {
      // The shared helper owns the decision→API mapping AND the second barrier:
      // approving a QUESTION with no answer throws BEFORE any request, so the
      // doomed 422 is never spent. Reject / request-changes are deliberately
      // unguarded there, matching the server.
      //
      // ⭐ `overrideReason` IS A THIRD ARGUMENT, NOT A SECOND MEANING FOR
      // `comment`, and this page used to DROP it on the floor: it accepted only
      // `(kind, comment)`, so a super-admin who typed a broken-gate override
      // reason here sent an approve with no `reason` and got the same 422 the
      // override exists to lift. The server reads `reason` for the #1064
      // override and `comment` for the answer, and subtracts a reason it
      // consumed as an override from the persisted answer — merging them would
      // re-create, on the client, the conflation that fix removes.
      const outcome = await recordDecision(
        approval.id,
        kind,
        comment,
        {
          isQuestion: isQuestionApproval,
          answerRequiredOnReclassify: answerRequired(approval, 'approved', 'RECLASSIFY'),
        },
        overrideReason,
        reclassify,
        coverage,
      );
      decided = outcome;
      // ⛔ NOT an unconditional success. `notice.tone` is `success` only when the
      // n8n callback was delivered — i.e. only when the card actually moved. A
      // recorded decision whose callback failed leaves the card BLOCKED, and the
      // green toast that used to fire here told the operator the opposite. See
      // $lib/approvals/decision-callback.
      const { notice } = outcome;
      toastDecisionNotice(notice);
      // Only leave the page when the card moved; otherwise the operator has a
      // notice to read and an action to take here.
      if (notice.delivered) {
        setTimeout(() => projectId && goto(projectNavHref(projectId, '')), 900);
      }
    } catch (e) {
      // Also the surface for recordDecision's client-side refusal of an
      // unanswered question — the same path an API error already took. The
      // panel this replaced returned silently here and told the operator nothing.
      toast.error(e instanceof Error ? e.message : 'Failed to record decision');
    } finally {
      busy = false;
    }
  }

  const fmt = (d: string | Date | null | undefined): string =>
    d ? new Date(d).toLocaleString() : '—';
</script>

<div class="grid h-[calc(100vh-4rem)] grid-cols-1 xl:grid-cols-[minmax(0,1fr)_360px]">
  <!-- Dossier -->
  <div class="overflow-y-auto bg-[var(--color-bg)]">
    <header class="flex flex-col gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
      <a
        href={projectNavHref(projectId, 'needs-you')}
        class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >← Needs you</a
      >
      <h1 class="text-xl font-semibold text-[var(--color-text)]">Approval review</h1>
    </header>

    <div class="mx-auto max-w-3xl space-y-4 p-6">
      {#if loading}
        <p class="text-sm text-[var(--color-text-muted)]">Loading approval…</p>
      {:else if error}
        <div
          class="rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
        >
          {error}
        </div>
      {:else if approval}
        <AgentSummary {summary} {recommendation} />

        <!-- The text being decided (for a conveyor sign-off: the whole plan),
             ABOVE the decision bar and with its line breaks kept. -->
        {#if isSignoffAsk(approval)}<ApprovalPlanText {approval} />{/if}

        <!-- ONE implementation, shared with /approvals/[id] and the NEEDS YOU
             queue: the question text, the honest notice when there is none, the
             roster + status gate, the terminal-state notes, and the DecisionBar
             with every prop it needs. This page adds nothing to it. -->
        <ApprovalDecisionSurface
          {approval}
          user={auth.user}
          canOverrideBrokenGate={auth.isSuperAdmin}
          canVoid={auth.isSuperAdmin}
          {decided}
          {busy}
          onDecide={decide}
        />

        {#if !isSignoffAsk(approval)}<ApprovalPlanText {approval} />{/if}

        {#if approval.impact_analysis}
          <DossierSection
            title="Impact & risk"
            deeplink="↗ architecture"
            onDeeplink={() => goto(projectNavHref(projectId, 'architecture/graph'))}
          >
            <p class="whitespace-pre-wrap">{markUnreadableProducerOutput(approval.impact_analysis)}</p>
          </DossierSection>
        {/if}

        <DossierSection
          title="Decomposition"
          deeplink="↗ goal integrity"
          onDeeplink={() => goto(projectNavHref(projectId, 'goal'))}
        >
          <p class="text-[var(--color-text-muted)]">
            How this request decomposes into epics → enablers → features → cards, and whether it
            still rolls up to the deliverable.
          </p>
        </DossierSection>

        <DossierSection
          title="Evidence & provenance"
          deeplink="↗ executions"
          onDeeplink={() => goto(projectNavHref(projectId, 'flow-runs'))}
        >
          <p class="text-[var(--color-text-muted)]">The runs and outcomes behind this gate.</p>
        </DossierSection>

        {#if approval.required_approvers && approval.required_approvers.length > 0}
          <DossierSection title="Required approvers">
            <ul class="space-y-1">
              {#each approval.required_approvers as r (r.user_id)}
                <li class="flex items-center justify-between">
                  <span title={r.user_id} data-testid="required-approver-label">{r.role ?? 'approver'} · {approvalUserLabel(approval, r.user_id)}</span>
                  <span class={r.approved ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}>
                    {r.approved ? '✓ approved' : 'pending'}
                  </span>
                </li>
              {/each}
            </ul>
          </DossierSection>
        {/if}

        <DossierSection title="Timeline">
          <dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[var(--color-text-muted)]">
            <dt>Requested</dt>
            <dd>{fmt(approval.created_at)}</dd>
            <dt>Expires</dt>
            <dd>{fmt(approval.expires_at)}</dd>
            <dt>Status</dt>
            <dd class="font-semibold text-[var(--color-text)]">{approval.status}</dd>
          </dl>
        </DossierSection>
      {:else}
        <div
          class="rounded-lg border border-dashed border-[var(--color-border)] p-6 text-center text-sm text-[var(--color-text-muted)]"
        >
          Approval not found.
        </div>
      {/if}
    </div>
  </div>

  <!-- Docked copilot -->
  <aside class="hidden min-h-0 flex-col border-l border-[var(--color-border)] bg-[var(--color-surface)] xl:flex">
    <div class="flex items-center gap-2.5 border-b border-[var(--color-border)] bg-[var(--color-bg)] px-4 py-2.5">
      <span
        class="grid h-6 w-6 place-items-center rounded-[7px] bg-gradient-to-br from-[var(--color-primary)] to-[var(--color-accent-strong)] text-[11px] font-bold text-white"
        >fr</span
      >
      <span class="text-sm font-bold">Copilot</span>
      <span class="text-[11px] text-[var(--color-text-muted)]">— ask about this approval</span>
    </div>
    <div class="flex min-h-0 flex-1 flex-col">
      <MessageList />
      <ChatInput />
    </div>
  </aside>
</div>
