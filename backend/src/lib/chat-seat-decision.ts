// src/lib/chat-seat-decision.ts
//
// ⛔ THE THREE CHAT SEATS TOLD THE OPERATOR A DECISION SUCCEEDED WITHOUT
//    CHECKING ANYTHING (#1083, the chat half).
//
// `routes/approvals.ts` — the API seat — was hardened for exactly this: it
// classifies the row's BLOCKED-exit, counts what the callback is about to drop,
// warns when the card cannot move, and REPORTS the callback outcome in its 200
// instead of asserting success. The three chat seats were left behind:
//
//   routes/telegram-webhook.ts   `await sendN8nCallback(approval.id)` then
//   routes/teams-webhook.ts      `await n8nCallback.sendN8nCallback(id)` then
//                                `{ received: true, status: 'approved' }`
//
// `sendN8nCallback` (since deleted) was typed `Promise<void>`, so the
// `DecisionCallbackResult` that `deliverDecisionCallback` computes — `sent`,
// `failed`, `skipped-not-found`, `skipped-unsupported-receiver` — was discarded
// at the call site. All four outcomes produced the same green tick.
//
// ── ⚠️ WHAT THE `deblock_action` HALF ACTUALLY IS. READ BEFORE "FIXING" IT. ───
//
// The audit that raised this said a chat-seat approval "completes with no
// `deblock_action` in the payload at all". MEASURED IN THE SOURCE, THAT IS NOT
// WHAT HAPPENS, and the difference decides where the fix goes:
// `buildCallbackPayload` (services/n8n-callback.ts) reads
// `metadata.deblock_action` off the APPROVAL ROW and knows nothing about which
// seat decided it. A row that carries an action carries it to n8n from Telegram
// exactly as it does from the API.
//
// ⭐ What the chat seats genuinely lacked is the OBSERVATION, not the field:
//
//   1. `fr_deblock_actions_total{stage="decide"}` counted API decisions only, so
//      every chat-seat decision was missing from the one counter built to say
//      "this approval could not move its card". An uncounted site cannot fail
//      its own gate.
//   2. The warn at `routes/approvals.ts` ("completed as approved with no usable
//      deblock_action — the callback will drop the field and the card will stay
//      in BLOCKED") never fired for a chat seat. The row completed, the tick was
//      sent, and nothing anywhere disagreed.
//
// So this module mirrors the classification and the counter, and additionally
// surfaces the finding to the human who is standing right there — which the API
// seat cannot do and a chat seat can.
//
// ⛔ NOTHING HERE ROLLS BACK A DECISION. The `approval_decisions` row and the
// completing UPDATE are committed before any of this runs, and a decider who has
// spent their one decision cannot decide again (every seat 200s/refuses a
// duplicate). A failed callback strands a CARD, which
// workers/deblock-callback-redelivery.ts repairs; an un-recorded decision is not
// repairable by anything. Only the MESSAGE changes.
//
// ⚠️ WHY THIS LIVES IN `lib/` AND NOT IN ONE OF THE ROUTES. The three routes
// drifted apart precisely because each carried its own copy of this flow (see
// the drift notes on each consumer). A fourth copy would drift too. It is
// deliberately NOT imported from `routes/approvals.ts`: that file's
// `reportDecisionCallback` is private, is being hardened concurrently, and
// importing a route from three other routes is how a merge conflict becomes a
// behaviour change. When the API seat is next touched it can be pointed at this
// module — the shapes are intentionally the same.

import type { DecisionCallbackOutcome } from '../services/n8n-callback';

// ─────────────────────────────────────────────────────────────────────────────
// 2. THE CALLBACK OUTCOME — delivered, bounded, and REPORTED rather than thrown.
// ─────────────────────────────────────────────────────────────────────────────

export type ChatSeatCallbackOutcome =
  | DecisionCallbackOutcome
  /** fr did not learn the outcome inside the deadline. NOT a success. */
  | 'pending'
  /** The approval did not complete on this decision, so no callback was owed. */
  | 'not-attempted';

export interface ChatSeatCallbackReport {
  outcome: ChatSeatCallbackOutcome;
  /**
   * ⭐ THE ONE BOOLEAN THE OPERATOR MESSAGE MAY BRANCH ON.
   *
   * TRUE for exactly two outcomes:
   *   `sent`                       n8n accepted the decision (`callback_acked_at` stamped);
   *   `skipped-no-callback-path`   a web-only approval — nothing was owed, so nothing is
   *                                outstanding.
   *
   * FALSE for `failed`, `pending`, `skipped-not-found` and
   * `skipped-unsupported-receiver`. ⛔ Do not widen this to "not failed": a
   * `skipped-unsupported-receiver` row was NOT sent, deliberately, and reading it
   * as delivered rebuilds the exact lie this module exists to remove.
   *
   * ⚠️ It is an ACK, never a card move. `callback_delivered_at` — the card
   * actually leaving BLOCKED — is written only by
   * workers/deblock-callback-redelivery.ts after it re-reads Planka. Nothing on
   * a chat seat can observe that inside a webhook, so nothing here claims it.
   */
  delivered: boolean;
  reason?: string;
}

/** The honest report for a decision that did not complete the approval. */
export const CHAT_SEAT_CALLBACK_NOT_ATTEMPTED: ChatSeatCallbackReport = {
  outcome: 'not-attempted',
  delivered: false,
  reason:
    'this decision did not complete the approval (another approver is still owed), ' +
    'so no n8n callback was owed',
};

// ─────────────────────────────────────────────────────────────────────────────
// 3. THE OPERATOR REPLY — one sentence per true fact, and no sentence for a fact
//    fr does not have.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the confirmation an operator sees in the chat seat they decided from.
 *
 * ⛔ THE RULE THIS ENCODES: `Approval is now APPROVED.` is a claim about the
 * WHOLE effect, and the seats were emitting it on the strength of a committed DB
 * row alone. It is now emitted only when fr has ALSO observed the hand-off. When
 * fr has not, the message still confirms what IS true — the decision is recorded
 * and will not be lost — and names what is not yet.
 *
 * ⚠️ THE FAILURE TEXT MUST NOT READ AS "TRY AGAIN". The operator's decision is
 * spent; re-replying gets them `You have already approved this request.` The
 * repair is fr's (workers/deblock-callback-redelivery.ts), and saying so is the
 * difference between an honest message and an unactionable alarm.
 */
export function chatSeatDecisionReply(input: {
  decision: 'approved' | 'rejected';
  approvalComplete: boolean;
  finalStatus: string;
  callback: ChatSeatCallbackReport;
  /**
   * Does `workers/deblock-callback-redelivery.ts` pick this row up? It selects only rows
   * with a `card_id` (and a callback path). Omitted = true, the old wording; a seat that
   * knows the row has NO card passes false, because "fr retries this automatically" is
   * then a promise nothing keeps (measured 2026-10-02: 0 such rows in prod, so a guard,
   * not a live repair).
   */
  redeliverable?: boolean;
}): string {
  const emoji = input.decision === 'approved' ? '✅' : '❌';

  if (!input.approvalComplete) {
    // Unchanged, and correct as it stood: it claims only that the vote landed.
    return (
      `${emoji} Your response (${input.decision}) has been recorded. ` +
      'Waiting for other approvers.'
    );
  }

  const status = input.finalStatus.toUpperCase();

  if (!input.callback.delivered) {
    return (
      `${emoji} Your response has been recorded and the approval is ${status} in fr. ` +
      `⚠️ fr could NOT confirm the hand-off to the automation (${input.callback.outcome}` +
      (input.callback.reason ? `: ${input.callback.reason}` : '') +
      (input.redeliverable === false
        ? '). Your decision is saved, but this approval has no card, so fr will NOT retry ' +
          'the hand-off on its own — tell an operator. Do not reply again; a second reply ' +
          'is refused as a duplicate.'
        : '), so the card may not have moved yet. Your decision is saved and will not be ' +
          'lost — fr retries this automatically. Do not reply again; a second reply is ' +
          'refused as a duplicate.')
    );
  }

  return `${emoji} Your response has been recorded. Approval is now ${status}.`;
}
