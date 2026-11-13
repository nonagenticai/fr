// src/lib/approvals/decision-callback.ts
//
// ── WHAT THE DECISION RESPONSE SAYS HAPPENED DOWNSTREAM, TURNED INTO UI COPY ──
//
// ⛔ THE DEFECT THIS EXISTS FOR. `PUT /api/approvals/:id` returns 200 with
// `callback: { outcome, reason? }` precisely so a caller can tell "the decision
// was recorded" from "the decision was recorded AND the card actually moved"
// (backend/src/routes/approvals.ts, `reportDecisionCallback` + the response body
// at the end of `handleUpdateApproval`). Every decision surface in this frontend
// ignored that field and printed an unconditional green `toast.success('Decision
// recorded.')`. So the operator whose decision was recorded but whose callback
// FAILED — card never leaves BLOCKED, row stays blocked, decision spent and not
// retakeable — was shown a success. That is the same "reported a success it had
// not verified" shape the backend fix was written to end, reproduced one layer up.
//
// ⭐ THE MAPPING IS TO A *TONE*, NOT A SUFFIX. Appending the outcome code to a
// success toast would still be a success toast. Only `sent` is green; everything
// else says, in the same breath, that the decision IS recorded (so DO NOT decide
// again — the row is decided-once per approver and a second attempt 422s) and
// that the card did or did not move, and why.
//
// The union below MIRRORS `DecisionCallbackReportOutcome` in
// backend/src/routes/approvals.ts. It is redeclared rather than imported: the
// frontend does not import from `backend/`, and a wire contract read off an
// untyped JSON body has to be narrowed at runtime anyway (see `readDecisionCallback`).

/**
 * Every value `callback.outcome` can carry, verbatim from the server union.
 *
 * `sent` is the ONLY value that means n8n accepted the decision.
 * `pending` means fr did not learn the outcome inside its deadline.
 * `not-attempted` means this decision did not complete the approval, so no
 * callback was owed.
 *
 * ⛔ `timeout-unknown` IS NOT A FAILURE, AND MUST NEVER BE RENDERED AS ONE. fr
 * stopped waiting before n8n answered: the request may well have been received
 * and the work completed. `callback_acked_at` stays NULL, so the redelivery
 * worker still reconciles the row. Reporting this as "the callback FAILED" — what
 * a timeout used to land on, via the `failed` case — states as fact something
 * nobody measured, which is the defect at the head of this file reproduced with
 * the sign flipped.
 */
export type DecisionCallbackOutcome =
  | 'sent'
  | 'skipped-not-found'
  | 'skipped-no-callback-path'
  | 'skipped-unsupported-receiver'
  | 'failed'
  | 'timeout-unknown'
  | 'pending'
  | 'not-attempted';

const KNOWN_OUTCOMES: readonly DecisionCallbackOutcome[] = [
  'sent',
  'skipped-not-found',
  'skipped-no-callback-path',
  'skipped-unsupported-receiver',
  'failed',
  'timeout-unknown',
  'pending',
  'not-attempted',
];

/** The `callback` object on the decide response. */
export interface DecisionCallbackReport {
  outcome: DecisionCallbackOutcome;
  reason?: string;
}

/**
 * Two sentinels the SERVER never sends, produced by this module so that "we did
 * not get an answer" is a case the UI has to handle rather than a hole it falls
 * through:
 *
 *  - `absent`       — the body carried no readable `callback` at all.
 *  - `unrecognised` — it carried an `outcome` string this build has never heard of.
 */
export type DecisionCallbackState = DecisionCallbackOutcome | 'absent' | 'unrecognised';

/** Maps 1:1 onto `toast.success/info/warning/error`. */
export type NoticeTone = 'success' | 'info' | 'warning' | 'error';

export interface DecisionNotice {
  /** TRUE only for `sent`. The single question every caller is really asking. */
  delivered: boolean;
  tone: NoticeTone;
  /** The line to put in front of the operator. Already includes the decision. */
  message: string;
  state: DecisionCallbackState;
}

/**
 * Narrow the decide response's `callback` field, or say it was not there.
 *
 * Deliberately total and never throws: this runs AFTER a decision has been
 * committed, and a parse error here must not be able to turn a recorded decision
 * into a thrown "failure" the operator would try to resubmit.
 */
export function readDecisionCallback(
  response: unknown,
): DecisionCallbackReport | { outcome: 'absent' } | { outcome: 'unrecognised'; raw: string } {
  if (typeof response !== 'object' || response === null) return { outcome: 'absent' };
  const callback = (response as Record<string, unknown>).callback;
  if (typeof callback !== 'object' || callback === null) return { outcome: 'absent' };
  const outcome = (callback as Record<string, unknown>).outcome;
  if (typeof outcome !== 'string') return { outcome: 'absent' };
  if (!(KNOWN_OUTCOMES as readonly string[]).includes(outcome)) {
    return { outcome: 'unrecognised', raw: outcome };
  }
  const reason = (callback as Record<string, unknown>).reason;
  return {
    outcome: outcome as DecisionCallbackOutcome,
    ...(typeof reason === 'string' && reason.trim().length > 0 ? { reason: reason.trim() } : {}),
  };
}

/**
 * ⛔ THE SPENT-DECISION CLAUSE, ATTACHED TO EVERY NON-DELIVERED OUTCOME.
 *
 * The one thing an operator reading "that did not work" will reach for is the
 * button they just pressed. On this row that is the worst available move: the
 * decision IS committed (`approval_decisions` row + the completing UPDATE both
 * land before the callback is even attempted, and the backend documents that
 * they are deliberately NOT rolled back when the receiver fails), and a second
 * decision from the same approver is refused with a 422. So a warning that does
 * not say "do not decide this again" invites the exact damage it is warning about.
 */
const SPENT = 'Your decision is already recorded — do not decide this row again.';

/**
 * Turn a decision line plus the raw response into the notice to show.
 *
 * `decisionLine` is the surface's own wording for what was decided ("Approved —
 * the system advances the phase."); it is kept as the head of the sentence so
 * each surface keeps its voice and only the downstream half is added here.
 */
export function decisionNotice(decisionLine: string, response: unknown): DecisionNotice {
  const report = readDecisionCallback(response);
  const head = decisionLine.trim();
  const lead = head.length > 0 ? `${head} ` : '';

  switch (report.outcome) {
    case 'sent':
      return {
        delivered: true,
        tone: 'success',
        state: 'sent',
        message: `${lead}The callback was delivered and the card moves on.`.trim(),
      };

    case 'not-attempted':
      // NOT a failure, and NOT a success either: the decision is correct and
      // complete for this approver, and the reason nothing was sent is that
      // nothing was owed yet. Saying "the card moves on" here would be a lie of
      // exactly the kind this module exists to stop.
      return {
        delivered: false,
        tone: 'info',
        state: 'not-attempted',
        message:
          `${lead}The approval is not complete yet — another required approver still owes a ` +
          'decision — so nothing was sent onward and the card has not moved.',
      };

    case 'skipped-no-callback-path':
      // The server treats this as a benign, expected outcome (it is the one
      // non-`sent` value it does not even log as an error): the row simply has
      // no callback path, so there is no card move to run. Still not a green
      // "the card moves on".
      return {
        delivered: false,
        tone: 'info',
        state: 'skipped-no-callback-path',
        message:
          `${lead}This approval carries no callback path, so nothing was sent onward and no ` +
          'card will move — the decision lives in fr only.',
      };

    case 'pending':
      return {
        delivered: false,
        tone: 'warning',
        state: 'pending',
        message:
          `${lead}fr did not hear back from n8n before its deadline, so it does not yet know ` +
          `whether the card moved. ${SPENT} Re-open the row shortly and check the card; if it ` +
          'is still blocked, fr retries the delivery on its next redelivery tick.',
      };

    case 'skipped-unsupported-receiver':
      return {
        delivered: false,
        tone: 'error',
        state: 'skipped-unsupported-receiver',
        message:
          `${lead}It was NOT sent onward: the receiver this approval points at does not ` +
          `understand this decision, so the card has not moved and stays blocked. ${SPENT} ` +
          'The card needs moving by hand.',
      };

    case 'skipped-not-found':
      return {
        delivered: false,
        tone: 'error',
        state: 'skipped-not-found',
        message:
          `${lead}The approval could not be read back when the callback was assembled, so ` +
          `nothing was sent onward and the card has not moved. ${SPENT}`,
      };

    case 'timeout-unknown':
      // ⛔ PLACED BEFORE `failed`, AND `warning` RATHER THAN `error`, BECAUSE
      // NOTHING OBSERVED HAS FAILED. fr gave up waiting; n8n was never observed
      // to refuse. The honest register for "recorded, outcome unknown" is the
      // same one `absent` and `unrecognised` use — a red "FAILED" here asserts a
      // downstream refusal that was never measured, and sends the operator to
      // move a card by hand that may already have moved.
      //
      // ⛔ `delivered` STAYS FALSE. Not because we know it was not delivered —
      // we do not — but because `delivered: true` is what drives the
      // auto-navigate-away on the detail page, and navigating away from a row
      // whose outcome is unknown is exactly the moment the operator needs to
      // stay and look at the card.
      return {
        delivered: false,
        tone: 'warning',
        state: 'timeout-unknown',
        message:
          `${lead}fr stopped waiting before n8n answered, so whether the card moved is ` +
          `UNKNOWN — the automation may well have finished. ${SPENT} Check the card; if it is ` +
          'still blocked, fr retries on its next redelivery tick.',
      };

    case 'failed':
      return {
        delivered: false,
        tone: 'error',
        state: 'failed',
        message:
          `${lead}The callback to n8n FAILED, so the card has not moved and stays blocked` +
          (report.reason ? ` (${report.reason})` : '') +
          `. ${SPENT} fr retries the delivery on its next redelivery tick; if the card is ` +
          'still blocked after that, it needs a hand.',
      };

    case 'unrecognised':
      return {
        delivered: false,
        tone: 'warning',
        state: 'unrecognised',
        message:
          `${lead}The server reported a callback outcome this page does not recognise ` +
          `("${report.raw}"), so whether the card moved is unknown. ${SPENT} Check the card ` +
          'before treating this as done.',
      };

    case 'absent':
    default:
      // ── THE CHOSEN DEFAULT FOR A MISSING `callback`, AND WHY ────────────────
      //
      // NOT success. The server documents this field as ALWAYS PRESENT on the
      // decide response, so its absence means one of two things: an older fr
      // that predates the reporting fix, or a response shape this page does not
      // understand. In BOTH cases we have no evidence the card moved — and
      // "claimed a success it had not verified" is the entire defect being
      // fixed here, so inventing one for the absent case would reinstate it.
      //
      // NOT an error either, and that is deliberate: nothing observed has
      // failed. `warning` is the honest register for "recorded, outcome
      // unknown", and it keeps the operator from resubmitting a spent decision
      // the way a red "failed" would.
      return {
        delivered: false,
        tone: 'warning',
        state: 'absent',
        message:
          `${lead}This fr server did not report what happened to the onward callback, so ` +
          `whether the card actually moved is unknown. ${SPENT} Check the card before ` +
          'treating this as done.',
      };
  }
}
