// src/lib/action-decision-identity.ts
//
// ⛔ P1-TEAM-c audit 2 (George 2026-10-15): "any current tenant member may approve an agent
// ACTION, and it runs as the APPROVER". So on an ACTION approval (`approvals.action_id` set)
// the decider's id is not an audit string — it is the identity a write EXECUTES under
// (`resolvePendingAction`). A seat may therefore decide one ONLY when the decider's identity
// was VERIFIED by something other than the request body.
//
// THIS IS AN ALLOWLIST, AND THE ONE PLACE EVERY DECIDE SEAT ASKS. The seats:
//   - web / AG-UI   `PUT /api/approvals/:id`           → routes/approvals.ts `recordApprovalDecision`
//   - chat free-text `approve <id>` (dispatcher)       → agui/actions/approvals-decide.ts `channelDecide`
//                    (and through it `recordApprovalDecision` again)
//   - Telegram, Teams → `decideAsChannelSender` (agui/actions/approvals-decide.ts), the
//                    one channel decide path, and through it `recordApprovalDecision`
// Each passes its channel id and the evidence it holds for THIS request. A channel that is
// not in the table below — email, voice, a synthetic test channel, any channel added later —
// is `unverified` and fails CLOSED for action rows: nothing is recorded, the reply says to
// approve it in fr. A NON-action approval is unaffected (fr executes nothing as its decider).
//
// HOW EACH ENTRY'S TRUST WAS CONFIRMED (read in code, 2026-10-15):
//   web    `handleUpdateApproval` → `validateAuth(req)` (Keycloak JWT); the in-app chat box
//          `POST /api/inapp/messages` → `validateAuth` + body `userId` must equal the token's
//          user, and the dispatcher marks that dispatch a web SESSION. ⚠️ The `web` channel's
//          OTHER ingress — the N8N_WEBHOOK_SECRET thread injection (channels/web.ts) — takes
//          `user_id` from the body: no session ⇒ `keycloakSession` false ⇒ refused.
//   inapp  as above (session only).
//   telegram  the sender id is `message.from.id` / `callback_query.from.id`, set by Telegram;
//          `handleTelegramIncoming` rejects any delivery whose `X-Telegram-Bot-Api-Secret-Token`
//          does not match TELEGRAM_WEBHOOK_SECRET (timing-safe, fail-closed in production —
//          utils/webhook-secret.ts) BEFORE the dispatcher or any decide path reads the body.
//   teams  ONLY with a Bot Framework JWT identity federated to an fr account
//          (`verifiedApproverId`). The shared-secret mode authenticates the CALLER, not the
//          person: `from.aadObjectId` / `approverId` are body strings. The free-text
//          dispatcher runs before any JWT check, so a Teams `approve <id>` never qualifies.
//   email  NOT verified: EMAIL_WEBHOOK_SECRET authenticates the relay, and the From address
//          is a body field with no SPF/DKIM/DMARC check (channels/email.ts) — refused.
//   voice  a stub (no provider) — refused.
//   mcp    (George 2026-10-30: "just another interface to fully operate the fr application",
//          like Telegram) the `address` is the client-scoped id the user linked themselves on
//          Communication settings; the MCP server → fr hop is authenticated by an HMAC over
//          the raw body under FR_MCP_CHANNEL_SECRET with a ±300 s timestamp
//          (channels/mcp-signature.ts, fail-closed on a blank secret) BEFORE the dispatcher or
//          any decide path reads the body — the Telegram bot-secret shape.
//
// `tests/unit/lib/action-decision-identity.test.ts` enumerates every registered channel and
// every `handleWebhook('<channel>'` call site and fails when one is not classified here.

import type { DecisionVia } from '../db/schema';
import { AppError } from '../utils/errors';

/** Stable code on every refusal this module produces (HTTP body `code`, chat reply tail). */
export const ACTION_DECISION_UNVERIFIED_CODE = 'action_decision_identity_unverified';

export type ActionDecisionTrust =
  /** Verified only when fr authenticated the decider on THIS request (Keycloak JWT / session). */
  | 'keycloak_session'
  /** The sender id is set by Telegram on a bot-secret-token-authenticated webhook. */
  | 'telegram_bot_webhook'
  /** The sender is the linked address on an HMAC-signed MCP-server request. */
  | 'mcp_signed_relay'
  /** Verified only with a Bot Framework JWT identity federated to an fr account. */
  | 'teams_bot_jwt'
  /** Never verified: fails closed for action approvals. */
  | 'unverified';

/**
 * Every channel id fr knows, classified. ⛔ Adding a channel means adding a row here — the
 * guard test fails until you do — and a row other than `unverified` needs the trust argument
 * written in this file's header.
 */
export const ACTION_DECISION_CHANNEL_TRUST: Readonly<Record<string, ActionDecisionTrust>> = Object.freeze({
  web: 'keycloak_session',
  inapp: 'keycloak_session',
  telegram: 'telegram_bot_webhook',
  teams: 'teams_bot_jwt',
  email: 'unverified',
  voice: 'unverified',
  mcp: 'mcp_signed_relay',
});

/** What a seat can prove about the decider of THIS request. Absent = not proven. */
export interface ActionDecisionEvidence {
  /** fr authenticated the decider on this request: `validateAuth` (web) or the in-app session. */
  keycloakSession?: boolean;
  /** Teams: the decider IS the verified Bot Framework JWT identity (not a body field). */
  teamsJwt?: boolean;
}

export interface ActionDecisionSeat {
  /** The channel id the decision arrived on (`ActionContext.channel`, or the seat's own). */
  channel: string;
  evidence?: ActionDecisionEvidence;
  /** fr #1683 option A: recorded as `approval_decisions.via` (a staff member deciding through the agent member). */
  via?: DecisionVia;
}

export function actionDecisionTrustOf(channel: string): ActionDecisionTrust {
  return Object.prototype.hasOwnProperty.call(ACTION_DECISION_CHANNEL_TRUST, channel)
    ? ACTION_DECISION_CHANNEL_TRUST[channel]!
    : 'unverified';
}

/**
 * True when the channel itself verifies the SENDER of every message (no per-request
 * evidence needed): Telegram, mcp. A typed `<action> {json}` is credited to
 * the linked person only on these (command-grammar.ts).
 */
export function senderVerifiedByChannel(channel: string): boolean {
  const trust = actionDecisionTrustOf(channel);
  return trust === 'telegram_bot_webhook' || trust === 'mcp_signed_relay';
}

/**
 * True when a TYPED reply on this channel can decide an ACTION approval: the channel verifies
 * its sender (Telegram, mcp) or the typed reply arrives in a Keycloak session (in-app). Email's
 * From and a Teams free-text sender are body fields, so their typed `1` is refused — and the
 * notification on those channels must not offer one (approval-menu.ts).
 */
export function typedReplyDecidesActionApprovals(channel: string): boolean {
  const trust = actionDecisionTrustOf(channel);
  return trust === 'telegram_bot_webhook' || trust === 'mcp_signed_relay' || trust === 'keycloak_session';
}

/** True when this seat may decide an ACTION approval (its decider's identity is verified). */
export function isVerifiedActionDecisionSeat(seat: ActionDecisionSeat): boolean {
  const evidence = seat.evidence ?? {};
  switch (actionDecisionTrustOf(seat.channel)) {
    case 'keycloak_session':
      return evidence.keycloakSession === true;
    case 'telegram_bot_webhook':
    case 'mcp_signed_relay':
      return true;
    case 'teams_bot_jwt':
      return evidence.teamsJwt === true;
    default:
      return false;
  }
}

/** The reply a refused seat sends. Names the fr web path to approve it in. */
export function actionDecisionUnverifiedMessage(channel: string, approvalId: string): string {
  return (
    'Nothing was recorded: an agent action runs as the person who approves it, and this ' +
    `${channel} message does not carry a verified identity. Approve it in fr: /approvals/${approvalId}`
  );
}

/**
 * The ONE check. Null when the seat may proceed (a non-action approval, or a verified seat);
 * otherwise the refusal text. Seats that reply (Telegram) send it; seats that answer
 * HTTP call `assertActionDecisionSeatVerified`.
 */
export function actionDecisionSeatRefusal(input: {
  approval: { id: string; action_id?: string | null };
  seat: ActionDecisionSeat;
}): string | null {
  const isAction = typeof input.approval.action_id === 'string' && input.approval.action_id !== '';
  if (!isAction) return null;
  if (isVerifiedActionDecisionSeat(input.seat)) return null;
  return actionDecisionUnverifiedMessage(input.seat.channel, input.approval.id);
}

/** Throwing form (403 `action_decision_identity_unverified`) for the HTTP / action seats. */
export function assertActionDecisionSeatVerified(input: {
  approval: { id: string; action_id?: string | null };
  seat: ActionDecisionSeat;
}): void {
  const refusal = actionDecisionSeatRefusal(input);
  if (refusal !== null) throw new AppError(403, refusal).withCode(ACTION_DECISION_UNVERIFIED_CODE);
}
