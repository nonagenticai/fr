<!--
  /approvals/[id] — project-agnostic Approval Review. This is the target the
  card-detail "view approval →" links (BlockedGateSection / DecisionsSection /
  ReadiedBriefSection) already point at, and the home for null-project approvals
  (n8n webhook / execution ready-signoff gates) that have no per-project page.

  Mirrors routes/projects/[id]/approve/[approvalId] but without the project
  coupling (no cockpit deeplinks, no docked copilot) — it only has an approval id.
  Phase advance is owned by the n8n callback, not this page.
-->
<script lang="ts">
  import { onMount } from 'svelte';
  import { page } from '$app/state';
  import { goto } from '$app/navigation';
  import { apiClient } from '$lib/api/unified-client';
  import { toast } from '$lib/stores/toast.svelte';
  import AgentSummary from '$lib/components/approval/AgentSummary.svelte';
  import ApprovalDecisionSurface from '$lib/components/approval/ApprovalDecisionSurface.svelte';
  import DossierSection from '$lib/components/approval/DossierSection.svelte';
  import ApprovalDocumentPreview from '$lib/components/approval/ApprovalDocumentPreview.svelte';
  import { auth } from '$lib/stores/auth.svelte';
  import { producerRationale, markUnreadableProducerOutput } from '$lib/approvals/rationale';
  import { changeSummaryGist, isSignoffAsk } from '$lib/approvals/plan-text';
  import ApprovalPlanText from '$lib/components/approval/ApprovalPlanText.svelte';
  import { answerRequired } from '$lib/approvals/question';
  import {
    recordDecision,
    bugFixPickerModel,
    bugReportHref,
    a3ReviewModel,
    artifactRefLink,
    type Decision,
  } from './page-helpers';
  import A3ReviewPanel from './A3ReviewPanel.svelte';
  import { getReport } from '$lib/api/reports';
  import { parseBugReportDetails, type BugReportBug } from '$lib/api/bug-report';
  import { toastDecisionNotice } from '$lib/approvals/toast-notice';
  // ⭐ The PERSISTED half of the same question `toastDecisionNotice` answers
  // transiently. The toast is shown once, to whoever pressed the button; this
  // page is where the row is met again hours later, and until now it rendered a
  // decided-but-undelivered approval identically to one whose card moved. See
  // $lib/approvals/callback-state.
  import { callbackRowNotice, callbackToneClasses } from '$lib/approvals/callback-state';
  import type { Approval } from '$lib/types/api';
  import { approvalUserLabel } from '$lib/approvals/user-label';
  import { loadProject } from '$lib/projects/load-project';

  const approvalId = $derived(page.params.id ?? '');

  let approval = $state<Approval | null>(null);
  let loading = $state(true);
  let busy = $state(false);
  let error = $state<string | null>(null);
  let decided = $state<{ kind: Decision; message: string } | null>(null);
  // fr-agui SPEC §7.5: this inbox page STAYS (no redirect), and offers "Open in
  // project" → /projects/P/approve/[id] ONLY when the caller can read P —
  // decided by GET /api/projects/:id itself (via loadProject), so a peer's
  // project never becomes a link into a 404 project shell.
  let openInProjectHref = $state<string | null>(null);

  async function resolveOpenInProject(a: Approval): Promise<void> {
    const pid = typeof a.project_id === 'string' && a.project_id ? a.project_id : null;
    if (!pid) return;
    const res = await loadProject(pid);
    if (res.project && approval?.id === a.id) {
      openInProjectHref = `/projects/${encodeURIComponent(pid)}/approve/${encodeURIComponent(a.id)}`;
    }
  }

  // ── G-12 A1 per-bug reject picker (bug-fix authorization rows ONLY) ──
  // null on every other row, so nothing below renders or travels for them. Every rule
  // behind it is in page-helpers.ts § "G-12 A1", read from backend u3-gates.ts.
  const bugModel = $derived(approval ? bugFixPickerModel(approval) : null);
  const reportHref = $derived(bugReportHref(bugModel));
  let rejectedBugIds = $state<string[]>([]);
  let rejectReasonCode = $state('');
  // Kind / severity / location per bug, from the cited report. Optional: on any failure
  // the picker still lists the ids, which is all the decision needs.
  let bugDetails = $state<Record<string, BugReportBug>>({});
  const approvingCount = $derived(
    bugModel ? bugModel.bugIds.filter((id) => !rejectedBugIds.includes(id)).length : 0,
  );

  // ── G-12 A3 feature-design review (execution.feature_design_approval ONLY) ──
  // null on every other row. Rules: page-helpers.ts § "G-12 A3", read from backend u3-gates.ts.
  const a3Model = $derived(approval ? a3ReviewModel(approval) : null);
  // D13: the ONE artifact this approval is about (null when it names none).
  const artifactLink = $derived(approval ? artifactRefLink(approval) : null);
  let a3RejectCode = $state('');

  function toggleBug(id: string, on: boolean): void {
    rejectedBugIds = on ? [...rejectedBugIds.filter((x) => x !== id), id] : rejectedBugIds.filter((x) => x !== id);
  }

  async function loadBugDetails(reportId: string): Promise<void> {
    try {
      const parsed = parseBugReportDetails((await getReport(reportId)).details);
      if (parsed) bugDetails = Object.fromEntries(parsed.bugs.map((b) => [b.id, b]));
    } catch {
      // The ids alone are enough to decide; the link still opens the full report.
    }
  }

  onMount(async () => {
    if (!approvalId) {
      loading = false;
      return;
    }
    try {
      approval = await apiClient.approvals.get(approvalId);
      // If it was actually DECIDED, reflect the outcome up front.
      //
      // ⛔ `voided` and `expired` are deliberately NOT mapped here, and never
      // may be. `decided` drives DecisionBar's outcome line ("Approved —
      // the system advances the phase."), which is a statement that a human
      // chose something. Nobody chose anything on either of those rows: an
      // expiry is machine-written by backend/src/workers/approval-expiry.ts
      // when `expires_at` passes, and a void is an operator WITHDRAWING an ask
      // that could never have been answered (migration 110). Both are terminal
      // and non-deciding — see the ApprovalStatus comment in
      // `$lib/types/api.ts` — so they get their own honest states below rather
      // than being dressed up as a decision.
      void resolveOpenInProject(approval);
      const model = bugFixPickerModel(approval);
      if (model?.reportId) void loadBugDetails(model.reportId);
      if (approval.status === 'approved') decided = { kind: 'approve', message: 'Approved.' };
      else if (approval.status === 'rejected') decided = { kind: 'reject', message: 'Rejected.' };
    } catch (e) {
      error = e instanceof Error ? e.message : 'Failed to load approval';
    } finally {
      loading = false;
    }
  });

  // ⛔ EVERY DECISION RULE THAT USED TO BE DERIVED HERE NOW LIVES IN
  // `ApprovalDecisionSurface` — the roster + `isPending` gate, the void audit
  // trail, the question presentation, the broken-gate terms and the approve
  // consequence. NOT because this page was wrong: it was the one surface that
  // had them ALL, and the component below is this block lifted verbatim.
  //
  // It moved because it was being maintained in three places. Two sibling
  // surfaces — `/projects/[id]/approve/[approvalId]` and the NEEDS YOU queue —
  // carried their own decision wiring, each repair landed on this page alone,
  // and by 2026-09-14 the project page still gated a live bar on
  // `isRequiredApprover` with no status term (a 422 on every button of a decided
  // row) and the queue still approved with a bare optional comment (a red toast
  // on every QUESTION and broken-gate row, with the question never shown). One
  // component means the next repair cannot land on one third of the product.
  //
  // The single derivation that stays is the argument to the SECOND barrier:
  // `recordDecision` refuses an answerless approve before any request is sent,
  // and takes `{ isQuestion }` as a required named field so no call site can
  // omit it. `answerRequired`, not `isQuestion` — the union of "typed QUESTION"
  // and "the row STATES a question", which is the server's own predicate
  // (`backend/src/domain/engagement/deblock-actions.ts :: classifyAnswerDemand`).
  // `'approved'`, not the row's status: this is a property of the decision about
  // to be taken, and rejection is exempt.
  const answerNeeded = $derived(approval ? answerRequired(approval, 'approved') : false);

  // ⛔ Both of these branch on `producerRationale(...)`, NOT on truthiness.
  //
  // The backend stopped writing NULL/'' to these columns on 2026-09-03: a producer
  // that supplied nothing now gets fr's marked statement of absence, so the
  // approver can SEE the gap instead of the section silently not being there. That
  // makes `approval.impact_analysis` ALWAYS truthy, and read literally the two
  // derivations below then lied — the recommendation told every approver to
  // "review the impact analysis below" about ~333 characters of fr saying there
  // ISN'T one, and the headline carried the same boilerplate as its subtitle.
  //
  // `producerRationale` returns the text only when a human actually wrote it, so
  // the headline stays clean and the prompt fires only when there is something to
  // read. The absence itself is NOT hidden: it still renders in the "What changed"
  // / "Impact & risk" dossier sections below, which is where it belongs — visible,
  // attributable, and not dressed up as content.
  // ⭐ MARK, THEN ESCAPE — the order is load-bearing.
  //
  // `AgentSummary` renders this with `{@html}`, so the string below is markup.
  // `markUnreadableProducerOutput` matches on the producer's own characters
  // (`[object Object]`, `step undefined`), and escaping first would hand it
  // `&lt;`-mangled text whose token boundaries have moved. Marking first is
  // safe in the other direction because the marker carries no HTML-special
  // character, so `escapeHtml` still sees — and still neutralises — every `<`
  // and `&` the producer wrote. Measured live 2026-09-15 on
  // `/approvals/b2ddf71e-…`: this headline printed `step undefined` six times,
  // raw, while the helper that formats exactly that case sat in the bundle
  // wired only into three improvement gate panels.
  //
  // ⛔ Still `producerRationale` for the BRANCH. Whether there is a change
  // summary at all is the absence question, and marking never answers it: a
  // row whose summary is fr's absence marker must not grow a headline suffix.
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
    return s.replace(/[&<>"']/g, (c) =>
      c === '&'
        ? '&amp;'
        : c === '<'
          ? '&lt;'
          : c === '>'
            ? '&gt;'
            : c === '"'
              ? '&quot;'
              : '&#39;',
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
      const outcome = await recordDecision(
        approval.id,
        kind,
        comment,
        {
          isQuestion: answerNeeded,
          answerRequiredOnReclassify: answerRequired(approval, 'approved', 'RECLASSIFY'),
        },
        overrideReason,
        reclassify,
        coverage,
        bugModel?.template
          ? {
              template: bugModel.template,
              bugIds: bugModel.bugIds,
              rejectedBugIds,
              rejectReasonCode,
            }
          : undefined,
        a3Model
          ? {
              template: a3Model.template,
              designHash: a3Model.designHash,
              hasHandoffContract: a3Model.hasHandoffContract,
              rejectReasonCode: a3RejectCode,
            }
          : undefined,
      );
      decided = outcome;
      // ⛔ NOT `toast.success('Decision recorded.')`. That line was true and
      // useless: it reported the half fr controls (the row is written) and
      // stayed silent about the half the operator is actually waiting on (did
      // the card move). `notice.tone` is `success` only when the n8n callback
      // was delivered; every other outcome says so, in words, in the register
      // its severity deserves. See $lib/approvals/decision-callback.
      const { notice } = outcome;
      toastDecisionNotice(notice);
      // Drop back to the approvals queue after a beat — but only when the card
      // actually moved. On any other outcome the operator is being told
      // something they must read, and navigating out from under it is how the
      // old success toast managed to be invisible as well as wrong.
      if (notice.delivered) setTimeout(() => goto('/approvals'), 900);
    } catch (e) {
      // Also the surface for recordDecision's client-side refusal of an
      // unanswered question — the same path an API error already took.
      toast.error(e instanceof Error ? e.message : 'Failed to record decision');
    } finally {
      busy = false;
    }
  }

  // `null` while loading, on every pending row, and on every row that resolved
  // cleanly — the chip's presence IS the signal, so there is no placeholder.
  const callbackNotice = $derived(approval ? callbackRowNotice(approval) : null);

  const fmt = (d: string | Date | null | undefined): string =>
    d ? new Date(d).toLocaleString() : '—';
</script>

<div class="min-h-[calc(100vh-4rem)] bg-[var(--color-bg)]">
  <header class="flex flex-col gap-1 border-b border-[var(--color-border)] bg-[var(--color-surface)] px-6 py-4">
    <div class="flex items-center justify-between gap-2">
      <a
        href="/approvals"
        class="text-xs font-semibold text-[var(--color-text-muted)] hover:text-[var(--color-accent)]"
        >← Approvals</a
      >
      {#if openInProjectHref}
        <a
          href={openInProjectHref}
          data-testid="approval-open-in-project"
          class="text-xs font-semibold text-[var(--color-accent)] hover:underline">Open in project →</a
        >
      {/if}
    </div>
    <div class="flex items-center gap-2">
      <h1 class="text-xl font-semibold text-[var(--color-text)]">Approval review</h1>
      <!-- Mirrors the queue row's chip, same module, same tone rule: only
           `send_exhausted` / `card_unreadable` may be red; "not confirmed" and
           "unknown" are warnings with no failure word in them. -->
      {#if callbackNotice}
        <span
          data-testid={callbackNotice.testId}
          data-callback-state={callbackNotice.state}
          title={callbackNotice.message}
          class="inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium {callbackToneClasses(
            callbackNotice.tone,
          )}"
        >
          {callbackNotice.label}
        </span>
      {/if}
    </div>
  </header>

  <div class="mx-auto max-w-3xl space-y-4 p-6">
    {#if loading}
      <p class="text-sm text-[var(--color-text-muted)]">Loading approval…</p>
    {:else if error}
      <div
        class="rounded-[var(--radius-sm)] border border-[var(--color-danger-border)] bg-[var(--color-danger-bg)] px-3 py-2 text-sm text-[var(--color-danger)]"
        data-testid="approval-error"
      >
        {error}
      </div>
    {:else if approval}
      <AgentSummary {summary} {recommendation} copilotHint={false} />

      <!-- ⛔ NO RE-DECIDE AFFORDANCE HERE, and none anywhere else for these
           states. The decision is spent; the only honest action is to open the
           card. `ApprovalDecisionSurface` below already refuses to offer a
           decision bar on a non-pending row, and this note must not reopen the
           question it closed. -->
      {#if callbackNotice}
        <div
          data-testid="approval-callback-note"
          data-callback-state={callbackNotice.state}
          class="rounded-[var(--radius-sm)] border p-3 text-sm {callbackToneClasses(
            callbackNotice.tone,
          )}"
        >
          <p class="font-medium">{callbackNotice.label}</p>
          <p class="mt-1">{callbackNotice.message}</p>
        </div>
      {/if}

      {#if bugModel}
        <section
          data-testid="bug-fix-picker"
          class="space-y-2 rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] p-3 text-sm"
        >
          <div class="flex items-center justify-between gap-2">
            <h2 class="font-semibold text-[var(--color-text)]">Bugs in this report</h2>
            {#if reportHref}
              <a
                href={reportHref}
                data-testid="bug-fix-report-link"
                class="text-xs font-semibold text-[var(--color-accent)] hover:underline">Open the bug report →</a
              >
            {/if}
          </div>
          {#if bugModel.template}
            <p class="text-xs text-[var(--color-text-muted)]" data-testid="bug-fix-count">
              Approving {approvingCount} of {bugModel.bugIds.length}
            </p>
          {/if}
          <ul class="space-y-1">
            {#each bugModel.bugIds as id (id)}
              {@const bug = bugDetails[id]}
              <li class="flex items-start gap-2">
                {#if bugModel.template}
                  <label class="flex shrink-0 items-center gap-1 text-xs text-[var(--color-text-muted)]">
                    <input
                      type="checkbox"
                      data-testid="bug-fix-reject"
                      data-bug-id={id}
                      checked={rejectedBugIds.includes(id)}
                      disabled={busy}
                      onchange={(e) => toggleBug(id, (e.currentTarget as HTMLInputElement).checked)}
                    />
                    reject
                  </label>
                {/if}
                <span class="min-w-0">
                  <span class="block break-all font-mono text-xs text-[var(--color-text)]">{id}</span>
                  {#if bug}
                    <span class="block text-xs text-[var(--color-text-muted)]">
                      {bug.kind}{bug.severity ? ` · ${bug.severity}` : ''} · {bug.location.file}:{bug.location.line}
                    </span>
                  {/if}
                </span>
              </li>
            {/each}
          </ul>
          {#if bugModel.template}
            <label class="flex flex-col gap-1 text-xs text-[var(--color-text-muted)]">
              Reject reason code (required for any rejected bug, and for Reject)
              <select
                data-testid="bug-fix-reject-code"
                bind:value={rejectReasonCode}
                disabled={busy}
                class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-bg)] px-2 py-1 text-sm text-[var(--color-text)]"
              >
                <option value="">— choose —</option>
                {#each bugModel.template.reject_codes as code (code)}
                  <option value={code}>{code}</option>
                {/each}
              </select>
            </label>
            {#if approvingCount === 0}
              <p class="text-xs text-[var(--color-danger-text)]" data-testid="bug-fix-all-rejected">
                Every bug is ticked: Approve would authorise no fix and is refused. Use Reject to reject the whole
                report.
              </p>
            {/if}
            <p class="text-xs text-[var(--color-text-muted)]">
              This approval takes no free-text comment — leave the comment box empty.
            </p>
          {/if}
        </section>
      {/if}

      {#if a3Model}
        <A3ReviewPanel model={a3Model} {busy} bind:rejectReasonCode={a3RejectCode} />
      {/if}

      <!-- The text being decided (for a conveyor sign-off: the whole plan),
           ABOVE the decision bar and with its line breaks kept. -->
      {#if isSignoffAsk(approval)}<ApprovalPlanText {approval} />{/if}

      <!-- ONE implementation, shared with /projects/[id]/approve/[approvalId]
           and the NEEDS YOU queue: the question text, the honest notice when
           there is none, the roster + status gate, the two terminal
           non-decided states, the catch-all for the statuses no branch claims,
           and the DecisionBar with every prop it needs. This page adds nothing
           to it — it was lifted FROM here. -->
      <ApprovalDecisionSurface
        {approval}
        user={auth.user}
        canOverrideBrokenGate={auth.isSuperAdmin}
        canVoid={auth.isSuperAdmin}
        {decided}
        {busy}
        onDecide={decide}
        decideBlockedReason={a3Model?.disabledReason ?? null}
      />

      {#if !isSignoffAsk(approval)}<ApprovalPlanText {approval} />{/if}

      {#if approval.document}
        <DossierSection title="Document">
          <ApprovalDocumentPreview approvalId={approval.id} document={approval.document} />
        </DossierSection>
      {/if}

      {#if artifactLink}
        <DossierSection title="Artifact">
          <a
            href={artifactLink.href}
            class="font-mono text-xs font-semibold text-[var(--color-accent)] hover:underline break-all"
            data-testid="approval-artifact-link">{artifactLink.label}</a
          >
        </DossierSection>
      {/if}

      {#if approval.impact_analysis}
        <DossierSection title="Impact & risk">
          <p class="whitespace-pre-wrap">{markUnreadableProducerOutput(approval.impact_analysis)}</p>
        </DossierSection>
      {/if}

      {#if approval.required_approvers && approval.required_approvers.length > 0}
        <DossierSection title="Required approvers">
          <ul class="space-y-1">
            {#each approval.required_approvers as r (r.user_id)}
              <li class="flex items-center justify-between">
                <!-- UI review 2026-10-07: name, not the raw id (same identities the
                     list page renders); and a row on a withdrawn/expired/
                     rejected approval is not "pending" — nobody can still sign. -->
                <span title={r.user_id}>{r.role ?? 'approver'} · {approvalUserLabel(approval, r.user_id)}</span>
                <span class={r.approved ? 'text-[var(--color-success)]' : 'text-[var(--color-text-muted)]'}>
                  {r.approved ? '✓ approved' : approval.status === 'pending' || approval.status === 'approved' ? 'pending' : approval.status}
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
        data-testid="approval-not-found"
      >
        Approval not found.
      </div>
    {/if}
  </div>
</div>
