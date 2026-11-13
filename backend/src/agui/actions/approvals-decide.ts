/**
 * fr-agui SPEC §5.2 (P0a) — `approvals.decide`.
 *
 * The command grammar has mapped `approve <id>` / `reject <id>` to this action
 * since Wave 4, and it was registered NOWHERE, so both verbs were dead. It is
 * the human's governance act on an approval that ALREADY exists, so it NEVER
 * parks (`parking:'never'`, allowed for this id only — registry.ts): parking it
 * would only mint an approval for the approval.
 *
 *   WEB      the agent proposes (`confirm`), the decision card calls
 *            `PUT /api/approvals/:approvalId` under the human's session.
 *   CHANNEL  the registry runs `handler` directly for a human channel initiator.
 *            It calls `recordApprovalDecision` — the SAME function the PUT route
 *            uses — so every decision guard applies unchanged (tenant scope, one
 *            decision per approver, the sender must be a required approver).
 *   AGENT    refused (registry: NeverParkingActionRefusedError). An agent token
 *            can never decide.
 *
 * A decision creates NO approval row (asserted by the integration test).
 */
import { and, eq, sql } from 'drizzle-orm';

import { registerAction } from '../registry';
import type { ActionContext, AgentCallableAction } from '../types';
import { db } from '../../db/client';
import { approvals } from '../../db/schema';
import { recordApprovalDecision, type UpdateApprovalBody } from '../../routes/approvals';
import { channelAuthUser } from '../../capabilities/principal';
import {
  chatSeatRefusalMessage,
  isChatSeatRefusal,
  narrowLinkedAccountsForDecision,
} from '../../lib/chat-seat-tenant-member';
import { assertActionDecisionSeatVerified, type ActionDecisionEvidence } from '../../lib/action-decision-identity';
import { resolveBareApprove } from '../../lib/channel-bare-approve';
import type { DecisionVia } from '../../db/schema';
import {
  CHAT_SEAT_CALLBACK_NOT_ATTEMPTED,
  chatSeatDecisionReply,
  type ChatSeatCallbackReport,
} from '../../lib/chat-seat-decision';
import { deriveAgentAction } from '../../capabilities/derive-agent';
import {
  approvalsDecideCapability,
  type DecideInput,
  type DecideOutput,
} from '../../capabilities/approvals/decide';
import { AppError } from '../../utils/errors';

/**
 * How a seat names itself in the recorded audit sentence ("Accepted reviewer recommendation:
 * BLOCKED (bare approve via Telegram)"). The channels are lowercase ids; the sentence reads
 * as a proper noun, and the names are the ones the old Telegram-only code wrote.
 */
const SEAT_LABEL: Record<string, string> = { telegram: 'Telegram', teams: 'Teams', mcp: 'mcp' };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PREFIX_RE = /^[0-9a-f-]{8,35}$/i;
// The decide input/output and the id-prefix floor live in the capability
// declaration (capabilities/approvals/decide.ts); re-exported for existing importers.
export { MIN_APPROVAL_ID_PREFIX, DecideInputSchema, type DecideInput } from '../../capabilities/approvals/decide';

/**
 * DecideInput → `PUT /api/approvals/:approvalId` body (`UpdateApprovalSchema`),
 * field for field. `approvalId` is the PATH parameter only, never in the body.
 */
export function decideInputToUpdateBody(
  input: DecideInput,
): UpdateApprovalBody & Pick<DecideInput, 'g12_decision' | 'rejected_bug_ids'> {
  const body: UpdateApprovalBody & Pick<DecideInput, 'g12_decision' | 'rejected_bug_ids'> = {
    status: input.decision === 'approve' ? 'approved' : 'rejected',
  };
  if (input.comment !== undefined) body.comment = input.comment;
  if (input.reason !== undefined) body.reason = input.reason;
  if (input.deblock_action !== undefined) body.deblock_action = input.deblock_action;
  if (input.new_card_type !== undefined) body.new_card_type = input.new_card_type;
  if (input.rejected_criterion_ids !== undefined) body.rejected_criterion_ids = input.rejected_criterion_ids;
  if (input.g12_decision !== undefined) body.g12_decision = input.g12_decision;
  if (input.rejected_bug_ids !== undefined) body.rejected_bug_ids = input.rejected_bug_ids;
  return body;
}

/** The link a channel reply sends for a row that must be decided on the web. */
export function approvalWebPath(approvalId: string): string {
  return `/approvals/${approvalId}`;
}

/** P1-TEAM-c: the sender's chat address is linked to several fr accounts. */
export const AMBIGUOUS_CHAT_ACCOUNT_CODE = 'chat_address_linked_to_several_accounts';

/**
 * Resolve the id a channel sender typed: a full UUID as-is (the decision
 * function scopes it to the sender's tenant), or a prefix that is unique among
 * the PENDING approvals of the sender's tenant. P1-TEAM-c: since every member may
 * decide every approval of their tenant (P1-TEAM-b) — action approvals included —
 * the prefix is looked up tenant-wide, not only among the sender's own rows; the
 * decision function still decides whether THIS sender may decide it. Unknown or
 * ambiguous ⇒ refused, nothing recorded.
 */
export async function resolveApprovalIdForSender(
  typed: string,
  /** No longer narrows the lookup (P1-TEAM-c, see above); kept for the call shape. */
  _userId: string,
  tenantId: string,
): Promise<string> {
  const t = typed.trim().toLowerCase();
  if (UUID_RE.test(t)) return t;
  if (!PREFIX_RE.test(t)) {
    throw new AppError(400, `Nothing was recorded: "${typed}" is not an approval id.`).withCode('approval_id_invalid');
  }
  const rows = await db
    .selectDistinct({ id: approvals.id })
    .from(approvals)
    .where(
      and(
        eq(approvals.tenant_id, tenantId),
        eq(approvals.status, 'pending'),
        sql`${approvals.id}::text LIKE ${`${t}%`}`,
      ),
    )
    .limit(2);
  if (rows.length === 0) {
    throw new AppError(404, `Nothing was recorded: no pending approval in your workspace starts with "${typed}".`).withCode(
      'approval_not_found',
    );
  }
  if (rows.length > 1) {
    throw new AppError(
      409,
      `Nothing was recorded: more than one pending approval in your workspace starts with "${typed}". Send more of the id.`,
    ).withCode('approval_id_ambiguous');
  }
  return rows[0]!.id;
}

/** Who decides, as the channel resolved them (each webhook keeps its own sender auth). */
export interface ChannelSender {
  /** The channel id the decision arrived on (`telegram`, `teams`, `mcp`, …). */
  channel: string;
  /** The fr account the channel resolved the sender to. */
  userId: string;
  tenantId: string;
  /** Every fr account the sender's address is linked to (narrowed below when several). */
  linkedAccountIds?: readonly string[];
  /** What this request proves about the sender (lib/action-decision-identity.ts). */
  evidence?: ActionDecisionEvidence;
  via?: DecisionVia;
  /**
   * FALSE when this decision came from free text an LLM read as an approval rather than
   * from the numbered grammar (`1` / `approve` / `2 <reason>`). Only the grammar may claim
   * what a `1` MEANS (approve-all on a G-12 row, accepting a BLOCKED recommendation) — see
   * lib/channel-bare-approve.ts. Defaults to true: every seat whose reply the bot matched
   * itself (Telegram, Teams, `approvals.decide`) is grammar.
   */
  bareGrammar?: boolean;
  /**
   * Was this approve the approve-all FORM the menu offers (`1` / `1 - Approve` / `Approve`)?
   * A seat sets it only from the raw text it received. Unset ⇒ this seat can never claim
   * approve-all, which is what stops a structured seat (Teams' button, an mcp agent) from
   * fixing every cited bug while having shown the human nothing.
   */
  approveAllForm?: boolean;
}

/**
 * ⭐ THE ONE CHANNEL DECIDE PATH (owner ruling 2026-10-31: every channel is equivalent).
 * Every chat seat — the `approvals.decide` action, Telegram buttons and replies, the
 * Teams card — decides through here, and this calls `recordApprovalDecision`,
 * the SAME function the web PUT uses: same fields, same rules, same atomic row lock. A
 * refusal throws the route's AppError (its `code` kept); nothing is recorded.
 */
export async function decideAsChannelSender(
  sender: ChannelSender,
  requested: DecideInput,
): Promise<{ output: DecideOutput; response: Record<string, unknown>; preface: string }> {
  let input = requested;
  const tenantId = sender.tenantId;
  // §6.5: the principal is the resolved channel identity in its own tenant;
  // refused unless the sender is a member of that tenant now.
  const user = await channelAuthUser(sender.userId, tenantId);
  const approvalId = await resolveApprovalIdForSender(input.approvalId, sender.userId, tenantId);

  const [row] = await db
    .select({
      id: approvals.id,
      tenant_id: approvals.tenant_id,
      metadata: approvals.metadata,
      requester_id: approvals.requester_id,
      action_id: approvals.action_id,
      action_channel: approvals.action_channel,
      source: approvals.source,
      kind: approvals.kind,
    })
    .from(approvals)
    .where(and(eq(approvals.id, approvalId), eq(approvals.tenant_id, tenantId)))
    .limit(1);
  // ⛔ P1-TEAM-c audit 2: the VERIFIED-IDENTITY ALLOWLIST (lib/action-decision-identity.ts).
  const seat = {
    channel: sender.channel,
    evidence: sender.evidence ?? {},
    ...(sender.via ? { via: sender.via } : {}),
  };
  if (row) assertActionDecisionSeatVerified({ approval: row, seat });
  // ⛔ P1-TEAM-c ATTRIBUTION (George 2026-10-15): an address linked to several accounts is
  // attributed by `narrowLinkedAccountsForDecision` — the ONE linked account that is a
  // current member of this approval's tenant; several or none ⇒ refused, nothing recorded.
  let deciderUser = user;
  const linked = [...(sender.linkedAccountIds ?? [])];
  if (row && new Set(linked).size > 1) {
    const narrowed = await narrowLinkedAccountsForDecision(linked, row, sender.channel);
    if (isChatSeatRefusal(narrowed)) {
      throw new AppError(409, chatSeatRefusalMessage(narrowed, approvalWebPath(approvalId))).withCode(
        AMBIGUOUS_CHAT_ACCOUNT_CODE,
      );
    }
    const decider = narrowed[0]!;
    if (decider !== user.id) deciderUser = await channelAuthUser(decider, tenantId);
  }
  // ⭐ WHAT A BARE APPROVE MEANS IS THE ROW'S ANSWER, NOT THE SEAT'S (lib/channel-bare-approve.ts).
  // A bug-fix authorization / feature design is completed with the SAME structured G-12 body
  // the web sends for "approve everything", and a bare approve that accepts a reviewer's
  // BLOCKED recommendation is recorded as the REJECT that keeps the card blocked. Before
  // this, only Telegram did either — a `1` that worked in one chat and was refused in another
  // for the same row. Every seat reaches the route through this function, so they agree now.
  const resolved = row === undefined
    ? { input, preface: '' }
    : await resolveBareApprove(row, input, {
      bareGrammar: sender.bareGrammar !== false,
      approveAllForm: sender.approveAllForm === true,
      seat: SEAT_LABEL[sender.channel] ?? sender.channel,
    });
  input = resolved.input;
  const body = decideInputToUpdateBody({
    ...input,
    approvalId,
    // The route requires a reason to reject; a channel reject carries its text
    // (or a plain marker) as that reason.
    ...(input.decision === 'reject'
      ? { reason: input.reason ?? input.comment ?? `Rejected from ${sender.channel}` }
      : {}),
  });
  // ⛔ `fromFreeText` is the ONLY thing about the REPLY this path forwards. `bareGrammar ===
  // false` means laya read the human's own words, so the route must not fill
  // `metadata.proposed_answer` over them (routes/approvals.ts `opts.fromFreeText`); on a row
  // that owes an answer it refuses with the same sentence every seat gets instead.
  const res = await recordApprovalDecision(deciderUser, approvalId, async () => body, new Headers(), seat, {
    fromFreeText: sender.bareGrammar === false,
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.status >= 400) {
    const message = typeof json.error === 'string' ? json.error : `decision refused (${res.status})`;
    const refused = new AppError(res.status, message);
    throw typeof json.code === 'string' ? refused.withCode(json.code) : refused;
  }
  return {
    output: {
      approvalId,
      decision: input.decision,
      status: typeof json.status === 'string' ? json.status : input.decision === 'approve' ? 'approved' : 'rejected',
      httpStatus: res.status,
    },
    response: json,
    preface: resolved.preface,
  };
}

/**
 * The chat reply for a decision `decideAsChannelSender` recorded (Telegram, Teams).
 *
 * ⛔ PASS `output.decision`, NEVER the verb the human typed: the shared path may have turned
 * a bare approve into a REJECT (accepting a reviewer's BLOCKED recommendation,
 * lib/channel-bare-approve.ts), and a reply that says "approved" over a rejected row is the
 * exact lie this module exists to remove.
 */
export function channelDecisionReply(
  decision: 'approve' | 'reject',
  response: Record<string, unknown>,
  redeliverable?: boolean,
): string {
  // The route's body carries `settled` (n8n accepted the hand-off), never `delivered`.
  const cb = (response.callback ?? {}) as Partial<ChatSeatCallbackReport> & { settled?: boolean };
  const callback: ChatSeatCallbackReport = typeof cb.outcome === 'string'
    ? { outcome: cb.outcome, delivered: cb.settled === true, ...(cb.reason ? { reason: cb.reason } : {}) }
    : CHAT_SEAT_CALLBACK_NOT_ATTEMPTED;
  return chatSeatDecisionReply({
    decision: decision === 'approve' ? 'approved' : 'rejected',
    approvalComplete: response.approval_complete === true,
    finalStatus: typeof response.status === 'string' ? response.status : 'pending',
    callback,
    ...(redeliverable !== undefined ? { redeliverable } : {}),
  });
}

/** The chat reply for a refusal: the route's own message, plus the web link to decide it in fr. */
export function channelRefusalReply(err: AppError, approvalId: string, publicBaseUrl: string): string {
  if (err.code === 'already_decided') return err.message;
  const message = err.message.replace(/[.\s]+$/u, '');
  const link = `${publicBaseUrl.replace(/\/+$/, '')}${approvalWebPath(approvalId)}`;
  return message.includes(approvalWebPath(approvalId))
    ? `${message}.`
    : `Not recorded — ${message}. Decide it in fr: ${link}`;
}

/** The channel handler of `approvals.decide` (capabilities/approvals/decide.ts). */
export async function channelDecide(input: DecideInput, ctx: ActionContext): Promise<DecideOutput> {
  const { output } = await decideAsChannelSender(
    {
      channel: ctx.channel,
      userId: ctx.userId,
      tenantId: ctx.tenantId ?? '',
      linkedAccountIds: ctx.channelLinkedAccountIds ?? [],
      evidence: { keycloakSession: ctx.channelWebSession === true },
      ...(ctx.decisionVia ? { via: ctx.decisionVia } : {}),
    },
    input,
  );
  return output;
}

/** fr-agui SPEC §3.4 (c): DERIVED from the declaration — no hand-written action object. */
export const approvalsDecideAction: AgentCallableAction<DecideInput, DecideOutput> =
  deriveAgentAction(approvalsDecideCapability);

function safeRegister<I, O>(a: AgentCallableAction<I, O>): void {
  try {
    registerAction(a);
  } catch (err) {
    if (err instanceof Error && err.name === 'ActionAlreadyRegisteredError') return;
    throw err;
  }
}

export function registerApprovalsDecideActions(): void {
  safeRegister(approvalsDecideAction);
}

registerApprovalsDecideActions();
