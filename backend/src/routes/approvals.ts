// src/routes/approvals.ts
import { decidedByKindFor } from '../lib/decided-by-kind';
import { assertActionDecisionSeatVerified, type ActionDecisionSeat } from '../lib/action-decision-identity';
import { db, approvals, approvalDecisions, requiredApprovers, projects, departments, workspaces, approvalKindEnum } from '../db/client';
import { traceIdOrMint } from '../lib/aa-trace';
import { eq, and, or, inArray, desc, ne, isNull, isNotNull, count, sql } from 'drizzle-orm';
import {
  findTenantScopedProject,
  loadTenantScopedProject,
  loadProjectForRead,
  isSuperAdminSwitchedView,
  tenantScopedProjectFilter,
  licenceProjectScope,
} from '../lib/project-access';
import { assertNotLicenceDecider } from '../lib/licence-door';
import {
  APPROVAL_LANE,
  APPROVAL_SCOPE,
  approverIdentityFilter,
  describeScope,
  requesterProjectLane,
  rosteredProjectLane,
  tenantMemberDecidableLane,
  type ApprovalLane,
} from '../lib/approval-roster-lane';
import { isSuperAdmin } from '../lib/super-admin-gate';
import { isPlatformTenant } from '../middleware/internal-tenant-only';
import { evaluateRosterQuorum } from '../services/approval-consensus';
import { validateAuth } from '../middleware/auth';
import { ctxTenantId } from '../middleware/request-context';
import {
  COVERAGE_SIGNOFF_KIND,
  FEATURE_DESIGN_APPROVAL_KIND,
  QUESTION_KIND,
  a6RegisteredAnswerFor,
  assertU3DecideGates,
  webA1DecideTemplate,
  webA3DecideTemplate,
} from '../services/approvals/u3-gates';
import { deliverAcCoverageForApproval } from '../services/approvals/ac-coverage-writeback';
import { afterSignoffDecided } from '../services/approvals/signoff-resolves-reports';
import { isValidUuid } from '../utils/tenant';
import {
  AppError,
  BadRequestError,
  ForbiddenError,
  NotFoundError,
  UnauthorizedError,
  ValidationError,
  pgErrorCode,
} from '../utils/errors';
import { jsonResponse, createdResponse } from '../utils/response';
import { isFinishedList } from '../services/toc-hooks';

// Map an auth-side throw to a 401 Response. `validateAuth` throws
// `UnauthorizedError` on bad/expired tokens (already 401-shaped); jose can
// also surface bare `Error` objects with `code: 'ERR_JWT_*'` if the upstream
// handler ever stops wrapping. Either is a 401, never a 500. Anything else
// is rethrown for the global handler.
function authErrorToResponse(e: unknown): Response {
  const code = (e as { code?: string }).code;
  const isJoseAuthError = typeof code === 'string' && code.startsWith('ERR_JWT_');
  if (e instanceof UnauthorizedError || isJoseAuthError) {
    return jsonResponse({ error: 'unauthorized' }, 401);
  }
  throw e;
}
import { z } from 'zod';
import {
  deliverDecisionCallback,
  decisionCallbackTimeoutMs,
  decisionOutcomeIsSettled,
  decisionRequestDeadlineMs,
  type DecisionCallbackOutcome,
  type DecisionCallbackResult,
} from '../services/n8n-callback';
import { keycloak } from '../services/keycloak';
// Role-holder resolution for the approval fan-out. ⚠️ This reads the `user_roles`
// TABLE, while approval VISIBILITY matches the JWT `roles` claim — see the
// divergence note at the fan-out loop in `handleCreateApproval`.
import {
  clientSafeStoredErrorText,
  reportSwallowedFailure,
  shouldRedactUpstreamDetailForCaller,
} from '../integrations/_lib/errors';
import { listUsersByRole } from '../services/user-roles';
import { ASSET_PROMOTION_KIND, isTenantAdminOnlyKind, onAssetPromotionDecided } from '../services/approvals/asset-promotion';
import { listWorkspaceAdminRecipients } from '../services/workspace-admin-recipients';
import { wsManager } from '../domain/engagement/adapters/websocket';
import * as notifications from '../domain/engagement/notifications';
import { fanOutApprovalToTenantMembers } from '../domain/engagement/tenant-member-fanout';
import { resolvePendingAction } from '../domain/engagement/action-approvals';
import {
  DEBLOCK_ACTIONS,
  classifyDeblockExit,
  classifyDeciderOverride,
  answerlessApproveDemand,
  withProposedAnswer,
  demandedDecisionText,
  FIX_ASSERTION_REFUSAL_EXIT,
  FIX_ASSERTION_REFUSAL_LEAD,
  plannedCardMove,
  asDeblockAction,
  classifyReclassifyDecision,
  reclassifyRefusalMessage,
  classifyCoverageDecision,
  coverageRefusalMessage,
  type CoverageDecision,
  type AnswerDemand,
  type CardMovePlan,
} from '../domain/engagement/deblock-actions';
import {
  reclassifyEscapesComputedGate,
  RECLASSIFY_ESCAPES_COMPUTED_GATE,
} from '../domain/engagement/proof-subset';
import { cardTypeRuleIndex, type CardTypeRuleIndex } from '../services/catalogue/card-type-rules';
import { recordDeblockAction, recordDeblockDualExit } from '../lib/deblock-action-metrics';
import {
  classifyRosterDischarge,
  recordRosterDischarge,
} from '../lib/roster-discharge-metrics';
import { hasPassedDeadline } from '../lib/approval-deadline';
import {
  MIN_DECISION_INTERVAL_MS,
  decisionGapMs,
  isWithinBurstWindow,
  decisionRateLimitMessage,
} from '../lib/decision-rate-limit';
import {
  isHumanRequesterDecidingOwnApproval,
  selectDischargedRosterRow,
  tenantMemberArmPrecondition,
} from '../domain/engagement/decision-guards';
import {
  isTenantMemberForDecision,
  readCompleteTenantMembership,
  readListLaneMembership,
} from '../services/tenant-member-recipients';
import { OUTLINE_APPROVAL_KIND, onOutlineDecided } from './project-request-lifecycle';
import { assertConveyorConfigured } from '../lib/conveyor-configured-gate';
import {
  currentCardListName,
  isV4ConveyorWaitApproval,
} from '../lib/approval-card-state';

// Re-exported so existing callers keep importing this name from this file — the
// DEFINITIONS now live in lib/decision-rate-limit.ts and lib/approval-card-state.ts
// so routes/teams-webhook.ts and telegram-webhook.ts can call the
// SAME functions instead of growing their own copies.
export { MIN_DECISION_INTERVAL_MS };

// ── A GATE THAT COULD NEVER HAVE BEEN CONSTRUCTED MUST NOT BE APPROVED (#1064) ──
//
// `BROKEN_GATE_TERMS`, `BROKEN_GATE_OVERRIDE_MIN_REASON` and `declaredGateTerms`
// used to be DEFINED here. They now live in `lib/broken-gate.ts` — read that
// file's header for the full essay on why the set is narrower than the
// client-side predicate, why `risk_block` must never be added, why the env
// union can only extend, and why the override has no chat-seat equivalent —
// so `routes/telegram-webhook.ts` and `routes/teams-webhook.ts` can enforce the
// SAME predicate instead of growing their own copy (which is exactly how they
// went two-for-two without it).
// Re-exported here, unchanged in name and value, for backward compatibility
// with anything already importing them from this file.
import {
  BROKEN_GATE_TERMS,
  BROKEN_GATE_OVERRIDE_MIN_REASON,
  declaredGateTerms,
} from '../lib/broken-gate';
export { BROKEN_GATE_TERMS, BROKEN_GATE_OVERRIDE_MIN_REASON };

/**
 * ── AN APPROVED QUESTION WITH NO ANSWER IS A NO-OP THAT COSTS A CARD ─────────
 *
 * `QUESTION` is the one `deblock_action` whose payload is not the action — it is
 * the ANSWER. The n8n consumer
 * (`patterns/approval-callback.json :: Resolve Target List`) computes:
 *
 *     const answerText = String(ctx.comment == null ? '' : ctx.comment).trim();
 *     const questionAnswered =
 *       action === 'QUESTION' && ctx.decision === 'approved' && answerText.length > 0;
 *
 * With no answer it takes the HOLDING branch, stamps `block_reason` =
 * `approval_answer_missing` / `approval_hold:QUESTION | decision:approved`, and
 * the card stays BLOCKED. Nothing sweeps it out again: the blocked-sweep
 * classifies that row `HUMAN` and skips it. Meanwhile the approval row is now
 * SPENT — fr refuses a second decision from the same approver — so the card can
 * never be released through the row that blocked it. "Approved" is the WORST of
 * the three outcomes here: rejecting frees the card, leaving it pending keeps it
 * answerable, approving-empty strands it permanently while reading as success.
 *
 * MEASURED 2026-09-09: at 05:00:41Z, 152 approvals were decided in 16 seconds,
 * every one with a NULL comment; 43 carried `deblock_action = 'QUESTION'`.
 * Estate-wide, 0 of 1,415 decisions in the last 7 days carried a non-empty
 * comment and 6 of 1,773 all-time, and ~300 cards are stranded this way.
 *
 * ⚠️ RE-MEASURED 2026-09-13 AGAINST PRODUCTION — THE "NEVER" HALF OF THAT IS NO
 * LONGER TRUE, AND THREE PLACES STILL ASSERT IT. This paragraph used to end
 * "so `questionAnswered` has essentially NEVER been true in production"; the
 * same claim is written into `patterns/approval-callback.json :: Resolve Target
 * List` ("has never once been true in production") and into the
 * `aa-approval-protocol` skill ("1,756 of 1,756 carry a NULL comment"). All
 * three date from before the rail was first exercised.
 *
 * Measured: 2,009 decisions all-time, 86 carrying answer text. Restricted to the
 * thing the claim is actually about — `approved` + `deblock_action = 'QUESTION'`
 * + non-empty comment — the rail has fired 31 times, FIRST at 2026-09-09T05:25Z
 * and most recently 2026-09-13T08:23Z. Per day since: 51, 9, 11, 6, 3.
 *
 * ⛔ So do not re-derive "the answer rail has never worked" from this file. It
 * works, it is in use, and the live problem is that its daily rate is DECAYING —
 * a different defect from the one this essay describes, and not fixed by this
 * guard. The stranded-card population above is a backlog from before 09-09, not
 * evidence that the mechanism is inert.
 *
 * ⛔ THERE IS NO OVERRIDE, AND THAT IS NOT AN OVERSIGHT — DO NOT ADD ONE.
 * The #1064 broken-gate guard above has one because the thing missing there is
 * NOT in the decider's hands: the evidence was never gathered upstream, and a
 * super-admin may genuinely know it was satisfied out of band. Here the missing
 * thing IS in the decider's hands and costs exactly one field. Worse, the
 * override field and the compliance field would be THE SAME FIELD: the answer
 * this guard demands is `comment || reason`, so a `reason` long enough to carry
 * a #1064-style override argument already satisfies the guard and never reaches
 * the hatch. An escape hatch that cannot be distinguished from compliance is not
 * an escape hatch; it is dead code that weakens the rule it decorates. And the
 * hatch would be strictly worse for its own user than complying, because
 * approving-anyway does not release the card — it buries it.
 *
 * ⭐ SCOPED TO `approved`. Rejecting a question you cannot answer is a
 * legitimate terminal — the callback's reject branch moves the card and the
 * producer learns the question was unanswerable. `rejected` is NEVER blocked.
 */

/*
 * `effectiveDeblockAction` USED TO LIVE HERE. It — and the whole refusal condition
 * this route has enforced since #1066 — now live in `domain/engagement/deblock-actions.ts
 * :: answerlessApproveDemand`, because this route was only ONE of the four paths that
 * write `approval_decisions` and was the only one enforcing the rule. Read that
 * function's header for the essay on the supplied-vs-stored action; it is unchanged.
 */

// ── A GATE ON A FINISHED CARD MAY NOT BE APPROVED (#1098) ────────────────────────
//
// MEASURED 2026-09-13 against the production db: 212 of 963 pending approvals — 22%
// — point at a card currently sitting in a Planka list named DONE. `approved` on one
// of those asks the receiver to move FINISHED work BACKWARD to TODO/READY.
//
// ⛔ fr HAS HAD NO OPINION ON THIS AT ALL, AND THAT IS THE DEFECT. The decision
// handler below re-reads the APPROVAL ROW and nothing else; `card_id` is carried
// through to the callback and never interrogated. The only thing standing between an
// approve and a dragged-back card is the `isFinished` arm of `n8n_custom_nodes ::
// approval-callback.json :: Resolve Target List`, shipped 2026-09-10 for fr#1080 after
// approving moved a FINISHED card back to TODO.
//
// ⭐ ONE GUARD IS NOT A GUARD, AND THE ASYMMETRY OF COST IS WHY. n8n's arm fires
// AFTER fr has committed the `approval_decisions` row and completed the approval —
// so when it holds, the decider's one decision is already SPENT (`existingDecision`
// 422s any second attempt) and the row is terminal with the card unmoved. fr's
// refusal fires BEFORE the INSERT, so the row stays pending and the human can still
// reject it. Same fact, two places, and only the earlier one is recoverable.
//
// ⛔ SCOPED TO `approved`, exactly as the #1064 broken-gate guard is, and for the
// identical reason: REJECT must stay open. Rejecting a gate on a finished card is
// the honest terminal — the work is done, the proposition is moot — and a guard that
// refused every decision would strand all 212 rows pending for ever. Voiding
// (`lib/void-approvals.ts`) is untouched and remains the operator's exit.
//
// ⚠️ AND IT FAILS **OPEN** ON AN UNREADABLE CARD. THAT IS A DECISION, NOT AN
// OVERSIGHT — state it rather than discover it. `services/planka-card-state.ts`
// throws on every unknown (404, 504, a 200 with no listId, a nameless list), and its
// header is explicit that a caller "must treat a throw as 'we do not know', never as
// 'not blocked'". Here, "we do not know" resolves to ALLOW:
//   * refusing on unknown would put the approvals queue behind Planka's availability.
//     A Planka outage would 422 every approve on the estate — a NEW, total outage of
//     the decision path, to defend a 22% population that already has n8n's arm behind
//     it.
//   * the failure this closes is a card dragged backward, and n8n still refuses that
//     one independently. Failing open here loses the EARLY refusal, not the refusal.
// So this is a BACKSTOP THAT MAKES THE REFUSAL RECOVERABLE, not a second line of
// defence that must hold when Planka is dark. Do not "harden" it into a closed fail
// without measuring what that does to the queue.
//
// ⛔ AND IT IS BOUNDED. `currentListName` is one `cards.get` plus at most one
// `lists.get` against the service whose 504s under load are the reason
// `workers/deblock-callback-redelivery.ts` paces at 500 ms. An unbounded read here
// would hang the decider's request on it, so the whole lookup races a deadline and a
// timeout is an unknown like any other — ALLOW, logged.
//
// The timeout and `currentCardListName` itself now live in `lib/approval-card-state.ts`
// (imported above) — moved out so `routes/teams-webhook.ts` and `telegram-webhook.ts`
// can call the SAME function instead of growing their own copies.

// ── THE DECISION RESPONSE MUST NOT CLAIM MORE THAN fr OBSERVED (#1083) ──────────
//
// THE DEFECT. `deliverDecisionCallback(approvalId)` used to be fired UN-AWAITED
// here, its non-`sent` outcome printed to `console.error` inside a `.then()`, and
// the `return jsonResponse({ ... status: finalStatus ... })` sat OUTSIDE that
// promise. So the 200 was produced before — and regardless of — the callback
// result. A decider (increasingly a Claude agent occupying the human seat) read
// `200 {status:"approved"}`, recorded success, and moved on, while the callback
// had failed or been withheld, `callback_acked_at` stayed NULL, and the Planka
// card never left BLOCKED. The only record was a log line nobody was reading.
//
// ⛔ THE FIX IS *REPORTING*, NOT ALL-OR-NOTHING, AND THAT DISTINCTION IS THE
// WHOLE DESIGN. The decision is durably recorded (the `approval_decisions` row
// and the completing UPDATE both committed before this runs) and it must NOT be
// rolled back because a receiver 504'd — a stranded card is repairable by
// workers/deblock-callback-redelivery.ts, an un-recorded decision is not, and a
// human/agent who has spent their one decision on this row cannot decide it
// again (`existingDecision` 422s them). So the callback outcome is REPORTED in
// the 200 body and never converted into a 4xx/5xx.
//
// ⚠️ AND IT IS BOUNDED, because the previous revision's stated reason for
// fire-and-forget was real: n8n has been measured returning 504, and hanging the
// decider's request on it would turn a stranded card into a failed decision. If
// the outer deadline wins, the answer is `pending` — which is the truthful
// answer, not a hedge: fr genuinely does not yet know. The in-flight promise is
// left running so its stamp still lands.
//
// ⚠️ CORRECTED 2026-09-13 — THIS PARAGRAPH USED TO SAY THERE WAS ONE BOUND, AND
// THAT SINGLE BOUND WAS THE DEFECT. It read: "The bound is
// `decisionCallbackTimeoutMs()` … passed DOWN as `deps.timeoutMs` (bounding the
// send) and ALSO used as the OUTER race deadline". True as written, and the
// coupling is what broke: one number was serving two opposed requirements.
//
//   the SEND bound must EXCEED the receiver's typical latency, or fr abandons a
//   call that was about to succeed and stamps it a failure;
//   the REQUEST deadline must sit UNDER it, or a human waits on a spinner.
//
// At 5,000 ms — below the receiver's measured p50 of 9,472 ms — the send lost.
// MEASURED: 66 approvals in 3 days stamped `decision callback abandoned after
// 5000ms (no response)` while n8n recorded ZERO errored executions in the same
// window, i.e. the work had very likely COMPLETED and only fr had stopped
// listening. Raising that one knob to cover the receiver would simply have moved
// the cost onto the decider.
//
// So they are now TWO knobs: `decisionRequestDeadlineMs()` (8s, the outer race)
// and `decisionCallbackTimeoutMs()` (30s, `deps.sendTimeoutMs`, bounding the
// send). ⛔ Do not re-collapse them — each value is wrong for the other's job.
type DecisionCallbackReportOutcome =
  | DecisionCallbackOutcome
  /** fr did not learn the outcome inside the request deadline. NOT a success. */
  | 'pending'
  /** The approval did not complete on this decision, so no callback was owed. */
  | 'not-attempted';

export interface DecisionCallbackReport {
  outcome: DecisionCallbackReportOutcome;
  reason?: string;
}

/**
 * Stamp `approvals.callback_outcome_unknown_at` — fr stopped waiting and never
 * learned the outcome (migration 122).
 *
 * ── THE FACT THAT HAD NO CARRIER ───────────────────────────────────────────
 * The deadline branch of `reportDecisionCallback` reported `pending` honestly in
 * the 202 body and then wrote NOTHING. A response body is not a record: it is
 * gone the moment it is read, so afterwards the row looked exactly like one whose
 * callback had never been owed. The path was therefore UNOBSERVED, which is not
 * the same thing as RARE — and "0 rows" for it was a fact about the instrument.
 *
 * ⛔ IT DELIBERATELY DOES NOT WRITE `callback_resolution`, AND THAT RESTRAINT IS
 * THE DESIGN, NOT AN OMISSION. `AND a.callback_resolution IS NULL` is a clause of
 * `workers/deblock-callback-redelivery.ts :: candidateWhereBase`, so any value
 * written there RETIRES the row from the only repair path there is. At this
 * instant the send is still in flight and `callback_acked_at` is still NULL —
 * i.e. the row is a prime re-delivery candidate, and retiring it because fr did
 * not wait long enough would strand precisely the cards that need repairing.
 * `services/n8n-callback.ts :: recordDecisionCallbackProblem` refuses the
 * identical move on the FAILED branch for the identical reason, in its own words.
 *
 * ⛔ AND IT DOES NOT TOUCH `callback_send_attempts` — that counter is the
 * de-block worker's retry BUDGET (`MAX_SEND_ATTEMPTS = 5` → `send_exhausted`),
 * charged by the worker before its own send. Spending one of the worker's five
 * repairs here, on every slow decision fr ever takes, would retire rows as
 * "unresponsive receiver" without the receiver ever having been asked five times.
 *
 * ⚠️ BEST-EFFORT, BY THE SAME RULE AS EVERY OTHER STAMP ON THIS PATH. The
 * decision is ALREADY COMMITTED before this runs. Letting a failed observation
 * throw would convert a recorded decision into a 500 — the "the response lied"
 * defect one direction over, and strictly worse than the gap being closed. Loud,
 * never silent: a row that fails to record its own uncertainty is the exact shape
 * this function exists to remove.
 */
async function recordCallbackOutcomeUnknown(
  approvalId: string,
  deadlineMs: number,
): Promise<void> {
  try {
    await db
      .update(approvals)
      .set({
        callback_outcome_unknown_at: new Date(),
        // Matches `recordDecisionCallbackProblem`, the sibling writer on the
        // other unobserved branch.
        //
        // ⚠️ CORRECTED 2026-09-16 — this comment used to justify the stamp with
        // "the E-5 stale-executing reaper — THE ONLY consumer that reads
        // `updated_at` as a deadline — cannot see it". **That was false**, and it
        // was the entire safety argument for writing this column. There are at
        // least TWO deadline readers. The conclusion survives; the reason it
        // survives is per-consumer, not a headcount:
        //
        //   * E-5 stale-executing reaper — keys on `status = 'executing'`. This
        //     path only ever runs on `approved`/`rejected`, so it is out of scope.
        //   * `workers/approval-expiry.ts` redrive damper —
        //     `updated_at <= now() - REDRIVE_ROW_COOLDOWN_SECONDS` (600s). It ALSO
        //     requires `error_message LIKE NOTIFY_DEFERRED/FAILED marker`, which
        //     only the EXPIRY notify path writes, and only onto `expired` rows.
        //     An approved/rejected row never carries one, so this stamp cannot
        //     push a row past that damper.
        //   * `workers/deblock-callback-redelivery.ts` — the consumer this column
        //     exists to protect. Verified: it WRITES `updated_at = now()` in five
        //     places and **never reads it in a candidate predicate**, so stamping
        //     it here cannot delay a redelivery.
        //
        // ⛔ If a future reader adds a deadline term on `updated_at` to the
        // redelivery candidate query, THIS WRITE BECOMES A DELAY on exactly the
        // rows that most need repairing. Re-derive the three bullets above before
        // trusting this stamp again; do not restore the "only consumer" wording.
        updated_at: new Date(),
      })
      .where(eq(approvals.id, approvalId));
  } catch (err) {
    console.error(
      `[approvals] could not stamp callback_outcome_unknown_at on ${approvalId} after the ` +
        `${deadlineMs}ms request deadline — this row will read as though fr always knew ` +
        'what happened to its callback:',
      err,
    );
  }
}

/**
 * Deliver the decision callback and RETURN WHAT HAPPENED, within a deadline.
 *
 * Never throws and never rejects: every path resolves to a report. A throw here
 * would 500 a decision that is already committed — the exact "the response lied"
 * shape one direction over.
 */
async function reportDecisionCallback(approvalId: string): Promise<DecisionCallbackReport> {
  // How long the DECIDER'S REQUEST waits before answering `pending`.
  // ⛔ NOT the same number as the SEND bound (`decisionCallbackTimeoutMs`, below), and it
  // used to be. See `decisionRequestDeadlineMs`: one knob cannot be both under the
  // receiver's p50 (so a human is not left on a spinner) and over it (so the send is not
  // abandoned mid-flight). Collapsing them again re-creates either the 30s spinner or the
  // 66 false `abandoned after 5000ms` stamps.
  const deadlineMs = decisionRequestDeadlineMs();

  // `.catch` is attached to the ORIGINAL promise, not to the race, so the
  // promise can never become an unhandled rejection when the deadline wins.
  // (`deliverDecisionCallback` documents that it never throws; this does not
  //  rely on that, because the whole point of this function is not to trust an
  //  unobserved claim.)
  const settled: Promise<DecisionCallbackResult> = deliverDecisionCallback(approvalId, { timeoutMs: decisionCallbackTimeoutMs() })
    .catch((err): DecisionCallbackResult => {
      console.error(`[approvals] n8n callback error for ${approvalId}:`, err);
      return { outcome: 'failed', error: err instanceof Error ? err.message : String(err) };
    })
    .then((r) => {
      if (r.outcome !== 'sent' && r.outcome !== 'skipped-no-callback-path') {
        console.error(
          `[approvals] n8n callback not delivered for ${approvalId}: ${r.outcome}` +
            (r.error ? ` — ${r.error}` : '') +
            ' — callback_acked_at stays NULL. workers/deblock-callback-redelivery.ts ' +
            'will retry this on its next tick IF the card is still in BLOCKED; it asks ' +
            'Planka rather than trusting the NULL, so a card that has since moved is ' +
            'deliberately left alone.',
        );
      }
      return r;
    });

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const raced = await Promise.race([
      settled,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), deadlineMs);
      }),
    ]);
    if (raced === null) {
      // ⭐ MIGRATION 122 — THE UNCERTAINTY IS NOW RECORDED, NOT ONLY ANNOUNCED.
      //
      // Everything below this line used to be the WHOLE of this branch: a
      // truthful `pending` in a response body, and not one byte written
      // anywhere. Once the caller had read that body the row was
      // indistinguishable from one whose callback was never owed —
      // `callback_acked_at` NULL, `callback_delivered_at` NULL,
      // `callback_resolution` NULL, `callback_send_attempts` 0 — so "how often
      // does fr answer a decider `pending`?" had NO ANSWER AT ALL, and a zero
      // count for it was a measurement of the instrument, not of the estate.
      // See the column's essay in src/db/schema.ts for why it is a new column
      // and not a sixth `callback_resolution` value.
      await recordCallbackOutcomeUnknown(approvalId, deadlineMs);
      return {
        outcome: 'pending',
        reason:
          `fr did not learn the callback outcome within ${deadlineMs}ms. The decision IS ` +
          'recorded and the send is still in flight; whether n8n accepted it is unknown at ' +
          'the time of this response. Read approvals.callback_acked_at, or wait for ' +
          'workers/deblock-callback-redelivery.ts, before treating the card as moved.',
      };
    }
    if (raced.outcome === 'sent') return { outcome: 'sent' };
    // `raced.error` can embed n8n's raw response body (services/n8n.ts) — logged
    // above in full; a non-super-admin decider gets the outcome only.
    const reason = raced.error
      ? shouldRedactUpstreamDetailForCaller()
        ? `callback ${raced.outcome} — fr will redeliver it; the decision is recorded`
        : raced.error
      : undefined;
    return { outcome: raced.outcome, ...(reason ? { reason } : {}) };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Validation schemas
const CreateApprovalSchema = z.object({
  description: z.string().min(1).max(2000),
  change_summary: z.string().optional(),
  impact_analysis: z.string().optional(),
  required_approvers: z.array(z.object({
    user_id: z.string().uuid(),
    role: z.string().optional(),
  })).min(1),
});

/**
 * The BLOCKED-exit proposition vocabulary. Kept in lockstep with
 * `services/n8n-callback.ts :: DEBLOCK_ACTIONS` and with
 * `n8n_custom_nodes workflows/patterns/approval-callback.json :: Resolve Target List`,
 * which routes DROP->DONE, SPLIT->READY, RETRY->TODO, MERGE->DONE-if-the-merge-succeeded,
 * and holds the rest. The set itself lives in domain/engagement/deblock-actions.ts.
 */

// ── `TriageApprovalSchema` WAS HERE, AND ITS DELETION IS THE POINT (2026-09-23) ──
//
// It validated the body of `PATCH /api/approvals/:approvalId/triage`, whose handler
// `handleTriageApproval` lived further down this file and WAS NEVER REGISTERED ON ANY
// ROUTE. Verified before removing: `server.ts` contained zero occurrences of
// `handleTriageApproval` and zero of `/triage`, against a positive control of 36
// `approvals` hits and three registered approval routes — so the absence was a real
// absence, not a mis-read file. The schema's only consumer was that handler.
//
// ⚠️ ITS OWN DOC COMMENT DIAGNOSED THE DEFECT AND THEN BUILT MORE OF IT. It said, of the
// four `triage_*` columns: "103 of 168 pending approvals carried non-null triage columns
// and NOT ONE of them was triaged — a populated column encoding zero information". That
// was exactly right. The remedy it introduced — a route that lets a caller write a REAL
// rationale into those columns — could not work, because nothing anywhere READS them:
// measured 2026-09-23, zero readers in backend/src and zero in frontend/src outside the
// write paths themselves. A better value in a column nobody reads is still nothing.
// The columns are retired instead; see the note on them in src/db/schema.ts.

const UpdateApprovalSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  comment: z.string().optional(),
  reason: z.string().optional(),
  /**
   * ⛔ THE DEFECT THIS CLOSES: DROP could never be chosen by anyone.
   *
   * `buildCallbackPayload` reads `deblock_action` from the approval's METADATA, which is
   * written once at mint time by `blocked-escalate.json :: Build Proposition`. That
   * classifier deliberately never proposes DROP — "a card may die given sufficient proof"
   * is a human's judgement on evidence, not a classifier's guess. So DROP was in the closed
   * set, was routed to DONE by the n8n callback, and had no emitter anywhere: a decider
   * could only approve or reject the action a machine had already picked.
   *
   * George, 2026-08-24, asked for exactly the missing half — a card may die, with a
   * recorded reason. This field is that override. It is the DECIDER's action, not the
   * proposer's, and it is recorded as such.
   */
  deblock_action: z.enum(DEBLOCK_ACTIONS).optional(),
  /**
   * The decider-chosen card_type for an approved RECLASSIFY (REALIGN R5). Required iff the
   * effective action is RECLASSIFY and the decision is `approved`; refused on every other
   * decision. Validated against the approval tenant's RM card types and against the
   * card's current type by `classifyReclassifyDecision`. Stored as
   * `approvals.metadata.new_card_type` and echoed by `buildCallbackPayload`.
   */
  new_card_type: z.string().max(200).optional(),
  /**
   * COVERAGE (George BDD ruling 2026-10-01): the criteria the decider marks as a GAP. Only on
   * a row whose stored deblock_action is COVERAGE; each id must be one of the row's
   * `metadata.coverage_request.criteria[].criterion_id`, no duplicates. Resolved by
   * `classifyCoverageDecision` into `metadata.coverage_decision`.
   */
  rejected_criterion_ids: z.array(z.string().max(200)).max(500).optional(),
});

/**
 * The metadata object a completing decision writes over `approvals.metadata`, or
 * `undefined` when the decision changes nothing there.
 *
 * Pure and exported so the RECLASSIFY round trip (decision body -> stored metadata ->
 * `buildCallbackPayload`) is unit-testable without a database. `snapshot` is the metadata
 * read at the top of the handler; the stamps are re-applied because this object REPLACES
 * the column (see the call site).
 */
export function buildDecisionMetadata(input: {
  snapshot: Record<string, unknown>;
  suppliedAction: string | undefined;
  newCardType: string | undefined;
  proposedAction: unknown;
  overriddenAction: string | undefined;
  deciderId: string;
  brokenGateOverride?: unknown;
  selfDecision?: unknown;
  coverageDecision?: CoverageDecision;
}): Record<string, unknown> | undefined {
  if (!input.suppliedAction && !input.newCardType && !input.coverageDecision) return undefined;
  return {
    ...input.snapshot,
    ...(input.brokenGateOverride ? { broken_gate_override: input.brokenGateOverride } : {}),
    ...(input.selfDecision ? { self_decision: input.selfDecision } : {}),
    ...(input.suppliedAction
      ? {
          deblock_action: input.suppliedAction,
          // Three values, not two. "DROP" after the fact cannot tell you whether a
          // classifier proposed it, a human overrode a different proposal, or a human
          // supplied the FIRST action this row ever had — and only the third says the
          // mint-side producer omitted it.
          decided_action_source:
            typeof input.proposedAction !== 'string'
              ? 'decider-supplied'
              : input.overriddenAction
                ? 'decider-override'
                : 'proposal-confirmed',
          decided_action_by: input.deciderId,
        }
      : {}),
    // Only ever present beside an approved RECLASSIFY: `classifyReclassifyDecision` has
    // already refused it on every other decision. Trimmed so the stored value is exactly
    // the value the roster check accepted.
    ...(input.newCardType ? { new_card_type: input.newCardType.trim() } : {}),
    // COVERAGE: the resolved per-criterion verdict, written in the SAME UPDATE that completes
    // the approval (this object is that UPDATE's metadata), so a status without its verdict
    // cannot exist.
    ...(input.coverageDecision ? { coverage_decision: input.coverageDecision } : {}),
  };
}

/**
 * GET /api/projects/:projectId/approvals
 * List all approvals for a project
 */
export async function handleListApprovals(
  req: Request,
  projectId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Verify the project exists and is reachable in the requester's active
  // tenant (owner-AND-tenant gate, same as routes/projects.ts get/delete).
  // READ lane (`loadProjectForRead`, not `loadTenantScopedProject`): this is
  // the endpoint `NeedsYouQueue.svelte` fires, and a super-admin in home view
  // is ALREADY shown these rows by `GET /api/approvals/all` and may already
  // decide them — so 404ing the list here is the find-vs-decide asymmetry, not
  // a boundary. Nothing below mutates. ⛔ `handleCreateApproval` (POST, same
  // file) deliberately keeps `loadTenantScopedProject`.
  await loadProjectForRead(db, user, projectId);

  // ⛔ fr row 14d: the row predicate is `approvals.tenant_id = <active tenant>`
  // for EVERY caller, a super-admin included. The super-admin home-view lane that
  // used to drop it (and list another tenant's rows on a project reachable from
  // home) is gone: reaching another workspace's approvals is the explicit
  // X-Active-Tenant switch, which is bounded to platform tenants
  // (middleware/request-context.ts). An approval whose tenant_id disagrees with
  // its project's tag is therefore invisible from either side.
  const tenantScope = eq(approvals.tenant_id, ctxTenantId(user.tenantId));

  // ⛔ `total` USED TO BE `approvalsWithDetails.length` — THE PAGE, NOT THE
  // POPULATION. It was internally consistent and therefore unfalsifiable: with no
  // paging the two numbers agreed, so nothing could reveal that the field meant
  // "rows in this array" rather than "rows that exist". Adding paging below without
  // fixing it would have made the widget silently report a truncated queue as a
  // complete one — the identical defect `handleListAllApprovals` closed on
  // 2026-08-26.
  //
  // ⚠️ DEFAULT LIMIT STAYS UNBOUNDED. `NeedsYouQueue.svelte` and the project
  // cockpit call this with no `?limit=`, and paging by default would silently
  // truncate them. `parseApprovalsPaging` returns `undefined` for an absent limit
  // and the query is only narrowed when one is supplied.
  const url = new URL(req.url);
  const { limit, offset } = parseApprovalsPaging(url);
  const where = and(
    eq(approvals.project_id, projectId),
    tenantScope,
  );
  const pageQuery = db.select()
    .from(approvals)
    .where(where)
    .orderBy(approvals.created_at)
    .$dynamic();
  const [projectApprovals, totalRows] = await Promise.all([
    limit === undefined
      ? (offset > 0 ? pageQuery.offset(offset) : pageQuery)
      : pageQuery.limit(limit).offset(offset),
    // The SAME `where` object the page was drawn from, not a re-derived copy — a
    // count that could drift from its own list is how the old number stayed
    // plausible.
    db.select({ n: count() }).from(approvals).where(where),
  ]);
  const total = totalRows[0]?.n ?? 0;

  // For each approval, get required approvers and decisions
  const perApproval = await Promise.all(
    projectApprovals.map(async (approval) => {
      const required = await db.select()
        .from(requiredApprovers)
        .where(eq(requiredApprovers.approval_id, approval.id));

      const decisions = await db.select()
        .from(approvalDecisions)
        .where(eq(approvalDecisions.approval_id, approval.id));

      return { approval, required, decisions };
    })
  );

  // Hydrate roster identities ONCE for the whole page. Deliberately outside the
  // per-approval loop above: two approvals sharing an approver must cost one
  // Keycloak lookup, not two.
  const { identities, truncated: identitiesTruncated } = await resolveApproverIdentities(
    identityRowsFor(
      perApproval.flatMap((p) => p.required),
      perApproval.flatMap((p) => p.decisions),
      perApproval.flatMap((p) => [p.approval.requester_id, voiderId(p.approval.voided_by)]),
    ),
  );

  const approvalsWithDetails = perApproval.map(({ approval, required, decisions }) => ({
    ...clientSafeApprovalRow(approval),
    ...requesterIdentity(approval.requester_id, identities),
    ...voiderIdentity(approval.voided_by, identities),
    required_approvers: required.map(r => toRosterEntry(r, decisions, identities)),
    decisions: decisions.map((d) => toDecisionEntry(d, identities)),
  }));

  return jsonResponse({
    items: approvalsWithDetails,
    // The POPULATION, not `items.length`. See the note at the query above.
    total,
    // ⭐ `scope: 'project'` — the honest answer for this endpoint, and NOT a
    // tenant-shaped one. The project read gate above authorized the WHOLE project,
    // so there is no visibility disjunction here and therefore no `scope_lanes`:
    // emitting `[]` or inventing a lane name would assert something about a
    // mechanism this lane does not have. `scope_tenant_id` is still stated because
    // the ROW predicate is tenant-scoped, for every caller (fr row 14d).
    scope: APPROVAL_SCOPE.PROJECT,
    scope_tenant_id: ctxTenantId(user.tenantId),
    scope_project_id: projectId,
    limit: limit ?? null,
    offset,
    // Additive, and ALWAYS present: `false` positively asserts "every roster id
    // was offered to Keycloak", which is the assurance a bulk-decide UI needs
    // and which an omitted key cannot give. See resolveApproverIdentities.
    approver_identities_truncated: identitiesTruncated,
  });
}

type ApprovalRow = typeof approvals.$inferSelect;

// The KAG ingest actions whose parked `action_input_json` carries the uploaded
// document inline as base64 (`file_b64`). Only these approvals expose a
// previewable document via GET /api/approvals/:id/document.
const KAG_UPLOAD_ACTIONS = new Set(['kag.upload_document', 'kag.upload_document_sync']);

/** Cheap decoded-size estimate for a base64 string (no whitespace assumed). */
function estimateBase64DecodedBytes(b64: string): number {
  const len = b64.length;
  if (len === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((len * 3) / 4) - padding);
}

/**
 * If this approval is a KAG document-upload with an inline base64 payload,
 * pull the previewable descriptor + raw base64 out of `action_input_json`.
 * Returns null for any other approval (or a doc-upload missing its bytes).
 */
function approvalDocumentInfo(
  approval: Pick<ApprovalRow, 'action_name' | 'action_input_json'>,
): { filename: string; content_type: string; file_b64: string } | null {
  if (!approval.action_name || !KAG_UPLOAD_ACTIONS.has(approval.action_name)) return null;
  const input = approval.action_input_json as
    | { file_b64?: unknown; filename?: unknown; content_type?: unknown }
    | null
    | undefined;
  if (!input || typeof input.file_b64 !== 'string' || input.file_b64.length === 0) return null;
  const filename = typeof input.filename === 'string' && input.filename ? input.filename : 'document';
  const content_type =
    typeof input.content_type === 'string' && input.content_type
      ? input.content_type
      : 'application/octet-stream';
  return { filename, content_type, file_b64: input.file_b64 };
}

/**
 * Response-shape an approval row for the list/detail JSON: add a lightweight
 * `document` descriptor for doc-upload approvals and STRIP the heavy `file_b64`
 * from the emitted `action_input_json` (the frontend never reads the base64 —
 * it fetches bytes from GET /api/approvals/:id/document — so shipping megabytes
 * of base64 on every 30s list poll is pure waste). Non-doc rows pass through.
 */
/**
 * `approvals.error_message` is the RAW operator record: n8n-callback writes the
 * n8n response text there (`recordDecisionCallbackProblem`), the expiry/notify
 * workers append transport failures. Operators triage from it, so the column
 * keeps it; a non-super-admin reader gets a generic sentence instead. Applied by
 * every lane that returns approval rows to a client (list, all, mine, get).
 */
const APPROVAL_ERROR_REDACTED =
  'A delivery or callback problem was recorded for this approval — the detail is available to an operator';
function clientSafeApprovalRow<T extends { error_message?: string | null }>(approval: T): T {
  if (approval.error_message === undefined || approval.error_message === null) return approval;
  return {
    ...approval,
    error_message: clientSafeStoredErrorText(approval.error_message, APPROVAL_ERROR_REDACTED),
  };
}

function toApprovalResponse<
  T extends Pick<ApprovalRow, 'action_name' | 'action_input_json'> & { error_message?: string | null },
>(
  rawApproval: T,
): T & { document?: { filename: string; content_type: string; byte_size: number } } {
  const approval = clientSafeApprovalRow(rawApproval);
  const info = approvalDocumentInfo(approval);
  if (!info) return approval;
  let action_input_json = approval.action_input_json;
  if (action_input_json && typeof action_input_json === 'object') {
    const { file_b64: _omit, ...rest } = action_input_json as Record<string, unknown>;
    action_input_json = rest as ApprovalRow['action_input_json'];
  }
  return {
    ...approval,
    action_input_json,
    document: {
      filename: info.filename,
      content_type: info.content_type,
      byte_size: estimateBase64DecodedBytes(info.file_b64),
    },
  };
}

type RequiredApproverRow = typeof requiredApprovers.$inferSelect;
type DecisionRow = typeof approvalDecisions.$inferSelect;
type ApproverIdentityMap = Record<string, { id: string; email: string | null; name: string }>;

/**
 * Resolve a roster's `user_id`s (Keycloak `sub` UUIDs) to displayable people.
 *
 * There is NO local `users` table in fr — `required_approvers.user_id` is a bare
 * Keycloak subject UUID and nothing in the schema carries a name or an email for
 * it (`user_roles.tenant_name` is the tenant's label; `user_secrets.name` is the
 * secret's). So the roster chip had nothing to render but the raw UUID.
 *
 * This reuses the EXISTING batch helper (`services/keycloak.ts :: resolveUsers`,
 * the same primitive the licenses-admin subject_id table uses) rather than
 * calling Keycloak per row inside the render loop: ids are deduped and fired as
 * one bounded `Promise.all`, so a page of 11 approvals sharing 3 approvers costs
 * 3 lookups, not 22 — the same dedupe discipline routes/comments.ts:125 applies
 * to comment authors.
 *
 * Best-effort by design, on two axes, and BOTH degrade to exactly today's
 * behaviour (a bare UUID in the chip) rather than to an error:
 *   - `resolveUsers` omits any id it cannot resolve (user deleted, Keycloak
 *     unreachable, admin creds absent) — those come back `name: null`.
 *   - it caps the UNIQUE id set at `APPROVER_IDENTITY_RESOLVE_MAX`; we keep 50
 *     deliberately instead of raising it, because the cap bounds concurrent
 *     admin round-trips on an endpoint the frontend polls every 30s. Ids past
 *     the cap are omitted, i.e. status quo, never worse.
 * The try/catch is the third rung: identity hydration is decoration, and an
 * approvals list MUST stay readable when Keycloak is degraded. NB there is no
 * identity cache anywhere in this backend today; if these polls show up on the
 * Keycloak admin API, the fix belongs in `services/keycloak.ts`, not here.
 *
 * ⚠️ WHAT CHANGED — the cap is no longer SILENT.
 * `keycloak.resolveUsers` `.slice(0, cap)`s without a word, and a dropped id
 * renders in the chip as `user_id.slice(0, 8)` — a plausible-looking short hash,
 * not a visible gap. That is survivable for a read-only list and NOT survivable
 * under a bulk-decide button, where "who am I deciding on behalf of" is the
 * whole question. The cap applies to the resolved ID SET, not to rows, so it
 * scales with rows × approvers-per-row: a 50-row page averaging two required
 * approvers is 100 unique ids, half of them silently unresolved.
 *
 * So this returns `{ identities, truncated }` and logs a warn carrying the
 * counts. It does NOT throw — the endpoint is polled every 30s and exceeding
 * the cap is a legitimate, servable state; this follows the `kag_degraded`
 * precedent in `integrations/kag.ts` (serve the payload, flag the degradation
 * in-band) rather than the fail-closed precedent used for auth. `truncated`
 * is emitted as a POSITIVE all-clear when false, for the same reason
 * `KagDegradation.degraded: false` is: absent ≠ verified-complete.
 */

/**
 * Cap PINNED AT THE CALL SITE, deliberately.
 *
 * ⚠️ This used to cite `routes/admin/licenses-admin.ts :: RESOLVE_USERS_MAX`
 * (200) as the precedent. That constant and its endpoint were DELETED when the
 * licence Person column was removed (a licence is held by a tenant, so nothing
 * needed to name the person), leaving this a dangling citation. The reasoning
 * below is unchanged and stands on its own.
 *
 * Do NOT "fix" this by raising the default in `services/keycloak.ts` — the
 * remaining callers of `resolveUsers` disagree on purpose: `routes/admin/users.ts`
 * chunks at 50 so it resolves everyone, and this route accepts truncation because
 * it polls. Moving the
 * default silently re-tunes the other two.
 */
const APPROVER_IDENTITY_RESOLVE_MAX = 50;

interface ApproverIdentityResolution {
  identities: ApproverIdentityMap;
  /**
   * True when the roster carried more UNIQUE approver ids than the cap can
   * resolve, so `identities` is knowingly partial and some chips will render a
   * raw UUID. False is a positive all-clear: every id was offered to Keycloak.
   * (An id Keycloak simply could not resolve is NOT truncation — that is the
   * best-effort axis above, and conflating the two would make this flag fire on
   * a degraded Keycloak and mean nothing.)
   */
  truncated: boolean;
}

async function resolveApproverIdentities(
  // Only `user_id` is read: roster rows, plus (FR-9) one pseudo-row per decision
  // approver and per requester, so those render as names too.
  rosterRows: ReadonlyArray<{ user_id: string | null }>,
): Promise<ApproverIdentityResolution> {
  const ids = rosterRows.map((r) => r.user_id).filter((id): id is string => Boolean(id));
  if (ids.length === 0) return { identities: {}, truncated: false };

  // Dedupe with the SAME rule `resolveUsers` applies internally
  // (`[...new Set(ids.filter(Boolean))]`) so the boundary we assert is the
  // boundary it actually enforces. Counting ROWS here instead would fire on a
  // 60-row page shared by 3 approvers, which is not truncated at all.
  const uniqueCount = new Set(ids).size;
  const truncated = uniqueCount > APPROVER_IDENTITY_RESOLVE_MAX;
  if (truncated) {
    console.warn(
      `[approvals] approver identity map TRUNCATED: ${uniqueCount} unique approver ids ` +
        `exceed the ${APPROVER_IDENTITY_RESOLVE_MAX}-id resolve cap; ` +
        `${uniqueCount - APPROVER_IDENTITY_RESOLVE_MAX} will render as raw UUIDs ` +
        `(rosterRows=${rosterRows.length}). Page the roster or chunk the resolve — ` +
        `do NOT raise the keycloak.resolveUsers default.`,
    );
  }

  try {
    return {
      identities: await keycloak.resolveUsers(ids, APPROVER_IDENTITY_RESOLVE_MAX),
      truncated,
    };
  } catch (err) {
    console.error('[approvals] approver identity resolve failed:', err);
    return { identities: {}, truncated };
  }
}

/**
 * FR-9: every user id an approval response renders — roster, decision approvers
 * and requesters — as `{user_id}` rows for ONE `resolveApproverIdentities` call.
 * Before this, only the roster was resolved, so "Requested by" and each decision
 * line printed a raw UUID.
 */
function identityRowsFor(
  required: ReadonlyArray<{ user_id: string | null }>,
  decisions: ReadonlyArray<{ approver_id: string | null }>,
  requesterIds: ReadonlyArray<string | null | undefined>,
): Array<{ user_id: string | null }> {
  return [
    ...required,
    ...decisions.map((d) => ({ user_id: d.approver_id })),
    ...requesterIds.map((id) => ({ user_id: id ?? null })),
  ];
}

/** One decision for the response: `approver_id` unchanged, name/email ADDITIVE (null when unresolved). */
function toDecisionEntry(d: DecisionRow, identities: ApproverIdentityMap) {
  const identity = d.approver_id ? identities[d.approver_id] : undefined;
  return {
    approver_id: d.approver_id,
    approver_name: identity?.name || null,
    approver_email: identity?.email ?? null,
    decision: d.decision,
    comment: d.comment,
    decided_at: d.decided_at,
    // Migration 211 (R-CK1): human | triage_agent | rule.
    decided_by_kind: d.decided_by_kind,
  };
}

const VOIDER_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `voided_by` as an id to resolve — only when it IS a user id. In practice it is
 * also free text (`operator:george via claude-session …`, `migration:114_…`),
 * which must never reach the Keycloak resolve.
 */
function voiderId(voidedBy: unknown): string | null {
  return typeof voidedBy === 'string' && VOIDER_UUID_RE.test(voidedBy.trim()) ? voidedBy.trim() : null;
}

/**
 * `voided_by_name` for an approval row: the resolved name when `voided_by` is a
 * user id (fr review round 3: 1,926 voided rows showed the oversight account's
 * raw uuid as "Voided by"), else null — the client then shows `voided_by` as is.
 */
function voiderIdentity(
  voidedBy: unknown,
  identities: ApproverIdentityMap,
): { voided_by_name: string | null } {
  const id = voiderId(voidedBy);
  const identity = id ? identities[id] : undefined;
  return { voided_by_name: identity?.name || identity?.email || null };
}

/** `requester_name`/`requester_email` for an approval row (null when absent or unresolved). */
function requesterIdentity(
  requesterId: string | null | undefined,
  identities: ApproverIdentityMap,
): { requester_name: string | null; requester_email: string | null } {
  const identity = requesterId ? identities[requesterId] : undefined;
  return { requester_name: identity?.name || null, requester_email: identity?.email ?? null };
}

/**
 * Shape one required-approver row for the response. `user_id` is unchanged and
 * still authoritative; `name`/`email` are ADDITIVE and are null when the identity
 * could not be resolved. Null is a rendering instruction — fall back to the raw
 * id (name, then email, then id) — not a missing value to paper over with a
 * fabricated placeholder name.
 */
function toRosterEntry(
  r: RequiredApproverRow,
  decisions: DecisionRow[],
  identities: ApproverIdentityMap,
) {
  const identity = r.user_id ? identities[r.user_id] : undefined;
  return {
    user_id: r.user_id,
    role: r.role,
    name: identity?.name || null,
    email: identity?.email ?? null,
    approved: decisions.some((d) => d.approver_id === r.user_id && d.decision === 'approved'),
  };
}

/**
 * `:approvalId` is an arbitrary URL path segment until proven otherwise, and
 * `approvals.id` is a PostgreSQL `uuid` column. Handing that column a segment
 * that is not a UUID does NOT return zero rows — it aborts the query with
 * `22P02 invalid input syntax for type uuid`, which escapes every handler here
 * and surfaces as a bare 500.
 *
 * ⛔ THE DEFECT THIS CLOSES: `/api/approvals/pending` 500'd, and it was never
 * about the word "pending". There is no `pending` route — server.ts (:~1979)
 * registers the static `/api/approvals` and `/api/approvals/all` ahead of the
 * parameterized `/api/approvals/:approvalId` precisely so they are not captured
 * as ids, and anything else falls through to `:approvalId`. Measured against
 * prod 2026-08-31: `GET /api/approvals/pending?limit=1000` → 500
 * `{"error":"Internal server error"}`, with `PostgresError: invalid input
 * syntax for type uuid: "pending" … code: "22P02"` in the fr pod log, while
 * `GET /api/approvals/all?status=pending&limit=1000` → 200 (639 rows).
 * `GET /api/approvals/not-a-uuid` 500'd identically — so EVERY malformed id on
 * this route family was a 500, on GET, on the document lane, and on PUT.
 *
 * 404, not 400, and deliberately the SAME body a well-formed-but-absent id
 * already gets (verified: a syntactically valid unknown UUID 404s "Approval not
 * found"). A segment that cannot be a UUID cannot name an approval, so "not
 * found" is the honest answer; splitting it into a distinct 400 would also hand
 * a prober a free oracle for telling malformed from absent, which is the exact
 * existence-probe leak handleUpdateApproval's tenant filter is written to deny.
 *
 * `isValidUuid` (utils/tenant) rather than a local regex or zod's `.uuid()`:
 * it additionally accepts the reserved bootstrap/system UUIDs whose version
 * nibble is `0` (`…-0000-0000-…`). Those are not RFC 9562 v1–v8 but they ARE
 * legal `uuid` literals and they are in production tables, so a stricter check
 * would 404 rows that genuinely exist.
 */
/**
 * THE approver-identity predicate — B10a. ONE definition, and every site that asks
 * "is this caller on the roster for this approval?" calls it.
 *
 * ⛔ THE BODY NOW LIVES IN `lib/approval-roster-lane.ts` AND IS RE-EXPORTED HERE
 * UNCHANGED. It moved because `rosteredApprovalLane` — the new roster visibility
 * lane — has to compose the identical predicate inside its correlated subquery,
 * and re-deriving it there would have recreated the very duplication this function
 * was extracted to end. ⚠️ It said FOUR call sites in this file —
 * `loadReachableApproval`, `handleUpdateApproval`, `handleTriageApproval`,
 * `handleListMyApprovals` — and `handleTriageApproval` was DELETED on 2026-09-23
 * (unrouted; see its tombstone below), so it is THREE now. The re-export keeps the
 * remaining call sites, and every importer of this module, textually untouched.
 *
 * Read the contract — what it does and does NOT answer — at its definition.
 */
export { approverIdentityFilter };

function assertApprovalIdShape(approvalId: string): void {
  if (!isValidUuid(approvalId)) {
    throw new NotFoundError('Approval not found');
  }
}

/**
 * Load an approval scoped to the caller and enforce the SAME reachability rule
 * as handleGetApproval — tenant-scoped, and for project-bound rows the caller
 * must own the project OR be the requester OR be on the approver roster. This
 * is factored out so the document-bytes endpoint never leaks a file more
 * broadly than the approval it belongs to. Throws NotFoundError on miss/deny.
 */
async function loadReachableApproval(
  user: Awaited<ReturnType<typeof validateAuth>>,
  approvalId: string,
): Promise<ApprovalRow> {
  // Before any `uuid`-typed predicate is built — see assertApprovalIdShape.
  // Covers both read lanes (GET /:approvalId and GET /:approvalId/document),
  // which is why it lives here and not in each handler.
  assertApprovalIdShape(approvalId);
  // fr row 14d: tenant-pinned for EVERY caller (the super-admin home-view
  // bypass, id-only with no reachability check, is gone). A super-admin reaches
  // another workspace's approval only by switching into it.
  const approvalScope = and(
    eq(approvals.id, approvalId),
    eq(approvals.tenant_id, ctxTenantId(user.tenantId)),
  );
  const [approval] = await db.select().from(approvals).where(approvalScope);
  if (!approval) {
    throw new NotFoundError('Approval not found');
  }
  // null-project (n8n / KAG worker ingest) → any user in this tenant.
  // project-bound → own the project OR requested it OR on the approver roster.
  if (approval.project_id) {
    let reachable = approval.requester_id === user.id;
    if (!reachable) {
      const approverIdentity = approverIdentityFilter(user);
      const [rosterRow] = await db.select({ approval_id: requiredApprovers.approval_id })
        .from(requiredApprovers)
        .where(and(eq(requiredApprovers.approval_id, approvalId), approverIdentity));
      reachable = !!rosterRow;
    }
    if (!reachable) {
      const project = await findTenantScopedProject(db, user, approval.project_id);
      reachable = !!project;
    }
    if (!reachable) {
      throw new NotFoundError('Approval not found');
    }
  }
  return approval;
}

/**
 * Hard ceiling on one page of /api/approvals/all. Not a silent narrowing: the
 * APPLIED limit is echoed back as `limit` and `total` always reports the full
 * matching population, so a caller can always tell it was clamped.
 */
const MAX_APPROVALS_PAGE_SIZE = 1000;

/**
 * Every status an approvals row can actually hold.
 *
 * Sources, not guesses: `pending` is the column default (schema.ts); `approved` /
 * `rejected` are written by handleUpdateApproval; `expired` by
 * workers/approval-expiry.ts (EXPIRED_STATUS); `executing` / `done` / `failed` by
 * the E-5 action-approval bus (domain/engagement/action-approvals.ts) and its
 * stale-executing reaper; `voided` by lib/void-approvals.ts:186 (the ONLY writer —
 * that module is structurally incapable of writing any other status).
 *
 * Measured on prod (worker4, db `fr`, 2026-09-13,
 * `select status, count(*) from approvals group by 1`): approved 1984 / pending
 * 963 / voided 892 / expired 120 / rejected 33 — 3,992 rows over FIVE populated
 * statuses. The action-bus statuses are legal but still unpopulated, and
 * admitting them costs nothing while rejecting them would 400 a legitimate query
 * the moment the bus writes one.
 *
 * ⛔ WHY `voided` WAS MISSING, AND WHY THAT IS THE FAILURE MODE TO WATCH FOR. This
 * list was written on 2026-09-04 against the four statuses that existed then.
 * Migration 110 (`backend/migrations/110_approval_void.sql`) added `voided`
 * AFTERWARDS, and nothing brought the list forward with it — so from the day the
 * first void was written until this fix, `?status=voided` answered
 * 400 "status must be one of: …" for 892 real rows, and this list's own docblock
 * below argued (correctly) that leaving a REAL status unnamed makes it unaskable.
 * That argument was already in the file; the bug simply repeated one status later.
 *
 * ⚠️ `approvals.status` is `text NOT NULL DEFAULT 'pending'` with NO CHECK and no
 * enum (schema.ts; migration 110 confirms the absence by grep through 109). So
 * THE DATABASE WILL NOT STOP THE NEXT ONE EITHER — a new status becomes legal the
 * moment application code writes it, silently, with no schema change to review.
 * Anyone adding a status must add it HERE in the same change, and the honest check
 * is the query above against prod, not a reading of this list.
 */
export const APPROVAL_STATUS_FILTERS = [
  'pending',
  'approved',
  'rejected',
  'expired',
  // Terminal and NOT a decision: an operator withdrew an unanswerable ask.
  // Separate from `rejected` (a human said no) and `expired` (the clock ran out)
  // on purpose — see migration 110. It writes no `approval_decisions` row.
  'voided',
  'executing',
  'done',
  'failed',
] as const;

/**
 * The two buckets that are NOT members of `DEBLOCK_ACTIONS` but must still be
 * askable and countable.
 *
 * `none` — the row carries no usable `metadata.deblock_action` (absent, JSON
 * null, a non-string, `''` or whitespace). Measured on the live queue
 * 2026-08-26: 9 of 29 pending rows carried none, and on the 2026-09-15 drive the
 * badge simply renders nothing for them. They are a real, large cohort of the
 * queue and "no action proposed" is a legitimate thing to filter to — it is the
 * set a decider cannot act on mechanically.
 *
 * `other` — a non-empty string outside the closed set. `asDeblockAction`
 * (domain/engagement/deblock-actions.ts) DROPS such a value on the way to n8n,
 * so a row here is one whose stored action can never move its card. It exists as
 * a bucket so the facet totals SUM TO `total`; without it an unrecognised value
 * would be counted nowhere and the chip row would quietly under-report the
 * population, which is the exact defect `kind_totals` was added to end one facet
 * row up.
 */
const ACTION_BUCKET_NONE = 'none';
const ACTION_BUCKET_OTHER = 'other';

/**
 * Every value `?deblock_action=` accepts — the closed BLOCKED-exit set plus the
 * two buckets above. Derived from `DEBLOCK_ACTIONS`, never retyped: a member
 * added there becomes askable here in the same change (the five-copies failure
 * that file's docblock exists to prevent).
 */
const APPROVAL_ACTION_FILTERS = [
  ...DEBLOCK_ACTIONS,
  ACTION_BUCKET_NONE,
  ACTION_BUCKET_OTHER,
] as const;

/**
 * ⭐ ONE SQL EXPRESSION, used by BOTH the `GROUP BY` that counts the facets and
 * the `WHERE` that filters to one of them.
 *
 * ⛔ THAT SHARING IS THE POINT, and it is the same rule the `kindQuery` below
 * states about reusing `where`: a facet whose count is computed by one rule and
 * whose filter is applied by another can disagree with its own list, and a chip
 * that says QUESTION 395 while its filtered list shows 387 is worse than no chip.
 * Here they cannot drift — selecting the bucket is literally asking for the rows
 * this expression put in it.
 *
 * `metadata` is untyped jsonb written by n8n, so the normalisation mirrors
 * `deblockActionOf` in frontend/src/lib/approvals/question.ts: `->>` yields NULL
 * for an absent key and for a JSON null, and a blank or whitespace-only string is
 * treated as absent rather than as an action named ''.
 *
 * ⚠️ CORRECTED 2026-09-15 — this sentence also claimed `->>` yields NULL for "a
 * non-string value". It does NOT, and the difference is load-bearing: `->>`
 * RENDERS a non-string as text, so a JSON number `4242` comes back as `'4242'`
 * and `true` as `'true'`, both of which fall through the CASE to `other` rather
 * than to `none`. Measured directly against Postgres 18. The CODE was always right; only this comment was wrong — which is worse
 * than a wrong comment usually is, because the frontend mirror was written to
 * match the sentence rather than the behaviour.
 *
 * ⚠️ It is NOT indexable — a `CASE` over a jsonb extraction cannot use an index
 * on `metadata`. That is accepted rather than overlooked: this handler already
 * runs an unindexed `count(*)` over the same predicate on every page load, the
 * population is ~4k rows per tenant, and buying an index would mean an expression
 * index on a field n8n writes freely.
 */
const deblockActionText = sql<string>`btrim(coalesce(${approvals.metadata} ->> 'deblock_action', ''))`;
const deblockActionBucket = sql<string>`(case
    when ${deblockActionText} = '' then ${ACTION_BUCKET_NONE}
    when ${deblockActionText} in (${sql.join(
      DEBLOCK_ACTIONS.map((a) => sql`${a}`),
      sql`, `,
    )}) then ${deblockActionText}
    else ${ACTION_BUCKET_OTHER}
  end)`;

/**
 * Parse `?deblock_action=`. Absent or empty → no filter. Present and
 * unrecognised → 400, for the reason `parseApprovalStatusFilter` gives at
 * length: a filter that silently declines to filter reports an unfiltered
 * population as if it were the filtered one, and nothing downstream can tell.
 *
 * Case-sensitive, same as `?status=`: the stored values are upper-case and
 * lower-casing a caller's guess would be a second guess in a function that
 * exists because guessing was the bug.
 */
function parseDeblockActionFilter(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  if (!(APPROVAL_ACTION_FILTERS as readonly string[]).includes(raw)) {
    throw new BadRequestError(
      `deblock_action must be one of: ${APPROVAL_ACTION_FILTERS.join(', ')}`,
    );
  }
  return raw;
}

/**
 * Parse `?status=`. Absent → no filter. Present and unrecognised → 400.
 *
 * ⛔ THE DEFECT THIS CLOSES. The predicate used to be a bare three-way `if` with
 * NO else and no validator:
 *
 *     if (statusParam === 'pending' || statusParam === 'approved' ||
 *         statusParam === 'rejected') { conditions.push(...) }
 *
 * so ANY other value fell through to an UNFILTERED list that was then reported as
 * if it were the filtered one. Measured 2026-09-04: `?status=zzzznotreal`,
 * `?status=PENDING` and `?status=` each returned the full 2,448 rows, and
 * `?status=expired` — a real, populated status the whitelist simply never
 * named — returned 2,448 instead of 106. A **23x overstatement** presented as an
 * answer to the question that was asked.
 *
 * Both halves matter. Adding `expired` alone would fix the counting error while
 * leaving every typo silently answering with the whole table; refusing unknown
 * values alone would leave `expired` unaskable. A filter that silently declines
 * to filter is worse than one that errors, because nothing downstream can tell.
 *
 * `''` (an empty `?status=`) is treated as ABSENT, not as an error: that is what a
 * form control submits for "any status", and it is the one falling-through value
 * whose old behaviour — the unfiltered list — was actually correct.
 *
 * ⚠️ `BadRequestError` (400), NOT `ValidationError`. MEASURED while writing this:
 * `ValidationError` in `utils/errors.ts` carries **statusCode 422**, not 400 —
 * despite `parseApprovalsPaging`'s docblock a few lines above asserting it throws
 * "`ValidationError` (400)". That docblock is simply wrong about its own class, and
 * `?limit=abc` really does answer 422 today. An unparseable enum in a query string
 * is a MALFORMED REQUEST (400), not a well-formed one that cannot be processed
 * (422), so this uses the class that actually emits 400 rather than copying a
 * neighbour that documents one code and sends another. The paging behaviour is
 * left alone — changing a live status code is not this change's business.
 */
function parseApprovalStatusFilter(raw: string | null): string | undefined {
  if (raw === null || raw.trim() === '') return undefined;
  if (!(APPROVAL_STATUS_FILTERS as readonly string[]).includes(raw)) {
    // Case-sensitive on purpose: the column stores lowercase, so `PENDING` would
    // match zero rows. Silently lower-casing it would be a second guess about
    // caller intent in a function that exists because guessing was the bug.
    throw new BadRequestError(
      `status must be one of: ${APPROVAL_STATUS_FILTERS.join(', ')}`,
    );
  }
  return raw;
}

/**
 * Parse `?limit=`/`?offset=` for the cross-project list. Absent or empty →
 * `undefined` limit / `0` offset, i.e. byte-identical to the pre-pagination
 * behaviour (every matching row). Anything present but not a sane non-negative
 * integer is a caller error and throws `ValidationError` (400) rather than
 * being silently dropped — a silently ignored `limit` is the exact defect this
 * closes (`?limit=10` returned 22 rows in production, 2026-08-26).
 */
/**
 * `?kind_counts=1` — opt in to the per-`kind` aggregate on the cross-project
 * list (`kind_totals` in the envelope).
 *
 * ⭐ OPT-IN, NOT ALWAYS-ON, and the reason is the caller mix rather than
 * squeamishness about a GROUP BY. This endpoint is not read once per page: the
 * /approvals page also fires FOUR `status=X&limit=1` population probes (see the
 * `statusTotals` docblock in frontend/src/routes/approvals/+page.svelte) plus a
 * fifth untabbed one, and there are machine callers (triage/drain seats) that
 * want rows and nothing else. Making the aggregate unconditional would put a
 * third scan of the same population behind every one of those, to serve a
 * number only the facet row reads. One flag on the ONE request that renders the
 * facets costs one extra query per page load.
 *
 * Anything but a recognised truthy token is `false` — an unrecognised value is
 * NOT a 400 here, because unlike `?status=` and `?limit=` a mis-typed flag
 * cannot produce a wrong ANSWER, only an absent optional key.
 */
function parseKindCountsFlag(url: URL): boolean {
  return parseCountsFlag(url, 'kind_counts');
}

/**
 * `?action_counts=1` — opt in to the per-`deblock_action` aggregate
 * (`action_totals`). Same opt-in reasoning, same parser, as `kind_counts`: the
 * /approvals page fires five `limit=1` population probes per refresh and only
 * the ONE rows request renders facets.
 */
function parseActionCountsFlag(url: URL): boolean {
  return parseCountsFlag(url, 'action_counts');
}

/**
 * `?actionable=1` — narrow the cross-project list to the ROSTER LANE ALONE: only
 * approvals this caller is required to decide.
 *
 * ⭐ IT IS A NARROWING, NOT A WIDENING, AND THAT IS WHY IT IS SAFE TO ADD IN THE
 * SAME CHANGE AS THE LANE. The default list is `owned_projects OR rostered OR
 * unscoped_project`; this drops the first and third disjuncts. The roster lane
 * carries its own `required_approvers.tenant_id = <active tenant>` conjunct, so a
 * narrowed list can never reach further than the disjunction it was carved out of.
 *
 * It exists because the default list answers "what can I see", and a decider needs
 * "what is waiting on ME". Before the roster lane those were the same question for
 * an owner and an unanswerable one for everybody else.
 *
 * Same truthiness rule as the aggregate flags, and the same reason an unrecognised
 * value is `false` rather than a 400: a mis-typed flag here cannot produce a WRONG
 * answer, only a wider one — and the envelope's `scope` states which it gave.
 */
function parseActionableFlag(url: URL): boolean {
  return parseCountsFlag(url, 'actionable');
}

/** Shared truthiness rule for the two opt-in aggregate flags. */
function parseCountsFlag(url: URL, name: string): boolean {
  const raw = url.searchParams.get(name);
  if (raw === null) return false;
  // `?kind_counts` with no `=` yields '' — the HTML-ish "present means true".
  if (raw === '') return true;
  return ['1', 'true', 'yes'].includes(raw.trim().toLowerCase());
}

function parseApprovalsPaging(url: URL): { limit?: number; offset: number } {
  const readInt = (name: string): number | undefined => {
    const raw = url.searchParams.get(name);
    if (raw === null || raw.trim() === '') return undefined;
    const n = Number(raw);
    if (!Number.isInteger(n)) {
      throw new ValidationError(`${name} must be an integer`);
    }
    return n;
  };
  const rawLimit = readInt('limit');
  const rawOffset = readInt('offset');
  if (rawLimit !== undefined && rawLimit < 1) {
    throw new ValidationError('limit must be >= 1');
  }
  if (rawOffset !== undefined && rawOffset < 0) {
    throw new ValidationError('offset must be >= 0');
  }
  return {
    limit: rawLimit === undefined ? undefined : Math.min(rawLimit, MAX_APPROVALS_PAGE_SIZE),
    offset: rawOffset ?? 0,
  };
}

/**
 * GET /api/approvals/all?status=pending|approved|rejected&limit=&offset=
 *                        &deblock_action=&kind_counts=1&action_counts=1
 *
 * Cross-project approvals for the /approvals page — every approval the caller
 * can see in the active tenant, in ONE query. Replaces the page's old
 * per-project fan-out (projects.list() → N× /api/projects/:id/approvals).
 *
 * Two visibility lanes, `OR`-ed under a defense-in-depth `approvals.tenant_id`
 * predicate (left join to projects so null-project rows survive):
 *   - Project-bound rows: the SAME boundary as handleListProjects — the
 *     identical `tenantScopedProjectFilter` (owner-scoped in home view; whole
 *     workspace for a super-admin switched view) + non-archived-project filter.
 *   - Null-project rows (n8n / KAG worker ingest): visible to any user in the
 *     tenant, matching handleGetApproval's null branch + rbac.ts defaultRule
 *     (`projectId null → tenant-role 'user'`). Before this the inner join
 *     dropped them entirely, so the list and detail endpoints disagreed.
 * The archived + project-scope predicates live INSIDE the project lane only —
 * under the left join `projects.*`/`departments.*` are NULL for null-project
 * rows, so a top-level `ne(projects.status,'archived')` would re-drop them.
 *
 * ⛔ fr row 14d: there is NO cross-tenant lane. The outer
 * `approvals.tenant_id = active` predicate applies to every caller, a
 * super-admin in home view included. `includeAllOwners` (a switched super-admin
 * or the orchestrator seat) widens the OWNER filter *within* the active tenant
 * only, and only through `tenantScopedProjectFilter`'s tag-based switched branch.
 *
 * Enrichment (required_approvers + decisions), the `projectName` join, and the
 * `document` descriptor match handleGetApproval.
 *
 * ⭐ A THIRD LANE — THE ROSTER LANE — was added because the two above are BOTH
 * owner-or-nothing for a project-bound row: `tenantScopedProjectFilter` pins
 * `projects.owner_id = user.id`, so a tenant member REQUIRED to approve a row on
 * someone else's project saw nothing, while `handleUpdateApproval` (no owner
 * filter) would have let them decide it. `rosteredApprovalLane`
 * (lib/approval-roster-lane.ts) is a correlated `EXISTS` over `required_approvers`
 * scoped to the ACTIVE tenant. It is purely ADDITIVE and does not touch
 * `tenantScopedProjectFilter`, which `handleListProjects` and the metrics
 * aggregate share.
 *
 * `?actionable=1` uses that lane ALONE — a NARROWING of the disjunction, for a
 * decider who wants "what is waiting on me" rather than "what can I see".
 *
 * Envelope: `{ data, items, total, scope, scope_lanes, scope_tenant_id, limit, offset }`.
 *   - `items`/`data` are ONE PAGE (`limit`/`offset` applied at the SQL level).
 *   - `total` counts the WHOLE matching population, not the page — the same
 *     WHERE + joins, `count(*)`. Measured 2026-08-26: `total` was `items.length`,
 *     so a bulk-selection UI could not tell a full result from a truncated one.
 *   - `scope`/`scope_tenant_id` state WHICH population `total` counted. The old
 *     number was not lying, it truthfully counted a scope the caller never asked
 *     for and could not see; being internally consistent, nothing could
 *     contradict it. ⚠️ `'tenant'` IS GONE — it asserted a tenant-wide population
 *     over an owner-pinned result set. The vocabulary is now
 *     `'tenant_owned_or_rostered'` (default) · `'tenant_rostered'`
 *     (`?actionable=1`) · `'all'` (super-admin home view) · `'project'` (the
 *     project-scoped list). See `APPROVAL_SCOPE` / `describeScope`.
 *   - `scope_lanes` names the DISJUNCTS actually applied, which `scope` alone
 *     cannot: one string cannot say whether the project arm carried an owner pin.
 *     Always present.
 *   - `kind_totals` (only with `?kind_counts=1`): `{ [approval_kind]: n }` over
 *     the WHOLE matching population, one `GROUP BY approvals.kind` on the same
 *     `where`. Its values sum to `total`. Opt-in — see `parseKindCountsFlag`.
 *   - `action_totals` (only with `?action_counts=1`): `{ [bucket]: n }` over the
 *     population WITHOUT `?deblock_action=` applied — see `whereWithoutAction`
 *     for why a facet must not be conditioned on itself.
 *   - `deblock_action`: the action filter as applied, or null.
 *
 * `?deblock_action=` narrows to ONE bucket of `metadata.deblock_action`
 * (`parseDeblockActionFilter`). It is what makes a large queue workable: the
 * ~395 QUESTION rows of a 1,294-row pending population are one request, not
 * seven pages of a blanket list — the DB stops producing the rest rather than
 * the browser hiding them.
 */
export async function handleListAllApprovals(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  const activeTenantId = ctxTenantId(user.tenantId);
  // Only the super-admin switched view drops the owner pin. The AA orchestrator
  // seat used to share this widening via its X-Tenant-Id override; fr#1437 /
  // fr#1527 removed that override (403 `orchestrator_tenant_override_removed`),
  // so the seat acts only in its own JWT tenant like any other caller.
  const includeAllOwners = isSuperAdminSwitchedView(user, activeTenantId);

  const url = new URL(req.url);
  const statusParam = url.searchParams.get('status');
  const { limit, offset } = parseApprovalsPaging(url);
  // Project-bound lane. Keep the project/department predicates INSIDE this lane
  // — under the left join they are NULL for null-project rows and would
  // otherwise re-exclude them.
  //
  // fr row 14d: ONE project lane for every caller. The super-admin no-owner
  // project lane survives ONLY as the switched path (`includeAllOwners`), whose
  // predicate is the project's tag == the active tenant.
  //
  // ⭐ P1-TEAM-a (George 2026-10-15): `tenantScopedProjectFilter`'s member lane no
  // longer pins `owner_id`, so this arm is now EVERY project of the active tenant
  // (the TENANT lane, `scope: 'tenant'`). The roster and requester arms below
  // stay; for a same-tenant tagged project they are subsumed, and they still
  // alone reach an in-tenant row on a project tagged elsewhere.
  const projectLane = and(
    isNotNull(approvals.project_id),
    tenantScopedProjectFilter(user.id, activeTenantId, user.tenantId, {
      includeAllOwners,
      ...licenceProjectScope(user),
    }),
    ne(projects.status, 'archived'),
  );
  // Null-project lane (n8n / KAG worker ingest): tenant-wide visibility.
  const nullProjectLane = isNull(approvals.project_id);
  // ⭐ THE ROSTER LANE — THE THIRD DISJUNCT, AND THE DEFECT THIS CHANGE CLOSES.
  //
  // The owner pin inside `tenantScopedProjectFilter` is not defense in depth here,
  // it is the whole filter for a project-bound row — so a tenant member who is a
  // REQUIRED APPROVER on a project someone ELSE owns matched neither lane above and
  // saw nothing, while `handleUpdateApproval` (no owner filter at all) would have
  // let them decide that same row by id. Rostered-but-invisible is the find-vs-decide
  // asymmetry this file already documents for the super-admin seat, one identity over.
  //
  // ⛔ ADDITIVE, AND DELIBERATELY NOT AN EDIT TO `tenantScopedProjectFilter`. That
  // filter is shared with `handleListProjects`, `handleDeleteProject` and the metrics
  // aggregate; widening it would hand a rostered approver the PROJECT, not just the
  // approval. Being on a roster is a claim on one row, never on the workspace.
  //
  // ⛔ AND IT DOES NOT CROSS TENANTS, VIA TWO INDEPENDENT FENCES. Inside, the lane
  // pins `required_approvers.tenant_id = activeTenantId` — mandatory, because role
  // strings (`tech_lead`, `card_approver`) are tenant-SHARED labels and an unscoped
  // role match would SURFACE another workspace's row rather than merely fail to hide
  // it. Outside, `eq(approvals.tenant_id, activeTenantId)` below is unchanged. The
  // integration suite deletes each fence separately and requires each to go RED.
  const rosterLane = rosteredProjectLane(user, activeTenantId);
  // ⭐ THE REQUESTER LANE — THE FOURTH DISJUNCT.
  //
  // ⛔ THE DEFECT IT CLOSES, and it is the roster gap one identity over. A user who
  // RAISED an approval could not FIND it here unless they ALSO owned the project or
  // sat on the roster: `tenantScopedProjectFilter`'s `projects.owner_id = user.id`
  // pin is the whole filter for a project-bound row, and a requester is neither the
  // owner nor necessarily an approver. Meanwhile `handleListMyApprovals` has read
  // this very column as a visibility arm all along (:~3614/3617), so the SAME row
  // was reachable from `/api/approvals` and invisible on `/api/approvals/all` — two
  // list endpoints over one table disagreeing about who raised what.
  //
  // ⛔ IT IS A SINGLE `eq` ON THE OUTER TABLE, NOT A SUBQUERY, AND IT CARRIES NO
  // TENANT CONJUNCT OF ITS OWN. `requester_id` is a column on `approvals`
  // (schema.ts:941), so there is no second table to fence. That makes
  // `eq(approvals.tenant_id, activeTenantId)` below the SOLE fence between this
  // lane and a cross-tenant leak — where the roster lane has two independent ones.
  // Read `requesterApprovalLane`'s docblock before adding an `activeTenantId`
  // parameter to it "for symmetry"; the asymmetry is the point.
  const requesterLane = requesterProjectLane(user);
  // `?actionable=1` ⇒ the roster lane ALONE. `scope` reports which it was, so a
  // client can never mistake the narrowed population for the default one.
  //
  // ⛔ THE REQUESTER LANE IS DELIBERATELY ABSENT FROM THE ACTIONABLE BRANCH.
  // `?actionable=1` means "rows I can act on", and raising a request is not
  // authority to decide it — OR-ing `requesterProjectLane` in here would hand every
  // requester their own request as something to sign off. Visibility and authority
  // are different questions and this parameter asks the second one.
  const actionableOnly = parseActionableFlag(url);
  const visibilityLane = actionableOnly
    ? rosteredProjectLane(user, activeTenantId)
    : or(projectLane, nullProjectLane, rosterLane, requesterLane);
  // EXACTLY the disjuncts applied above — this array and `visibilityLane` are the
  // same decision written twice and must be changed together. `scope_lanes` is the
  // field that makes `scope` falsifiable: `tenant_owned_or_rostered` is one string
  // over a FOUR-arm predicate whose live arms depend on the caller's identity.
  const scopeLanes: ApprovalLane[] = actionableOnly
    ? [APPROVAL_LANE.ROSTERED]
    : [
        // P1-TEAM-a: the project arm is the TENANT-MEMBER lane for every
        // caller — no owner pin anywhere — so it is always `tenant_projects`.
        APPROVAL_LANE.TENANT_PROJECTS,
        APPROVAL_LANE.ROSTERED,
        APPROVAL_LANE.REQUESTED_BY_ME,
        APPROVAL_LANE.UNSCOPED_PROJECT,
      ];
  const conditions = [
    // fr row 14d: unconditional, for every caller. The super-admin home-view
    // relaxation that dropped it is gone.
    //
    // ⛔⛔ THIS LINE IS THE **SOLE** CROSS-TENANT FENCE FOR THE REQUESTER LANE.
    // Every other arm of `visibilityLane` carries a second, independent tenant
    // barrier: the project lane has the project's own tenant tag inside
    // `tenantScopedProjectFilter`, and the roster lane has
    // `required_approvers.tenant_id = activeTenantId` inside its EXISTS. The
    // requester lane has NEITHER, because `requester_id` is a bare user uuid on
    // `approvals` itself — there is no second table on which to put an inner fence.
    // So for a raised row this predicate is not defence in depth; it is the entire
    // defence, and deleting it puts tenant B's approvals in a tenant A user's queue.
    eq(approvals.tenant_id, activeTenantId),
    visibilityLane,
  ];
  const statusFilter = parseApprovalStatusFilter(statusParam);
  if (statusFilter) {
    conditions.push(eq(approvals.status, statusFilter));
  }
  // `?project_id=` (UI review 2026-10-07): pushed into `conditions`, so the
  // rows, `total`, the kind/action facets and the status counts all narrow
  // together — a filtered list beside unfiltered counts is the defect class
  // the facet docblock below exists for. Malformed ⇒ 400, not "no rows".
  const projectIdParam = url.searchParams.get('project_id');
  if (projectIdParam !== null) {
    if (!UUID_RE_LIST.test(projectIdParam)) {
      return jsonResponse({ error: 'invalid project_id', code: 'invalid_project_id' }, 400);
    }
    conditions.push(eq(approvals.project_id, projectIdParam));
  }

  // `workspaceName` joins the tenant the row belongs to. It is not cosmetic:
  // a super-admin once read EVERY tenant's approvals here (removed by fr row
  // 14d; every row is now the active tenant's), and a null-project row — which is what
  // the n8n improvement loops raise — carried no scope marker at all, so the
  // procedure-improvement and prompt-improvement queues were rendered
  // indistinguishably from the system queue's rows. Measured 2026-08-26: 33
  // procedure-workspace and 22 prompt-workspace approvals were visible to
  // super-admin and identifiable as neither.
  /**
   * ⭐ TWO PREDICATES, AND THE DIFFERENCE IS THE WHOLE FACET CONTRACT.
   *
   * `whereWithoutAction` is everything EXCEPT the action filter. It is what the
   * `action_totals` aggregate counts, so selecting QUESTION leaves the other
   * chips reading their real populations instead of collapsing to zero. A facet
   * conditioned on itself answers "how many of the rows I am already showing are
   * the thing I am showing?" — always the whole list — and stops being
   * navigation, which is precisely the failure `statusCount`'s docblock in
   * frontend/src/routes/approvals/+page.svelte records for the status pills.
   *
   * `where` adds it, and is what the ROWS, `total` and `kind_totals` use — so
   * `sum(kind_totals) === total` still holds under an action filter, and
   * `total` answers "how many QUESTION rows exist", which is the number the page
   * needs to know whether its page is the whole subset.
   */
  const whereWithoutAction = and(...conditions);
  const actionFilter = parseDeblockActionFilter(url.searchParams.get('deblock_action'));
  const where = actionFilter
    ? and(whereWithoutAction, eq(deblockActionBucket, actionFilter))
    : whereWithoutAction;
  const pageQuery = db
    .select({ approval: approvals, projectName: projects.name, workspaceName: workspaces.name })
    .from(approvals)
    .leftJoin(projects, eq(approvals.project_id, projects.id))
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .leftJoin(workspaces, eq(approvals.tenant_id, workspaces.id))
    .where(where)
    .orderBy(desc(approvals.created_at))
    .$dynamic();
  // `limit`/`offset` are applied in SQL, not by slicing the result — the point
  // is that the DB stops producing rows, and `offset` without `limit` is still
  // a legal window. `.$dynamic()` is what lets these be conditional.
  const paged = limit === undefined
    ? (offset > 0 ? pageQuery.offset(offset) : pageQuery)
    : pageQuery.limit(limit).offset(offset);

  // `total` counts the SAME population the page was drawn from — identical
  // WHERE and identical joins (the project/department joins are load-bearing:
  // `ne(projects.status,'archived')` and `tenantScopedProjectFilter` both read
  // joined columns, so a count without them would count a different set).
  const totalQuery = db
    .select({ n: count() })
    .from(approvals)
    .leftJoin(projects, eq(approvals.project_id, projects.id))
    .leftJoin(departments, eq(projects.dept_id, departments.id))
    .leftJoin(workspaces, eq(approvals.tenant_id, workspaces.id))
    .where(where);

  // ⭐ PER-KIND AGGREGATE over the SAME population `total` counted — the facet
  // row's missing server number.
  //
  // THE DEFECT IT CLOSES: frontend/src/routes/approvals/+page.svelte:768 counts
  // kinds over `byStatus`, i.e. over ONE `PAGE_SIZE` (200) page, while the
  // status pills two lines up read the server's `total`. With 978 matching rows
  // the facets describe 200 of them and the pills describe 978, side by side.
  // The file notes at :736 that no server aggregate exists; this is it.
  //
  // ⛔ IT REUSES `where` — the SAME object the page and the count use, not a
  // re-derived copy. The `where` is built ONCE above from the super-admin /
  // orchestrator / status conditions; an aggregate that rebuilt it could drift
  // from the list silently, and a facet that disagrees with its own list is
  // exactly the defect being fixed. The three leftJoins are load-bearing for
  // that predicate, NOT cosmetic (`ne(projects.status,'archived')` and
  // `tenantScopedProjectFilter` both read joined columns), so they are repeated
  // verbatim from `totalQuery` above and must be changed together.
  //
  // ONE query, ONE `GROUP BY` — no N+1 and no per-kind round trip; `limit` and
  // `offset` are deliberately NOT applied, which is the whole point.
  const kindCountsRequested = parseKindCountsFlag(url);
  const kindQuery = kindCountsRequested
    ? db
        .select({ kind: approvals.kind, n: count() })
        .from(approvals)
        .leftJoin(projects, eq(approvals.project_id, projects.id))
        .leftJoin(departments, eq(projects.dept_id, departments.id))
        .leftJoin(workspaces, eq(approvals.tenant_id, workspaces.id))
        .where(where)
        .groupBy(approvals.kind)
    : undefined;

  /**
   * ⭐ PER-ACTION AGGREGATE — the facet a decider actually reads.
   *
   * ⛔ THE DEFECT IT CLOSES, measured in a live browser 2026-09-15. /approvals
   * rendered 200 of 1,294 pending rows and offered exactly ONE facet, by `kind`
   * (`All 1294 / Improvement 310 / Execution 138 / Other 846`). But every row
   * badges its `deblock_action`, 104 of the 200 loaded rows were QUESTION, and
   * ~395 QUESTION rows exist estate-wide. So the one lens the page had sliced by
   * a dimension nobody decides on, while the dimension they do decide on —
   * "which of these are asking me something?" — could not be filtered to at all
   * and was mostly inside the 1,094 rows the page had never loaded.
   *
   * ⛔ IT COUNTS `whereWithoutAction`, NOT `where` — see the note there. Every
   * other property is copied from `kindQuery` deliberately: the same three
   * leftJoins (load-bearing for `tenantScopedProjectFilter` and the archived
   * predicate, not cosmetic), ONE `GROUP BY`, no N+1, and `limit`/`offset`
   * NEVER applied.
   */
  const actionCountsRequested = parseActionCountsFlag(url);
  const actionQuery = actionCountsRequested
    ? db
        .select({ action: deblockActionBucket, n: count() })
        .from(approvals)
        .leftJoin(projects, eq(approvals.project_id, projects.id))
        .leftJoin(departments, eq(projects.dept_id, departments.id))
        .leftJoin(workspaces, eq(approvals.tenant_id, workspaces.id))
        .where(whereWithoutAction)
        // ⛔ `GROUP BY 1` — THE ORDINAL — AND NOT `groupBy(deblockActionBucket)`,
        // WHICH IS A 500. MEASURED against a real Postgres 18 while writing this:
        //
        //   ERROR 42803: column "approvals.metadata" must appear in the GROUP BY
        //   clause or be used in an aggregate function
        //
        // The `CASE` carries BIND PARAMETERS (the closed action set), and drizzle
        // numbers them per occurrence: the select list renders `$1…$9` and the
        // GROUP BY renders `$10…$18`. Postgres matches a grouped expression to a
        // select expression by PARSE TREE, and two trees whose Param nodes carry
        // different `paramid`s are not equal — so it saw an ungrouped
        // `metadata` reference and refused the whole query. The expression is
        // textually identical and still wrong; equality of the SQL STRING is not
        // equality of the parsed expression.
        //
        // ⚠️ THE SHAPE OF THIS BUG IS THAT NOTHING ABOVE COULD CATCH IT. It is
        // not a type error (`tsc` is clean either way), and every frontend test
        // mocks the API client, so the whole page suite passes green against a
        // route that answers 500 to every `?action_counts=1`. Only executing the
        // SQL finds it.
        //
        // `1` refers to the first select column, which is the bucket — so the
        // ORDER OF `.select({ action, n })` ABOVE IS LOAD-BEARING. Adding a
        // column before `action` silently groups by the wrong one.
        .groupBy(sql`1`)
    : undefined;

  const [rows, totalRows, kindRows, actionRows] = await Promise.all([
    paged,
    totalQuery,
    kindQuery,
    actionQuery,
  ]);
  const total = totalRows[0]?.n ?? 0;

  // Every enum member is present, zeroes included. `kind` is a closed pg enum
  // (`approval_kind`), so "absent from the GROUP BY" means exactly zero and
  // saying so is honest — and a client that has to distinguish "0" from "this
  // server does not know that kind" would be back to guessing. `kind_totals`
  // is `undefined` (⇒ omitted from the JSON) when the flag is off, so a caller
  // that did not ask cannot mistake an unbuilt aggregate for an empty one.
  const kindTotals = kindRows
    ? (() => {
        const seeded = Object.fromEntries(
          approvalKindEnum.enumValues.map((k) => [k, 0]),
        ) as Record<string, number>;
        for (const r of kindRows) seeded[r.kind] = r.n;
        return seeded;
      })()
    : undefined;

  /**
   * Every bucket present, zeroes included — same reasoning as `kind_totals`:
   * "RETRY 0" is an answer, an absent key is a client guessing whether the
   * server knows the action at all. `undefined` (⇒ omitted) when the flag is
   * off, so a caller that did not ask cannot read an unbuilt aggregate as an
   * empty population.
   *
   * ⚠️ `sum(action_totals)` equals the population BEFORE the action filter, not
   * `total`. Under `?deblock_action=QUESTION` it is deliberately the LARGER
   * number, because that is what makes the other chips still navigable — see
   * `whereWithoutAction`. `action_totals[actionFilter] === total` is the
   * invariant that holds in that case, and it is the one the page asserts.
   */
  const actionTotals = actionRows
    ? (() => {
        const seeded = Object.fromEntries(
          APPROVAL_ACTION_FILTERS.map((a) => [a, 0]),
        ) as Record<string, number>;
        for (const r of actionRows) seeded[r.action] = r.n;
        return seeded;
      })()
    : undefined;

  // Batch the enrichment (2 IN queries, not 2×N) — this endpoint exists to kill
  // an N+1, so it must not reintroduce one server-side.
  const approvalIds = rows.map((r) => r.approval.id);
  const [allRequired, allDecisions] = approvalIds.length
    ? await Promise.all([
        db.select().from(requiredApprovers).where(inArray(requiredApprovers.approval_id, approvalIds)),
        db.select().from(approvalDecisions).where(inArray(approvalDecisions.approval_id, approvalIds)),
      ])
    : [[], []];

  const requiredByApproval = new Map<string, typeof allRequired>();
  for (const r of allRequired) {
    (requiredByApproval.get(r.approval_id) ?? requiredByApproval.set(r.approval_id, []).get(r.approval_id)!).push(r);
  }
  const decisionsByApproval = new Map<string, typeof allDecisions>();
  for (const d of allDecisions) {
    (decisionsByApproval.get(d.approval_id) ?? decisionsByApproval.set(d.approval_id, []).get(d.approval_id)!).push(d);
  }

  // One deduped identity resolve for the whole page, in the same batched spirit
  // as the two IN queries above — this endpoint exists to kill an N+1, so the
  // roster-name hydration must not smuggle one back in per row.
  const { identities, truncated: identitiesTruncated } = await resolveApproverIdentities(
    identityRowsFor(
      allRequired,
      allDecisions,
      rows.flatMap((r) => [r.approval.requester_id, voiderId(r.approval.voided_by)]),
    ),
  );

  const items = rows.map(({ approval, projectName, workspaceName }) => {
    const required = requiredByApproval.get(approval.id) ?? [];
    const decisions = decisionsByApproval.get(approval.id) ?? [];
    return {
      ...toApprovalResponse(approval),
      ...requesterIdentity(approval.requester_id, identities),
      ...voiderIdentity(approval.voided_by, identities),
      projectName,
      workspaceName,
      required_approvers: required.map((r) => toRosterEntry(r, decisions, identities)),
      decisions: decisions.map((d) => toDecisionEntry(d, identities)),
    };
  });

  // `scope` is the field that makes `total` readable: without it a client that
  // gets `total: 22` cannot distinguish "22 approvals exist" from "22 exist in
  // the one workspace we silently narrowed you to". Additive — `data`, `items`
  // and `total` keep their keys, so existing callers do not break; only
  // `total`'s VALUE changes, from the page length to the population size, which
  // is the only reading under which it and `limit` can coexist.
  return jsonResponse({
    data: items,
    items,
    total,
    // ⭐ P1-TEAM-a (George 2026-10-15): `'tenant'`. The project arm is now the
    // TENANT-MEMBER lane — every project of the active tenant, no owner pin — so
    // the population IS tenant-wide and the name retired on 2026-09-22 (when it
    // asserted a tenant-wide population over an owner-pinned subset) is honest
    // again. `scope_lanes` still names the arms. `?actionable=1` stays
    // `tenant_rostered`. Readers: the frontend decoder kept `'tenant'` as a
    // legacy value; the operator scripts compared `== "tenant"` first.
    // `scope_tenant_id` keeps its name and meaning. Never `'all'` (fr row 14d).
    scope: describeScope({ rosteredOnly: actionableOnly, tenantWide: true }),
    scope_tenant_id: activeTenantId,
    // The disjuncts ACTUALLY applied, in the order they are OR-ed. Additive and
    // always present: an absent key would leave a client unable to tell "this
    // server does not report lanes" from "no lane was applied".
    scope_lanes: scopeLanes,
    limit: limit ?? null,
    offset,
    // Per-`kind` population counts over the same WHERE as `total` — present
    // only under `?kind_counts=1`. `sum(kind_totals) === total` by construction
    // (one GROUP BY over one predicate), which is the invariant the facet row
    // needs and the paged count could never satisfy.
    kind_totals: kindTotals,
    // Per-`deblock_action` population counts, present only under
    // `?action_counts=1`. Counted over the population WITHOUT the
    // `?deblock_action=` filter applied, so the chips stay navigable while one
    // of them is selected. See `whereWithoutAction`.
    action_totals: actionTotals,
    // The action filter AS APPLIED, echoed back for the same reason `limit` and
    // `scope` are: a client must be able to tell a filtered list from an
    // unfiltered one it was handed, rather than inferring it from the rows. Null
    // when no filter was asked for.
    deblock_action: actionFilter ?? null,
    // Additive, always present. This is the queue endpoint a bulk-decide UI
    // reads, so it is the one that most needs to say whether the roster names
    // it is showing are complete. See resolveApproverIdentities.
    approver_identities_truncated: identitiesTruncated,
  });
}

/**
 * POST /api/projects/:projectId/approvals
 * Submit project for approval
 */
export async function handleCreateApproval(
  req: Request,
  projectId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Verify the project exists and is reachable in the requester's active
  // tenant (owner-AND-tenant gate, same as routes/projects.ts get/delete).
  await loadTenantScopedProject(db, user, projectId);

  // Check if there's already a pending approval — in the ACTIVE tenant, the same
  // tenant the insert below writes (fr row 14d). An approval's tenant_id can
  // differ from its project's tag (webhooks card-approval lets a body tenant_id
  // win), so a project_id-only read let another tenant's pending row answer
  // "already pending" here: a cross-tenant existence oracle, and a block on this
  // tenant's own request.
  const [existingApproval] = await db.select()
    .from(approvals)
    .where(
      and(
        eq(approvals.project_id, projectId),
        eq(approvals.tenant_id, ctxTenantId(user.tenantId)),
        eq(approvals.status, 'pending')
      )
    );

  if (existingApproval) {
    throw new ValidationError('An approval is already pending for this project');
  }

  const body = await req.json();
  const validated = CreateApprovalSchema.parse(body);

  // Create approval (expires in 24 hours)
  const expiresAt = new Date();
  expiresAt.setHours(expiresAt.getHours() + 24);

  const [approval] = await db.insert(approvals).values({
    tenant_id: ctxTenantId(user.tenantId),
    project_id: projectId,
    requester_id: user.id,
    description: validated.description,
    // ⛔ DELIBERATELY EXEMPT from `lib/approval-rationale.ts :: rationaleOrAbsence`,
    // which the three n8n producer routes (webhooks card-approval, execution
    // ready-signoff, improvement gates) now all apply. Written down rather than left
    // silent, because a half-applied invariant is how the next reader concludes it
    // applies nowhere.
    //
    // The exemption is about WHO is missing, not about the columns. The sentinel's
    // job is to name an absent MACHINE producer so the gap is visible and chaseable
    // upstream. Here there is no such producer: this route is the human self-service
    // path (`validateAuth` + project-owner gate), `requester_id` is set to that
    // person's id two lines above, and `source` takes its `'web'` default. The
    // accountable party is already ON the row, so stamping "no change summary was
    // supplied by …" onto it would be fr editorialising about a named human's own
    // form submission, not disclosing a producer gap.
    //
    // And the cohort is empty: measured on prod 2026-09-03 06:52 UTC, of 971 PENDING
    // `generic` approvals exactly ONE was minted here (`source='web'`,
    // aa11a001-0000-7aa1-8aa1-000000000a01) and it carries real prose. The other 970
    // are `source='n8n'` from the card-approval webhook. This route is not where the
    // silence lives.
    //
    // ⚠️ If this route ever becomes machine-callable (a service identity, an import,
    // an agent acting on a user's behalf), that argument dies with it and this site
    // must adopt `rationaleOrAbsence` with its own RATIONALE_PRODUCERS entry.
    change_summary: validated.change_summary,
    impact_analysis: validated.impact_analysis,
    status: 'pending',
    expires_at: expiresAt,
  }).returning();

  if (!approval) {
    throw new Error('Failed to create approval');
  }

  // Add required approvers
  await db.insert(requiredApprovers).values(
    validated.required_approvers.map(approver => ({
      tenant_id: ctxTenantId(user.tenantId),
      approval_id: approval.id,
      user_id: approver.user_id,
      role: approver.role,
    }))
  );

  // Fan-out notifications to approvers
  notifications.notificationService
    .fanOut({ ...approval, metadata: null }, [{ channel: 'websocket', address: 'broadcast' }])
    .catch((err) => console.error('[approvals] ws fan-out error:', err));

  // ⛔ ROLE APPROVERS WERE NEVER TOLD — THE NOTIFIED SET WAS STRICTLY SMALLER THAN
  // THE VISIBLE SET. This loop read `approver.user_id` and nothing else, while
  // `approverIdentityFilter` admits a caller by `required_approvers.user_id` OR by
  // `required_approvers.role`. So a roster row `{user_id: X, role: 'tech_lead'}`
  // makes the approval visible-and-decidable to EVERY tech_lead in the tenant and
  // notifies exactly one of them. Everybody else had to happen to look. Nothing
  // reported the gap: the websocket broadcast above still fired, so the page looked
  // alive, and `notification_log` recorded a delivery — to the one person it knew.
  //
  // ⚠️ MEASURED REFUTATION OF THE STRONGER CLAIM, recorded because it changes what
  // this code has to be robust to. The stated defect was "a roster row carrying a
  // `role` with a NULL `user_id` notifies nobody". That row CANNOT EXIST today:
  // `required_approvers.user_id` is `uuid(...).notNull()` (db/schema.ts:985) and
  // `information_schema` on a freshly migrated postgres 18 agrees
  // (`user_id | NO`), and all four producers' zod schemas require
  // `user_id: z.string().uuid()` (this file :514, webhooks.ts:80,
  // execution-approvals.ts, improvement-approvals.ts). So the NULL-user_id branch is
  // UNREACHABLE — the reachable defect is the one above, the partial role fan-out,
  // and that is what this fixes. The `Boolean(id)` filter below is kept anyway
  // because it costs nothing and the column's NOT NULL is not this file's to rely on.
  //
  // Resolve role holders through `listUsersByRole` (services/user-roles.ts) and
  // notify each, DEDUPED against the directly-named users — a person who is both
  // named on the roster and holds the role must get ONE notification, not two.
  //
  // ⚠️ A DIVERGENCE I MEASURED AND AM DELIBERATELY NOT FIXING HERE. VISIBILITY and
  // NOTIFICATION resolve a role from two different sources:
  //   - visibility (`approverIdentityFilter` → `rosteredApprovalLane`) matches
  //     `required_approvers.role` against the caller's JWT `roles` claim, i.e. the
  //     Keycloak realm/client roles on the signed token;
  //   - notification (here) resolves holders from the `user_roles` TABLE.
  // A role present in one and not the other makes the NOTIFIED set ≠ the VISIBLE
  // set, in both directions: a Keycloak-only holder sees the row and is never told,
  // and a table-only holder is told about a row the list will not show them.
  // Reconciling the two is a change to the identity model (which source is
  // authoritative for a roster role), not to this handler — do NOT "fix" it by
  // quietly switching one side to the other.
  //
  // ⛔⛔ AND THE DIVERGENCE IS TOTAL TODAY, NOT MARGINAL — MEASURED, AND IT MEANS
  // THIS LOOP RESOLVES NOBODY FOR ANY ROLE PRODUCTION ACTUALLY USES. The two
  // vocabularies are DISJOINT:
  //   - `user_roles.role` is CHECK-constrained by migration 104 to exactly
  //     `{'workspace-admin','workspace-member'}` (verified on a migrated postgres
  //     18: `CHECK (role = ANY (ARRAY['workspace-admin','workspace-member']))`).
  //     It is a WORKSPACE-MEMBERSHIP table.
  //   - `required_approvers.role` is free text and carries `execution_signoff`
  //     (execution-approvals.ts:156), `card_approver` (webhooks.ts:1517) and
  //     `tech_lead`. NONE of those three can even be STORED in `user_roles`.
  // So `listUsersByRole(tenant, 'execution_signoff')` returns `[]` BY CONSTRUCTION,
  // and this fan-out widening is a NO-OP for every roster role in production. It is
  // kept because it is the correct shape, it is exercised (the integration test
  // drives it with `workspace-admin`, the one role both sides admit), and it starts
  // working the instant the vocabularies converge.
  //
  // ⚠️ DO NOT read a green fan-out test as "role approvers are now notified". The
  // REMEDY is upstream of this file and is one of two things, both out of scope
  // here: (a) resolve holders from Keycloak, matching the visibility source — this
  // service has `getUserRealmRoles` (user→roles) but NO role→members call, so that
  // needs a new `GET /admin/realms/{realm}/roles/{role}/users` client method (which
  // needs `view-realm`; fr's service account has only `view-users`); or
  // (b) widen `user_roles_role_check` to admit the roster roles and populate it.
  // Until one lands, a role-gated approval still waits with only its NAMED approver
  // told.
  const namedApprovers = validated.required_approvers
    .map((a) => a.user_id)
    .filter((id): id is string => Boolean(id));
  // EVERY role on the roster, not only the rows that lack a `user_id`. Keying on
  // role-only rows would have been a fix for the unreachable defect above and a
  // no-op for the reachable one: it is precisely the `{user_id: X, role: R}` row
  // that makes R's other holders able to decide and unable to know.
  const rosterRoles = Array.from(
    new Set(
      validated.required_approvers
        .map((a) => a.role)
        .filter((r): r is string => Boolean(r)),
    ),
  );
  const roleHolders = (
    await Promise.all(
      rosterRoles.map((role) =>
        // `workspace-admin` resolves through the SAME recipients helper every
        // other workspace-admin notification uses: `user_roles` ∪ Keycloak realm
        // `tenant_admin` holders of this tenant (CLAUDE.md rule). Its directory
        // half is fail-soft inside the helper (reported, DB list kept); a DB
        // failure still throws into the catch below, exactly as before.
        // (The visibility/notification divergence described above still applies:
        // visibility matches the JWT `roles` claim, not either of these sources.)
        (role === 'workspace-admin'
          ? listWorkspaceAdminRecipients(ctxTenantId(user.tenantId)).then((r) => r.userIds)
          : listUsersByRole(ctxTenantId(user.tenantId), role)
        ).catch((err) => {
          // ⛔ DEGRADING IS RIGHT HERE; DEGRADING SILENTLY IS NOT. If role
          // resolution fails we still notify the directly-named approvers rather
          // than failing the whole approval — but a resolver outage and a role
          // that genuinely has no holders would otherwise produce IDENTICAL logs,
          // and the second is the normal case today (see the CHECK-constraint note
          // above). reportSwallowedFailure records the difference; it changes no
          // behaviour and no response.
          reportSwallowedFailure(err, {
            service: 'fr.user-roles',
            method: 'listUsersByRole',
            path: `role=${role}`,
            degradedTo: 'empty role-holder list; directly-named approvers still notified',
          });
          return [] as string[];
        }),
      ),
    )
  ).flat();
  // ONE Set over both sources — the dedupe is the point, not an optimisation.
  const addressed = new Set([...namedApprovers, ...roleHolders]);
  for (const recipient of addressed) {
    notifications.notificationService
      .fanOutToUser({ ...approval, metadata: null }, recipient, 'approval')
      .catch((err) => console.error('[approvals] per-user fan-out error:', err));
  }
  // P1-TEAM-b (George 2026-10-15): every member of the approval's tenant is told too —
  // told, NOT enrolled (the roster above stays the quorum). Fire-and-forget like the
  // per-user fan-out; it never throws.
  void fanOutApprovalToTenantMembers({
    approval: { ...approval, metadata: null },
    tenantId: approval.tenant_id,
    alreadyNotified: addressed,
    context: 'approvals',
  });

  return createdResponse({
    id: approval.id,
    project_id: approval.project_id,
    status: approval.status,
    requester_id: approval.requester_id,
    description: approval.description,
    created_at: approval.created_at,
    expires_at: approval.expires_at,
    required_approvers: validated.required_approvers,
  });
}

/**
 * Machine-readable cause on the requester-is-decider 403 in `handleUpdateApproval`.
 *
 * ⛔ THE SAME STRING `routes/teams-webhook.ts` HAS RETURNED SINCE BEFORE
 * `domain/engagement/decision-guards.ts` EXISTED, and it is spelled identically on
 * purpose. Four code paths insert an `approval_decisions` row; three of them refused a
 * requester-as-decider and this one — the HTTP seat the human approvals UI drives — did
 * not. A consumer distinguishing the seats by error code would have had to learn a fourth
 * spelling for one rule, which is how a shared predicate grows four slightly different
 * copies again. Pinned by tests; do not rename.
 */
export const APPROVER_IS_REQUESTER_CODE = 'APPROVER_IS_REQUESTER';

/**
 * WHICH allowance let a requester decide their own approval.
 *
 * Recorded on `approvals.metadata.self_decision.exempt_reason`. There are exactly TWO
 * arms and they answer DIFFERENT questions, so collapsing them to a bare
 * `self_decision: true` would make the stamp unauditable: a later reader could not tell
 * whether the exemption rested on the TENANT (one member, nobody else exists) or on the
 * ROSTER (several members exist, but this approval asked nobody but the requester).
 */
export type SelfDecisionExemptReason = 'solo_tenant_member' | 'roster_names_only_requester';

/**
 * ⭐ GEORGE'S RULING, 2026-09-26, VERBATIM:
 *
 *     "if a tenant has one member, that tenant member is the default god of that tenant.
 *      period."
 *
 * ── WHY THIS EXISTS BESIDE `rosterAsksOnlyTheRequester`, NOT INSTEAD OF IT ────────────
 *
 * ⛔ THE SHIPPED EXEMPTION WAS KEYED ON ROSTER SHAPE, AND ROSTER SHAPE IS NOT TENANT
 * SIZE. `rosterAsksOnlyTheRequester` asks "does every `required_approvers` row on THIS
 * approval name the requester?". That is a fact about one approval's obligation set, and
 * it is the WRONG instrument for George's rule: a genuinely solo tenant whose roster
 * happened to pick up ONE extra subject — an absent Keycloak user, a stale
 * `execution_signoff` id, a second row the minter added — fails it and the requester is
 * refused with `ForbiddenError`, leaving a row that NOBODY IN THE TENANT CAN EVER DECIDE.
 * Measured context: ~85% of pending approvals name an approver absent from Keycloak, so
 * the extra-subject roster is the COMMON shape, not a corner.
 *
 * ⭐ SO THIS IS AN ADDITIONAL ALLOWANCE, OR-ed WITH THE EXISTING ONE — NEVER A
 * REPLACEMENT. Everything that decides today must still decide tomorrow: the roster arm
 * covers multi-member tenants whose roster asks nobody else, and this arm covers
 * one-member tenants whose roster asks somebody who does not exist. Neither is a superset
 * of the other, and deleting either one re-opens a population that cannot be decided.
 *
 * ── THE MEMBER COUNT IS READ WHERE fr ALREADY READS IT ───────────────────────────────
 *
 * `services/user-roles.ts :: listGrantsForTenant` — the SAME query
 * `routes/tenant/members.ts :: handleListTenantMembers` (`GET /api/tenant/members`, the
 * directory the approver picker renders) and `routes/workspace/members.ts` fold into a
 * member list. Folded to DISTINCT `user_id` for the identical reason that route states:
 * `user_roles` is unique on (user_id, tenant_id, ROLE), so one person holding
 * `workspace-admin` AND `workspace-member` is TWO rows, and a raw row count would read a
 * solo tenant as a two-member one and refuse exactly the tenant this rule is for.
 *
 * ⛔ NOT KEYCLOAK. `listGrantsForTenant`'s own header states it: "Keycloak's user search
 * needs >=2 characters and cannot enumerate, and `user_roles` is the table the backend
 * actually gates on — so it, not the directory, is the authority on fr access." Counting
 * members through the directory would make this rule fail in precisely the condition that
 * motivates it — a tenant whose subjects are absent from Keycloak.
 *
 * ── WHY THE DECIDER MUST BE THAT ONE MEMBER, AND NOT MERELY `count === 1` ────────────
 *
 * ⚠️ `count === 1` ALONE IS NOT GEORGE'S RULE — it drops the subject of the sentence.
 * "that tenant member is the god" names a PERSON, and a super-admin acting in their home
 * view could reach this handler against a tenant they are not a member of (before fr
 * row 14d; a switched super-admin still can, inside a platform tenant). On a solo tenant
 * they do not belong to, `count === 1` is true and the decider is a stranger — so the
 * predicate requires the single member to BE the decider. That is the fail-closed
 * reading, and it costs the genuine solo member nothing.
 *
 * ⚠️ AN EMPTY MEMBERSHIP IS NOT A SOLO TENANT. `listGrantsForTenant` fails CLOSED — it
 * returns `[]` for a malformed / non-uuid tenant id — and a tenant with zero recorded
 * grants returns `[]` too. Both give `size === 0`, which is not `=== 1`, so an unreadable
 * or ungranted tenant refuses rather than being read as "nobody else exists, go ahead".
 * The `.has(deciderId)` term makes that doubly true: an empty set contains nobody.
 *
 * Exported for direct unit test — the arms are otherwise only reachable through a handler
 * that needs Postgres and a whole approval fixture before they can be observed.
 */
export async function soloTenantMemberIsTenantGod(
  tenantId: string | null | undefined,
  deciderId: string | null | undefined,
): Promise<boolean> {
  if (!tenantId || !deciderId) return false;
  // ⛔ AMENDED P1-TEAM-b (2026-10-15) — THE "⛔ NOT KEYCLOAK" PARAGRAPH ABOVE IS SUPERSEDED.
  // A member is now `user_roles` ∪ Keycloak users whose `tenant_id` attribute is T
  // (`services/tenant-member-recipients.ts`), because since P1-TEAM every such user can
  // act on — and decide — the tenant's approvals, so a Keycloak-only colleague IS the
  // second party this rule asks about. The union only ever ADDS members, so the ghost
  // subjects that paragraph worried about (absent from Keycloak) still do not count.
  // FAIL CLOSED: a membership that cannot be read COMPLETELY (directory outage) is not
  // provably solo — `null` ⇒ false. The DB count stays distinct `user_id` (unchanged).
  const members = await readCompleteTenantMembership(tenantId);
  if (!members) return false;
  return members.size === 1 && members.has(deciderId);
}

/**
 * The API route's refusal text for an answerless approve — `PUT /api/approvals/:id`'s
 * bespoke wording, which differs from the chat seats' shared
 * `answerRequiredMessage` only in naming the request FIELD the text must go in.
 *
 * ⛔ A `switch` WITH A `never` DEFAULT, AND THAT IS THE FIX. This was an inline two-way
 * ternary (`=== 'question_action' ? … : <stated-question text>`) when `fix_assertion` was
 * added to `AnswerDemand`, so an empty approve of an INFRASTRUCTURE hold was refused with
 * "This approval states an open question (metadata.open_questions)" — false, and `tsc`
 * exit 0. A fourth demand kind is now a compile error here.
 *
 * Exported and pure so the wording is unit-testable without a database: the handler it
 * came from is 300 lines behind auth and a db read.
 *
 * ⛔ DO NOT ADVISE A FIELD THAT CANNOT WORK ON THIS ROW. This refusal used to say, on every
 * row, "Approve again WITH the answer in `comment` (or `reason`)". On a row that is ALSO a
 * broken gate that advice is false AND it loops, which is the exact defect #1108 exists to
 * remove, reproduced on the API path:
 *
 *   reason >= 30 chars  → consumed as the broken-gate override, never becomes the answer
 *                         → this same 422, for ever
 *   reason <  30 chars  → the OTHER 422, demanding a >= 30-char override reason
 *
 * so NO value of `reason` alone can satisfy both rules, and the message never named the
 * one field that works. Caught by the #1108 audit.
 */
export function apiAnswerRequiredMessage(
  answerDemand: Exclude<AnswerDemand, null>,
  brokenTerms: readonly string[],
): string {
  const demanded = demandedDecisionText(answerDemand);
  const answerFieldName = brokenTerms.length > 0 ? '`comment`' : '`comment` (or `reason`)';
  const answerFieldAdvice =
    brokenTerms.length > 0
      ? `Approve again WITH ${demanded} in \`comment\`. ⛔ On THIS row \`reason\` cannot carry ` +
        'it: the row also carries a broken gate ' +
        `(${brokenTerms.join(', ')}), so \`reason\` is consumed as the super-admin override ` +
        `argument for that gate and never becomes ${demanded}. No value of \`reason\` alone ` +
        `satisfies both rules — ${demanded} must be in \`comment\`, alongside the override ` +
        '`reason`. '
      : `Approve again WITH ${demanded} in \`comment\` (or \`reason\`), which is the field ` +
        'forwarded to the callback. ';
  switch (answerDemand) {
    case 'question_action':
      return (
        'This approval is a QUESTION, and approving it is how the answer is delivered: the ' +
        'n8n callback releases the card only when the decision carries non-empty answer ' +
        'text. Approving with an empty comment does not release it — it holds the card in ' +
        'BLOCKED with block_reason approval_answer_missing, permanently, because this row ' +
        'is then spent and no second decision is accepted from you. ' +
        answerFieldAdvice +
        'If you cannot answer it, REJECT it with a reason — rejecting a question is a ' +
        'legitimate terminal and is never blocked by this rule. There is deliberately no ' +
        'override: the answer is the whole content of the decision.'
      );
    case 'fix_assertion':
      // The lead and the exit are the SAME constants every chat seat sends, so the four
      // seats cannot disagree about what approving a hold does. Only the field advice is
      // this route's own.
      return FIX_ASSERTION_REFUSAL_LEAD + answerFieldAdvice + FIX_ASSERTION_REFUSAL_EXIT;
    case 'stated_question':
      // A row that STATES a question in `metadata.open_questions` while proposing no
      // QUESTION action. The wording differs because the consequence does: the answer is
      // persisted on the decision and forwarded to the callback as `comment`, so the asker
      // receives it — but with no QUESTION action there is no card re-drive to promise,
      // and claiming one would be a lie the wire cannot carry.
      return (
        'This approval states an open question (metadata.open_questions), and approving it ' +
        'is how the answer is delivered: ' + answerFieldName + ' is recorded on the ' +
        'decision and forwarded to the n8n callback, and it is the only thing the asker ' +
        'receives. Approving with an empty comment answers nothing while spending the ' +
        'approval — no second decision is accepted from you, so the question can never be ' +
        'answered through this row afterwards. Approve again WITH the answer, or REJECT it ' +
        'with a reason, which is never blocked by this rule.'
      );
    default: {
      const _exhaustive: never = answerDemand;
      return _exhaustive;
    }
  }
}

// ── WHO MAY DECIDE THIS ROW — ONE PREDICATE, TWO READERS ───────────────────────────
//
// Extracted VERBATIM from `handleUpdateApproval` (the roster / super-admin / solo-tenant
// candidate set, the discharged-row choice, the requester-may-not-decide rule with its two
// exemptions, and the one-decision-per-approver check), so `GET /api/approvals/:id` can ask
// "could THIS caller decide THIS row?" without re-spelling it. Same queries, same order, same
// memo. It REFUSES by returning a `refusal` kind; the PUT turns each kind into the exact
// error (and warn line) it always threw, so no PUT outcome moved. It writes nothing.
//
// ⚠️ It does NOT cover what the PUT checks BEFORE it (tenant pin, pending, deadline) or AFTER it (body-dependent gates, the #901 rate limit, the
// U3 gates). `callerMayDecideApproval` adds the first group
// for the read lane.
type DecideRefusal =
  | 'no_roster_match'
  | 'no_open_obligation'
  | 'requester_is_decider'
  | 'already_decided';

type DecideEligibility =
  | {
      eligible: true;
      superAdminDecider: boolean;
      soloTenantGodWidened: boolean;
      /** P1-TEAM-b: discharged through the 1-of-any tenant-member arm. */
      tenantMemberWidened: boolean;
      requiredApprover: RequiredApproverRow;
      allRequiredApprovers: RequiredApproverRow[];
      selfDecisionExemptReason: SelfDecisionExemptReason | null;
    }
  | { eligible: false; refusal: DecideRefusal; superAdminDecider: boolean; rosterSize: number };

export async function resolveDecideEligibility(
  user: Awaited<ReturnType<typeof validateAuth>>,
  approval: ApprovalRow,
): Promise<DecideEligibility> {
  const approvalId = approval.id;
  // Verify user is a required approver — matched by user_id OR by a role they
  // hold, the SAME identity match handleListMyApprovals + the frontend
  // isRequiredApprover use. Without the role arm, a role-based approver who is
  // SHOWN the Approve/Reject controls (queue + /approvals/[id]) got a 422 here on
  // submit.
  //
  // ⛔ CORRECTED 2026-08-31 — THIS NOTE USED TO SAY THE ROLE ARM IS INERT. It is
  // not inert; it is the PRIMARY path, and believing otherwise cost two sessions
  // real time and nearly produced a reported authorization bypass.
  //
  // The old text read: "today every roster row carries a concrete user_id (role
  // is a descriptive label, not a Keycloak role the user holds), so the role arm
  // is inert in practice". Measured against prod (worker4, db `fr`):
  //
  //   required_approvers.role   execution_signoff 380 · card_approver 261
  //                             reviewer 2 · action_approver 1
  //   approval_decisions        32969c16… 343 · 22560966… 11 · all-zeros 4
  //   required_approvers rows   e148e8af… 595 · 22560966… 45 · 32969c16… 2
  //
  // So the identity rostered on 595 approvals has decided ZERO, and an identity
  // rostered on 2 has decided 343. That reads as a bypass until you notice the
  // `role` column holds `execution_signoff` / `card_approver` — which ARE
  // Keycloak realm roles, not descriptive labels. 341 of those 343 decisions are
  // authorized by the role arm, correctly. Nothing is bypassed; the comment was
  // simply false, and a false comment in an authz path generates exactly this
  // kind of false alarm.
  //
  // ⚠️ CONSEQUENCE, and it is the reason this correction is not cosmetic: the old
  // note itself said "if genuinely role-only rosters are introduced, the
  // completion tally below (row-count based) must also treat a role requirement
  // as satisfied by any role-holder's decision." That condition is ALREADY MET.
  // The tally below compares `allDecisions.length === allRequiredApprovers.length`
  // and never checks WHO decided, so on a multi-approver roster one role-holder
  // can in principle satisfy every row alone.
  //
  // MEASURED BLAST RADIUS, so nobody over-reacts to the paragraph above: of 354
  // approvals with decisions, 353 are (1 required, 1 distinct actor). Exactly ONE
  // has a 2-row roster and a single actor — e65772e0-…-55512fe3d6e5 — and it
  // carries 1 decision against 2 required, so the tally never fired and it
  // reached `expired`, not `approved`. ZERO approvals have been mis-completed by
  // this gap to date. It is a real hole with no realized instance.
  //
  // PRECEDENT — the estate already decided this question, one level up. fr #886
  // fixed `planSignoffApprovers` SUBSTITUTING an unreachable roster with a single
  // off-roster user, collapsing a 2-of-2 gate to 1-of-1. Its own comment is the
  // specification for this one: "Keep it WHOLE — its cardinality is the quorum."
  // The tally below violates that same invariant at the COUNTING step instead of
  // the CONSTRUCTION step: cardinality preserved, identity ignored.
  //
  // ⚠️ UNIT TESTS WILL NOT CATCH THIS. #886 passed 29/29 on BOTH the broken and
  // the fixed version; only integration tests against a real Postgres separated
  // them (23/0 parent -> 22/1 branch). Whoever fixes this must reach for an
  // integration test, or they will ship a green suite over a collapsed quorum.
  //
  // ⛔ AND THE OBVIOUS FIX IS NOT IMPLEMENTABLE AS STATED. An earlier draft of
  // this very comment said "fix it by tallying DISTINCT satisfied roster ROWS" —
  // which cannot be done from what is persisted. `approval_decisions` stores
  // (approval_id, approver_id, decision, comment, decided_at) and NOTHING ELSE:
  // there is no link to the roster row a decision satisfied, and the decider's
  // roles came from a JWT that is never written down. So at tally time you know
  // only WHO decided, and you cannot recover WHICH requirement they met — a
  // role-arm decision is indistinguishable from an unrostered one after the fact.
  //
  // DONE (migration 108, #923): the satisfied requirement is now recorded AT
  // DECISION TIME as `approval_decisions.required_approver_id`, written in the same
  // insert as the decision, and quorum below checks that every roster obligation
  // was discharged instead of comparing two counts. The 358 historical rows keep
  // NULL — see the migration for why that is the truthful value.
  //
  // ⛔ AND WHEN YOU DO IT: DO NOT BACK-FILL THOSE 358 ROWS BY INFERRING THE
  // ROSTER ROW FROM ROLES HELD TODAY. It is the obvious move and it is wrong —
  // it reconstructs a fact that was never recorded, from a role assignment that
  // may have changed since, and writes the guess into a column every later reader
  // will trust as history. NULL / "unknown, predates the column" is a TRUTHFUL
  // value; a plausible reconstruction is not. This estate has already put Planka
  // snowflake ids into an fr-project column by exactly that reflex.
  //
  // Do NOT "fix" this by removing the role arm: that 422s every role-based
  // approver the UI already shows Approve/Reject controls to.
  // ── A SUPER-ADMIN MAY DISCHARGE ANY ROSTER OBLIGATION ────────────────────────────
  // MEASURED 2026-09-15, and this is why the round exists: the product owner
  // (`george@nonagentic.ai`) holds `super_admin` + `tenant_admin` and NEITHER
  // `card_approver` NOR `execution_signoff`, and appears on ZERO `required_approvers`
  // rows out of 1032 pending — ever. `isSuperAdminHomeView` let him SEE all 1032, and
  // this predicate then 422'd every one of them. Four rounds of repair to the decide
  // rail could not change that by one pixel, because he never reached the rail.
  //
  // ⛔ THE OBVIOUS IMPLEMENTATION IS WRONG AND WOULD RE-OPEN #886/#923. "Skip the check
  // for a super-admin" leaves `requiredApprover` undefined, so `required_approver_id`
  // writes NULL, so the quorum branch below sees `anyPre108 === true` and silently falls
  // back to the COUNT comparison that migration 108 exists to kill. The approval would
  // still complete — by the compatibility branch for historical rows, not by anything
  // anyone decided — and every later reader of that NULL would read "unknown, predates
  // the column" about a row written today.
  //
  // So the super-admin arm widens WHICH roster row may be discharged, not whether one is.
  // `selectDischargedRosterRow` still picks a real obligation, `required_approver_id`
  // still records it, and quorum is untouched. This is the same shape as the role arm
  // that already exists: #1059 measured 519 of 519 decisions reaching their row through
  // it, discharging an obligation that named a DIFFERENT user. A super-admin doing so
  // deliberately is not a new kind of act.
  //
  // ⚠️ Scoped to THIS handler on purpose. `approverIdentityFilter`'s own contract warns
  // that attribution and quorum/listing must not silently inherit changes to "may this
  // caller act?" — so the other three call sites keep the unwidened predicate, and
  // `handleListMyApprovals` does not become "everything" for a super-admin.
  //
  // ⚠️ MEASURED the same day: all 1032 pending rows have a roster of EXACTLY 1 (0 rows
  // with 0, 0 rows with >1). So today this always discharges the single obligation and
  // completes. Whoever enables multi-approver rosters should decide explicitly whether
  // one super-admin discharges one obligation (what this does) or all of them (what it
  // does NOT do) — do that before the first two-approver row exists, not after.
  // ⛔ fr row 14d: the super-admin discharge arm acts ONLY inside the active
  // tenant (the approval was loaded tenant-pinned above) and ONLY when that
  // tenant is a PLATFORM tenant. In a customer workspace — including a
  // super-admin whose JWT home is not a platform tenant — a super-admin is an
  // ordinary decider and must be on the roster.
  const superAdminDecider =
    isSuperAdmin(user) && isPlatformTenant(ctxTenantId(user.tenantId));
  // ── G8 / R313 + R208: a TENANT PROMOTION is the tenant_admins' decision alone ──
  // `asset.promotion` replaces a workspace-level asset for every project, so neither the
  // roster's role arm on its own nor the P1-TEAM-b member arm may open it: the decider must
  // be a workspace-admin (user_roles ∪ pinned realm `tenant_admin`, `isWorkspaceAdminVia`)
  // of the APPROVAL's tenant. A member is told (fan-out) but answered `no_roster_match`.
  if (isTenantAdminOnlyKind(approval.kind) && !superAdminDecider) {
    const { userRolesService } = await import('../services/user-roles');
    if (!(await userRolesService.isWorkspaceAdminVia(user, approval.tenant_id, userRolesService.hasRole))) {
      return { eligible: false, refusal: 'no_roster_match', superAdminDecider, rosterSize: 0 };
    }
  }
  const approverIdentity = approverIdentityFilter(user);
  let candidateRosterRows = await db.select()
    .from(requiredApprovers)
    .where(
      superAdminDecider
        ? eq(requiredApprovers.approval_id, approvalId)
        : and(
            eq(requiredApprovers.approval_id, approvalId),
            approverIdentity,
          )
    );

  // ── THE SOLO TENANT'S GOD REACHES THE ROSTER AT ALL (fr#1220) ────────────────────
  //
  // ⛔ THE SELF-DECISION EXEMPTION BELOW WAS UNREACHABLE IN THE SHAPE PRODUCTION
  // ACTUALLY MINTS. `soloTenantMemberIsTenantGod` sits ~180 lines down, behind the
  // `candidateRosterRows.length === 0` refusal immediately below this block. That refusal
  // is keyed on `approverIdentityFilter` — "does a roster row name you, or ask for a realm
  // role you hold?" — so a solo tenant whose roster names ONLY an absent subject matched
  // NO row, was 422'd here, and never reached the arm written for it. The shipped
  // exemption therefore only fired when the solo member happened to ALSO be named on the
  // roster beside the ghost; the ghost-ONLY roster — George's ruling's own subject — was
  // still refused.
  //
  // MEASURED on the prod primary 2026-09-26: the live `generic` / `kanban/approval-callback`
  // producer minted 106 rows in 7 days, **105** with `approver_source='fallback'` resolving
  // to a subject OUTSIDE the row's own tenant; 2 of 5 then-pending rows named a uuid absent
  // from `user_roles` entirely. So the ghost-only roster is the COMMON mint, not a corner,
  // and a one-member tenant could raise an approval, be the only human in existence who
  // could answer it, and be refused.
  //
  // ⭐ THE FIX IS THE SHAPE THE SUPER-ADMIN ARM ALREADY TAKES, STATED IN ITS OWN WORDS
  // TWENTY LINES UP: it "widens WHICH roster row may be discharged, not whether one is".
  // `selectDischargedRosterRow` still picks a real obligation, `required_approver_id` is
  // still written NOT NULL, and the #923 quorum predicate is untouched. Nothing here makes
  // an approval complete that an obligation-count would not.
  //
  // ⛔ WHY IT IS GATED ON `length === 0` AND NOT COMPUTED UP FRONT. Two reasons, and the
  // second is the load-bearing one:
  //   1. COST. `listGrantsForTenant` is a round trip. Hoisting it would put it on every one
  //      of ~2,900 ordinary decisions; here it runs ONLY on the path that was about to
  //      throw, which today carries no successful traffic at all.
  //   2. IT CANNOT CHANGE AN OUTCOME THAT ALREADY EXISTS. A caller who matched a row keeps
  //      the exact candidate set they had, so `selectDischargedRosterRow`'s preference
  //      order, the discharge metric and quorum are bit-identical for every decision that
  //      succeeds today. This block can only turn a REFUSAL into a decision, never move one
  //      decision onto a different obligation.
  //
  // ⛔ SCOPE — EXACTLY ONE MEMBER, AND THAT MEMBER IS THE CALLER. `soloTenantMemberIsTenantGod`
  // folds `user_roles` to DISTINCT `user_id` and demands `size === 1 && has(deciderId)`, so:
  // a MULTI-member tenant whose roster names only ghosts is NOT widened and is still refused
  // below — that population is deliberately out of scope and filed as fr#1225 for George,
  // because "eligible" meaning "exists and can act" rather than "is named" is a larger policy
  // change than the ruling covers. An EMPTY / unreadable tenant gives `size === 0` and is not
  // widened either (fails closed). And a stranger on a solo tenant they do not belong to fails
  // `.has(deciderId)`.
  // ⭐ SUPERSEDED P1-TEAM-b (George 2026-10-15): fr#1225 is now RULED — "all actions are able
  // to be done by all members of the tenant". The tenant-member arm below widens for ANY
  // member of the approval's tenant (fail-closed membership read), which subsumes this
  // solo widening; the solo fact is kept only for its `solo_tenant_discharge` stamp and the
  // self-decision exemption.
  //
  // ⚠️ NOT gated on `requesterIsDecider`. George's sentence is about tenant MEMBERSHIP
  // ("that tenant member is the default god of that tenant"), not about who filed the row,
  // and the measured producer sets `requester_id` from the same fallback resolution that
  // produces the ghost roster — so keying this on the requester would leave the fix vacuous
  // for the very rows it was written for. The self-decision guard further down is
  // unchanged and still runs: when the caller IS also the requester it stamps
  // `self_decision` as before, now via the memo below so the member count is read ONCE.
  let soloTenantGodMemo: boolean | undefined;
  const callerIsSoloTenantGod = async (): Promise<boolean> => {
    if (soloTenantGodMemo === undefined) {
      soloTenantGodMemo = await soloTenantMemberIsTenantGod(approval.tenant_id, user.id);
    }
    return soloTenantGodMemo;
  };

  /**
   * True when the candidate set below was widened by the solo-tenant allowance, i.e. the
   * row this decision discharges is one this caller is NOT named on and holds no role for.
   * Carried to the metadata stamp — see `soloTenantDischarge` at the stamp site.
   */
  let soloTenantGodWidened = false;

  // ── P1-TEAM-b: 1-OF-ANY TENANT MEMBER (George 2026-10-15) ─────────────────────────
  //
  // ⭐ "all actions are able to be done by all members of the tenant, all
  // notifications/approvals/questions are sent to all members". Every member is now TOLD
  // about every approval of their tenant (`fanOutApprovalToTenantMembers`), so every member
  // must be able to ANSWER it. A member of the approval's tenant who matched no roster row
  // may discharge ONE open obligation — the SAME shape as the super-admin and solo-tenant
  // arms: it "widens WHICH roster row may be discharged, not whether one is".
  // `selectDischargedRosterRow` (override) still picks a real obligation,
  // `required_approver_id` is written NOT NULL, and the #923 quorum is untouched.
  //
  // ⛔ NOT N ROSTER ROWS. Members are never ENROLLED in `required_approvers`: that would
  // turn a 1-of-1 gate into an N-of-N one. One member's decision discharges the one
  // obligation a 1-row roster has; an N-row roster still needs N obligations met.
  //
  // ⛔ STRICT TENANT SEPARATION — two terms, both required:
  //   1. the approval's tenant IS the caller's request tenant (`ctxTenantId`). The
  //      approval was loaded tenant-pinned, but the super-admin HOME-VIEW read relaxation
  //      lets a super-admin READ other tenants' rows; it must never leak into this write.
  //   2. the caller is a MEMBER of that tenant — `isTenantMemberForDecision`: a
  //      `user_roles` row in T, else a FRESH Keycloak read of users whose `tenant_id`
  //      attribute is T. FAIL CLOSED: a directory outage admits nobody the DB does not.
  // A member of ANOTHER tenant fails (1) on the web seat and (2) everywhere.
  //
  // ⚠️ GATED ON `length === 0`, like the solo arm before it and for the same reason: a
  // caller who matched a row keeps the exact candidate set they had, so every decision that
  // succeeds today lands on the same obligation. This can only turn a refusal into a
  // decision. It SUBSUMES the solo-tenant widening (the solo member is a member); the solo
  // fact is still read below, but only to keep the `solo_tenant_discharge` stamp.
  let tenantMemberWidened = false;
  if (!superAdminDecider && candidateRosterRows.length === 0) {
    const fullRoster = await db.select()
      .from(requiredApprovers)
      .where(eq(requiredApprovers.approval_id, approvalId));
    if (
      tenantMemberArmPrecondition({
        approvalTenantId: approval.tenant_id,
        callerTenantId: ctxTenantId(user.tenantId),
        callerMatchedARosterRow: false,
        rosterSize: fullRoster.length,
        superAdminDecider,
      }) &&
      (await isTenantMemberForDecision(approval.tenant_id, user.id))
    ) {
      candidateRosterRows = fullRoster;
      tenantMemberWidened = true;
      soloTenantGodWidened = await callerIsSoloTenantGod();
    } else if (await callerIsSoloTenantGod()) {
      // ⚠️ THE fr#1220 SOLO ARM, KEPT AS IT WAS for the rows the member arm does not open
      // (a caller acting outside the row's tenant; since P1-TEAM-c an ACTION approval is
      // opened by the member arm and runs as the decider — `resolvePendingAction`). The member arm
      // subsumes it everywhere else; dropping it here would refuse a decision that
      // succeeds on origin/main.
      candidateRosterRows = fullRoster;
      soloTenantGodWidened = true;
    }
  }

  // ⚠️ NO `candidateRosterRows.length > 0` TERM ON THE FLAG ABOVE, AND ITS ABSENCE IS
  // DELIBERATE. An earlier draft wrote `soloTenantGodWidened = candidateRosterRows.length
  // > 0` "so an empty roster cannot be widened into". MEASURED by mutation: forcing that
  // term to `true` changed NOTHING — all 17 cases stayed green — because a genuinely empty
  // roster leaves `candidateRosterRows` empty after the widening SELECT too, and the
  // refusal immediately below is UNCONDITIONAL and throws before the flag is ever read.
  // The term could not fail, and a guard that cannot fail reads in review as protection
  // that is not there. The real protection is the refusal's unconditionality — the same
  // argument the roster arm's own `length > 0` note makes 180 lines down. ⛔ So do NOT
  // "harden" this by making that refusal skip a widened caller: the solo tenant's god may
  // discharge an obligation nobody else can, NOT approve into an empty obligation set, and
  // the super-admin arm refuses the identical condition for the identical reason.

  if (candidateRosterRows.length === 0) {
    // Refusal wording lives in `handleUpdateApproval` (`no_roster_match`), unchanged.
    return { eligible: false, refusal: 'no_roster_match', superAdminDecider, rosterSize: 0 };
  }

  // WHICH of the matched rows does this decision discharge?
  //
  // This used to be `const [requiredApprover] = ...` — whatever the database
  // returned first. That is fine while nothing reads it, but #923 makes the choice
  // load-bearing: it is now recorded, and quorum is computed from it. Picking the
  // first match would let TWO role-holders both discharge the SAME roster row,
  // leaving a second obligation silently unmet while the approval looked complete.
  //
  // Order of preference — now `selectDischargedRosterRow`
  // (domain/engagement/decision-guards.ts), shared with the three chat seats:
  //   1. a row that names this caller  — the strongest claim, and it must not be
  //      shadowed by a role row that merely happens to sort first;
  //   2. any row not already discharged — so N role-holders cover N role rows;
  //   3. an already-discharged row      — cannot happen today (a caller may decide
  //      once per approval) but is a defined answer rather than `undefined`.
  //
  // ⚠️ AMENDED (fr#1237) — TWO CHANGES, AND BOTH ARE ABOUT THIS SELECT HAVING NO
  // `ORDER BY`. Every rung above used to be a `.find()` over these rows in whatever
  // order Postgres happened to return them, so on a roster with two rows this caller
  // could discharge, WHICH obligation landed in `required_approver_id` was the heap's
  // choice, not anyone's. `selectDischargedRosterRow` now resolves each rung over a
  // total order, and it gained a rung: an undischarged row asking for a role this
  // caller ACTUALLY HOLDS is preferred over an arbitrary undischarged one.
  //
  // ⛔ `user.roles` IS PASSED HERE AND NOWHERE ELSE, and that asymmetry is the same one
  // `approverIdentityFilter` already draws. THIS seat's candidate set was built from
  // "user_id OR a role you hold", so a role row in it is one this caller verifiably
  // holds. The three chat seats match on `user_id` alone and carry no verifiable role
  // claim, so they omit the argument — see the parameter's own note. ⚠️ Do NOT "tidy"
  // this by hoisting a shared `roles` argument into all four call sites.
  const priorDecisions = await db.select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approvalId));
  // fr#1059: only the two explicit override arms above (super-admin, the solo tenant's god —
  // both of which widened `candidateRosterRows` on purpose) may discharge a row the caller is
  // neither named on nor holds the role for. Everyone else needs a real claim, or is refused.
  const requiredApprover = selectDischargedRosterRow(
    candidateRosterRows,
    priorDecisions,
    user.id,
    user.roles ?? [],
    { override: superAdminDecider || tenantMemberWidened || soloTenantGodWidened },
  );
  if (!requiredApprover) {
    // Refusal wording lives in `handleUpdateApproval` (`no_open_obligation`), unchanged.
    return { eligible: false, refusal: 'no_open_obligation', superAdminDecider, rosterSize: 0 };
  }

  // ── THE REQUESTER MAY NOT CLOSE THEIR OWN GATE — ON THIS SEAT TOO ────────────────
  //
  // ⛔ THIS WAS THE ONE UNGUARDED INSERT. `isRequesterDecidingOwnApproval`
  // (domain/engagement/decision-guards.ts) has fired in `routes/teams-webhook.ts`
  // and `routes/telegram-webhook.ts` since #1107; the path the
  // HUMAN approvals UI actually drives — this one — never called it. So the rule existed
  // on the chat seats that carry ~0 traffic and was absent on the seat that carries the
  // web decisions. Measured against production: 2,915 decisions by source `n8n`, 4 by
  // `web`, 0 by `teams`, and 16 all-time decisions with `approver_id = requester_id`
  // (4 of them off-roster). So this refuses a rare event that was already a defect —
  // it is not a behaviour change anyone was relying on.
  //
  // ⛔ THE GUARD'S REAL SUBJECT IS "A SECOND ELIGIBLE APPROVER EXISTED AND YOU BYPASSED
  // THEM", NOT "YOU ARE THE REQUESTER". Those two are the same question on a multi-party
  // roster and OPPOSITE questions on a one-seat tenant, and reading it as the latter is
  // what makes fr unusable for a solo tenant: a tenant with ONE member means that member
  // is both tenant-admin and tenant-user, so there is genuinely no second party to
  // bypass, and refusing would leave every approval that tenant ever raises permanently
  // undecidable. So the roster decides, and the two symptoms are one rule.
  //
  // ⚠️ "NO SECOND ELIGIBLE APPROVER" IS READ OFF `required_approvers`, WHICH IS THE
  // OBLIGATION SET THIS HANDLER ALREADY RESOLVES — not a tenant member count and not a
  // claim from the request body. `candidateRosterRows` above is NARROWED to rows this
  // caller may discharge (`approverIdentityFilter`, or everything for a super-admin), so
  // it cannot answer this question: a roster naming a second person would be narrowed
  // down to the caller's own row and read as "nobody else". `allRequiredApprovers` is the
  // WHOLE roster for the approval, hoisted here from the quorum tally below so there is
  // ONE read and one answer. `required_approvers.user_id` is NOT NULL (schema.ts), so
  // every row names a concrete person and "the roster asks nobody but the requester" is
  // decidable from this table alone.
  //
  // ⚠️ AMENDED 2026-09-26 — THE PARAGRAPH ABOVE IS STILL CORRECT FOR WHAT IT CLAIMS, AND
  // IT IS NO LONGER THE WHOLE RULE. Read it as written: it says the ROSTER-shaped question
  // is answerable from `required_approvers` alone, and it is — `allRequiredApprovers` is
  // still the right instrument for "does this approval ask anybody but the requester?",
  // and the "not a tenant member count" clause still rules the member count OUT of THAT
  // predicate. Nothing below changes `rosterAsksOnlyTheRequester` by one character.
  //
  // ⛔ WHAT WAS WRONG WAS NOT THE READING — IT WAS THAT THE ROSTER ALONE CANNOT DELIVER
  // THE OUTCOME THE BLOCK ABOVE SAYS IT EXISTS TO DELIVER. Two paragraphs up: "refusing
  // would leave every approval that tenant ever raises permanently undecidable". That is
  // exactly what shipped, because `required_approvers.user_id` being NOT NULL guarantees
  // a row names a UUID — NOT that the UUID names anybody who exists. MEASURED: ~85% of
  // pending approvals name an approver ABSENT FROM KEYCLOAK. So a genuinely one-member
  // tenant whose roster picked up one extra or stale subject fails
  // `rosterAsksOnlyTheRequester`, is refused here, and the row becomes undecidable by
  // ANYONE — the extra subject cannot act because it does not exist, and the one real
  // member is refused as the requester. The author intended George's outcome and chose an
  // instrument that measures roster SHAPE where the rule is about tenant SIZE.
  //
  // ⭐ GEORGE'S RULING, 2026-09-26, VERBATIM:
  //
  //     "if a tenant has one member, that tenant member is the default god of that
  //      tenant. period."
  //
  // ⇒ A SECOND, INDEPENDENT ALLOWANCE IS OR-ed IN BELOW — never a replacement. See
  // `soloTenantMemberIsTenantGod` (module scope, above `handleUpdateApproval`) for the
  // predicate, the member-count source (`services/user-roles.ts :: listGrantsForTenant`,
  // the SAME query `GET /api/tenant/members` folds into a member list) and why it is NOT
  // read from Keycloak.
  //
  // ⭐ WHY A MEMBER COUNT IS THE INSTRUMENT ON *THIS* ARM SPECIFICALLY — and the argument
  // is the block above's own, not a new one. It states the guard's subject: "A SECOND
  // ELIGIBLE APPROVER EXISTED AND YOU BYPASSED THEM". What this arm establishes is that
  // the tenant has exactly ONE MEMBER — one DISTINCT `user_roles.user_id`, which is the
  // fact George's ruling names and the only fact this count can carry. It does NOT
  // establish that no second party can exist (see the correction immediately below). The
  // arm is deliberately narrow — the tenant has exactly one member AND the requester is
  // the decider AND that one member IS the decider — so it cannot fire for a stranger on
  // a tenant they do not belong to.
  //
  // ⛔ CORRECTED 2026-09-26 — THE PARAGRAPH ABOVE USED TO CLAIM MORE THAN A MEMBER COUNT
  // CAN CARRY, AND AN ADVERSARIAL AUDIT REFUTED IT BY MEASUREMENT. The old text is kept
  // here rather than deleted, per the 2026-08-31 correction thirty lines up — a false
  // sentence in an authz path is what generates false alarms, and a deleted one cannot be
  // recognised when it is proposed again. It read, verbatim:
  //
  //     "With exactly ONE member in the tenant there is provably no second party to
  //      bypass, so the guard's stated subject is not engaged at all; the count is not
  //      being used to weaken the roster test, it is being used to show the roster test
  //      has nothing to protect."
  //
  // FALSE for the widening arm. Two successful attacks, each run beside a PASSING control
  // — the control is what makes each one a measurement rather than an assertion:
  //
  //   A1 — THE ROSTERED SUBJECT NEED NOT BE A GHOST. A REAL reviewer R, whose JWT carries
  //        tenant T but who holds NO `user_roles` row in T, decided the approval HIMSELF
  //        in the control — so R is reachable, eligible and a genuine second party. The
  //        solo member then discharged R's obligation on an identical row. The widening
  //        never asks whether the named subject is reachable; it asks only how many
  //        members the tenant has.
  //   A2 — THE ROLE THE ROW ASKS FOR IS NOT CHECKED AGAINST THE DECIDER. A solo member
  //        holding `roles:['user']` discharged a roster row whose `role` is
  //        `execution_signoff`; the control shows a real `execution_signoff` holder could
  //        have done so. A member count says nothing about who holds that realm role.
  //
  // ROOT CAUSE, and it is the same shape as the 2026-08-31 correction above: MEMBERSHIP is
  // read from `user_roles`, while ELIGIBILITY comes from the JWT tenant claim plus the
  // Keycloak realm roles `approverIdentityFilter`'s role arm matches on. Those are
  // DIFFERENT SETS. So "member count is 1" does not entail "no second party exists" — it
  // entails only "no second party is recorded in the table fr gates on".
  //
  // ⚠️ THE BEHAVIOUR IS CORRECT AND MUST NOT CHANGE. A1 and A2 are George's ruling
  // working as intended — "if a tenant has one member, that tenant member is the default
  // god of that tenant. period." — not defects, and this correction is PROSE ONLY. Do not
  // add an eligibility term to `soloTenantMemberIsTenantGod` on the strength of it: that
  // would count members through Keycloak, which is the one thing the predicate's own
  // header rules out, and would re-refuse the tenants the ruling is for.
  //
  // ⭐ WHICH IS EXACTLY WHY THE DECISION IS STAMPED. The predicate is deliberately
  // permissive here, so it is not the predicate that makes the act accountable — it is
  // the audit trail. Every widened decision carries `solo_tenant_discharge` with
  // `discharged_row_names` (the person the obligation ACTUALLY named) and a `quorum_note`
  // stating what it did to the tally, and, when the decider is also the requester,
  // `self_decision.exempt_reason = 'solo_tenant_member'`. A later auditor can enumerate
  // every row where this fired and see whose obligation a solo member discharged. That is
  // the accountability claim this arm makes; "no second party existed" never was.
  //
  // ⚠️ MEASURED PRODUCTION CONTEXT 2026-09-26, because it changes how a reader weighs
  // the two attacks. 13 of 13 GRANTED TENANTS ARE SOLO — this arm is the ordinary case,
  // not a corner. Of the 2 pending rows the widening unblocks, BOTH carry a
  // `card_approver` / `execution_signoff` row naming someone else, so A2 is the ONLY shape
  // it unblocks today; A1 is demonstrated, not observed in the live queue. And the scope
  // guard that proves a MULTI-member tenant is never widened (`members.size === 1`; the
  // out-of-scope population is filed as fr#1225) has ZERO production subjects: it is
  // TESTED, NOT EXERCISED. Do not read its green as evidence that the multi-member
  // population behaves.
  //
  // ⚠️ WHAT THIS DELIBERATELY DOES NOT CLAIM, because a guard that overstates its reach
  // is worse than one that states it: `approverIdentityFilter` also admits a caller by a
  // REALM ROLE the roster row asks for, and who holds `card_approver` /
  // `execution_signoff` lives in Keycloak, not in this table. So a role-holder elsewhere
  // in the tenant may be ELIGIBLE to discharge a row that names only the requester. They
  // were never ASKED — nothing notified them, they appear on no roster row — so treating
  // their hypothetical existence as "a second party you bypassed" would refuse on a fact
  // fr never recorded and cannot read here. The predicate is therefore "the roster asks
  // nobody but the requester", stated as such, and the allowance is STAMPED rather than
  // silent precisely so a later reader can find every row where it applied.
  //
  // ⚠️ AN EMPTY ROSTER DOES NOT TAKE THE ALLOW ARM. `candidateRosterRows.length === 0`
  // has already 422'd a non-super-admin above, and for a super-admin an empty roster gets
  // its own "no obligation to discharge" refusal — so `length > 0` here is an assertion
  // about which arm we are on, not a fallback. Without it a zero-row roster would read as
  // "nobody but the requester is asked" and self-decide into an empty obligation set.
  // ⚠️ The solo-tenant arm added 2026-09-26 carries NO such term and does not need one:
  // both refusals above are UNCONDITIONAL and sit before this point, so an empty roster
  // never reaches either arm. Do not "harden" it by re-adding a `length > 0` there — that
  // would read as this predicate having a roster precondition, which is the one thing it
  // deliberately does not have.
  //
  // ⚠️ NOT SCOPED TO `approved`, unlike the #1064 broken-gate and #1098 finished-card
  // guards, and the difference is not an oversight. Those two refuse a PROPOSITION that
  // cannot be approved and must leave REJECT open, or the row has no exit at all. This
  // one refuses a PRINCIPAL, and the exit it leaves open is a different PERSON: the
  // roster names someone else, and that someone else can still approve or reject. A
  // rejection is also terminal on the first vote (`allDecisions.some(rejected)` below),
  // so scoping to `approved` would leave the requester able to kill their own gate
  // single-handedly — the same bypass with the sign flipped. The three chat seats do not
  // scope it either, and parity across the four inserts is the whole point of the shared
  // predicate.
  //
  // ⛔ ABOVE THE `existingDecision` READ, matching `routes/teams-webhook.ts`'s own
  // ordering note ("an unauthorized caller must get a refusal, not a `{duplicate:true}`
  // 200 that discloses whether a decision already exists"). It is also above the INSERT,
  // the status flip, the Planka read and the n8n callback, so a refusal writes NOTHING
  // and the row stays pending, decidable by the approver the roster actually names.
  //
  // 403 with `code`, not 422: the same body replayed by the rostered approver is
  // accepted, so this is "you may not act here", not "your input is invalid".
  const allRequiredApprovers = await db.select()
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, approvalId));

  const rosterAsksOnlyTheRequester =
    allRequiredApprovers.length > 0 &&
    approval.requester_id != null &&
    allRequiredApprovers.every((ra) => ra.user_id === approval.requester_id);

  // ── TWO INDEPENDENT ALLOWANCES, OR-ed — see `soloTenantMemberIsTenantGod` above ─────
  //
  // ⭐ WHICH one applied is carried forward rather than re-derived at the stamp site
  // below: `validated` is not parsed yet here (the body read is deliberately BELOW this
  // refusal, so a refused principal is not even asked for a payload), and two spellings of
  // one predicate is how the stamp goes out of step with the refusal.
  //
  // ⚠️ THE TENANT ARM IS EVALUATED FIRST AND WINS WHEN BOTH HOLD, and the order is a
  // claim, not a coin toss: on a solo tenant the roster arm is a COINCIDENCE (the roster
  // happens to name only the one person there is), whereas the tenant arm is the REASON.
  // Stamping the coincidence would tell a later auditor that the roster was the operative
  // fact on a row where it was not.
  //
  // ⚠️ THE MEMBER-COUNT QUERY IS INSIDE THE `requesterIsDecider` BRANCH ON PURPOSE. It is
  // one extra SELECT on a population measured at 16 rows ALL-TIME (`approver_id =
  // requester_id`), against ~2,900 ordinary decisions that must not pay for it. Hoisting
  // it out of the branch "for readability" puts a per-decision round trip on the hot path.
  //
  // ⚠️ AMENDED (fr#1220): the call is now `callerIsSoloTenantGod()`, the MEMO declared with
  // the candidate-roster widening above, not a second `soloTenantMemberIsTenantGod(…)`. The
  // hot-path argument is unchanged — the memo is still only ever POPULATED on a cold path
  // (a zero-candidate refusal, or this branch) — but two independent reads of one member
  // count in one request is how a widened candidate set and its own stamp come to disagree
  // about whether the tenant was solo.
  // ⭐ P1-TEAM-b: the guard is about the HUMAN who raised the row. A conveyor/system-raised
  // row (`isSystemRaisedApproval`: source 'n8n', not an action approval) names the project
  // OWNER in `requester_id` only because the producer defaulted it — "the requester of a
  // conveyor-raised row is the system, not the owner" — so the owner deciding it is not a
  // self-decision and is neither refused nor stamped. This is what keeps the owner deciding
  // conveyor sign-offs now that the tenant-member arm routes them to this check.
  const requesterIsDecider = isHumanRequesterDecidingOwnApproval(approval, user.id);
  let selfDecisionExemptReason: SelfDecisionExemptReason | null = null;
  if (requesterIsDecider) {
    if (await callerIsSoloTenantGod()) {
      selfDecisionExemptReason = 'solo_tenant_member';
    } else if (rosterAsksOnlyTheRequester) {
      selfDecisionExemptReason = 'roster_names_only_requester';
    }
  }
  const isExemptSelfDecision = selfDecisionExemptReason !== null;

  if (requesterIsDecider && !isExemptSelfDecision) {
    // The warn line and the 403 live in `handleUpdateApproval` (`requester_is_decider`), unchanged.
    return {
      eligible: false,
      refusal: 'requester_is_decider',
      superAdminDecider,
      rosterSize: allRequiredApprovers.length,
    };
  }

  // Check if user has already decided
  const [existingDecision] = await db.select()
    .from(approvalDecisions)
    .where(
      and(
        eq(approvalDecisions.approval_id, approvalId),
        eq(approvalDecisions.approver_id, user.id)
      )
    );

  if (existingDecision) {
    return { eligible: false, refusal: 'already_decided', superAdminDecider, rosterSize: allRequiredApprovers.length };
  }

  return {
    eligible: true,
    superAdminDecider,
    soloTenantGodWidened,
    tenantMemberWidened,
    requiredApprover,
    allRequiredApprovers,
    selfDecisionExemptReason,
  };
}

/**
 * READ-LANE question: could this caller decide this (already reachable, tenant-pinned) row
 * through `PUT /api/approvals/:id` right now? Used by `handleGetApproval` to serve the A1
 * `g12_decide` template ONLY to a caller who could actually decide the row.
 *
 * The PUT's own pre-checks, in its order (tenant pin, pending, deadline), then `resolveDecideEligibility` — the PUT's roster / self-decision /
 * already-decided predicate, the same function, not a copy. The pending term is the ONLY one
 * here: the GET does not re-check status, so removing it would serve a decided row.
 *
 * ⚠️ ONE term is STRICTER than the PUT: a service account is refused. The PUT has no
 * decider-class rule (owner ruling 2026-10-31: the responder is the responder, human or
 * agent). The template exists for the web reject picker, which a service account never drives, so
 * this read lane withholds it — serving fewer callers than the PUT admits is the safe side.
 * It does not change what the PUT accepts.
 */
async function callerMayDecideApproval(
  user: Awaited<ReturnType<typeof validateAuth>>,
  approval: ApprovalRow,
): Promise<boolean> {
  if (approval.tenant_id !== ctxTenantId(user.tenantId)) return false;
  if (approval.status !== 'pending') return false;
  if (hasPassedDeadline(approval.expires_at)) return false;
  if (user.isServiceAccount === true) return false;
  return (await resolveDecideEligibility(user, approval)).eligible;
}

/**
 * PUT /api/approvals/:approvalId
 * Approve or reject an approval request
 */
export async function handleUpdateApproval(
  req: Request,
  approvalId: string
): Promise<Response> {
  const user = await validateAuth(req);
  // The web seat: fr authenticated the decider on THIS request (lib/action-decision-identity.ts).
  return recordApprovalDecision(user, approvalId, () => req.json(), req.headers, {
    channel: 'web',
    evidence: { keycloakSession: true },
  });
}

/** The decision body `PUT /api/approvals/:approvalId` accepts (exported for the DecideInput mapping test). */
export type UpdateApprovalBody = z.input<typeof UpdateApprovalSchema>;
export { UpdateApprovalSchema };

/**
 * The ONE approval-decision function (fr-agui SPEC §5.2): `PUT
 * /api/approvals/:approvalId` (handleUpdateApproval) and the channel
 * `approve|reject <id>` command (`approvals.decide`, agui/actions/approvals-decide.ts)
 * both call it, so every decision guard — tenant scope, one decision per
 * approver, required-approver routing, the requester-is-decider refusal — applies
 * to both unchanged. `readBody` is read AFTER the eligibility checks, exactly
 * where the route read `req.json()`.
 */
export async function recordApprovalDecision(
  user: Awaited<ReturnType<typeof validateAuth>>,
  approvalId: string,
  readBody: () => Promise<unknown>,
  headers: Headers,
  /**
   * ⛔ P1-TEAM-c audit 2: the seat this decision arrived on and what it proves about the
   * decider. REQUIRED, so no caller can record a decision without classifying itself:
   * an ACTION approval runs as its decider, and only a verified-identity seat may decide
   * one (`assertActionDecisionSeatVerified`).
   */
  seat: ActionDecisionSeat,
  /**
   * ⛔ WHETHER THE HUMAN ACTUALLY WROTE THIS APPROVE, as opposed to clicking a button or
   * typing the numbered grammar. A chat seat that had laya read free text sets it (via
   * `ChannelSender.bareGrammar === false` in `decideAsChannelSender`); every other seat
   * leaves it unset.
   *
   * It exists for ONE decision: `metadata.proposed_answer` (fr#1687). A comment-less approve
   * normally accepts the asker's proposal, and that is right for a button or a bare `1` —
   * the human supplied no words, so the row's own answer is the only answer there is. But
   * when the human DID write something ("approve, but use the main repo") and the row owes
   * an answer, `toChatDecision` drops those words rather than storing them as the answer.
   * Filling the proposal would then record the asker's text OVER the human's — a decision
   * they never made. With this set, the fill is skipped and the row's own answer-required
   * refusal fires, which asks for `approve: <your answer>`: the same sentence every other
   * channel gives, with nothing invented on the human's behalf.
   */
  opts?: { fromFreeText?: boolean },
): Promise<Response> {
  // Minting ≠ deciding: a licence caller never decides (lib/licence-door.ts).
  assertNotLicenceDecider(user);

  // Same guard as the read lanes. handleUpdateApproval does not go through
  // loadReachableApproval (it builds its own scope so it can distinguish
  // not-pending / expired / not-authorized below), so it needs the check
  // explicitly — otherwise `PUT /api/approvals/pending` stays a 500 while the
  // GET on the identical path is a 404.
  assertApprovalIdShape(approvalId);

  // Get approval — scoped to the caller's tenant. Without the tenant filter a
  // cross-tenant caller could probe approval IDs and distinguish the distinct
  // errors below ("not found" vs "no longer pending" vs "expired" vs "not
  // authorized"), leaking the existence + status of another tenant's approvals.
  // Mirrors handleGetApproval; tenant_id is NOT NULL (migration 042).
  //
  // fr row 14d: NO exception. A super-admin in home view used to ACT
  // cross-tenant here (id only); a super-admin now decides only inside the
  // active tenant, i.e. after an explicit switch into a platform workspace.
  const approvalScope = and(
    eq(approvals.id, approvalId),
    eq(approvals.tenant_id, ctxTenantId(user.tenantId)),
  );
  const [approval] = await db.select()
    .from(approvals)
    .where(approvalScope);

  if (!approval) {
    throw new NotFoundError('Approval not found').withCode('approval_not_found');
  }

  // Check if approval is still pending
  if (approval.status !== 'pending') {
    throw new ValidationError('Approval is no longer pending').withCode('already_decided');
  }

  // Check if approval has expired. A NULL `expires_at` means "no deadline, ever" and must
  // NOT refuse: `new Date(null)` is epoch 0, so the previous bare comparison read a
  // deadline-less approval as expired since 1970 and made it permanently undecidable.
  if (hasPassedDeadline(approval.expires_at)) {
    throw new ValidationError('Approval has expired').withCode('approval_expired');
  }

  // ⛔ P1-TEAM-c audit 2: an ACTION approval runs AS ITS DECIDER, so it may be decided only
  // from a verified-identity seat (the allowlist in lib/action-decision-identity.ts). Before
  // anything is read from the body or written: a refusal records nothing.
  assertActionDecisionSeatVerified({ approval, seat });

  // ⛔ v4 wiring gate for the OUTLINE road. Deciding a project outline promotes
  // its request into a project (onOutlineDecided → promoteProjectRequest), which
  // an instance without the v4 conveyor wiring must refuse. Refuse HERE, before
  // the decision commits: the approval stays `pending`, the outline `proposed`
  // and the request untouched, so the same decision is simply retried once the
  // instance is wired. Refusing any later strands the request — the approval is
  // already decided and nothing re-drives onOutlineDecided.
  if (approval.kind === OUTLINE_APPROVAL_KIND && approval.project_request_id) {
    assertConveyorConfigured();
  }

  const eligibility = await resolveDecideEligibility(user, approval);
  if (!eligibility.eligible) {
    const { superAdminDecider } = eligibility;
    switch (eligibility.refusal) {
      case 'no_roster_match':
        throw new ValidationError(
          superAdminDecider
            ? 'This approval has no required approvers recorded, so there is no obligation ' +
                'to discharge. That is a defect in whatever raised it — reject or void it ' +
                'rather than approving into an empty roster.'
            : 'You are not authorized to approve this request. Deciding it requires being ' +
                'named on its approver roster, holding one of the realm roles the roster asks ' +
                'for (card_approver, execution_signoff), or being a member of the tenant this ' +
                'approval belongs to, acting in that tenant — any member of the tenant may ' +
                'decide its approvals. You are none of these here (or your membership could ' +
                'not be verified right now — try again shortly).',
        ).withCode('no_decide_rights');
      case 'no_open_obligation':
        throw new ValidationError(
          'You are not authorized to discharge any open obligation on this approval: no open ' +
            'roster row names you or asks for a role you hold (every row you could claim is already ' +
            'discharged, or none was yours).',
        ).withCode('no_decide_rights');
      case 'requester_is_decider': {
        console.warn(
          `[approvals] REFUSED decision on approval ${approvalId}: requester ${user.id} is ` +
            `also the decider, the roster names ${eligibility.rosterSize} row(s) ` +
            `including someone else, and tenant ${approval.tenant_id} does not have exactly ` +
            'one member (or that member is not this caller). Nothing was written.',
        );
        throw new ForbiddenError(
          // ⚠️ "one required approver who is not you", NOT "one OTHER required approver"
          // (fr#1240 re-audit N1). This refusal has NO roster-membership term on the requester
          // — deliberately, see the note in `resolveDecideEligibility` — so it fires on
          // requesters who are not on the roster at all. MEASURED all-time on 4,889 approvals:
          // 77 rows carry this shape and only 1 names the requester on its own roster; on the other 76 the word "other"
          // presupposed a membership the reader does not have. Integration tests match on
          // /may not be recorded as its decider/i, not on this clause.
          'The requester of an approval may not be recorded as its decider. This approval ' +
            'names at least one required approver who is not you — ask them to decide it (or ' +
            'any other member of this tenant). (Three exemptions exist and none applies ' +
            'here: a tenant with exactly ONE member may always decide its own approvals — that ' +
            'member is the tenant god; an approval whose approver roster contains nobody but ' +
            'the requester has no second party to bypass; and a conveyor-raised approval, ' +
            'whose requester is the system, not you. The first two are recorded as an ' +
            'explicit self-decision.)',
        ).withCode(APPROVER_IS_REQUESTER_CODE);
      }
      case 'already_decided':
        throw new ValidationError('You have already made a decision on this approval').withCode('already_decided');
    }
  }
  const {
    superAdminDecider,
    soloTenantGodWidened,
    requiredApprover,
    allRequiredApprovers,
    selfDecisionExemptReason,
  } = eligibility;
  const isExemptSelfDecision = selfDecisionExemptReason !== null;

  const body = await readBody();
  const validated = UpdateApprovalSchema.parse(body);

  // If rejecting, require a reason
  if (validated.status === 'rejected' && !validated.reason) {
    throw new ValidationError('A reason is required when rejecting');
  }

  // ── THE ONE-SEAT SELF-DECISION IS A RECORDED FACT, NOT AN ABSENCE OF A REFUSAL ───
  //
  // ⛔ WHY THIS FIELD AND NOT A NEW COLUMN. `approval_decisions` has exactly seven
  // columns (schema.ts): id, approval_id, approver_id, decision, comment, decided_at,
  // required_approver_id. The ONLY free-text one is `comment`, and `comment` is
  // load-bearing somewhere else entirely — it is the ANSWER `answerlessApproveDemand`
  // demands and `buildCallbackPayload` forwards to n8n as the reply to a QUESTION. Writing
  // an audit stamp there would release a card with a provenance note standing in for a
  // human's answer, which is the exact merge-of-two-meanings the #1064/#1066 interaction
  // above was written to subtract. So the decision row has no field for this, and a
  // migration is not this change's call to make.
  //
  // ⭐ `approvals.metadata` IS the codified place for an attributable decision-time fact
  // on this handler, and `broken_gate_override` two blocks down is the precedent, written
  // for the same reason in the same shape: a jsonb key, merged (not replaced) into
  // whatever the producer wrote, scoped to `status = 'pending'`, queryable as
  // `metadata ? 'self_decision'`. It is on the APPROVAL rather than the DECISION, which
  // is a real difference — state it, do not paper over it.
  //
  // ⚠️ CORRECTED 2026-09-26, and the correction is the point of `exempt_reason`. This
  // paragraph used to claim "a second author is impossible BY CONSTRUCTION on this arm —
  // the stamp only exists when every roster row names the requester". That was true while
  // `rosterAsksOnlyTheRequester` was the ONLY allowance; it is NOT true of the
  // `solo_tenant_member` arm, which fires on rosters that DO name someone else (an absent
  // Keycloak subject, a stale id). What still holds, and is what actually rules out a
  // clobber, is narrower: this stamp is only ever written by the REQUESTER
  // (`requesterIsDecider` gates both arms), `existingDecision` above refuses that one
  // person a second decision, and the write is scoped to `status = 'pending'` — which a
  // completed decision leaves. A different roster member deciding the same row takes
  // neither arm, so `selfDecision` is `undefined` for them and the spread below writes
  // nothing. Do not restore the stronger sentence: it would be quoted in review as a
  // guarantee the code no longer makes.
  //
  // ⚠️ `decision` is recorded, not just the fact of a self-decision: a solo tenant
  // rejecting their own request and approving it are different acts, and an auditor
  // reading only "self_decision: true" cannot tell them apart.
  //
  // ⭐ `exempt_reason` IS THE FIELD THAT KEEPS THE STAMP AUDITABLE NOW THAT THERE ARE TWO
  // WAYS IN. `roster_user_ids` is sufficient EVIDENCE for the roster arm — it is the
  // roster that named nobody else, as it stood at decision time — and it is NOT evidence
  // for the tenant arm, where the roster commonly names somebody. Without this field the
  // two are indistinguishable after the fact, and a row stamped on a one-member tenant
  // would read to a later auditor as a roster claim its own `roster_user_ids` refutes.
  const selfDecision = isExemptSelfDecision
    ? {
        by: user.id,
        decision: validated.status,
        exempt_reason: selfDecisionExemptReason,
        // ⚠️ SORTED, and that is not cosmetic. `required_approvers` is read with no
        // ORDER BY, so Postgres may hand back the same rows in a different order after
        // any plan or table change — and this field is an AUDIT RECORD. An unordered set
        // rendered in arbitrary order gives two auditors two different-looking stamps for
        // one identical decision, and it made a green branch test fail on main for a
        // reason nothing in the diff named (measured 2026-09-26: expected
        // [..0001, ..dead], received [..dead, ..0001], same two elements).
        // Sorting here makes the evidence stable; do not "simplify" it away.
        roster_user_ids: [...allRequiredApprovers.map((ra) => ra.user_id)].sort(),
        required_approver_id: requiredApprover.id,
        at: new Date().toISOString(),
      }
    : undefined;

  // ── A ROW DISCHARGED BY SOMEBODY IT DID NOT NAME IS A RECORDED FACT (fr#1220) ────
  //
  // ⛔ THIS IS A SEPARATE STAMP FROM `self_decision`, AND COLLAPSING THEM WOULD LOSE THE
  // ONE THING WORTH RECORDING. `self_decision` answers "the requester decided their own
  // approval, under which allowance". This answers a DIFFERENT question — "the obligation
  // this decision discharged named SOMEONE ELSE, and the decider reached it only because
  // they are the sole member of the tenant". The two overlap in the common case and come
  // apart in both directions: a solo member who is NOT the requester takes this arm and
  // no `self_decision` arm at all, and a requester whose own name IS on the roster takes
  // `self_decision` with no widening. A single flag could not tell a later auditor which
  // of those they were reading.
  //
  // ⭐ THE HONEST NAME FOR THE ACT. The roster row still says a specific uuid, and after
  // this write `approval_decisions.required_approver_id` points at that row while
  // `approver_id` is a different person. `classifyRosterDischarge` already emits
  // `named_other` for exactly this and the #1059 warn below names both ids — but a metric
  // and a log line are not queryable per row three months later, and the whole reason
  // `self_decision` is metadata rather than an absence of a refusal applies verbatim here.
  //
  // ⚠️ `quorum_note` IS NOT DECORATION — it is the answer to "what did this do to the
  // tally", written where the row's reader will be. The decision writes a NON-NULL
  // `required_approver_id`, so the #923 predicate below (`every roster row's id is in the
  // satisfied set`) applies in full and the pre-108 count fallback is NOT engaged. With a
  // one-row roster — every pending row measured, 1032 of 1032 — that completes the
  // approval. With a roster naming TWO ghosts it does NOT: this caller may decide once
  // (`existingDecision`), one obligation is discharged, the other is not, and the row
  // stays `pending` rather than reporting itself complete. That is the intended direction
  // — an approval must never look discharged when an obligation was never met — and it is
  // the reason (a) "discharge the named row on their behalf" was chosen over (b) "record
  // the decision with a NULL `required_approver_id`": (b) would set `anyPre108` and fall
  // back to `allDecisions.length === allRequiredApprovers.length`, which for a 2-ghost
  // roster completes on the SECOND decision by anyone at all, and would additionally
  // write NULL — a value every later reader is told means "unknown, predates migration
  // 108" — onto a row written today. The file says that in its own words twenty lines
  // above the candidate query; this stamp is what keeps it true.
  // ── fr#1059: THE SUPER-ADMIN OVERRIDE IS EXPLICIT AND LOGGED ─────────────────────
  // George's ruling (role slot): a row is discharged by its named user or a holder of its
  // role. A super-admin who is NEITHER may still discharge it — the operator's deliberate
  // override (see the super-admin arm above) — but only visibly: this stamp on the row and a
  // warn line. A super-admin who IS named or holds the role is an ordinary decider and gets
  // no stamp.
  const superAdminOverride =
    superAdminDecider &&
    requiredApprover.user_id !== user.id &&
    !(requiredApprover.role && (user.roles ?? []).includes(requiredApprover.role))
      ? {
          by: user.id,
          decision: validated.status,
          discharged_required_approver_id: requiredApprover.id,
          discharged_row_names: requiredApprover.user_id,
          discharged_row_role: requiredApprover.role ?? null,
          at: new Date().toISOString(),
        }
      : null;
  if (superAdminOverride) {
    console.warn(
      `[approvals] super-admin override (fr#1059): ${user.id} discharged required_approvers row ` +
        `${requiredApprover.id} on approval ${approvalId}, which names ${requiredApprover.user_id} ` +
        `(role=${requiredApprover.role ?? 'none'}) — neither the named user nor a holder of its role.`,
    );
  }
  // P1-TEAM-b: a MEMBER (not the solo one) discharged a row naming someone else — the same
  // accountability stamp as the solo arm's, under its own key so an auditor can tell the
  // two allowances apart. The solo case keeps `solo_tenant_discharge` byte-for-byte.
  const tenantMemberDischarge =
    eligibility.tenantMemberWidened && !soloTenantGodWidened
      ? {
          by: user.id,
          decision: validated.status,
          tenant_id: approval.tenant_id,
          discharged_required_approver_id: requiredApprover.id,
          discharged_row_names: requiredApprover.user_id,
          roster_user_ids: [...allRequiredApprovers.map((ra) => ra.user_id)].sort(),
          quorum_note:
            'a member of this tenant discharged a roster row naming someone else (1-of-any ' +
            'tenant member, George 2026-10-15); required_approver_id is recorded NOT NULL, so ' +
            'the #923 per-obligation quorum applies unchanged and any other roster row remains ' +
            'outstanding',
          at: new Date().toISOString(),
        }
      : undefined;
  const soloTenantDischarge = soloTenantGodWidened
    ? {
        by: user.id,
        decision: validated.status,
        tenant_id: approval.tenant_id,
        // The obligation discharged, and WHO it actually named — the pair is the finding.
        discharged_required_approver_id: requiredApprover.id,
        discharged_row_names: requiredApprover.user_id,
        // Sorted for the same reason as the sibling stamp above: the roster is read with
        // no ORDER BY, and an audit record must not vary by query plan.
        roster_user_ids: [...allRequiredApprovers.map((ra) => ra.user_id)].sort(),
        quorum_note:
          'the sole member of this tenant discharged a roster row naming someone else; ' +
          'required_approver_id is recorded NOT NULL, so the #923 per-obligation quorum ' +
          'applies unchanged and any other roster row remains outstanding',
        at: new Date().toISOString(),
      }
    : undefined;

  // Hoisted above the broken-gate guard below (it used to be declared with the
  // deblock-override block): the guard reads `gate_terms` off the SAME stored
  // metadata, and both must see one value rather than two reads that can drift.
  const approvalMetadata = (approval.metadata as Record<string, unknown> | null) ?? {};

  // ── A BROKEN GATE MAY NOT BE APPROVED (#1064) ────────────────────────────────────
  // See BROKEN_GATE_TERMS at the top of this file for the population this refuses and
  // for why `risk_block` is deliberately absent from it.
  //
  // ⭐ SCOPED TO `approved`, AND THAT IS THE WHOLE POINT — assert it, do not "fix" it.
  // REJECTING a broken gate is the CORRECT terminal for one: it is how the row leaves
  // the queue truthfully, and it is what the upstream producer needs to see. A guard
  // that refused every decision on these rows would strand them pending for ever and
  // make the queue unclearable — the exact shape the deblock recovery door above was
  // reopened to undo. `validated.status === 'rejected'` is NEVER blocked here.
  //
  // Placed AFTER the reject-reason check so a rejection is still validated normally,
  // and BEFORE the `deblock_action` override gating so a caller cannot get a confusing
  // action-shaped refusal on a row that was never approvable in the first place.
  // It is also above the decision INSERT, so a refusal writes nothing: no
  // `approval_decisions` row, no status change. A guard that 422s the caller after
  // persisting the decision would be worse than none.
  const brokenTerms = declaredGateTerms(approvalMetadata).filter((t) =>
    BROKEN_GATE_TERMS.has(t),
  );
  // Set when the refusal is deliberately overridden, so the override is recorded on the
  // row rather than being invisible after the fact. `undefined` on every other path.
  let brokenGateOverride:
    | { terms: string[]; by: string; reason: string; at: string }
    | undefined;
  if (validated.status === 'approved' && brokenTerms.length > 0) {
    // ⭐ THE ESCAPE HATCH IS ATTRIBUTABLE, NOT AMBIENT. An env killswitch would let one
    // pod's environment silently disable this for every caller with no record; this
    // requires a specific super-admin to state, in writing, on this row, why they are
    // signing off on a gate that could not be constructed. That is a claim someone can
    // be held to; an env var is not.
    const reason = validated.reason ?? '';
    const mayOverride =
      isSuperAdmin(user) && reason.trim().length >= BROKEN_GATE_OVERRIDE_MIN_REASON;
    if (!mayOverride) {
      throw new ValidationError(
        `This approval cannot be approved: its gate_terms include ` +
          `${brokenTerms.join(', ')}, which describe a DEFECT in the process that raised ` +
          'it, not a decision anyone can take. There is no proposition here to approve. ' +
          'Three things do work: fix it upstream and let the producer re-raise the ' +
          'approval; REJECT it (rejecting a broken gate is the correct terminal and is ' +
          'never blocked by this rule); or have an operator void it (voiding is not ' +
          'offered in the UI — it is a super-admin API call). A super-admin may ' +
          'override, in the UI on the approval page or here, with a ' +
          `\`reason\` of at least ${BROKEN_GATE_OVERRIDE_MIN_REASON} characters, which is ` +
          'recorded on the approval.',
      );
    }
    brokenGateOverride = {
      terms: brokenTerms,
      by: user.id,
      reason: reason.trim(),
      at: new Date().toISOString(),
    };
  }

  // ── A GATE ON A FINISHED CARD MAY NOT BE APPROVED (#1098) ────────────────────────
  // The essay lives with `currentCardListName` at the top of this file: why fr must own
  // this rather than leaving it to n8n's `isFinished` arm, why REJECT is never blocked,
  // and why an unreadable card ALLOWS.
  //
  // Placed immediately AFTER the #1064 broken-gate guard and BEFORE the `deblock_action`
  // override gating, for the same two reasons that guard states: a correctness refusal
  // must not be masked by an action-shaped one, and — the load-bearing half — it sits
  // ABOVE the decision INSERT, so a refusal writes NOTHING. No `approval_decisions` row,
  // no status change, no callback. The row stays pending, rejectable and voidable.
  //
  // ⚠️ `approval.card_id` IS NULLABLE AND A NULL SKIPS THE GUARD, deliberately. A
  // cardless approval has no card to be finished; there is no read to make and nothing
  // to refuse. Measured: the 212-row population is defined by a card_id joining to
  // Planka, so this excludes nothing the guard is for.
  //
  // ⭐ A v4 conveyor ask (`sub.ask_fr`) is EXEMPT: its callback only resumes an n8n
  // Wait, it never moves the card — see `isV4ConveyorWaitApproval`.
  if (
    validated.status === 'approved' &&
    approval.card_id &&
    !isV4ConveyorWaitApproval(approval)
  ) {
    const listName = await currentCardListName(approval.card_id);
    if (listName !== null && isFinishedList(listName)) {
      console.warn(
        `[approvals] REFUSED approve on approval ${approvalId}: card ${approval.card_id} ` +
          `is in list "${listName}" — the work is finished and approving would ask the ` +
          'receiver to move it backward. Nothing was written.',
      );
      throw new ValidationError(
        `This approval cannot be approved: its card is currently in the list ` +
          `"${listName}", which means the work is already FINISHED. Approving would ask ` +
          'the n8n receiver to move a completed card backward to TODO/READY, destroying ' +
          'the state it has legitimately reached. Nothing has been written — this row is ' +
          'still pending. Two things do work: REJECT it (the work is done, so the ' +
          'proposition is moot, and rejecting is never blocked by this rule); or have an ' +
          'operator void it (voiding is not offered in the UI — it is a super-admin API ' +
          'call). If the card is in that list by mistake, move it back in Planka first ' +
          'and decide again.',
      );
    }
  }

  // ── the decider's action override ────────────────────────────────────────────────
  // Only meaningful on a BLOCKED-exit proposition, i.e. an approval that already carries a
  // machine-proposed `deblock_action`. Sending it on any other approval is a caller error,
  // not something to silently ignore: `buildCallbackPayload` would echo an action the n8n
  // callback has no context to execute.
  const proposedAction = approvalMetadata.deblock_action;
  // Same classifier the mint uses (`routes/webhooks.ts`), run against the STORED metadata
  // rather than an inbound payload — so "is this a BLOCKED-exit proposition?" has one
  // answer in this codebase instead of two that can drift apart.
  const deblockExit = classifyDeblockExit({
    action: proposedAction,
    doingListId: approvalMetadata.doingListId,
    todoListId: approvalMetadata.todoListId,
    advancePhase: approvalMetadata.advance_phase_on_approve,
    improvementKind:
      typeof approval.kind === 'string' && approval.kind.startsWith('improvement')
        ? approval.kind
        : undefined,
    // REQUIRED HERE, unlike at the mint seam. This handler is generic over every approval
    // kind, so it is the only place `execution.ready_signoff` rows reach the classifier.
    // Measured 2026-09-07: all 844 of them carry NON-EMPTY doingListId/todoListId and zero
    // carry a deblock_action, so without this they land on the `required` arm and this
    // counter reads 844/844 `absent` on a rail that is working exactly as designed.
    approvalKind: approval.kind,
    // (fr#1481: no `cardType` — the signoff-lane card-type phase signal was deleted with the
    // approval-completion phase advance; both seams now pass the same inputs.)
  });
  let overriddenAction: string | undefined;
  // ⛔ G-12 GATED KINDS (A3 execution.feature_design_approval, A6 execution.question): the
  // recorded G-12 decision IS the outcome — A3 approve/reject the design, A6 the registered answer
  // or reject `no_registered_answer`. A decider-supplied action (DROP, RETRY, …) would move the
  // card somewhere that decision does not say (`design_ok` / `answered:Q2` while the conveyor
  // kills the card) and R10 cannot see it in item_decisions. So the recovery door below is CLOSED
  // on these kinds; on A6 only the stored QUESTION itself may be echoed back. (Two fresh
  // validators, reproduced: DROP → card_move DONE on A6, and on A3 — the A3 half predates U3/A3.)
  if (
    validated.deblock_action &&
    (approval.kind === FEATURE_DESIGN_APPROVAL_KIND ||
      (approval.kind === QUESTION_KIND && validated.deblock_action !== 'QUESTION'))
  ) {
    throw new ValidationError(
      `deblock_action cannot be supplied on an ${approval.kind} approval: its outcome is fixed by its ` +
        'G-12 decision. Decide it without deblock_action.',
    ).withCode('deblock_action_not_allowed');
  }
  if (validated.deblock_action) {
    // ⛔ THE RECOVERY DOOR. This used to refuse unless a machine had ALREADY proposed an
    // action, which made the 137 keyless approvals measured on 2026-09-06 unrepairable by
    // hand: a human could see the card, know the answer, and had no way to say it. The
    // mint refuses new ones now (see webhooks.ts) but cannot un-mint those, and a backfill
    // is an operator decision, not fr's. So the gate is now "is this a BLOCKED-exit
    // proposition at all", which is the question that was actually being asked.
    // ⚠️ NEW REFUSAL SURFACE, DISCLOSED DELIBERATELY. Adding the `signoff_rail`
    // exemption moves all 844 `execution.ready_signoff` rows from `required: true` to
    // `required: false`, so a decider who supplies a `deblock_action` on one now gets a
    // 400 here where the previous revision quietly ACCEPTED it. That is the intended
    // direction: `buildCallbackPayload` on that rail does not read the field, so the old
    // behaviour wrote a value into `metadata` that could never act -- the identical
    // silent-no-op shape this whole change exists to close. A loud refusal beats a
    // stored lie.
    // ⭐ MEASURED 2026-09-07: `metadata->>'decided_action_source'` is NULL on 2,856 of
    // 2,856 rows, so NO decider has ever supplied or confirmed an action and today this
    // path carries zero traffic. ⛔ Do not read that zero as safety. It is zero because
    // the recovery door that makes supplying an action possible shipped in #982 hours
    // ago; its whole purpose is to take traffic, so this number is expected to leave
    // zero. Exactly the "a zero that depends on nobody doing X yet" trap this file's
    // sibling guard was written to fix.
    // ⛔ THE DUAL-EXIT ROW SLIPS PAST THE REFUSAL BELOW, SO IT IS REFUSED HERE FIRST.
    // The test below is `no stored action AND not required`. On a row carrying BOTH a lane
    // marker and a `deblock_action`, `proposedAction` IS a string, so the first half is
    // false and the refusal never fires — a decider could override the action on a row the
    // classifier had just ruled is NOT a BLOCKED-exit proposition at all. The stored action
    // was acting as proof of a proposition the same classifier denies exists.
    //
    // ⚠️ ORDER, NOT AN EXTRA CONDITION, AND DELIBERATELY SO. Widening the test below to
    // `(!stored || conflict) && !required` would give both refusals one message, and they
    // are different findings: "this approval moves no card" sends the decider away, while
    // this one says the ROW is contradictory and names which two exits collided. A message
    // that cannot tell its reader which of two problems they have is the reason the
    // recovery door had to be reopened in the first place.
    //
    // ⭐ SCOPED TO THE OVERRIDE, NOT TO THE DECISION. This refuses supplying an action on a
    // dual-exit row; it does NOT refuse deciding one. Throwing on every PUT would strand
    // the approval with no way to answer it — the exact shape the recovery door below was
    // opened to undo. A decider may still approve or reject; `buildCallbackPayload` then
    // withholds the action so the decision still has one effect.
    // ⛔ BOTH REFUSALS NOW COME FROM ONE PURE FUNCTION, AND NOT BECAUSE IT IS TIDIER.
    // They used to be two inline `if`s here, which meant the only thing testing them was
    // a grep over this file. A mutation run that disabled the dual-exit refusal outright
    // left every grepped string in place and all 67 tests passed — a presence check cannot
    // fail for a behaviour change. `classifyDeciderOverride` is pure and unit-tested, so
    // the refusal is now covered by something that can actually go red.
    const overrideVerdict = classifyDeciderOverride(deblockExit, proposedAction);
    if (!overrideVerdict.allowed && overrideVerdict.reason === 'dual_exit') {
      // ⭐ THIS IS THE ONE THE OLD TEST COULD NOT FIRE ON. The refusal below is
      // `no stored action AND not required`; a dual-exit row ALWAYS has a stored action,
      // so its first half was false and a decider could override an action on a row the
      // classifier had just ruled is not a BLOCKED-exit proposition at all.
      //
      // ⚠️ SCOPED TO THE OVERRIDE, NOT THE DECISION. This refuses supplying an action, not
      // deciding the approval — throwing on every PUT would strand the row with no way to
      // answer it, which is the shape the recovery door below was opened to undo. A
      // decider may still approve or reject; `buildCallbackPayload` then withholds the
      // card move so the decision still has exactly one effect.
      const { conflict } = overrideVerdict;
      recordDeblockDualExit('decide', conflict.exemption);
      throw new ValidationError(
        `This approval asserts two exits at once: the ${conflict.exemption} lane AND a ` +
          `stored deblock_action=${conflict.discarded}. Supplying an action would add a ` +
          'third claim to a row that already contradicts itself, and fr will not pick a ' +
          'winner on your behalf. Approving or rejecting still works — the callback ' +
          'withholds the card move so your decision has one effect. To make the card move ' +
          'instead, the producer must re-raise this approval with exactly one exit.',
      );
    }
    if (!overrideVerdict.allowed && overrideVerdict.reason === 'signoff_rail') {
      // Its own message, because neither neighbour's is true of this row: it is not
      // contradictory (no second exit), and it does carry a proposed action. See
      // `classifyDeciderOverride` for why the signoff receiver cannot honour an override.
      throw new ValidationError(
        'deblock_action cannot be supplied on an execution.ready_signoff approval. Its ' +
          'receiver does not execute a decider-supplied action: it routes QUESTION to its ' +
          'answer path and every other approval to its plain approved path, so fr would ' +
          'report a card move the receiver will not make. Approve or reject without ' +
          `deblock_action; the stored deblock_action (${String(proposedAction)}) is left as ` +
          'the producer wrote it.',
      );
    }
    if (!overrideVerdict.allowed) {
      throw new ValidationError(
        'deblock_action may only be supplied on a BLOCKED-exit proposition ' +
          '(this approval carries no proposed action and moves no card)',
      );
    }
    // A card may die "given sufficient proof" — so the proof is mandatory, not advisory.
    // DROP moves the card to DONE and the conveyor stops retrying it for ever; an
    // unexplained DROP is indistinguishable afterwards from work that actually completed.
    if (validated.deblock_action === 'DROP' && !(validated.reason || validated.comment)) {
      throw new ValidationError(
        'DROP requires a reason: it moves the card to DROPPED (a terminal, NON-DONE list) and the conveyor stops ' +
          'retrying it, so the record of why must survive the decision',
      );
    }
    if (validated.deblock_action !== proposedAction) overriddenAction = validated.deblock_action;
  }

  // ── RECLASSIFY MUST NAME A REAL, DIFFERENT CARD TYPE (REALIGN R5) ────────────────
  // The effective action is the same expression the completion block uses
  // (`validated.deblock_action ?? deblockExit.action`), so a dual-exit row — whose action
  // `buildCallbackPayload` withholds — cannot accept a type that would then travel alone.
  // 400, above the decision INSERT: a refusal writes nothing.
  // The card-type vocabulary is the APPROVAL's tenant's RM catalogue (design: fr consumes
  // RM vocabulary). Read only when an approved RECLASSIFY names a type — the one case the
  // predicates below are consulted — so no other decision pays an RM round trip.
  let ruleIndex: CardTypeRuleIndex | null = null;
  if (
    validated.status === 'approved' &&
    asDeblockAction(validated.deblock_action ?? deblockExit.action) === 'RECLASSIFY' &&
    typeof validated.new_card_type === 'string' &&
    validated.new_card_type.trim() !== ''
  ) {
    ruleIndex = await cardTypeRuleIndex(approval.tenant_id);
  }
  const reclassifyRefusal = classifyReclassifyDecision({
    decision: validated.status,
    effectiveAction: validated.deblock_action ?? deblockExit.action,
    newCardType: validated.new_card_type,
    currentCardType: approvalMetadata.card_type,
    isKnownCardType: (t) => ruleIndex?.known.has(t) ?? false,
    // fr#1441: a type the catalogue marks `no_reclassify_target` (QA dead end) is refused.
    isRefusedTarget: (t) => ruleIndex?.reclassifyRefused.has(t) ?? false,
  });
  if (reclassifyRefusal !== null) {
    throw new BadRequestError(
      reclassifyRefusalMessage(reclassifyRefusal, {
        newCardType: validated.new_card_type,
        currentCardType: approvalMetadata.card_type,
      }),
      { code: reclassifyRefusal },
    );
  }

  // ── A RECLASSIFY MAY NOT ESCAPE THE COMPUTED GATE (liveness-DONE design row #6) ────
  // A proof-subset card (domain/engagement/proof-subset.ts) re-typed to a type whose QA has
  // no computed gate (judge / liveness) could then reach DONE without a computed check. 422,
  // above the decision INSERT: a refusal writes nothing. Creation cannot be checked: a
  // minted row never carries `new_card_type` (one-open-gate.ts strips decide-owned keys), so
  // the decide path — where the type is chosen — is the choke point. ncn mirrors this set.
  if (
    validated.status === 'approved' &&
    asDeblockAction(validated.deblock_action ?? deblockExit.action) === 'RECLASSIFY' &&
    reclassifyEscapesComputedGate({
      sourceCardType: approvalMetadata.card_type,
      newCardType: validated.new_card_type,
      isComputedGated: (t) => typeof t === 'string' && (ruleIndex?.computedGated.has(t.trim()) ?? false),
    })
  ) {
    throw new ValidationError(
      `RECLASSIFY from ${String(approvalMetadata.card_type)} to ${String(validated.new_card_type)} ` +
        'is refused: the source type must reach DONE through a computed check, and the new ' +
        "type's QA has no computed gate (judge or liveness only). Choose a computed-gated type.",
      { code: RECLASSIFY_ESCAPES_COMPUTED_GATE },
    ).withCode(RECLASSIFY_ESCAPES_COMPUTED_GATE);
  }

  // ── A COVERAGE DECISION IS PER-CRITERION (George BDD ruling 2026-10-01) ──────────
  // Keyed on the STORED action (the criteria live on the row). 400 above the decision
  // INSERT, like the RECLASSIFY refusal: a refusal writes nothing.
  const coverageVerdict = classifyCoverageDecision({
    decision: validated.status,
    storedAction: proposedAction,
    overrideAction: validated.deblock_action,
    metadata: approvalMetadata,
    rejectedCriterionIds: validated.rejected_criterion_ids,
  });
  if (coverageVerdict !== null && 'refusal' in coverageVerdict) {
    throw new BadRequestError(
      coverageRefusalMessage(coverageVerdict.refusal, coverageVerdict.detail),
      { code: coverageVerdict.refusal },
    );
  }
  // Known limitation: with multiple required approvers only the COMPLETING decision's verdict (its rejected_criterion_ids) is kept on the row; earlier approvers' per-criterion rejections are not merged.
  // AA-TRACE: the verdict carries the trace of the request that decided it — the inbound
  // `X-AA-Trace-Id` when it is a UUIDv7, else ONE UUIDv7 fr mints for this decision (an
  // approval decision is an fr-originated action, spec §1). Written in the same completing
  // UPDATE as the verdict, since it is a field of it.
  const coverageDecision = coverageVerdict?.coverage
    ? { ...coverageVerdict.coverage, decided_trace_id: traceIdOrMint(headers) }
    : undefined;

  // ── AN APPROVED QUESTION MUST CARRY ITS ANSWER (#1066) ───────────────────────────
  // See the essay at the top of this file for the measured population and for why this
  // one has NO override.
  //
  // ⭐ THE VALUE UNDER TEST IS THE VALUE THAT GETS PERSISTED — BY CONSTRUCTION, NOT BY
  // A MATCHING COPY. `persistedComment` is hoisted here and is the SAME const the
  // `approval_decisions` INSERT below writes, which `buildCallbackPayload` then forwards
  // to n8n as `comment`. Re-deriving it at the guard site would make the gate vacuous the
  // first time someone changed one of the two expressions: note `comment || reason`, not
  // `comment ?? reason` — an explicitly-sent empty-string `comment` falls through to
  // `reason`, so a guard reading `comment` alone would refuse a decision whose answer text
  // is in fact non-empty. The `.trim()` is not decoration either: the consumer trims, so
  // a whitespace-only comment is an EMPTY answer there and must be one here too.
  //
  // Placed AFTER the deblock-override gating (unlike the #1064 guard, which sits before
  // it) because this rule is ABOUT the action: it must read the decider's supplied action,
  // which is only known to be legitimate once `classifyDeciderOverride` has passed on it.
  // Placed BEFORE the #901 interval check so a correctness refusal is never masked by a
  // transient rate refusal, and above the decision INSERT so a refusal writes nothing.
  //
  // ⛔ THE PREDICATE IS `classifyAnswerDemand`, NOT `=== 'QUESTION'` — AND THAT IS THE FIX,
  // NOT A TIDY-UP. The stored type and the stated question are DISJOINT on this estate:
  // measured 2026-09-10, of 1040 pending rows 137 were typed QUESTION carrying ZERO
  // `metadata.open_questions`, and the only 15 rows carrying a readable question all had
  // `deblock_action` NULL. So the `=== 'QUESTION'` form demanded an answer on exactly the
  // rows that state nothing to answer, and demanded none on the only rows that ask
  // something — and the UI mirrors this guard, so fr rendered its answer box the same way
  // round. The predicate is now the UNION of the two reasons and is defined ONCE, in the
  // domain module, so this server and `frontend/src/lib/approvals/question.ts ::
  // answerRequired` cannot demand different things.
  //
  // ⛔ THE `QUESTION` HALF IS NOT SUBTRACTED FOR AN UNSTATED ROW. Read the essay above:
  // the n8n receiver branches on the ACTION and never reads `open_questions`, so an empty
  // approve on one of those 137 rows strands its card exactly as a stated one would, and
  // the row is then spent. Rejection stays exempt and stays the honest terminal there.
  //
  // ⚠️ NEW REFUSAL SURFACE, DISCLOSED DELIBERATELY: an approve with no text on a row that
  // STATES a question now 422s where it previously succeeded. That is the intended
  // direction — such an approve delivered no answer to a question a human was asked — and
  // the refusal is recoverable in a way the old silence was not: the row stays pending and
  // answerable, whereas the accepted-empty approve spent it.
  //
  // ⛔ THE CONDITION ITSELF NOW LIVES IN THE DOMAIN MODULE, and that move IS part of this
  // fix rather than a tidy-up: this route was one of FOUR paths that insert an
  // `approval_decisions` row and the only one that enforced the rule. The chat seats and
  // the Teams webhook now call the SAME function, so there is one definition of "this
  // approve strands a card" and it cannot drift into four.
  //
  // ⛔ A REASON CONSUMED AS A #1064 BROKEN-GATE OVERRIDE IS NOT AN ANSWER, AND THE
  // FALLBACK BELOW IS WHERE THOSE TWO MEANINGS WOULD MERGE. The essay at the top of
  // this file already names the mechanism, as the argument for why the answer rule has
  // no override of its own: "the override field and the compliance field would be THE
  // SAME FIELD: the answer this guard demands is `comment || reason`, so a `reason` long
  // enough to carry a #1064-style override argument already satisfies the guard".
  //
  // That sentence describes a HOLE, not just a reason to withhold a hatch. On a row that
  // is BOTH a broken gate AND an answer demand, a super-admin's ">=30 char" argument for
  // overriding the gate would satisfy this guard, be written to `approval_decisions.comment`,
  // and be forwarded to n8n as the ANSWER — releasing the card with an override rationale
  // standing in for a reply nobody wrote. Subtracting it here is what makes the essay's
  // claim true rather than merely stated.
  //
  // ⭐ SUBTRACTED FROM THE PERSISTED VALUE, NOT FROM THE GUARD'S INPUT, so the invariant
  // three paragraphs up survives intact: the value under test is still, by construction,
  // the same const the INSERT writes and `buildCallbackPayload` forwards. Testing a
  // narrowed copy while persisting the wide one would re-open the hole at the INSERT.
  //
  // Nothing is lost by the subtraction: the override argument is persisted in full on the
  // approval itself as `metadata.broken_gate_override` ({terms, by, reason, at}) below, and
  // logged. It simply stops masquerading as commentary on the work.
  //
  // ⚠️ "CHANGES NOTHING TODAY" IS THE LOOSE VERSION OF THIS CLAIM AND IT IS NOT WHAT THE
  // NUMBERS SAY. The subtraction is unconditional on ANY overridden approve, not only on the
  // ones that are also an answer demand, so it does have a scope — state it exactly.
  //
  // MEASURED 2026-09-13 against the production DB:
  //   974 pending · 174 carrying a broken gate term · 132 an answer demand · INTERSECTION 0
  //   `metadata ? 'broken_gate_override'`                          → 0 rows, EVER
  //   approved decisions on broken-gate approvals, all-time        → 288, of which
  //   carrying any comment                                         → 0
  //
  // So: no override has ever been performed (the UI had no field for one until this change),
  // and on the 174 broken-gate rows that are NOT answer demands the decision comment this
  // subtracts from has been NULL on 288 of 288 historical approves anyway. The subtraction
  // KEEPS that field NULL rather than newly filling it with an override argument — it does
  // not remove commentary anyone was writing.
  //
  // The intersection being 0 is why nothing is stranded today; it is not a claim that the
  // line is inert. It is armed ahead of the UI override control landing in this same change,
  // which is the thing that makes both the override and the intersection reachable at all.
  // ⭐ G-12 A6 (execution.question): an APPROVED question records the REGISTERED answer for its
  // stamped question_id (services/approvals/question-registry.ts), never the decider's text —
  // the U3 decide gate below refuses any free text on this row anyway, and this value is what
  // `buildCallbackPayload` forwards to n8n as the answer. Null for every other row.
  // A bare approve on a row carrying `metadata.proposed_answer` accepts it (withProposedAnswer).
  const persistedComment =
    a6RegisteredAnswerFor(approval, validated.status) ??
    withProposedAnswer({
      decision: validated.status,
      comment: validated.comment || (brokenGateOverride ? undefined : validated.reason),
      metadata: approvalMetadata,
      suppliedAction: validated.deblock_action,
      // ⛔ A chat seat's free-text approve never claims the proposal — see `opts` above.
      fromFreeText: opts?.fromFreeText === true,
    });
  // ⭐ G-12 A6 FIRST, for `execution.question` only. Its gate is the authority on what an
  // approve may carry (`answered:<stamped id>`; never free text) and the registered answer above
  // satisfies the QUESTION answer guard for every approve it admits. Run after it, the guard
  // answered an unanswerable question's approve with "approve again WITH the answer in
  // `comment`" — free text this row refuses. Every other kind keeps its existing order.
  const earlyU3ItemDecisions = approval.kind === QUESTION_KIND
    ? await assertU3DecideGates({ approval, rawBody: body, status: validated.status, deciderId: user.id })
    : undefined;
  const answerDemand = answerlessApproveDemand({
    decision: validated.status,
    comment: persistedComment,
    metadata: approvalMetadata,
    suppliedAction: validated.deblock_action,
  });
  if (answerDemand !== null) {
    // Wording, per demand kind and per broken-gate row, lives in `apiAnswerRequiredMessage`
    // above — an exhaustive switch, so a new demand kind cannot fall through to another's text.
    throw new ValidationError(apiAnswerRequiredMessage(answerDemand, brokenTerms));
  }

  // ── NO HUMAN DECIDES AT MACHINE SPEED (#901) ─────────────────────────────────────
  // MEASURED 2026-08-31: one shared super-admin account decided 184 approvals in a
  // 38s window, every one with an EMPTY comment. The span understates it — the true
  // shape is two-phase: 9 decisions paced over 34s (~3.8s apart, plausibly a human),
  // then 175 in 1.14 SECONDS, ~153 per second, ~6.5ms apart.
  //
  // Those were not arbitrary rows. The approval predicate had assessed the queue 1h42m
  // earlier: all 157 of the rows it had judged were decided in that burst, 115 of them
  // carrying `do_not_decide`. The gate said these must not be decided and they were
  // approved anyway, unread — no card can be read in 6.5ms.
  //
  // A minimum interval is the honest discriminator, because it separates the two
  // measured phases with room to spare: 3.8s apart passes with a 3.8x margin, 6.5ms
  // apart fails by 150x. It does not try to guess intent, cap a daily total, or model
  // a session; it asserts the one thing that is physically true — reading a
  // proposition and deciding it takes longer than a second.
  //
  // Refusal is per-decision and immediately retryable, so a human clearing a queue is
  // slowed, never blocked. The alternative on offer is 175 unread approvals.
  //
  // Enforced against `approval_decisions.decided_at` rather than in memory so it holds
  // across pods, restarts AND CHANNELS — an in-process limiter would reset exactly when
  // a crash loop (or a channel switch) made bursts most likely. `decisionGapMs` /
  // `isWithinBurstWindow` / `decisionRateLimitMessage` now live in
  // `lib/decision-rate-limit.ts`, shared with the three chat seats — see that file's
  // header for why a burst keyed on the decider's identity must not stay HTTP-only.
  const gapMs = await decisionGapMs(user.id);
  if (isWithinBurstWindow(gapMs)) {
    throw new ValidationError(decisionRateLimitMessage(gapMs!));
  }

  // ── U3: G-12 STRUCTURED DECISION (migration 153) ──
  // Gated rows: any row marked metadata.approval_kind='bug_fix_authorization' (generic deblock
  // or execution.ready_signoff — RULING 10-01; A1 + rejected_bug_ids[] ⊆ bug_ids, report hash
  // re-checked) and execution.feature_design_approval (A3). Above the INSERT, so a refusal
  // writes nothing. null for every other row, including qa.coverage_signoff (its decide side
  // is fr#1333's). Web-only for marked rows (no chat seat) is fr#1333's, on the same
  // predicate; this hook does not touch the chat seats. See services/approvals/u3-gates.ts.
  const u3ItemDecisions = earlyU3ItemDecisions !== undefined
    ? earlyU3ItemDecisions
    : await assertU3DecideGates({ approval, rawBody: body, status: validated.status, deciderId: user.id });

  // ── FIRST ANSWER WINS, ATOMICALLY (owner direction 2026-10-31) ─────────────────
  // Approvals multicast to every channel the tenant configured (web, Telegram, mcp, …), so
  // two seats answering at the same moment is the normal case, not an edge. The decision
  // INSERT, the quorum read and the completing UPDATE run in ONE transaction that first
  // takes the approval row FOR UPDATE — the Telegram seat's pattern. A second decider
  // waits on the lock, then finds the row no longer pending and is refused
  // `already_decided` with NOTHING written: exactly one `approval_decisions` row for a
  // 1-of-any approval. The callback and broadcast stay OUTSIDE (a slow n8n must not hold
  // the row lock). UNIQUE (approval_id, approver_id) — migration 157 — still turns a
  // double submit by this approver into a 23505, answered with the same 422.
  let finalStatus = approval.status;
  let approvalComplete = false;
  let cardMovePlan: CardMovePlan | undefined;
  let updated: typeof approvals.$inferSelect | undefined;
  try {
   await db.transaction(async (tx) => {
    const [locked] = await tx
      .select({ status: approvals.status })
      .from(approvals)
      .where(eq(approvals.id, approvalId))
      .for('update');
    if (!locked || locked.status !== 'pending') {
      throw new ValidationError('Approval is no longer pending').withCode('already_decided');
    }
    await tx.insert(approvalDecisions).values({
      approval_id: approvalId,
      approver_id: user.id,
      decision: validated.status,
      ...(u3ItemDecisions ? { item_decisions: { ...u3ItemDecisions } } : {}),
      // ⛔ THE SAME const the QUESTION guard above tested. Do not re-derive the expression
      // here: two spellings of one value is how that guard goes vacuous without a test
      // noticing.
      comment: persistedComment,
      // WHICH roster obligation this discharges (migration 108, #923). This is the
      // row `approverIdentityFilter` matched above, so it records the requirement
      // actually met — by name or by role — at the moment the roles were known.
      required_approver_id: requiredApprover.id,
      // Migration 211 (R-CK1): a triage service account decides through this route as an ordinary approver.
      decided_by_kind: decidedByKindFor(user.id),
      ...(seat.via ? { via: seat.via } : {}),
    });

  // ── RECORD THE BROKEN-GATE OVERRIDE ON THE ROW ───────────────────────────────
  // Written HERE, not only in the completion branch below, because a multi-approver
  // roster does not complete on the first decision — and an override that is recorded
  // only when the approval happens to finish is an override that is invisible on every
  // row where a second approver is still owed. The whole point of preferring this to an
  // env killswitch is attributability; that cannot be conditional on quorum.
  //
  // Merged into whatever metadata the row already carries (spread, not replace) so the
  // n8n-written keys the callback reads — `deblock_action`, the lane markers, `card_id`
  // context — survive. Scoped to `status = 'pending'` for the same reason the completion
  // update below is: never write onto a row another replica already completed.
  if (brokenGateOverride) {
    // ⚠️ SINGLE-OVERRIDE BY SHAPE, AND THAT IS ONLY SAFE WHILE ROSTERS ARE SINGLETONS.
    // `brokenGateOverride` is per-DECISION but `broken_gate_override` is one OBJECT on the
    // row, so if an approval ever needed a quorum, two super-admins overriding the same
    // broken gate would each write here and the second would CLOBBER the first — destroying
    // one of two attributed sign-offs, silently, on the exact field whose purpose is
    // attribution. The per-row `brokenTerms` would also 422 the second approver unless they
    // too were a super-admin with their own >= 30-char reason.
    //
    // MEASURED 2026-09-13 against production, which is why this is documented rather than
    // restructured into an array: of 963 pending rows, rows with more than one
    // `required_approvers` entry = 0, and max roster size = 1 — ACROSS THE WHOLE QUEUE, not
    // just the 174 broken-gate rows. The protocol's `single_point_approver` rung firing on
    // 80/80 says the same thing from the other side. So this is unreachable today.
    //
    // ⛔ WHOEVER ENABLES MULTI-APPROVER ROSTERS OWNS THIS. Make it an array keyed by
    // approver before the first row with two required approvers exists, not after.
    // Raised by the #1108 audit.
    console.warn(
      `[approvals] broken-gate override: super-admin ${user.id} approved approval ` +
        `${approvalId} despite gate_terms [${brokenGateOverride.terms.join(', ')}]. ` +
        'The gate could not have been constructed; the approval is being signed off ' +
        'anyway on a recorded reason.',
    );
  }

  // ── THE DECISION-TIME STAMPS SHARE ONE WRITE (three of them since fr#1220) ───
  // ⛔ NOT A TIDY-UP — TWO `.update()` CALLS HERE WOULD CLOBBER EACH OTHER. Both stamps
  // spread the SAME pre-insert `approvalMetadata` snapshot, so whichever ran second would
  // write a document missing the other's key. That intersection is reachable: a
  // super-admin who is also the requester, on a broken-gate approval whose roster names
  // nobody but them, sets both — and the field that would vanish is an attribution field,
  // silently, which is the failure mode both stamps exist to prevent.
  //
  // Scoped to `status = 'pending'` for the same reason the completion update below is:
  // never write onto a row another replica already completed. Written HERE rather than
  // only in the completion branch because an attribution that is recorded only when the
  // approval happens to finish is invisible on every row where a second approver is still
  // owed.
  const metadataStamps: Record<string, unknown> = {
    ...(brokenGateOverride ? { broken_gate_override: brokenGateOverride } : {}),
    ...(selfDecision ? { self_decision: selfDecision } : {}),
    // fr#1220. Distinct key, same single write — see the two-`.update()` warning above:
    // a third stamp in its own `.update()` would spread the same pre-insert snapshot and
    // clobber the other two.
    ...(soloTenantDischarge ? { solo_tenant_discharge: soloTenantDischarge } : {}),
    // P1-TEAM-b: same single write, distinct key.
    ...(tenantMemberDischarge ? { tenant_member_discharge: tenantMemberDischarge } : {}),
    // fr#1059: same single write, distinct key.
    ...(superAdminOverride ? { super_admin_discharge: superAdminOverride } : {}),
  };
  if (Object.keys(metadataStamps).length > 0) {
    await tx
      .update(approvals)
      .set({ metadata: { ...approvalMetadata, ...metadataStamps } })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')));
  }

  // ── #1059: RECORD *WHO* DISCHARGED THE ROW, NOT ONLY *WHICH* ROW ─────────────
  //
  // ⛔ THIS CHANGES NO AUTHORIZATION OUTCOME AND IS NOT ALLOWED TO. It reads two
  // values that already exist at this point and emits. It does not touch
  // `requiredApprover`, `finalStatus`, `approvalComplete`, or the quorum
  // predicate below; nothing downstream branches on it. Whether the role arm may
  // discharge a row naming a specific user is a product decision that belongs to
  // the operator (issue #1059 measures why tightening it would halt the
  // conveyor: 1,021 of 1,041 pending roster rows name a user who has never
  // decided anything, and every one of them is being notified). Until that
  // decision is taken the divergence must at least be VISIBLE — it currently is
  // not, at 519 of 519 in an 8-minute burst, without fr emitting one byte.
  //
  // Placed AFTER the insert on purpose: the burst guard (#901), the
  // already-decided check and schema validation all throw above this line, and a
  // throw is not a discharge. Everything that reaches here is persisted.
  //
  // The counter carries no identity (see lib/roster-discharge-metrics.ts on
  // cardinality); the log line beside it carries the ids, so a rate that moves
  // can still be turned into rows. Same pairing the `deblock_action` warning
  // below uses.
  const dischargeOutcome = classifyRosterDischarge(requiredApprover.user_id, user.id);
  recordRosterDischarge(dischargeOutcome);
  if (dischargeOutcome !== 'named_self') {
    console.warn(
      `[approvals] roster-discharge divergence (#1059): decision by ${user.id} on approval ` +
        `${approvalId} discharged required_approvers row ${requiredApprover.id}, which names ` +
        `${requiredApprover.user_id ?? 'NO USER'} (role=${requiredApprover.role ?? 'none'}) — ` +
        `outcome=${dischargeOutcome}. The caller is not the named user (a role-holder, or an ` +
        'override arm — see the override warning when there is one); quorum counts it as one ' +
        'slot of this row\'s role. No authorization outcome was changed by this line.',
    );
  }

  // Check if all approvers have approved.
  //
  // ⚠️ `allRequiredApprovers` IS THE READ HOISTED ABOVE, not a second one. It used to be
  // fetched here; the requester-is-decider guard needs the WHOLE roster and must run
  // before the INSERT, and two reads of one table in one handler is how two answers to
  // "who is on this roster" appear in one request. Nothing between the two points writes
  // `required_approvers`, so the value is the same one this tally always saw.
  const allDecisions = await tx.select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approvalId));

  // ⭐ fr#1059: THE shared quorum rule (services/approval-consensus.ts evaluateRosterQuorum),
  // the same one the three chat seats now call — see its header. The two branches below are
  // its two terminal outcomes; the explanation of WHY the predicate is obligation-based (not a
  // count, not "every named user") stays here because this is where it was learned.
  const quorum = evaluateRosterQuorum(allRequiredApprovers, allDecisions);
  if (quorum === 'rejected') {
    finalStatus = 'rejected';
    approvalComplete = true;
  }
  // If every roster obligation has been discharged, mark as approved.
  //
  // ⚠️ THIS USED TO BE `allDecisions.length === allRequiredApprovers.length` — a
  // COUNT compared to a COUNT, which never asked whether the people who decided
  // were the people the roster required. `approverIdentityFilter` admits a caller
  // by user_id OR by a matching role, so ONE role-authorised decision satisfied a
  // quorum of one no matter whose obligation it was.
  //
  // MEASURED: of 343 decisions by 32969c16-…, 338 were on approvals whose rostered
  // approver was a DIFFERENT uuid (e148e8af-…). Those approvals completed; the
  // named approver never decided.
  //
  // Pre-108 rows carry NULL and genuinely cannot say which obligation they met —
  // the decider's roles were never recorded. For an approval holding any such
  // decision we fall back to the old count comparison rather than invent an
  // answer, so no pending row becomes uncompletable. NULL reads as "unknown",
  // never as "unrostered".
  else if (quorum === 'approved') {
    finalStatus = 'approved';
    approvalComplete = true;
  }

  // ── WHAT THIS DECISION DOES TO THE CARD, AS A FIELD RATHER THAN AS FOLKLORE ──
  //
  // ⛔ THE GAP. `callback.outcome` answers "did the receiver accept the send?" and
  // NOTHING answered "was a card move even being asked for?". Those are different
  // questions and the difference is the whole of the INFRASTRUCTURE/DEPENDENCY
  // defect: 214 pending rows on which approve and reject produced BYTE-IDENTICAL
  // outcomes, both reporting `callback.outcome: 'sent'`, because the receiver
  // accepted a payload it then deliberately did not act on. A decider reading the
  // response could not tell that apart from a RETRY that re-drove the card.
  //
  // ⚠️ IT IS A PLAN, NOT AN OBSERVATION, AND THE FIELD NAME SAYS SO. fr does not
  // move Planka cards; `callback_delivered_at` (written only by
  // workers/deblock-callback-redelivery.ts, after it re-reads the board) is the
  // only statement that one moved. This is fr's mirror of the receiver's routing
  // table saying what the receiver is going to be asked to do.
  //
  // Left `undefined` until the approval COMPLETES: a decision that leaves a roster
  // obligation outstanding sends no callback at all, so there is no routing to
  // report and asserting one would be an answer to a question nobody asked.
  // (`cardMovePlan` is declared above the transaction.)

  // Update approval status if complete (optimistic lock to prevent double callback)
  if (approvalComplete) {
    // The override is written INSIDE the same optimistic-locked update that completes the
    // approval, so it cannot land on a row another replica already completed and callback'd.
    // `decided_action_source` is kept beside it: after the fact, "DROP" alone cannot tell you
    // whether a classifier proposed it or a human overrode it, and those are different claims.
    //
    // ⚠️ `broken_gate_override` is re-applied here, not merely relied upon from the write
    // above. `approval.metadata` is the SNAPSHOT read at the top of this handler, so
    // spreading it would silently revert the override write on any decision that also
    // carries a `deblock_action`. Re-applying the same value is idempotent; dropping it
    // would erase the only record of who signed off on a broken gate.
    //
    // Same argument for the sibling stamp `self_decision`: this object REPLACES
    // `approvals.metadata`, and it is built from the PRE-insert snapshot, so a
    // `self_decision` written a few lines earlier would be reverted by any decision
    // that also carries a `deblock_action` (or a RECLASSIFY `new_card_type`). Re-applying
    // the same value is idempotent; dropping it would erase the only record of why a
    // requester was allowed to decide their own approval.
    const metadataForCallback = buildDecisionMetadata({
      snapshot: (approval.metadata as Record<string, unknown> | null) ?? {},
      suppliedAction: validated.deblock_action,
      newCardType: validated.new_card_type,
      proposedAction,
      overriddenAction,
      deciderId: user.id,
      brokenGateOverride,
      selfDecision,
      coverageDecision,
    });
    // ── COUNT WHAT THE CALLBACK IS ABOUT TO DROP ─────────────────────────────────
    // The mint now refuses a BLOCKED-exit approval with no usable action, but the rows
    // minted BEFORE that refusal existed are still in the queue and still get answered.
    // When one completes, `buildCallbackPayload` will narrow its absent/unrecognised
    // action to `undefined`, omit the field, and the card will not move — exactly as
    // before, except now it is a number on /api/metrics/prom instead of nothing at all.
    // ⭐ THE ACTION THE CALLBACK WILL ACTUALLY CARRY. Hoisted out of the
    // `deblockExit.required` block below because the decide RESPONSE needs it too,
    // and because re-deriving the same expression in two places is how the two
    // readers of one row end up disagreeing about what the row says — the exact
    // failure `classifyDeblockExit` vs `buildCallbackPayload` produced in #1008.
    // Same expression as `metadataForCallback` above writes and as
    // `buildCallbackPayload` narrows.
    const effectiveAction = validated.deblock_action ?? deblockExit.action;
    // ⛔ `persistedComment`, NOT `validated.comment`. It is the exact value the
    // `approval_decisions` INSERT wrote and `buildCallbackPayload` forwards as the
    // answer text, so fr's prediction and the receiver's `questionAnswered` test
    // read the SAME string. Re-deriving it here is how this goes vacuous.
    cardMovePlan = plannedCardMove({
      decision: finalStatus,
      action: effectiveAction,
      answerText: persistedComment,
      cardType: approvalMetadata.card_type,
      // The STORED verdict (`metadata.coverage_decision`), the value the receiver reads.
      coverageRejectedCount: coverageDecision ? coverageDecision.rejected_criterion_ids.length : null,
    });
    if (deblockExit.required) {
      const finalAction = effectiveAction;
      recordDeblockAction('decide', finalAction, { rawWasPresent: deblockExit.rawWasPresent });
      if (!finalAction) {
        console.warn(
          `[approvals] approval ${approvalId} (card ${approval.card_id ?? 'unknown'}) completed ` +
            `as ${finalStatus} with no usable deblock_action — the n8n callback will drop the ` +
            'field and the card will stay in BLOCKED. A decider can supply one on the PUT.',
        );
      }
    }

    // Under the FOR UPDATE lock the row is still pending; the status guard stays as the
    // optimistic lock it always was (workers/approval-expiry.ts writes without this lock).
    [updated] = await tx.update(approvals)
      .set({
        status: finalStatus,
        completed_at: new Date(),
        ...(metadataForCallback ? { metadata: metadataForCallback } : {}),
      })
      .where(and(eq(approvals.id, approvalId), eq(approvals.status, 'pending')))
      .returning();
  }
   });
  } catch (err) {
    if (pgErrorCode(err) === '23505') {
      throw new ValidationError('You have already made a decision on this approval').withCode('already_decided');
    }
    throw err;
  }

  // What the response will say about the n8n callback. Defaults to the honest
  // "no callback was owed" — an approval that has not completed does not call
  // back, and reporting `sent`-shaped silence there would be its own small lie.
  let callbackReport: DecisionCallbackReport = {
    outcome: 'not-attempted',
    reason:
      'this decision did not complete the approval (a roster obligation is still ' +
      'outstanding), so no n8n callback was owed',
  };

  if (approvalComplete) {
    if (updated) {
      // ── BROADCAST FIRST, THEN WAIT ON n8n ──────────────────────────────────
      // The websocket fan-out and the deferred-action bus are LOCAL effects with
      // no dependency on the receiver, and they used to run before the (then
      // un-awaited) callback. Now that the callback is awaited they are hoisted
      // above it so a slow n8n cannot delay the board update by up to the
      // request deadline. Same two calls, same arguments; only the order moved.
      wsManager.broadcastDecision(
        { ...approval, status: finalStatus },
        // ⛔ `persistedComment`, NOT a re-derivation. These three surfaces — the DB row,
        // this websocket broadcast and the HTTP echo below — agreed by CONSTRUCTION until
        // the broken-gate subtraction landed, and re-deriving `comment || reason` here would
        // have silently broadcast an override RATIONALE as the decision's comment to every
        // TOPIC_ALL subscriber while the stored row and the n8n callback carried nothing.
        // Three readers, two answers, no error: exactly the drift the subtraction exists to
        // end. Caught by the #1108 audit.
        { status: finalStatus, decided_by: user.id, comment: persistedComment },
      );

      // E-5: if this approval row is bound to a deferred action, run/notify
      // through the action-approval bus. Fire-and-forget — the HTTP response
      // does not wait for the deferred handler.
      if (updated.action_id) {
        resolvePendingAction(updated.action_id, { approverId: user.id }).catch(err =>
          console.error('[approvals] resolvePendingAction error:', err));
      }

      // ⛔ THE RESULT IS NOW PERSISTED, NOT ONLY LOGGED.
      //
      // This call is what moves the Planka card BLOCKED -> DOING. It used to be
      // `sendN8nCallback(id).catch(err => console.error(...))`: a failure was
      // written NOWHERE, and because the promise is un-awaited, a pod that rolled
      // between the UPDATE above committing and the POST landing dropped the
      // callback with no record that it had ever been owed. Measured on prod
      // 2026-09-04: 320 cards in BLOCKED behind 488 already-decided approvals.
      //
      // ⚠️ CORRECTED BY MIGRATION 113 — this used to say `deliverDecisionCallback`
      // "stamps `approvals.callback_delivered_at` after a real 2xx", and that was
      // both true and the defect: a 2xx is n8n ACCEPTING the callback, not the
      // Planka card leaving BLOCKED, and the stamp retired the row from the
      // re-delivery worker's population either way. MEASURED 2026-09-06: 373 of
      // 373 rows stamped in 30h were still BLOCKED. It now stamps
      // `callback_acked_at`; `callback_delivered_at` means the card moved and is
      // written only by workers/deblock-callback-redelivery.ts, after it re-reads
      // the card from Planka.
      //
      // ⚠️ NO LONGER FIRE-AND-FORGET, AND THE OLD REASON FOR THAT IS PRESERVED,
      // NOT DISCARDED. The previous revision said "making the decider's request
      // hang on a receiver that has been observed returning 504 would turn a
      // stranded card into a failed decision" — true, and `reportDecisionCallback`
      // honours it on BOTH halves: the wait is bounded by
      // `decisionCallbackTimeoutMs()`, and the outcome is REPORTED in the 200
      // body rather than converted into an error. A failed callback never fails
      // the decision. See the essay at `reportDecisionCallback`.
      callbackReport = await reportDecisionCallback(approvalId);

      // ── A DECIDED PROJECT OUTLINE HANDS OFF TO ITS REQUEST (migration 123) ──
      // The outline decision deliberately reuses this whole path — optimistic
      // lock, approval_decisions, WS broadcast — instead of a second decision
      // mechanism. This is the one extra step: an approved outline promotes the
      // request into a project; a rejected one sends it back to await a new
      // outline. onOutlineDecided NEVER throws — a failed promotion is recorded
      // on the request (status=failed) and must not turn a human's decision into
      // an error response. A no-op for every other approval kind.
      if (updated.kind === 'project_outline.approval' && updated.project_request_id) {
        await onOutlineDecided({
          approval: {
            id: updated.id,
            kind: updated.kind,
            project_request_id: updated.project_request_id,
            status: finalStatus,
          },
          decidedBy: user,
          comment: persistedComment ?? undefined,
        });
      }

      // ── G8 / R313: A DECIDED TENANT PROMOTION (asset.promotion only) ──
      // Approved ⇒ fr calls RM `POST /{kind}/{copy_id}/promote` as the approver; rejected ⇒
      // nothing upstream (the copy stays project-scoped). Never throws: the outcome is
      // stamped on `metadata.promotion` (services/approvals/asset-promotion.ts).
      if (updated.kind === ASSET_PROMOTION_KIND) {
        await onAssetPromotionDecided({
          approval: { id: updated.id, tenant_id: updated.tenant_id, kind: updated.kind, metadata: (updated.metadata ?? null) as Record<string, unknown> | null },
          status: finalStatus,
          decidedBy: user.id,
        });
      }

      // ── U3 R5: ONE ac_coverage ROW PER AC (qa.coverage_signoff only) ──
      // Reads `metadata.coverage_decision` (written by fr#1333 in this completing UPDATE);
      // absent ⇒ writes nothing. Never throws, so it cannot fail the decision.
      if (updated.kind === COVERAGE_SIGNOFF_KIND) {
        // The trace is fr#1333's decided_trace_id, never this request's header (see the
        // writeback module); a missing one is retried by workers/ac-coverage-redelivery.ts.
        await deliverAcCoverageForApproval(updated.id);
      }

      // ── George 2026-10-29: A DECIDED CARD SIGN-OFF RESOLVES ITS PENDING REPORTS ──
      // ask_kind 'signoff' with a card_id only (a question or a plain request resolves nothing).
      // The card's still-pending conveyor report.json artifacts get the same decision as the same
      // actor (approved → approve, rejected → revise ⇒ needs_revision). Detached and never throws,
      // so it cannot fail or delay the decision; every failure is logged
      // (services/approvals/signoff-resolves-reports.ts). The chat seats call the same helper.
      afterSignoffDecided(updated, finalStatus, user.id);
    } else {
      // ── THE LOST OPTIMISTIC LOCK IS NOT A NO-OP, AND IT IS NOT "APPROVED" ────
      //
      // ⛔ THIS LINE USED TO READ: "If !updated, another concurrent request
      // already completed this approval" — and then fell through to a 200
      // carrying `status: finalStatus`. Both halves were wrong.
      //
      // WRONG ABOUT THE CAUSE. The dominant writer of that zero-row UPDATE is not
      // a concurrent decider; it is workers/approval-expiry.ts, whose 15-minute
      // tick runs `UPDATE approvals SET status='expired' WHERE status='pending'
      // AND expires_at <= now()`. This handler reads the row at the top, spends
      // several queries and a rate-limit check, then completes with
      // `WHERE id=… AND status='pending'`. An expiry landing in that window
      // matches zero rows.
      //
      // WRONG ABOUT THE CONSEQUENCE, and this is the part that actually hurt. The
      // whole `if (updated)` block — the n8n callback AND the websocket broadcast
      // — is skipped, and the response then announced `status: "approved"` with
      // HTTP 200. The DB said `expired`, the card never left BLOCKED, nothing was
      // logged, and the decider (a Claude agent, in the AA conveyor) recorded a
      // success and moved on. There was no observable difference between this and
      // a decision that worked.
      //
      // So: RE-READ and answer with what is actually there. 409, never 200 — the
      // caller's state assumption is stale, which is precisely what 409 means.
      // Each cause gets its OWN `code`, because "expired by the reaper" and
      // "decided by someone else" call for different next actions (re-raise the
      // approval upstream vs. do nothing, the answer already exists).
      //
      // ⚠️ THE `approval_decisions` ROW STAYS. It was inserted above and is NOT
      // rolled back, deliberately: it is the only durable evidence that this
      // decider answered this proposition, and nothing in this codebase ever
      // returns an approval to `pending` (verified: no writer sets
      // `status: 'pending'` on `approvals`), so a late decision can never later
      // satisfy quorum on a re-opened row. `details.decision_recorded` says so
      // out loud, because a caller that reads "409" and assumes "nothing was
      // written" would then retry — and get a 422 from the `existingDecision`
      // guard, which is a confusing second lie.
      const [current] = await db
        .select()
        .from(approvals)
        .where(eq(approvals.id, approvalId));

      const found = current?.status ?? null;
      const detail = { approval_id: approvalId, status: found, decision_recorded: true };

      if (!current) {
        throw new AppError(
          409,
          // ⚠️ WORDED LIKE ITS THREE SIBLINGS, DELIBERATELY. This arm used to open with
          // "Your decision was not applied", which is true about the COMPLETION and false
          // about the RECORD — and it was the one arm of the four that never said the
          // decision had been recorded at all, while `details.decision_recorded` said
          // `true` right beside it. A caller reading a 409 whose prose says "not applied"
          // and whose detail says "recorded" has been handed both answers and no way to
          // pick. Every arm now states the same two facts in the same order: the decision
          // IS recorded, the approval was NOT completed.
          'This approval row DISAPPEARED between your decision being recorded and the ' +
            'completing update. Your decision was recorded but the approval was NOT ' +
            'completed, no callback was sent, and the approval no longer exists.',
          detail,
        ).withCode('approval_vanished');
      }
      if (found === 'expired') {
        throw new AppError(
          409,
          'This approval EXPIRED between the moment it was read and the moment your ' +
            'decision was applied (workers/approval-expiry.ts runs every 15 minutes and ' +
            'expires any pending row past `expires_at`). Your decision was recorded but ' +
            'the approval was NOT completed, no callback was sent, and the card has not ' +
            'moved. The approval must be re-raised upstream before it can be decided.',
          detail,
        ).withCode('approval_expired');
      }
      if (found === 'voided') {
        throw new AppError(
          409,
          'This approval was VOIDED (withdrawn as unanswerable) between the moment it was ' +
            'read and the moment your decision was applied. Your decision was recorded but ' +
            'the approval was NOT completed and no callback was sent.',
          detail,
        ).withCode('approval_voided');
      }
      if (found === 'approved' || found === 'rejected') {
        throw new AppError(
          409,
          `This approval was already completed as '${found}' by a concurrent request. Your ` +
            'decision was recorded but did not complete the approval, and this request sent ' +
            'no callback — the request that won the race did.',
          detail,
        ).withCode('already_decided');
      }
      // ⛔ NO GUESS. `pending` here means the UPDATE matched nothing while the row
      // still reads pending, which nothing in the current code can produce; any
      // other value is a status this handler has never seen. Either way the
      // honest answer is to name what was found rather than to pick the closest
      // familiar cause — mislabelling is what this whole branch exists to undo.
      throw new AppError(
        409,
        `This approval could not be completed: the optimistic update matched no row, and ` +
          `re-reading it found status '${found}' rather than a completed state. Your ` +
          'decision was recorded but the approval was NOT completed and no callback was ' +
          'sent. fr will not guess at the cause.',
        detail,
      ).withCode('approval_lock_lost');
    }
  }

  // ── 200 vs 202 — THE STATUS LINE STOPS LYING BY OMISSION ────────────────────────
  //
  // ⛔ THE DEFECT. This handler answered HTTP **200 for every completing decision** —
  // `sent`, `pending`, `timeout-unknown`, `failed` and all three `skipped-*` alike. The
  // frontend was fine: `frontend/src/lib/approvals/decision-callback.ts` reads
  // `callback.outcome` and maps it to a tone. Every OTHER caller was not, and they are
  // the majority of the traffic on this route — the AA conveyor, the approval scripts,
  // `curl` — and they branch on the status code, because that is what a status code is
  // for. To all of them "the decision reached n8n" and "fr has no idea what happened
  // downstream" were the same two hundred.
  //
  // ⭐ 202, NOT A 4xx/5xx, AND THE DISTINCTION IS LOAD-BEARING. The decision genuinely
  // WAS recorded: the `approval_decisions` row and the completing UPDATE both committed
  // before the callback was even attempted, and they are deliberately not rolled back.
  // Turning that into an error status would tell the caller to retry a decision that is
  // spent — and a retry gets a 422 from the `existingDecision` guard, which is a second,
  // more confusing lie. 202 Accepted is the honest reading: recorded, in flight,
  // reconciliation owed. `response.ok` is true for it, so no existing 2xx consumer
  // changes behaviour (checked: `frontend/src/lib/api/auth-fetch.ts` and
  // `unified-client.ts` both branch on `.ok`, never on `=== 200`).
  //
  // ⚠️ THE PREDICATE IS "fr KNOWS", NOT "THE CARD MOVED". `decisionOutcomeIsSettled`
  // treats `sent` and `skipped-no-callback-path` as settled and NOTHING else — see its
  // comment for why the other two `skipped-*` are deliberately excluded. `not-attempted`
  // is unsettled too: a roster obligation is outstanding, so this decision finished
  // nothing.
  const settled = decisionOutcomeIsSettled(callbackReport.outcome);
  return jsonResponse(
    {
      id: approvalId,
      status: finalStatus,
      approver: {
        id: user.id,
        name: user.name,
      },
      decision_at: new Date().toISOString(),
      // Same const the DB row, the callback payload and the websocket broadcast carry — see
      // the note at the broadcast. A caller reading this echo must see what was persisted.
      comment: persistedComment,
      approval_complete: approvalComplete,
      // ⛔ WHAT ACTUALLY HAPPENED DOWNSTREAM, ALWAYS PRESENT. A caller may branch on
      // `callback.outcome`; `sent` is the ONLY value that means n8n accepted the
      // decision. `pending` means fr does not know yet. `not-attempted` means this
      // decision did not complete the approval (a roster obligation is still owed),
      // so no callback was owed either.
      //
      // ⭐ `settled` is the SAME predicate as the status code above, carried in the body
      // so a caller need not re-enumerate the eight outcome strings to re-derive it —
      // and so the two can never disagree, because there is one expression.
      // ⚠️ NOT named `delivered`: a delivered callback is a card that left BLOCKED, and
      // only the re-delivery worker can say that.
      callback: { ...callbackReport, settled },
      // ⛔ PRESENT ONLY WHEN THE APPROVAL COMPLETED. See `cardMovePlan` above: this is
      // fr's mirror of the receiver's routing table — what the receiver is being ASKED
      // to do with the card — and is the field that finally distinguishes an approved
      // INFRASTRUCTURE row (now a re-drive to TODO) from a rejected one (held).
      ...(cardMovePlan ? { card_move: cardMovePlan } : {}),
    },
    settled ? 200 : 202,
  );
}

// ── `handleTriageApproval` WAS HERE. REMOVED 2026-09-23 (B3 reverted) ───────────────
//
// It implemented `PATCH /api/approvals/:approvalId/triage` and NO ROUTE EVER REACHED IT.
// Verified before removing, with a positive control so the absence could not be a
// mis-read file: `server.ts` contained ZERO occurrences of `handleTriageApproval` and
// ZERO of `/triage`, while the same grep found 36 `approvals` hits and three registered
// approval routes (`GET /api/approvals`, `GET /api/approvals/:approvalId`,
// `GET /api/projects/:projectId/approvals`). Its only callers on disk were its own
// integration tests, which invoked it as a plain function — so the suite proved the
// handler's behaviour while never touching the question of whether anything could call it.
//
// ⭐ DELETING IT REMOVED THE LAST READER OF THE FOUR `triage_*` COLUMNS AND ONE OF THE
// THREE WRITERS IN ONE STROKE — and the "reader" was itself circular: it read the columns
// back out of its own `.returning()` clause, i.e. out of the row it had just written, in
// the same statement. No code anywhere loaded those columns from a row it had not written.
//
// ⚠️ WHAT WAS GENUINELY GOOD HERE, recorded so it is not re-derived from scratch if a real
// triage seam is ever built:
//   * TRIAGE MUST NOT DECIDE. `status` was deliberately absent from the `.set()`. A
//     handler that could annotate AND flip status would be an approval path bypassing the
//     required-approver roster, the per-approver decision rows and the quorum rule in
//     `handleUpdateApproval` — an authorization bypass wearing the clothes of an
//     annotation. Deciding stays with `PUT /api/approvals/:approvalId`.
//   * AUTHORIZATION WAS THE ROSTER, NOT A ROLE CLAIM. It reused the same
//     `approverIdentityFilter` predicate `handleUpdateApproval` uses, because `requireRole`
//     was deleted from middleware/auth.ts on 2026-08-29 for matching no real grant, and
//     `scripts/check-admin-claim-only.ts` fails CI if a claim-only check reappears.
//   * THE KNOWN LIMITATION IT STATED IS WHY IT COULD NEVER HAVE WORKED AS INTENDED: an
//     unattended triage WORKER is on no roster, so the one caller the seam existed for was
//     the one caller this authorization model could not admit.
//
// ⛔ Do not restore this handler to "un-strand" the columns. The columns are being retired
// (migration 130); a route that writes them would re-arm the thing being removed.

/**
 * GET /api/approvals/:approvalId
 * Get approval details
 */
export async function handleGetApproval(
  req: Request,
  approvalId: string
): Promise<Response> {
  const user = await validateAuth(req);

  // Tenant-scoped load + reachability (own the project OR requester OR roster;
  // null-project rows are tenant-visible). Shared with the document-bytes
  // endpoint so a file never leaks more broadly than its approval.
  const approval = await loadReachableApproval(user, approvalId);

  // Get required approvers and decisions
  const required = await db.select()
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, approvalId));

  const decisions = await db.select()
    .from(approvalDecisions)
    .where(eq(approvalDecisions.approval_id, approvalId));

  // Same roster hydration as the two list lanes, so the detail page and the
  // queue chip name the same people instead of one showing a UUID.
  const { identities, truncated: identitiesTruncated } = await resolveApproverIdentities(
    identityRowsFor(required, decisions, [approval.requester_id, voiderId(approval.voided_by)]),
  );
  // Template first (pure), then the PUT's own eligibility (DB) only when there is one to
  // serve — so the GET pays no roster query on any row that is not a marked A1 sign-off.
  // `callerMayDecideApproval` carries the pending term; there is deliberately no second copy.
  const a1Template = webA1DecideTemplate(approval);
  const g12Decide =
    a1Template && (await callerMayDecideApproval(user, approval)) ? a1Template : null;
  // A3 (execution.feature_design_approval): same rule — served only to a caller who could
  // decide it now (callerMayDecideApproval also withholds it from a service account; the PUT
  // itself admits any decider).
  const a3Template = webA3DecideTemplate(approval);
  const g12DecideA3 =
    a3Template && (await callerMayDecideApproval(user, approval)) ? a3Template : null;

  return jsonResponse({
    ...toApprovalResponse(approval),
    ...requesterIdentity(approval.requester_id, identities),
    ...voiderIdentity(approval.voided_by, identities),
    required_approvers: required.map(r => toRosterEntry(r, decisions, identities)),
    decisions: decisions.map((d) => toDecisionEntry(d, identities)),
    approver_identities_truncated: identitiesTruncated,
    // A1 only (marked execution.ready_signoff, still pending, AND this caller could decide
    // it — callerMayDecideApproval): the G-12 fields the web decide body must stamp, so the per-bug reject picker never re-spells a rule_version
    // or a reason code. Absent on every other row — their response is unchanged.
    ...(g12Decide ? { g12_decide: g12Decide } : {}),
    // A3 only (pending, sealed, decidable by this caller): the G-12 fields the A3 review
    // form must stamp. Absent on every other row.
    ...(g12DecideA3 ? { g12_decide_a3: g12DecideA3 } : {}),
  });
}

/**
 * GET /api/approvals/:approvalId/document
 *
 * Stream the pending document for a KAG document-upload approval, so an
 * approver can preview what they're about to ingest. The bytes are parked
 * inline (base64) in `action_input_json.file_b64` at request time — this
 * endpoint decodes them; no object store is involved.
 *
 * Authz is IDENTICAL to handleGetApproval (via loadReachableApproval): the
 * file is never readable by anyone who can't already read the approval row.
 * 404 (not 400) for a non-document approval or a doc approval missing bytes,
 * so the endpoint never discloses which approvals exist but aren't documents.
 */
export async function handleGetApprovalDocument(
  req: Request,
  approvalId: string
): Promise<Response> {
  const user = await validateAuth(req);
  const approval = await loadReachableApproval(user, approvalId);

  const info = approvalDocumentInfo(approval);
  if (!info) {
    throw new NotFoundError('No document for this approval');
  }

  const bytes = Buffer.from(info.file_b64, 'base64');
  // RFC 6266: keep the filename ASCII-safe in the header; the UI already knows
  // the real filename from the `document` descriptor. `inline` lets the browser
  // render (PDF/image) rather than force-download.
  const safeName = info.filename.replace(/[^\x20-\x7E]/g, '_').replace(/["\\]/g, '_');
  return new Response(bytes, {
    status: 200,
    headers: {
      'Content-Type': info.content_type,
      'Content-Length': String(bytes.length),
      'Content-Disposition': `inline; filename="${safeName}"`,
      // Never let a browser MIME-sniff a parked document into something
      // executable, and keep it out of any shared cache.
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    },
  });
}

/**
 * GET /api/approvals[?mine=1]
 *
 * Top-level approvals listing — used by the home-page PendingApprovalsCell
 * (frontend polls every 30s; see plan-3-followups.md Task 14, spec
 * continuous-improvement-design.md §11).
 *
 * - With `?mine=1`: returns pending approvals where the current user is a
 *   required approver, OR where their `required_approver_role` matches one
 *   of the user's roles within their own tenant. This is the "my queue"
 *   view.
 * - Without `mine`: returns pending approvals where the user is the
 *   requester OR a required approver (self-scoped within their tenant).
 * - P1-TEAM-b (George 2026-10-15): BOTH also include, for a verified CURRENT member
 *   of the active tenant, every row that member may decide through the 1-of-any arm
 *   (`tenantMemberDecidableLane`; `scope_lanes` then carries `tenant_member`).
 *
 * Tenant isolation: every query against `required_approvers` and
 * `approvals` is filtered on `tenant_id = ctxTenantId(user.tenantId)`. Role strings
 * (e.g. 'tech_lead') are tenant-shared labels — without the tenant
 * predicate a tech_lead in tenant A would match required-approver rows
 * authored in tenant B. Migration 042 added tenant_id NOT NULL to both
 * tables for exactly this reason. fr row 14d: there is no exception — the
 * super-admin home-view lane that dropped the outer predicate is gone.
 *
 * Response envelope: `{ data, items, total, scope, scope_tenant_id, scope_lanes,
 * limit, offset }`. `data`/`items`/`total` keep their keys for the dashboard cells
 * and the home cell's `body.items?.length` consumer; only `total`'s VALUE changes,
 * from the page length to the population size.
 *
 * ⛔ FIVE DEFECTS FIXED HERE, AND FOUR OF THEM WERE INVISIBLE BECAUSE THE CODE WAS
 * SELF-CONSISTENT:
 *  1. `status` was the hardcoded literal `'pending'` and `?status=` was READ BY
 *     NOBODY. Now `parseApprovalStatusFilter`. ⚠️ ABSENT `?status=`
 *     STILL MEANS `pending` — see the note at `statusFilter` below; that is a
 *     deliberate divergence from "just use the parser".
 *  2. It was UNPAGED. Now `parseApprovalsPaging`, with an UNBOUNDED default: every
 *     current caller omits `?limit=`, so paging by default would silently truncate
 *     the home dashboard and the nav badge.
 *  3. `total` was `pending.length` — the page, not the population. Now `count(*)`
 *     over the SAME where clause.
 *  4. The super-admin branch DROPS `approvals.tenant_id`, so rows from other
 *     tenants arrived UNLABELLED: the dashboard rendered another workspace's
 *     approvals indistinguishably from its own. The relaxation is KEPT — it is the
 *     read the decide lane already grants — but the response now stamps
 *     `scope: 'all'` and every row carries its own `tenant_id`.
 *  5. It carried no `scope` at all, so a client could not tell which of these
 *     populations `total` counted.
 */
const UUID_RE_LIST = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function handleListMyApprovals(req: Request): Promise<Response> {
  let user;
  try {
    user = await validateAuth(req);
  } catch (e) {
    return authErrorToResponse(e);
  }
  const url = new URL(req.url);
  const mine = url.searchParams.get('mine') === '1';
  const { limit, offset } = parseApprovalsPaging(url);
  // ⚠️ ABSENT `?status=` KEEPS MEANING `pending`, AND THAT IS A DELIBERATE
  // DIVERGENCE FROM A LITERAL "use parseApprovalStatusFilter" — the parser returns
  // `undefined` for an absent value, which would mean NO status filter at all.
  // Defaulting to unfiltered here would be a silent behaviour change in the
  // dangerous direction: `navCounts` badges this endpoint's count and
  // `PendingApprovalsCard` renders its rows, so every approved and rejected row in
  // the tenant's history would land in a card labelled "pending" and inflate the
  // badge. The DEFECT was that
  // `?status=approved` was silently IGNORED; the fix is to honour it when supplied,
  // not to change what silence means.
  const statusFilter = parseApprovalStatusFilter(url.searchParams.get('status')) ?? 'pending';

  // Required-approver rows that match this user (by user_id OR by a role
  // they hold), scoped strictly to this tenant. One JOIN-less query
  // against required_approvers gives us every approval row the user is
  // eligible to act on inside their tenant.
  const identityMatch = approverIdentityFilter(user);
  const matcher = and(
    eq(requiredApprovers.tenant_id, ctxTenantId(user.tenantId)),
    identityMatch,
  );

  // fr row 14d: tenant-pinned for every caller, a super-admin included.
  const tenantScope = eq(approvals.tenant_id, ctxTenantId(user.tenantId));

  const requiredRows = await db.select({ approval_id: requiredApprovers.approval_id })
    .from(requiredApprovers)
    .where(matcher);
  const eligibleApprovalIds = Array.from(
    new Set(requiredRows.map(r => r.approval_id)),
  );

  // For mine=1, ONLY include approvals the user is eligible to action.
  // For the no-mine case (self-scoped view), also include approvals the
  // user requested. Tenant filter on the outer query is defense in depth
  // against bad inserts that could have escaped the writer-side check.
  //
  // ⛔ THE LANES ARE NAMED, NOT DESCRIBED. `scopeLanes` below is derived from the
  // SAME branch that builds `idCondition`, so the two cannot drift.
  //
  // ── P1-TEAM-b (George 2026-10-15): A CURRENT MEMBER'S QUEUE IS TENANT-WIDE ─────────
  // Every member is told about every approval of their tenant and any one member may
  // decide it (1-of-any), so "my queue" must hold every pending row the caller is
  // ENTITLED to decide, not only the rows that name them. The member lane is applied
  // only after `readListLaneMembership` verified the caller as a CURRENT member of the
  // active tenant (`user_roles`, else Keycloak). The outer `tenantScope` stays the tenant
  // fence. The requester exemption mirrors the decide path: the solo tenant's god may
  // decide their own human-raised rows; nobody else may.
  //
  // ⏱️ TTL-CACHED per (tenant, user), NEVER THROWS (P1-TEAM-b audit 3): this endpoint is
  // the sidebar badge's poll, so it must not pay a Keycloak round trip per poll, nor 500
  // on an outage — a failed read degrades to the rostered lanes (no Keycloak needed).
  // ⛔ This verdict only chooses which rows are SHOWN. The decide path does NOT use it:
  // it re-reads membership uncached and fail closed (`isTenantMemberForDecision`,
  // `soloTenantMemberIsTenantGod`), so a stale "is member" never lets an ex-member decide.
  // Rationale in full: `services/tenant-member-recipients.ts`, "LIST PATH ONLY".
  const activeTenantId = ctxTenantId(user.tenantId);
  const listMembership = await readListLaneMembership(activeTenantId, user.id);
  const memberLane = listMembership.isMember
    ? tenantMemberDecidableLane(user, activeTenantId, {
        requesterMayDecide: listMembership.requesterMayDecide,
      })
    : undefined;
  const scopeLanes: ApprovalLane[] = [
    APPROVAL_LANE.ROSTERED,
    ...(mine ? [] : [APPROVAL_LANE.REQUESTED_BY_ME]),
    ...(memberLane ? [APPROVAL_LANE.TENANT_MEMBER] : []),
  ];
  // `?mine=1` with an empty roster is a real empty population, not a missing
  // filter: `inArray` on `[]` renders `false`, so this is the honest predicate and
  // it flows through the SAME count/page path as every other case. The old code
  // early-returned `{items:[],total:0}` here, which is how it shipped an envelope
  // with no `scope` and no `limit` on one branch and (later) different keys on the
  // others — a per-branch envelope is how a contract rots.
  const idCondition = or(
    inArray(approvals.id, eligibleApprovalIds),
    mine ? undefined : eq(approvals.requester_id, user.id),
    memberLane,
  );

  // `?project_id=` narrows to one project's approvals (UI review 2026-10-07:
  // the Approvals page had no project filter). Absent ⇒ unfiltered, as before.
  // A malformed id is a caller error, not "no rows".
  const projectIdParam = url.searchParams.get('project_id');
  if (projectIdParam !== null && !UUID_RE_LIST.test(projectIdParam)) {
    return jsonResponse(
      { error: 'invalid project_id', code: 'invalid_project_id' },
      400,
    );
  }
  const where = and(
    tenantScope,
    eq(approvals.status, statusFilter),
    idCondition,
    projectIdParam ? eq(approvals.project_id, projectIdParam) : undefined,
  );
  const pageQuery = db.select()
    .from(approvals)
    .where(where)
    .orderBy(approvals.created_at)
    .$dynamic();
  const [pending, totalRows] = await Promise.all([
    // Unbounded unless `?limit=` was supplied — see the paging note in the docblock.
    limit === undefined
      ? (offset > 0 ? pageQuery.offset(offset) : pageQuery)
      : pageQuery.limit(limit).offset(offset),
    // `count(*)` over the SAME `where` object, never `pending.length`.
    db.select({ n: count() }).from(approvals).where(where),
  ]);
  const total = totalRows[0]?.n ?? 0;

  // `data` mirrors `items` for the home-page dashboard cards which read
  // `body?.data ?? body ?? []` (PendingApprovalsCard, navCounts). `items`
  // + `total` stays for the existing per-project consumers — additive.
  const clientPending = pending.map(clientSafeApprovalRow);
  return jsonResponse({
    data: clientPending,
    items: clientPending,
    total,
    // Every row is the active tenant's (fr row 14d), so `scope` is never `'all'`
    // and `scope_tenant_id` is never null. The per-row `tenant_id` still rides
    // along (`SELECT *`).
    scope: describeScope({ rosteredOnly: mine }),
    scope_tenant_id: ctxTenantId(user.tenantId),
    scope_lanes: scopeLanes,
    status: statusFilter,
    limit: limit ?? null,
    offset,
  });
}
