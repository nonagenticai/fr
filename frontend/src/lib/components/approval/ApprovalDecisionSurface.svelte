<!--
  ApprovalDecisionSurface — THE decision surface. One implementation, every
  surface that lets a human decide an approval.

  ⛔ WHY THIS COMPONENT EXISTS, AND WHAT IT IS NOT.
  It is NOT a new abstraction over the approval rules: `question.ts`, `canAct.ts`
  and `DecisionBar.svelte` already own every rule it applies, and this file adds
  none. What was duplicated was the *wiring* — which predicates a surface reads,
  which props it forwards to `DecisionBar`, and which honest note it renders when
  the bar must NOT appear — and it was duplicated THREE times, in
  `routes/approvals/[id]`, `routes/projects/[id]/approve/[approvalId]` and
  `lib/components/workspace/NeedsYouQueue`. Each round of repair landed on ONE of
  them:

    - `/approvals/[id]` got `&& isPending`, the question text, the question
      notice, `brokenGateTerms`, `canOverrideBrokenGate` and `approveConsequence`.
    - `/projects/[id]/approve/[approvalId]` got NONE of those. It gated a live
      Approve/Reject bar on `isRequiredApprover` alone, so a rostered approver
      opening a decided / voided / expired row was handed three buttons that all
      422 `Approval is no longer pending`, and it rendered no question at all.
    - `NeedsYouQueue` got none of them either, and had no `DecisionBar`: an
      unlabelled "Comment / reason (optional)" input and a bare
      `approve(id, comment ? {comment} : undefined)`. On a QUESTION row or a
      broken-gate row the server 422s and the operator gets a red toast with
      nothing on screen explaining it. That is the reported complaint, verbatim.

  So the fix is convergence, not a fourth port. Everything below was LIFTED from
  the repaired `/approvals/[id]` page — same markup, same `data-testid`s, same
  branch order — and all three surfaces now mount this. A behaviour that lands
  here reaches every surface at once, which is the property whose absence
  produced the defect.

  ⛔ THE BRANCH ORDER IS LOAD-BEARING; do not reorder it for tidiness. The two
  terminal non-decided states (`voided`, `expired`) come FIRST among the
  read-only branches because they are true of every reader, rostered or not, and
  the notes after them are pending-only sentences. Before that ordering existed,
  a voided row told its reader it was "awaiting sign-off from the approver(s)
  listed below" — false in both directions.
-->
<script lang="ts">
  import DecisionBar from './DecisionBar.svelte';
  import {
    canActOnApproval,
    isRequiredApprover,
    isSuperAdminDecider,
    isTenantMemberDecider,
    type ApproverIdentity,
  } from '$lib/approvals/canAct';
  import {
    answerRequired,
    answerDemandOf,
    questionPresentation,
    brokenGateTermsOf,
    approveConsequenceNotice,
    proposedAnswerOf,
    ANSWER_CONTRACT,
  } from '$lib/approvals/question';
  import type { DecisionNotice } from '$lib/approvals/decision-callback';
  import {
    selfDecisionStamp,
    selfDecisionHeadline,
  } from '$lib/approvals/self-decision';
  import { apiClient } from '$lib/api/unified-client';
  import {
    reclassifyEligible,
    currentCardTypeOf,
    loadCardTypeRoster,
    type ReclassifyChoice,
  } from '$lib/approvals/reclassify';
  import {
    coverageArtifactsOf,
    coverageCriteriaOf,
    isCoverageRow,
    type CoverageChoice,
  } from '$lib/approvals/coverage';
  import type { Approval } from '$lib/types/api';
  import { approvalUserLabel } from '$lib/approvals/user-label';

  // Structurally identical to DecisionBar's `Decision` and to page-helpers'.
  // Declared locally for the same reason page-helpers declares it: a type
  // imported from a `.svelte` module is not reliably resolvable from every
  // consumer of this tree, and the union is three literals.
  type Decision = 'approve' | 'changes' | 'reject';

  interface Props {
    /**
     * The WHOLE row. ⛔ Not a projection, and not a cockpit-shaped adapter: this
     * component reads `metadata` (the question, the deblock action, the gate
     * terms) and `status` (pending vs terminal), and a caller that can only
     * supply the narrow shape cannot use this component — it must say so on
     * screen instead of offering buttons whose outcome it cannot predict. See
     * `NeedsYouQueue`'s hydration note for the one caller in that position.
     */
    approval: Approval;
    /** The viewer, for the roster rule. Pass `auth.user`. */
    user: ApproverIdentity | null | undefined;
    /** `auth.isSuperAdmin` — gates the broken-gate override input, never the row. */
    canOverrideBrokenGate?: boolean;
    /** Set once a decision has been taken HERE (or reflected from the row's status). */
    decided?: { kind: Decision; message: string; notice?: DecisionNotice } | null;
    busy?: boolean;
    /** The bar's own generic prompt. Chrome — never the row's question. */
    question?: string;
    onDecide?: (
      kind: Decision,
      comment: string,
      overrideReason?: string,
      reclassify?: ReclassifyChoice,
      coverage?: CoverageChoice,
    ) => void;
    /**
     * `auth.isSuperAdmin` — gates the WITHDRAW (void) control, and nothing else.
     *
     * ⛔ THE PRODUCER FOR AN AUDIT PANEL THAT ALREADY EXISTED. This component has
     * rendered `voided_at` / `voided_reason` / `voided_by` since migration 110, but
     * `POST /api/approvals/void` was reachable only by curl or the in-cluster CLI:
     * a consumer with no in-product producer. The scale is recorded IN THIS REPO, at
     * `backend/src/db/schema.ts:891-893`: "Measured 2026-09-05: 240 pending rows
     * unanswerable by construction, 192 of them holding a card in BLOCKED."
     * ⚠️ That figure is dated, not live — re-count before quoting it as current. It is
     * cited here because it is the reason this control exists: 192 cards were
     * clearable only from a shell.
     *
     * ⚠️ VISIBILITY ONLY, exactly like `canOverrideBrokenGate`. The real gate is the
     * `super_admin` Keycloak realm role checked server-side
     * (`backend/src/lib/super-admin-gate.ts`, asserted in
     * `backend/src/routes/approval-void.ts`); this prop only decides whether a
     * control the server would accept is offered at all. Callers pass
     * `auth.isSuperAdmin` — the same expression they already pass above — never a
     * locally re-derived role test.
     */
    canVoid?: boolean;
    /**
     * Called once a void has actually LANDED (`outcome === 'voided'`), so the caller
     * can refetch the row / drop it from its queue. Optional: the control states its
     * own outcome on screen, so a caller that does not wire this is honest, just
     * stale until its next load.
     */
    onVoided?: (id: string) => void;
    /**
     * Set by a caller that KNOWS this row cannot be decided from here (today: an A3 design
     * approval missing its design_hash / handoff_contract / G-12 template). While the row is
     * pending and undecided, the decision bar is replaced by this reason — never a live bar
     * whose every button is a guaranteed refusal. Absent on every other row.
     */
    decideBlockedReason?: string | null;
  }

  let {
    approval,
    user,
    canOverrideBrokenGate = false,
    decided = null,
    busy = false,
    question = "What's your decision on this approval?",
    onDecide,
    canVoid = false,
    onVoided,
    decideBlockedReason = null,
  }: Props = $props();

  /**
   * ⛔ THE HALF THAT WAS MISSING ON TWO OF THE THREE SURFACES. `canActOnApproval`
   * answers ONE question — "is this user on the roster, and have they already
   * voted" — and never reads `status` at all (`$lib/approvals/canAct.ts`, whose
   * `Pick<>` is literally `'required_approvers' | 'decisions'`). Without
   * `&& isPending` a rostered approver is handed a live Approve / Reject / answer
   * bar on a row that is no longer pending, and every button on it PUTs and comes
   * back `422 Approval is no longer pending` with nothing recoverable on screen.
   *
   * ⚠️ THE STATUS TERM LIVES HERE, NOT IN `canActOnApproval`. That helper is the
   * shared predicate for five other surfaces, three of which reach it through
   * adapters projecting a narrower shape with no `status` field at all (see
   * `toApproverGate` in `$lib/components/cockpit/cockpitApproval.ts`). Widening
   * its `Pick<>` turns each of those into a type error and forces a status to be
   * invented for rows that have none.
   */
  const isPending = $derived(approval.status === 'pending');
  const canAct = $derived(isPending && canActOnApproval(approval, user));
  const isRostered = $derived(isRequiredApprover(approval, user));
  /**
   * Acting as a super-admin on a row whose roster does not name them.
   *
   * ⭐ RENDERED, NOT SILENT. Round 5 widened `canActOnApproval` so a super-admin can
   * discharge any one of an approval's roster obligations — without which the product
   * owner could decide NOTHING (measured: 0 roster rows out of 1032 pending). But the
   * controls appearing on a row that names someone else is exactly the kind of quiet
   * privilege that later reads as a bug. The backend records WHICH obligation the
   * decision discharged; this says the same thing on screen, before the click.
   */
  const actingAsSuperAdmin = $derived(canAct && isSuperAdminDecider(approval, user));
  /**
   * P1-TEAM-b (George 2026-10-15): acting as a MEMBER of the approval's tenant on a row
   * whose roster does not name them — 1-of-any tenant member. Rendered for the same reason
   * the super-admin note is: the controls on a row naming someone else must say why.
   * ⛔ Changes together with `canAct.ts` and the backend arm (`tenantMemberArm.ts`).
   */
  const actingAsTenantMember = $derived(canAct && isTenantMemberDecider(approval, user));

  /**
   * The void audit trail — `voided_at` / `voided_reason` / `voided_by`, added by
   * backend migration 110 and returned verbatim by `GET /api/approvals/:id`.
   *
   * ⚠️ Cast, not a typed field: `Approval` declares `status` but not these three
   * columns, and widening that shared type is a change to a file this component
   * does not own. Defensive on every field, so a payload lacking them renders
   * nothing rather than the string "undefined".
   */
  const voidedAudit = $derived.by(() => {
    if (approval.status !== 'voided') return null;
    const row = approval as Approval & {
      voided_at?: string | Date | null;
      voided_reason?: string | null;
      voided_by?: string | null;
    };
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.trim().length > 0 ? v.trim() : null;
    return { reason: str(row.voided_reason), by: str(row.voided_by), at: row.voided_at ?? null };
  });

  /**
   * ⛔ `answerRequired`, NOT `isQuestion`. `isQuestion` is only ONE of the two
   * reasons an approve must carry text; this is the union of that and "the row
   * actually STATES a question", and it is the SAME predicate the server refuses
   * on (`backend/src/domain/engagement/deblock-actions.ts :: classifyAnswerDemand`).
   * `'approved'`, not the row's status: this is a property of the decision about
   * to be taken, and rejection is exempt.
   */
  const answerNeeded = $derived(answerRequired(approval, 'approved'));
  /**
   * WHY the text is demanded, so the bar words the box for THIS row. ⭐ The one
   * place all three web surfaces learn that an INFRASTRUCTURE / DEPENDENCY approve
   * needs a stated fix — the rule is in `question.ts`, the wiring is here, and no
   * surface re-derives either.
   */
  const answerDemand = $derived(answerDemandOf(approval, 'approved'));
  const proposedAnswer = $derived(proposedAnswerOf(approval));
  /**
   * ⭐ THE SELF-DECISION STAMP, RENDERED HERE AND NOWHERE ELSE.
   *
   * This component is the ONE decision surface — `/approvals/[id]`,
   * `/projects/[id]/approve/[approvalId]` and the NEEDS YOU queue all mount it,
   * and its own header comment records what happened the last time a rule was
   * maintained in three places. `self_decision` had the opposite problem: it was
   * written by the backend and rendered by NOBODY, so putting it on one of the
   * three surfaces would have re-created the split it is the fix for.
   *
   * ⚠️ NOT gated on `status`, and not on `decided`. The stamp is written at
   * decision time on an arm that also flips the row terminal, so its presence is
   * itself the claim that a decision happened; gating it on a status term would
   * add a second, weaker predicate that can only ever hide it.
   */
  const selfDecision = $derived(selfDecisionStamp(approval));
  const questionInfo = $derived(questionPresentation(approval));
  const brokenTerms = $derived(brokenGateTermsOf(approval));
  const consequence = $derived(approveConsequenceNotice(approval));

  // ── RECLASSIFY (REALIGN R5) ────────────────────────────────────────────────
  // Offered only on a BLOCKED-exit proposition the viewer can act on, and only once
  // the roster has loaded: a picker with no catalogue would let the decider type a
  // type the server then refuses. The roster is fetched lazily, once per surface.
  const canReclassify = $derived(canAct && reclassifyEligible(approval));
  const currentCardType = $derived(currentCardTypeOf(approval));
  // The text demand if the decider switches the action to RECLASSIFY (server parity).
  const reclassifyAnswerDemand = $derived(answerDemandOf(approval, 'approved', 'RECLASSIFY'));
  let cardTypeRoster = $state<string[] | null>(null);
  let rosterRequested = false;
  $effect(() => {
    if (!canReclassify || rosterRequested) return;
    rosterRequested = true;
    void loadCardTypeRoster().then((r) => {
      cardTypeRoster = r;
    });
  });

  // ── COVERAGE (BDD ruling 2026-10-01): the per-criterion gap list ──────────────
  const coverageCriteria = $derived(isCoverageRow(approval) ? coverageCriteriaOf(approval) : null);
  const coverageArtifacts = $derived(isCoverageRow(approval) ? coverageArtifactsOf(approval) : []);

  const fmt = (d: string | Date | null | undefined): string =>
    d ? new Date(d).toLocaleString() : '—';

  // ── WITHDRAW (VOID) ────────────────────────────────────────────────────────
  /**
   * ⛔ THE SERVER'S MINIMUM, NOT A CHOSEN ONE. `VoidApprovalsSchema`
   * (`backend/src/lib/void-approvals.ts`) is `z.string().trim().min(10, 'reason is
   * required and must be at least 10 characters — a void with no recorded reason is
   * an unaudited write')`. The `.trim()` runs BEFORE the length check, so the client
   * must measure the TRIMMED text too — a 12-space-padded 9-character reason passes a
   * naive `length` test here and is refused there.
   */
  const VOID_REASON_MIN = 10;

  let voidOpen = $state(false);
  let voidReason = $state('');
  let voiding = $state(false);
  let voidError = $state<string | null>(null);
  let voidDone = $state<string | null>(null);

  const voidReasonText = $derived(voidReason.trim());
  const voidReasonOk = $derived(voidReasonText.length >= VOID_REASON_MIN);
  /**
   * ⛔ `isPending && !decided`, not `canVoid` alone. A void can only remove a
   * PENDING ask (`void-approvals.ts` reports `skipped_not_pending` for anything
   * else), so offering it on a decided / already-voided / expired row is a button
   * whose only possible outcome is a refusal. `!decided` covers the row decided in
   * THIS session, whose `approval.status` the caller has not refetched yet.
   */
  const canOfferVoid = $derived(canVoid && isPending && !decided);

  function cancelVoid(): void {
    voidOpen = false;
    voidReason = '';
    voidError = null;
  }

  async function submitVoid(): Promise<void> {
    if (!voidReasonOk || voiding) return;
    voiding = true;
    voidError = null;
    try {
      /**
       * ⛔ `dryRun: false` IS EXPLICIT AND LOAD-BEARING. The schema declares
       * `dryRun: z.boolean().default(true)`, so a body that OMITS the flag returns a
       * 200 with a success-shaped `{results, counts}` and writes NOTHING. That is the
       * one way this control can ship looking correct and doing nothing, which is why
       * the field is spelled out here and pinned in the test.
       */
      const res = await apiClient.post<{
        dryRun?: boolean;
        results?: { id: string; outcome: string }[];
      }>('/api/approvals/void', {
        ids: [approval.id],
        reason: voidReasonText,
        dryRun: false,
      });
      const outcome = res?.results?.[0]?.outcome ?? null;
      if (res?.dryRun === true) {
        // Report the dry run rather than claim a withdrawal: nothing was written.
        voidError =
          'The server processed this as a dry run, so nothing was withdrawn. The request is still open.';
      } else if (outcome === 'voided') {
        voidOpen = false;
        voidDone = 'Withdrawn. This request is no longer waiting on anyone, and no decision was recorded against it.';
        onVoided?.(approval.id);
      } else if (outcome === 'skipped_not_pending') {
        voidError =
          'This request is no longer pending, so it was not withdrawn. Reload to see its current state.';
      } else {
        voidError = `The server did not withdraw this request (outcome: ${outcome ?? 'none reported'}).`;
      }
    } catch (err) {
      voidError = err instanceof Error ? err.message : 'Withdrawing this request failed.';
    } finally {
      voiding = false;
    }
  }
</script>

<!-- ── THE REQUESTER DECIDED THIS THEMSELVES, AND AN AUDITOR MUST NOT MISS IT ────
     FIRST on the surface, above the question and above the decision bar, because
     it changes how everything under it should be read: the row was not reviewed
     by a second party, and until now nothing on screen said so.

     ⛔ NOT styled as a failure. This is a PERMITTED act on an arm the backend
     explicitly allows and explicitly records — the refusal message it is exempt
     from says so in as many words. Red would tell an auditor a rule was broken
     when the point is that a rule was FOLLOWED and written down. It is a warning
     tone, because it is something to notice, not something to be alarmed by.

     ⚠️ The RULE is stated, never just the fact. "Self-decided" alone is an
     accusation with no defence attached; naming the rule and listing the roster
     it was checked against is what makes it auditable. -->
{#if selfDecision}
  <section
    data-testid="approval-self-decision"
    data-exempt-reason={selfDecision.exemptReason ?? 'not_recorded'}
    class="rounded-[var(--radius-sm)] border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
  >
    <p class="text-xs font-semibold uppercase tracking-wide">Self-decided</p>
    <p class="mt-1 font-semibold text-[var(--color-text)]">
      {selfDecisionHeadline(selfDecision)}
    </p>
    <!-- ⛔ ALWAYS RENDERED, on every branch. `ruleSentence` has no empty case —
         a row with no `exempt_reason` gets the sentence that SAYS it is not
         recorded. A template that wrote `{stamp.exemptReason}` here would print
         a blank line for exactly those older rows, and a blank beside "Rule"
         reads as "there wasn't one". -->
    <p class="mt-1" data-testid="approval-self-decision-rule">
      {selfDecision.ruleSentence}
    </p>
    <dl class="mt-2 space-y-0.5 text-xs" data-testid="approval-self-decision-audit">
      {#if selfDecision.by}
        <div>
          <dt class="inline font-semibold">Decided by:</dt>
          <dd class="inline"> {selfDecision.by}</dd>
        </div>
      {/if}
      {#if selfDecision.at}
        <div>
          <dt class="inline font-semibold">Decided at:</dt>
          <dd class="inline"> {fmt(selfDecision.at)}</dd>
        </div>
      {/if}
      <!-- THE EVIDENCE, not a summary of it. The backend keeps the roster AS IT
           STOOD so a later reader can re-check the exemption instead of trusting
           it; a count ("1 approver") would be a summary they cannot re-check.
           The empty case is stated rather than omitted — a roster section that
           simply vanishes is indistinguishable from one that was never read. -->
      <div>
        <dt class="inline font-semibold">Roster at decision time:</dt>
        <dd class="inline">
          {selfDecision.rosterUserIds.length > 0
            ? ` ${selfDecision.rosterUserIds.join(', ')}`
            : ' not recorded on this row'}
        </dd>
      </div>
    </dl>
  </section>
{/if}

<!-- ⭐ THE QUESTION, ABOVE THE ANSWER BOX. Verbatim producer text, plain
     interpolation (never `{@html}`) — real metadata carries `[object Object]`
     and truncated prose, and that is the only visible evidence of the producer
     defect. -->
{#if questionInfo.questions.length > 0}
  <section
    data-testid="approval-open-questions"
    class="rounded-[var(--radius-sm)] border border-[var(--color-accent)] bg-[var(--color-accent-bg)] px-3 py-2"
  >
    <p class="text-xs font-semibold uppercase tracking-wide text-[var(--color-accent-text)]">
      {questionInfo.questions.length === 1
        ? 'Question for you'
        : `Questions for you (${questionInfo.questions.length})`}
    </p>
    <ul class="mt-1 list-disc space-y-0.5 pl-5 text-sm text-[var(--color-text)]">
      {#each questionInfo.questions as openQuestion}
        <li class="whitespace-pre-line">{openQuestion}</li>
      {/each}
    </ul>
  </section>
{/if}

<!-- ⛔ AND THE HONEST STATE WHEN THERE IS NO QUESTION TO SHOW. Never hides the
     row, never decides it: it states that the producer supplied no question (or,
     on an `unrouted` row, what answering there does and does not do). Presenting
     an instrument report under an "answer this" heading is the defect this
     replaces. -->
{#if questionInfo.notice}
  <p
    data-testid="approval-question-notice"
    class="rounded-[var(--radius-sm)] border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
  >
    {questionInfo.notice}
  </p>
{/if}

{#if actingAsSuperAdmin}
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-super-admin-override-note"
  >
    You are not on this request's approver roster — you can decide it because you hold
    <code>super_admin</code>. Your decision is recorded against one of the obligations listed
    below, in your name.
  </div>
{/if}
{#if actingAsTenantMember}
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-tenant-member-note"
  >
    You are not on this request's approver roster — you can decide it because you are a member
    of this workspace, and any member may decide its approvals. Your decision is recorded against
    one of the obligations listed below, in your name.
  </div>
{/if}
{#if !decided && canAct && decideBlockedReason}
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-warning)] bg-[var(--color-warning-bg)] px-3 py-2 text-sm text-[var(--color-warning-text)]"
    data-testid="approval-decide-blocked"
  >
    {decideBlockedReason}
  </div>
{:else if decided || canAct}
  <!-- `approveConsequence` states WHAT APPROVING DOES TO THE CARD, derived from
       `metadata.deblock_action` and mirroring the RECEIVER's branch
       (`approval-callback.json :: Resolve Target List`) rather than the
       producer's description prose. It NEVER disables Approve — the defect it
       closes was SILENCE, not the button. -->
  <DecisionBar
    {question}
    {decided}
    {busy}
    answerRequired={answerNeeded}
    {answerDemand}
    {proposedAnswer}
    answerContract={questionInfo.state === 'unrouted' ? null : ANSWER_CONTRACT}
    questionState={questionInfo.state}
    brokenGateTerms={brokenTerms}
    approveConsequence={consequence}
    {canOverrideBrokenGate}
    reclassifyCardTypes={canReclassify ? cardTypeRoster : null}
    {currentCardType}
    {reclassifyAnswerDemand}
    {coverageCriteria}
    {coverageArtifacts}
    {onDecide}
  />
{:else if approval.status === 'voided'}
  <!-- ⚠️ A VOID IS NOT A DECISION, and the wording here is load-bearing.
       `voided` means an operator WITHDREW the ask because it could never have
       been answered. Presenting it as an outcome ("closed", "resolved",
       "declined") would attribute to a human a judgement no human made. -->
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-withdrawn-note"
  >
    <p class="font-semibold text-[var(--color-text)]">This request was withdrawn.</p>
    <p class="mt-1">
      It was not decided — nobody approved or rejected it. It was retracted because it could not
      be answered as asked, so there is nothing to decide here. If the underlying question still
      matters, it has to be raised again as a new request.
    </p>
    {#if voidedAudit}
      <dl class="mt-2 space-y-0.5 text-xs" data-testid="approval-withdrawn-audit">
        {#if voidedAudit.reason}
          <div><dt class="inline font-semibold">Reason:</dt>
            <dd class="inline"> {voidedAudit.reason}</dd></div>
        {/if}
        {#if voidedAudit.by}
          <div><dt class="inline font-semibold">Withdrawn by:</dt>
            <!-- UI review 2026-10-07: a uuid is resolved through the identities
                 the GET already hydrated; free text is shown as written. -->
            <dd class="inline" title={voidedAudit.by}> {approvalUserLabel(approval, voidedAudit.by)}</dd></div>
        {/if}
        {#if voidedAudit.at}
          <div><dt class="inline font-semibold">Withdrawn at:</dt>
            <dd class="inline"> {fmt(voidedAudit.at)}</dd></div>
        {/if}
      </dl>
    {/if}
  </div>
{:else if approval.status === 'expired'}
  <!-- ⚠️ ALSO NOT A DECISION, and NOT the same thing as a withdrawal. An expiry
       is machine-written when `expires_at` passes on a still-pending row: the
       ask was answerable, and went unanswered. Conflating it with `rejected`
       reads a "no" out of a silence; with `voided`, it blames an operator for a
       deadline. -->
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-expired-note"
  >
    <p class="font-semibold text-[var(--color-text)]">
      This request passed its deadline unanswered.
    </p>
    <p class="mt-1">
      It was not decided — no approval, no rejection, just no answer before
      {fmt(approval.expires_at)}. Deciding it is no longer possible; raise a new request if the
      sign-off is still needed.
    </p>
  </div>
{:else if isRostered && isPending}
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-awaiting-others-note"
  >
    You've recorded your decision — awaiting the other approver(s).
  </div>
{:else if !isPending}
  <!-- ⛔ THE CATCH-ALL, AND NOT DEFENSIVE PADDING. `approvals.status` is plain
       text with NO CHECK constraint (migration 110), and `executing` / `done` /
       `failed` are written by `domain/engagement/action-approvals.ts` and
       claimed by no branch above. Without this, a rostered approver who never
       voted, opening an `executing` row, falls past `decided`, past `canAct`
       (not pending), past voided and expired, and lands on "You've recorded your
       decision" — which they had not. -->
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-not-open-note"
  >
    <p class="font-semibold text-[var(--color-text)]">This request is no longer open.</p>
    <p class="mt-1">
      Its status is <code>{approval.status}</code>, so it cannot be decided here. No decision is
      recorded against it by this page.
    </p>
  </div>
{:else}
  <!-- Pending, and the reader is not on the roster. -->
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm text-[var(--color-text-muted)]"
    data-testid="approval-readonly-note"
  >
    You're not an assigned approver for this request — it's awaiting sign-off from the approver(s)
    listed below.
  </div>
{/if}

<!-- ⛔ WITHDRAW LIVES OUTSIDE THE BRANCH CHAIN ABOVE, DELIBERATELY. That chain is
     ordered by what the reader may DECIDE, and its order is load-bearing (see the
     file header); withdrawing is not a decision, and the person who may withdraw is
     not necessarily on the roster. Measured: the one account holding `super_admin`
     is on ZERO `required_approvers` rows out of 1032 pending, so on a row with an
     EMPTY roster `canActOnApproval` is false and the chain lands on
     `approval-readonly-note` — the exact row most likely to need withdrawing. A
     control nested inside the decide branch would be invisible there. -->
{#if canOfferVoid}
  <div
    class="rounded-[var(--radius-sm)] border border-[var(--color-border)] bg-[var(--color-surface)] px-3 py-2 text-sm"
    data-testid="approval-void-control"
  >
    {#if voidDone}
      <p class="text-[var(--color-text-muted)]" data-testid="approval-void-done">{voidDone}</p>
    {:else if !voidOpen}
      <button
        type="button"
        disabled={busy}
        onclick={() => (voidOpen = true)}
        data-testid="approval-void-open"
        class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-text)] hover:bg-[var(--color-surface)] disabled:opacity-50"
      >
        Withdraw request
      </button>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        For an ask nobody can answer as written. Withdrawing is not a rejection — it takes the
        question away instead of answering it "no".
      </p>
    {:else}
      <!-- ⚠️ THE CONFIRM STEP EXISTS TO STATE THE DIFFERENCE, not to add a click.
           A reject is an ANSWER: it is recorded against an approver, and the n8n
           callback runs on it. A void is the withdrawal of the question itself —
           no decision row, no approver credited, nothing sent back as an outcome
           (`backend/src/lib/void-approvals.ts`, "NO AUDIT ROW IN
           `approval_decisions`"). Offering it without saying that invites an
           operator to use it as a quiet "no". -->
      <p class="font-semibold text-[var(--color-text)]" data-testid="approval-void-confirm-title">
        Withdraw this request — this is not a rejection.
      </p>
      <p class="mt-1 text-xs text-[var(--color-text-muted)]">
        Rejecting is an answer: "no" is recorded against you as the approver and is sent back to
        whatever asked. Withdrawing says this question can never be answered by anyone — no
        decision is recorded, nobody is credited with one, and nothing is sent back as an outcome.
        It cannot be undone; if the underlying need still stands it has to be raised again as a new
        request.
      </p>
      <label class="mt-2 block space-y-1.5">
        <span
          class="block text-xs font-bold text-[var(--color-text)]"
          data-testid="approval-void-reason-label"
        >
          Why this can never be answered ({VOID_REASON_MIN}+ characters)
        </span>
        <textarea
          bind:value={voidReason}
          disabled={voiding || busy}
          rows="2"
          aria-label="Why this request can never be answered"
          aria-invalid={!voidReasonOk}
          data-testid="approval-void-reason-input"
          placeholder="What made this unanswerable. Recorded on the approval against your name — it is the only audit trail a withdrawal leaves."
          class="block w-full rounded-[var(--radius-md)] border border-[var(--color-border)] px-2.5 py-2 text-sm"
        ></textarea>
      </label>
      {#if !voidReasonOk}
        <p
          class="mt-1 text-xs text-[var(--color-danger-text)]"
          data-testid="approval-void-reason-refusal"
        >
          A withdrawal with no recorded reason is an unaudited write, so the reason is the whole
          audit trail — it is stored as <code>voided_reason</code> and is all any later reader gets.
          The server refuses anything under {VOID_REASON_MIN} characters, so this button stays
          disabled until yours is at least that long.
        </p>
      {/if}
      {#if voidError}
        <p class="mt-1 text-xs text-[var(--color-danger-text)]" data-testid="approval-void-error">
          {voidError}
        </p>
      {/if}
      <div class="mt-2 flex flex-wrap items-center gap-2.5">
        <button
          type="button"
          disabled={!voidReasonOk || voiding || busy}
          onclick={submitVoid}
          data-testid="approval-void-submit"
          class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-danger-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold text-[var(--color-danger-text)] hover:bg-[var(--color-danger-bg)] disabled:opacity-50"
        >
          {voiding ? 'Withdrawing…' : 'Withdraw — take the question away'}
        </button>
        <button
          type="button"
          disabled={voiding}
          onclick={cancelVoid}
          data-testid="approval-void-cancel"
          class="inline-flex items-center gap-1.5 rounded-[var(--radius-md)] border border-[var(--color-border)] bg-[var(--color-bg)] px-3.5 py-2 text-xs font-semibold hover:bg-[var(--color-surface)] disabled:opacity-50"
        >
          Keep it open
        </button>
      </div>
    {/if}
  </div>
{/if}
