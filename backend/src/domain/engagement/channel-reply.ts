// src/domain/engagement/channel-reply.ts
//
// ⭐ THE ONE IMPLEMENTATION OF "A REPLY TO AN APPROVAL NOTIFICATION BECOMES A DECISION".
//
// George, 2026-10-31: "NO, telegram does not have anything of its own. all channels SAME
// flow! adapters only do the minimal work to make the unified multi-cast and
// first-response-counts single implementation function! rip out and delete all tests and
// code that does anything otherwise!"
//
// So this module owns the reply→decision flow — the tag grammar, the untagged bind, laya
// reading, the decider guards and the ONE decide write — for EVERY text channel. A channel
// webhook is only a TRANSPORT ADAPTER: it authenticates the delivery, parses its own
// envelope into a {@link ChannelTurnInput} and calls {@link runChannelTurn}. Nothing here
// belongs to a channel: `channel` and `senderAddress` come from the caller, and the delivery
// location is the caller's `chatKey` + `threadKey`.
//
// ⛔ WHAT IS STILL TRANSPORT-SHAPED, AND WHY THAT IS NOT A SECOND FLOW. The delivery
// location key (`engagement_deliveries.metadata_json` chatId + messageThreadId, shared with
// `lib/untagged-reply-guard.ts`) and `quotesOwnNotificationOf` (proving a quoted message is
// fr's OWN approval notification — it needs the bot id from the Bot-API token and the
// adapter's own notification text) are Telegram's. They are INPUTS here, not branches: a
// transport that records deliveries differently extends {@link ChannelTurnInput} and is
// served by this same flow. It does not get a copy of this file.
//
// ⛔ THERE IS NO PER-CHANNEL STATE. The flow is a pure function of the inbound message plus
// what fr has already sent: no "the bot asked you a question, so your next message means X"
// row, on any transport. A reply is read on its own evidence (its tag, its Reply, its
// grammar, laya) and a bare approve on a row that owes an answer is decided by the SHARED
// decide path exactly as it is on every other channel.
import {
  db,
  approvals,
  approvalDecisions,
  requiredApprovers,
  engagementDeliveries,
} from '../../db/client';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { reportSwallowedFailure } from '../../integrations/_lib/errors';
import { config } from '../../config';
import { DEFAULT_FR_PUBLIC_URL } from '../../services/github-app-config';
// ⛔ The menu's vocabulary comes from the menu, never from a channel adapter: the strings
// this flow strips from a pasted-back echo must be the ones `approvalMenuLines` writes.
import {
  FOOTER_APPROVE_ANNOTATIONS,
  FOOTER_ANSWER_ANNOTATIONS,
  FOOTER_ANSWER_PLACEHOLDER,
  approvalMenuLines,
  containsApprovalNotificationText,
  isApprovalNotificationText,
  typedReplyCannotDecideLine,
} from './approval-menu';
import { isExplicitApprovalIdCommand } from './command-grammar';
import { findUserIdsByChannelAddress } from './channel-prefs';
import { answerlessApproveDemand } from './deblock-actions';
import { AppError } from '../../utils/errors';
import {
  channelDecisionReply,
  channelRefusalReply,
  decideAsChannelSender,
} from '../../agui/actions/approvals-decide';
import { isApproveAllMenuReply } from '../../lib/channel-bare-approve';
import type { RequesterGuardApproval } from './decision-guards';
import {
  chatSeatRefusalMessage,
  chooseTenantMemberDecider,
  isChatSeatRefusal,
  narrowLinkedAccountsForDecision,
  type ChatSeatRefusal,
} from '../../lib/chat-seat-tenant-member';
import { hasPassedDeadline } from '../../lib/approval-deadline';
import { telegramBotIdFromToken, type ReplyToMessage } from '../../channels/telegram-envelope';
import {
  deliveredAtLocationSql,
  deliveredChatSql,
  inboundTime,
  untaggedBindAllowed,
  untaggedBindRefusedMessage,
} from '../../lib/untagged-reply-guard';
import { attributeRequestTo } from '../../integrations/_lib/context';
import type { DecisionVia } from '../../db/schema';
import { isVerifiedActionDecisionSeat, type ActionDecisionEvidence } from '../../lib/action-decision-identity';
import {
  interpretApprovalReply,
  interpretedPreface,
  toChatDecision,
  unclearChoiceMessage,
  REJECT_DEFAULT_REASON,
  type ChatDecision,
} from '../../lib/approval-reply-interpreter';

/** One chat reply back to the sender. The resolved value is not read by this flow. */
export type Say = (text: string) => Promise<unknown>;

/**
 * Everything {@link runChannelTurn} needs from a transport. The adapter does the minimal
 * transport work — authenticate, parse its envelope, send a reply — and nothing else.
 */
export interface ChannelTurnInput {
  /** Channel id recorded on the decision ('telegram', 'teams', …). */
  channel: string;
  /** The transport address the sender is looked up by (user_channel_prefs / linked accounts). */
  senderAddress: string;
  /** engagement_deliveries location key for this conversation (chat id for Telegram). */
  chatKey: string;
  /** Per-thread key within chatKey (Telegram message_thread_id or '' ). */
  threadKey: string;
  isDirectChat: boolean;
  isReplyToOther: boolean;
  isEdited: boolean;
  /** The transport's own clock, seconds. Ordering anchor; never the DB clock. */
  messageDate?: number;
  /**
   * fr's own clock (epoch ms) at receipt, for a transport whose message carries no send time
   * (mcp, email, teams, inapp). Set ⇒ the turn orders by fr's clock; `messageDate` must then be
   * `floor(receivedAtMs / 1000)`.
   */
  receivedAtMs?: number;
  /**
   * The transport already resolved WHO decides (mcp `on_behalf_of`: a member of the agent's
   * own workspace, whom the agent relays) and the ONE workspace they act in. An approval of
   * any other workspace is refused. Absent ⇒ the sender's address decides, as on every channel.
   */
  actAs?: { userId: string; tenantId: string };
  /** The audit `via` a decision from this message carries (an agent member's mcp relay). */
  via?: DecisionVia;
  /**
   * What THIS request proves about the sender beyond the channel itself (the in-app chat box's
   * Keycloak session), for the action-approval identity allowlist (lib/action-decision-identity.ts).
   */
  evidence?: ActionDecisionEvidence;
  /** The raw inbound text. */
  text: string;
  /** Text of the message this one replies to, when the transport quotes. */
  quotedText?: string;
  /** Send one chat reply back to the sender. Never throws. */
  say(text: string): Promise<unknown>;
  /**
   * The transport marks this message a FORWARD (someone else's words, often fr's own
   * notification): never read by laya as this sender's answer. Optional — absent = not a
   * forward (a transport with no forward concept simply omits it).
   */
  isForwarded?: boolean;
  /**
   * The message this one replies to, when the transport can name its sender: the input of
   * the verified-identity allowlist (`quotesOwnNotificationOf`), so only a Reply to fr's OWN
   * notification of THIS approval is laya-read. Absent = not proven = not read (fail closed).
   */
  quotedReply?: ReplyToMessage;
  /**
   * Offer text this flow does not claim to the agent dispatcher, which gets first refusal
   * BEFORE the ordinary "couldn't match" paths but AFTER laya has read the message (a laya
   * reading is what stops an agent answering "approved" with "I didn't recognize that as an
   * action"). Resolves true when the agent took it. The route owns the dispatcher; this flow
   * only sequences it.
   */
  dispatch?(): Promise<boolean>;
  /**
   * Called once the turn has bound the message to an approval, BEFORE any write, so a
   * transport's top-level failure report can name it. It is the one thing a thrown failure
   * cannot otherwise recover.
   */
  onApprovalResolved?(approvalId: string): void;
}

/**
 * Run the ONE reply→decision flow for an inbound chat message.
 *
 * `handled` is false only for a message nothing applied to and nothing was said about (the
 * deliberately silent group-chatter case). `approvalId` names the approval the turn bound
 * the message to, when one was resolved.
 */
export async function runChannelTurn(
  turn: ChannelTurnInput,
): Promise<{ handled: boolean; approvalId: string | null; decided?: boolean }> {
  const senderAddress = turn.senderAddress;
  const messageText = turn.text;
  const quotedText = turn.quotedText;
  const isEdited = turn.isEdited;
  const isDirectChat = turn.isDirectChat;
  const messageDate = turn.messageDate;
  const say: Say = (text) => turn.say(text);
  // The delivery location: the chat the message arrived in, and — for a forum — its topic.
  const chatKey = turn.chatKey;
  const threadKey = turn.threadKey;
  const threadId = threadKey === '' ? null : Number(threadKey);
  // `quotedText` alone misses a reply to a photo/sticker/voice note (no `text`), so the
  // envelope's structural flag is OR'd in: "1" answering a captioned screenshot in the
  // group must not approve the sender's one pending approval.
  const isReplyToOther = turn.isReplyToOther || Boolean(quotedText && quotedText.trim());
  // The untagged-bind guard's location: EXACTLY the key the untagged binder reads
  // (`deliveredAtLocationSql` — the chat + topic as recorded, else the recipient address the
  // delivery was sent to on a 1:1 channel).
  // The guard reads the location AS OF this message's own `date` (validator 6): an ask posted
  // after the human typed (a delayed / retried update) can never enable the bind.
  // ONE location model for every channel (`lib/untagged-reply-guard.ts` ChannelLocation): the
  // recorded chat + topic when the transport records one, else the address it was sent to.
  // Can THIS seat decide an ACTION approval (lib/action-decision-identity.ts)? When it cannot
  // (email, Teams free text, an in-app box without its session), action approvals stay
  // candidates — so "exactly one could have been meant" keeps its meaning — but no message
  // offers a typed decision on one: it names fr instead (`offerTyped`).
  const decidesActions = isVerifiedActionDecisionSeat({ channel: turn.channel, evidence: turn.evidence ?? {} });
  const guardScope = {
    channel: turn.channel,
    location: { chatId: chatKey, threadId, senderAddress },
    inboundAt: inboundTime(messageDate, turn.receivedAtMs),
  };

  // ── APPROVAL TRAFFIC IS ROUTED HERE, BEFORE THE AGENT DISPATCHER SEES IT ──────────────
  // The inbound dispatcher answers free text (agent intent → conversational reply). It used
  // to get FIRST crack at every body, with its own keyword filter deciding what to hand
  // back — and that filter knew only the tags and a few exact keywords. With
  // CHANNEL_DISPATCH_ENABLED=true (production) `1.`, `Approve!`, `Approve 👍`,
  // `1 #abcd1234`, `#abcd1234 1`, a Reply to the bot's `[AnswerFor:…]` question and the
  // free-text answer the bot had just asked for in the DM all went to the agent and never
  // reached approvals. Ownership is now decided from what THIS flow reads:
  // `looksLikeApprovalTraffic` (the ONE predicate; `channels/telegram.ts` delegates to it).
  // Only what it does not claim is offered to the dispatcher — which returns false when
  // dispatch is off, and the paths below run unchanged.
  const unclaimed = !looksLikeApprovalTraffic({ quotedText, messageText });
  // ⛔ NEVER laya-read, on ANY path (quoted Reply or R325): an EDITED message (a correction
  // after more approvals arrived), a Telegram FORWARD, and a message whose own text is (or
  // contains) fr's approval notification — a pasted one. The last two are fr's words, not the
  // human's answer: laya would read "🔔 Approval Required … 1 - Approve" as a decision. Only
  // the exact grammar can decide such a message (`1`, `2 <reason>`).
  const layaExcluded = isEdited || turn.isForwarded === true || containsApprovalNotificationText(messageText);
  // ── FREE TEXT WITHOUT A Reply IS READ BY laya (George 2026-10-23, R325) ──────────────────
  // Measured on prod 2026-10-23: George typed "approved" in the forum topic of approval
  // e3e7cea6 without tapping Reply. No tag, not a grammar keyword, so the agent got it and
  // answered "I didn't recognize that as an action".
  // ⭐ R325 (decided 2026-10-24, simplest functional rule): free text with no Reply, in a DM or
  // forum topic, when the sender has EXACTLY ONE pending approval addressed to them in this
  // chat (the untagged-bind rules of `1`: delivered to this sender here, the newest thing fr
  // sent here is an approval ask) ⇒ laya reads it against THAT approval with the same choices
  // and the same confidence gate as a quoted reply, and a confident approve / reject is
  // RECORDED (through every processDecision guard), exactly as if it had quoted the approval.
  //   * zero pending here ⇒ unchanged: the agent dispatcher gets it;
  //   * ⛔ SEVERAL pending ⇒ laya is NEVER called: main's behaviour (the agent, else the help
  //     text). It used to read the message against every candidate's text on ONE tenant's
  //     licence, so another tenant's approval text left its tenant (sixth audit);
  //   * laya says question / unrelated / unsure / is unreachable ⇒ the agent gets it.
  // ⛔ ONCE laya HAS BEEN CALLED, ITS ANSWER IS FINAL (fourth audit). A message laya read and
  // did not read as a decision (`declined`: unsure / question / unrelated / unreachable / the
  // call threw) records NOTHING: it goes to the agent, else the help text below — never to
  // the untagged grammar. It used to fall through to it, so `1. Approve` (a grammar form that
  // `looksLikeApprovalTraffic` does not claim, so laya read it) was recorded as an approve
  // after laya said "unsure" — on a BLOCKED recommendation as a REJECT. The exact grammar the
  // approvals path claims (`1`, `1.`, `approve`, `Approve!`, a tag …) never reaches laya.
  const layaUnquoted = unclaimed && !layaExcluded
    ? await layaUnquotedRead({
        channel: turn.channel, senderAddress, chatKey, threadId, messageDate, messageText, isDirectChat,
        isForumTopic: threadKey !== '',
        isReplyToOther,
        guardScope,
        say,
        decidesActions,
      })
    : null;
  if (layaUnquoted?.kind === 'answered') {
    return { handled: true, approvalId: null };
  }
  const layaDeclined = layaUnquoted?.kind === 'declined' ? layaUnquoted : null;
  if (unclaimed && (layaUnquoted === null || layaDeclined !== null)) {
    if (turn.dispatch !== undefined && (await turn.dispatch())) {
      return { handled: true, approvalId: null };
    }
  }
  if (layaDeclined !== null) {
    // The agent did not take it (dispatch off): help text only. Nothing below may decide it.
    if (layaDeclined.candidateId !== null && layaDeclined.read === 'question') {
      await say(needInfoMessage(layaDeclined.candidateId, decidesActions || !layaDeclined.candidateIsAction));
      return { handled: true, approvalId: null };
    }
    if (layaDeclined.candidateId !== null && layaDeclined.read === 'unsure') {
      // Same sentence as every other unclear reply; no option list here because this arm has
      // only a candidate id, not the row that carried the menu.
      await say(unclearChoiceMessage([]));
      return { handled: true, approvalId: null };
    }
    if (isDirectChat || isGroupDecisionAttempt(stripApprovalTag(messageText))) {
      // A seat that cannot decide actions is not told to "send your decision again" about an
      // ACTION approval it cannot decide: it gets that approval's fr link. A non-action
      // candidate can be decided by a typed reply here, so it keeps the ordinary answer.
      await say(layaDeclined.candidateId !== null && layaDeclined.candidateIsAction && !decidesActions
        ? typedReplyCannotDecideLine(layaDeclined.candidateId)
        : unmatchedReplyMessage());
    }
    return { handled: true, approvalId: null };
  }

  // Extract approval id from the quoted (replied-to) text or the message body.
  let approvalId = extractApprovalId(quotedText, messageText);
  let decisionText = stripApprovalTag(messageText);

  // ── NO TAG: BIND ONLY WHEN EXACTLY ONE APPROVAL CAN HAVE BEEN MEANT ──────────────
  // Measured on prod 2026-10-01: the product owner answered a notification three ways
  // ("1", "1 - Approve", "Approve") without tapping Reply, and every one landed in the
  // unmatched branch below. The tag is the reliable anchor, but it is not the only
  // unambiguous one: if exactly ONE pending approval was delivered to THIS sender in
  // THIS chat, a decision-shaped reply can only mean that one. With zero or 2+ we never
  // guess — a wrong bind decides someone else's approval — and with 2+ we list the
  // candidates so the human can address one by `#<short id>`.
  //
  // ⛔ TWO MORE CONDITIONS, BOTH FROM A PRE-PUSH REVIEW, BOTH WRONG-DECISION PATHS:
  //   * the message must NOT be a reply to some other message — "ok" answering a
  //     colleague is conversation, not a decision on the sender's one pending approval;
  //   * the text must be an UNTAGGED decision form (`isUntaggedDecisionForm`), which is
  //     narrower than `parseDecision`: `ok`/`yes`/`no …` and `2 people are coming` all
  //     parse, and none of them may decide an approval nobody quoted.
  let boundWithoutTag: UnquotedCandidate | null = null;
  /** The bind came from an explicit `#id` (named), not inferred. */
  let boundByRef = false;
  //   * an EDITED message never binds — correcting a typo after a second approval arrived
  //     would decide the second one — and the delivery must PREDATE the message, so a
  //     late webhook retry cannot land on an approval sent after the human typed.
  //   * a message with NO chat id never binds: eligibility is "delivered to THIS chat", and
  //     an unknown chat is not the sender's DM (`isDirectChat`), whatever it falls back to.
  if (!approvalId && !isReplyToOther && !isEdited && chatKey !== '') {
    const shortRef = extractShortRef(decisionText);
    const candidateText = shortRef ? shortRef.rest : decisionText;
    if (
      isUntaggedDecisionForm(candidateText, { addressed: shortRef !== null, isDirectChat }) &&
      parseDecision(candidateText) !== null
    ) {
      const resolution = await resolveUnquotedReply(
        turn.channel, senderAddress, chatKey, threadId, messageDate ?? null, shortRef?.prefix ?? null, isDirectChat,
      );
      // ⛔ UNTAGGED-BIND GUARD (lib/untagged-reply-guard.ts, George 2026-10-10). Every outcome
      // that BINDS requires the newest outbound fr sent into this chat to be an approval ask.
      // A licence notification saying "send 1" must not steer a fresh `1` (or `1 #<id>`) onto
      // the sender's pending approval. Outcomes that only list or explain (ambiguous,
      // elsewhere, unlinked) bind nothing and are left alone.
      if (resolution.kind === 'bound' || resolution.kind === 'recently-closed') {
        const guard = await untaggedBindAllowed(guardScope);
        // ONE exemption: an explicit `#<id>` the human typed in a chat where fr has sent
        // NOTHING (e.g. their DM, naming an approval posted to a group topic). Nothing fr
        // sent here can have steered it, and the human named the approval themselves. A
        // non-approval send here (a licence notification) or a failed read still refuses.
        const explicitRefInSilentChat = shortRef !== null && !guard.allowed && guard.reason === 'no_outbound';
        if (!guard.allowed && !explicitRefInSilentChat) {
          await say(untaggedBindRefusedMessage('reply'));
          return { handled: true, approvalId: null };
        }
      }
      if (resolution.kind === 'bound') {
        approvalId = resolution.candidate.id;
        decisionText = candidateText;
        boundWithoutTag = resolution.candidate;
        boundByRef = shortRef !== null;
      } else if (resolution.kind === 'unlinked') {
        // Not "tap Reply": a Reply would hit the same not-linked refusal. Say the real cause.
        await say(NOT_LINKED_MESSAGE);
        return { handled: true, approvalId: null };
      } else if (resolution.kind === 'elsewhere') {
        await say(elsewhereReplyMessage(resolution.candidates, resolution.total, offerTyped(decidesActions, resolution.candidates)));
        return { handled: true, approvalId: null };
      } else if (resolution.kind === 'recently-closed') {
        // Nothing recorded: another approval here closed recently, so a reply that quotes
        // nothing could mean either one. Name the pending one and the explicit address.
        await say(recentlyClosedReplyMessage(resolution.candidate, offerTyped(decidesActions, [resolution.candidate])));
        return { handled: true, approvalId: null };
      } else if (resolution.kind === 'ambiguous') {
        await say(ambiguousReplyMessage(
          resolution.candidates, shortRef?.prefix ?? null, offerTyped(decidesActions, resolution.candidates),
        ));
        return { handled: true, approvalId: null };
      } else if (shortRef) {
        await say(unknownShortRefMessage(shortRef.prefix));
        return { handled: true, approvalId: null };
      }
    }
  }

  // R325: the unquoted free text laya read as a decision on the ONE approval it can mean.
  if (!approvalId && layaUnquoted?.kind === 'bound') {
    approvalId = layaUnquoted.candidate.id;
    boundWithoutTag = layaUnquoted.candidate;
  }

  if (!approvalId) {
    // ── THIS BRANCH USED TO BE THE ONLY SILENT ONE, AND IT IS THE LIKELIEST ONE ──
    // It read `return` with ZERO adapter call, while every other refusal in this file
    // (approval-not-found, already-decided, expired, unparseable, not-an-approver,
    // already-decided-by-you, requester-is-decider, finished-card, rate-limited,
    // answer-required, broken-gate) sends the human a sentence. Measured on prod 2026-09-15:
    // the product owner typed a decision into the group WITHOUT tapping Reply, so no
    // `[ApprovalId:…]` was quoted, and fr answered with total silence — indistinguishable
    // from "fr is down" or "I am not allowed". Replying without quoting is the single most
    // likely user mistake on this transport, so it is the last branch that should be mute.
    //
    // ⚠️ THE ANSWER IS CONDITIONED, AND SAYING WHY MATTERS. This handler is reached by
    // EVERY inbound text update once `CHANNEL_DISPATCH_ENABLED=false` makes the dispatcher
    // a no-op (with dispatch ON, only what `looksLikeApprovalTraffic` claims, plus what the
    // agent declined, gets here). An unconditional send would make the bot answer ordinary
    // group chatter, which is a new defect, not a fix. So we answer when the message is
    // plausibly aimed at us:
    //   * a DM — every message in a 1:1 chat with the bot is addressed to the bot;
    //   * a reply to SOMETHING — the user tapped Reply, just not on the notification
    //     carrying the tag (an n8n forwarder that drops `reply_to_message`, or a reply
    //     to fr's own confirmation message). This is the measured mistake itself;
    //   * anything that parses as a decision — `1`, `approve: …`, `2 too risky`. The
    //     user clearly tried to decide; they deserve to be told it landed nowhere.
    // Free-standing group chatter that is none of those stays silent, deliberately.
    const isReplyToSomething = Boolean(quotedText && quotedText.trim());
    // ⛔ In a GROUP "decision-shaped" means the UNTAGGED grammar, not `parseDecision`:
    // "ok", "no problem", "2 days" all parse, and answering them made the bot butt into
    // colleagues' conversation. (A DM is answered by the `isDirectChat` arm regardless.)
    const looksLikeDecision = isGroupDecisionAttempt(stripApprovalTag(messageText));
    // The pasted `approve: <your answer>` template is unmistakably aimed at the bot (it is
    // our own text), so it gets the specific fix in any chat. Nothing is recorded.
    if (isPastedAnswerPlaceholder(stripApprovalTag(messageText))) {
      await say(PASTED_PLACEHOLDER_MESSAGE);
      return { handled: true, approvalId: null };
    }
    // `3 …` addressed to the bot (a DM, a Reply, or the menu line `3 - Need more info` in a
    // group) gets the question answer, not "couldn't match": it was never a decision.
    const unboundText = stripApprovalTag(messageText);
    if (
      isNeedInfoRequest(unboundText) &&
      (isDirectChat || isReplyToSomething || isMenuEcho(cleanDecisionText(unboundText)))
    ) {
      await say(needInfoMessage(null, decidesActions));
      return { handled: true, approvalId: null };
    }
    if (isDirectChat || isReplyToSomething || looksLikeDecision) {
      await say(unmatchedReplyMessage());
      return { handled: true, approvalId: null };
    }
    // No fallback-by-address: unlike Signal's phone match, a Telegram reply that
    // doesn't quote an approval can't be safely attributed, so we never guess WHICH
    // approval was meant — we only ever say that we could not.
    return { handled: false, approvalId: null };
  }

  turn.onApprovalResolved?.(approvalId);
  const [approval] = await db.select()
    .from(approvals)
    .where(eq(approvals.id, approvalId));

  if (!approval) {
    await say(`Approval not found. It may have expired.`);
    return { handled: true, approvalId };
  }

  if (approval.status !== 'pending') {
    await say(`This approval has already been ${approval.status}.`);
    return { handled: true, approvalId };
  }

  // ── AN EXPIRED APPROVAL MAY NOT BE DECIDED HERE EITHER (parity with the HTTP seat) ──
  // `hasPassedDeadline` (lib/approval-deadline.ts) was enforced only in
  // `routes/approvals.ts`. A row past `expires_at` but not yet reaped (the reaper sweeps
  // at most every 15 minutes, BATCH_SIZE 500) was decidable by a chat reply while the
  // HTTP seat refused the identical row.
  if (hasPassedDeadline(approval.expires_at)) {
    await say(`This approval has expired. It can no longer be decided here.`);
    return { handled: true, approvalId };
  }

  // ── ONE COHERENT OUTCOME FOR AN UNTAGGED BIND (round 7) ────────────────────────────────
  // This used to say "I applied it to the only pending approval…" BEFORE processDecision ran,
  // so every refusal there (web-only, rate limit, already decided, approve-all refused,
  // requester-is-decider) followed it with "nothing was recorded" — two contradicting
  // messages. Now processDecision's replies are HELD and sent once it has returned: on a
  // recorded decision behind the bound-to line, on a refusal behind a line that names the
  // approval (#id) it concerned, so a human who meant another one still knows which was hit.
  const subject: UnquotedCandidate | null = boundWithoutTag;
  const held: string[] = [];
  const decisionSay: Say = subject ? async (text) => { held.push(text); return true; } : say;
  let recorded = false;
  try {
    recorded = await processDecision(approval, senderAddress, decisionSay, decisionText, {
      channel: turn.channel,
      // ⛔ The CLASS, not one marker: a Reply quoting ANY message that is not an approval
      // notification is never read.
      // ⭐ The ALLOWLIST input: what the Reply quotes. Only fr's own notification for THIS
      // approval, proven by the sent-message record, may be laya-read (quotesOwnNotificationOf).
      quoted: { chatId: turn.chatKey, quotedText, replyTo: turn.quotedReply },
      layaExcluded,
      ...(turn.actAs ? { actAs: turn.actAs } : {}),
      ...(turn.via ? { via: turn.via } : {}),
      ...(turn.evidence ? { evidence: turn.evidence } : {}),
      ...(layaUnquoted?.kind === 'bound' && layaUnquoted.candidate.id === approvalId ? { layaPreRead: layaUnquoted.read } : {}),
    });
  } finally {
    if (subject) {
      const head = recorded
        ? boundByRef
          ? `Applied your reply to #${shortId(subject.id)} — ${firstLine(subject.description)}`
          : boundWithoutTagMessage(subject)
        : untaggedSubjectLine(subject, boundByRef ? 'named' : 'untagged');
      // ⛔ Its own try: a throw from `say` here would REPLACE processDecision's exception
      // (the one worth logging). If processDecision threw, the top-level catch still tells
      // the human the outcome is unknown, naming this approval (`processingFailedMessage`).
      if (recorded || held.length > 0) {
        try {
          await say([head, ...held].join('\n\n'));
        } catch (sayErr) {
          console.error('[channel-reply] could not send the held decision reply:', sayErr);
        }
      }
    }
  }
  return { handled: true, approvalId, decided: recorded };
}

// ─────────────────────────────────────────────────────────────────────────────
// Untagged-reply resolution.
//
// Eligibility is deliberately narrow: a PENDING, non-expired approval with a `sent`
// telegram `engagement_deliveries` row addressed to one of the sender's own fr users
// (via user_channel_prefs) AND posted to the chat the reply arrived in. An approval sent
// to someone else, or to a different chat, is never a candidate — except that in the
// sender's own DM a head `#<id>` may name one delivered to them elsewhere
// (`findPendingForRecipientAnywhere`). processDecision still
// runs every approver/requester/rate/answer guard on the bound row afterwards.
// ─────────────────────────────────────────────────────────────────────────────

/** A candidate row for an untagged reply. */
type UnquotedCandidate = { id: string; description: string; kind?: unknown; metadata?: unknown; action_id?: string | null };

/**
 * May a message that lists these candidates offer a typed decision (`1 #<id>`)? Not on a seat
 * that cannot decide ACTION approvals when one of them is an action: that offer would be refused.
 */
function offerTyped(decidesActions: boolean, candidates: readonly UnquotedCandidate[]): boolean {
  return decidesActions || candidates.every((c) => !c.action_id);
}

/**
 * When the sender's own vote on the row was cast, read so a session zone can only make it look
 * NEWER, never older. `decided_at` is timestamp WITHOUT time zone: the decision seats write it
 * with `defaultNow()` (session-zone wall time; fr's session is UTC) while fixtures write a JS
 * Date (UTC wall time). Misreading a recent vote as OLD would drop the row and bind another
 * one; misreading an old one as newer only asks for a confirm. So take the later reading.
 */
function ownVoteAfter(userIds: string[], cutoffEpoch: number) {
  return sql`EXISTS (
    SELECT 1 FROM ${approvalDecisions}
    WHERE ${approvalDecisions.approval_id} = ${approvals.id}
      AND ${inArray(approvalDecisions.approver_id, userIds)}
      AND greatest(
        ${approvalDecisions.decided_at} AT TIME ZONE 'UTC',
        ${approvalDecisions.decided_at} AT TIME ZONE current_setting('TimeZone')
      ) > to_timestamp(${cutoffEpoch}::bigint)
  )`;
}

/**
 * ⛔ ROUND 7: an approval the sender has ALREADY VOTED ON — through ANY fr account linked to
 * their address (`findUserIdsByChannelAddress`, the same set `findApproverForSender`
 * picks from) — is not a candidate. It is still pending only because a co-approver has not
 * decided; counting it made `1` on the next row ambiguous, or, alone, "You have already
 * approved this request" about a row the human was not addressing.
 *
 * ⛔ BUT ONLY ONCE THE VOTE IS OLDER THAN OWN_DECISION_CORRECTION_WINDOW_S (round 7b). A vote
 * cast seconds before the message keeps the row (the caller counts it as a recent own
 * decision, which sends the reply to the CONFIRM path): `1 #A`, then `2` typed to correct A,
 * must never reject the one other pending row. The same race the round-6 window guards.
 */
function notVotedByOrVotedRecently(userIds: string[], messageDate: number) {
  return sql`(NOT EXISTS (
    SELECT 1 FROM ${approvalDecisions}
    WHERE ${approvalDecisions.approval_id} = ${approvals.id}
      AND ${inArray(approvalDecisions.approver_id, userIds)}
  ) OR ${ownVoteAfter(userIds, messageDate - OWN_DECISION_CORRECTION_WINDOW_S)})`;
}

type UnquotedResolution =
  | { kind: 'bound'; candidate: UnquotedCandidate }
  | { kind: 'ambiguous'; candidates: UnquotedCandidate[] }
  | { kind: 'recently-closed'; candidate: UnquotedCandidate }
  /** The sender's Telegram id maps to no fr user: no reply form can ever bind. */
  | { kind: 'unlinked' }
  /** DM, nothing pending here, but pending approvals were delivered to them elsewhere. */
  | { kind: 'elsewhere'; candidates: UnquotedCandidate[]; total: number }
  | { kind: 'none' };

/** The eligible set, plus how many OTHER approvals were in play here recently.
 * `unlinked` is set ONLY when the sender has no linked fr user (not merely no candidates). */
type UnquotedLookup = {
  eligible: UnquotedCandidate[];
  recentlyClosed: number;
  unlinked?: boolean;
  /** Link-only rows (decidable only in fr) that may be what an untagged reply meant: delivered
   * here AFTER the sole candidate, or within OWN_DECISION_CORRECTION_WINDOW_S of the message.
   * Non-empty ⇒ the reply goes to the confirm path, which names these as fr-only. */
};

/**
 * When the delivery reached the human: the transport's recorded `date` (Telegram's clock) when
 * there is one. A row with no recorded `date` (an older Telegram row, or a channel whose
 * transport returns no send time — mcp, email, teams, inapp) falls back to its `created_at`
 * ONLY in the sender's own 1:1 conversation (no `messageThreadId` key, chat = the sender): it
 * has no topics to leak across, so the fallback cannot widen anything. Group rows still need
 * `date`. `created_at` is a timestamp WITHOUT time zone written by `now()`, so it is read back
 * in the session zone.
 */
function deliveredAtSql(senderAddress: string) {
  return sql`coalesce(
    (${engagementDeliveries.metadata_json}->>'date')::bigint,
    CASE WHEN NOT coalesce(${engagementDeliveries.metadata_json} ? 'messageThreadId', false)
          AND ${deliveredChatSql()} = ${senderAddress}
      THEN floor(extract(epoch from (${engagementDeliveries.created_at} AT TIME ZONE current_setting('TimeZone'))))::bigint
    END
  )`;
}

/** How long the sender's OWN decision on another approval here still makes an untagged reply
 * ambiguous: the window in which a reply could be a correction of that decision. */
const OWN_DECISION_CORRECTION_WINDOW_S = 5 * 60;

export async function findEligibleUnquotedApprovals(
  channel: string,
  senderAddress: string,
  chatKey: string,
  threadId: number | null,
  messageDate: number | null,
  /** true = the bot INFERS the approval (bare untagged reply): link-only rows and rows the
   * sender already voted on are dropped. false = the human NAMED it with `#id`: every pending
   * row is returned, so processDecision gives its specific answer ("already approved", the
   * fr link) instead of "no pending approval … #id". */
  inferred = true,
): Promise<UnquotedLookup> {
  const none: UnquotedLookup = { eligible: [], recentlyClosed: 0 };
  // Linked-user check FIRST, so "you are not linked" is never masked by a missing date.
  const userIds = await findUserIdsByChannelAddress(channel, senderAddress);
  if (userIds.length === 0) return { ...none, unlinked: true };
  if (!messageDate || messageDate <= 0) return none;

  // The delivery predicate, shared by both reads below.
  const deliveredHere = and(
    eq(engagementDeliveries.channel, channel),
    eq(engagementDeliveries.status, 'sent'),
    inArray(engagementDeliveries.recipient_user_id, userIds),
    // THE location key, shared with the untagged-bind guard (one function, so the guard's
    // "newest thing fr sent HERE" is the same place as "delivered HERE"): the recorded chat,
    // and the recorded forum topic exactly. A LEGACY row (written before deliveries recorded
    // `messageThreadId`) is eligible only in the sender's own DM: a private chat has no
    // forum topics, so there is no topic-Q approval it could leak into topic P. Measured
    // 2026-10-01: approval 2bdc6219 was delivered to the product owner's DM before #1328
    // and could not be answered untagged for exactly this reason.
    deliveredAtLocationSql({ chatId: chatKey, threadId, senderAddress }),
  );

  const rows = await db
    .select({
      id: approvals.id,
      description: approvals.description,
      expires_at: approvals.expires_at,
      kind: approvals.kind,
      metadata: approvals.metadata,
      action_id: approvals.action_id,
      // EARLIEST delivery here: a re-send after an own decision cannot make it look newer.
      delivered_at: sql<string>`min(${deliveredAtSql(senderAddress)})`,
      // The sender voted on it inside the correction window (only read when inferred).
      own_vote_recent: inferred
        ? sql<boolean>`${ownVoteAfter(userIds, messageDate - OWN_DECISION_CORRECTION_WINDOW_S)}`
        : sql<boolean>`false`,
      // The sender voted on it at ANY time (only read when inferred; round 7c).
      own_vote_any: inferred
        ? sql<boolean>`EXISTS (SELECT 1 FROM ${approvalDecisions} WHERE ${approvalDecisions.approval_id} = ${approvals.id} AND ${inArray(approvalDecisions.approver_id, userIds)})`
        : sql<boolean>`false`,
    })
    .from(approvals)
    .innerJoin(engagementDeliveries, sql`${engagementDeliveries.engagement_id} = ${approvals.id}::text`)
    .where(and(
      eq(approvals.status, 'pending'),
      // deliveredHere: same channel/status/recipient/chat, and the SAME forum topic —
      // topics share one chat, so a reply in topic P must not bind an approval posted in
      // topic Q. Only rows that RECORDED their thread (key present, null for none) are
      // eligible; rows written before that could leak a topic-Q approval into General.
      deliveredHere,
      // Delivered BEFORE the human typed. On Telegram both sides are Telegram's clock (the
      // send response's `date` and the inbound message's `date`, unix seconds), so fr's own
      // write latency cannot move the comparison. A row with no recorded date is eligible
      // only in the sender's own 1:1 conversation, by its `created_at` (`deliveredAtSql`) —
      // which on mcp / email / teams / inapp is the same fr clock as the inbound time.
      sql`${deliveredAtSql(senderAddress)} <= ${messageDate}::bigint`,
    ))
    .groupBy(approvals.id, approvals.description, approvals.expires_at, approvals.kind, approvals.metadata, approvals.action_id);
  const unexpired = rows.filter((r) => !hasPassedDeadline(r.expires_at));
  // ⛔ ROUND 7b: a row the sender voted on INSIDE the correction window is not a candidate,
  // but it is still "possibly meant" — it counts like a recently-closed own decision.
  const votedRecently = inferred ? unexpired.filter((r) => r.own_vote_recent === true) : [];
  // ⛔ ROUND 7c: a row voted on BEFORE the window is not a candidate either — but it is no
  // longer dropped in SQL, so the "newest thing here" check below can still see it.
  const votedOld = inferred ? unexpired.filter((r) => r.own_vote_any === true && r.own_vote_recent !== true) : [];
  const open = inferred ? unexpired.filter((r) => r.own_vote_any !== true) : unexpired;
  const eligible = open;
  // ⛔ ROUND 7c: the same for a row the sender voted on long ago that is still pending on a
  // co-approver: delivered AFTER the sole candidate it is the newest notification, so `1` may
  // mean it. It counts as possibly-meant (confirm path), never binds the other row silently.
  let votedOldInPlay = 0;
  if (inferred && eligible.length === 1) {
    const candidateAt = Number(eligible[0]!.delivered_at);
    const recentCutoff = messageDate - OWN_DECISION_CORRECTION_WINDOW_S;
    const inPlay = (r: { delivered_at: string }) =>
      Number(r.delivered_at) > candidateAt || Number(r.delivered_at) > recentCutoff;
    votedOldInPlay = votedOld.filter(inPlay).length;
  }

  // ⛔ "Exactly one PENDING" is not "the one the human meant": with A and B both sent
  // here, A decided by a co-approver (or expired) a minute ago, a "2 too risky" typed
  // about A would reject B. So ANY other approval delivered here that closed in the last
  // 24h makes an unaddressed reply ambiguous — INCLUDING one this sender decided
  // themselves. An "own decision before the candidate arrived" exemption was tried and
  // removed: it is inherently racy, because approving A makes the conveyor deliver B to
  // the same topic within seconds, so a corrective `2` about A would reject B. The human
  // addresses the candidate explicitly with `1 #<short id>`, and a reply that could mean
  // either one records nothing and is told so (`recentlyClosedReplyMessage`).
  //
  // ⭐ ONE NARROWING (round 6), and only for approvals the sender DECIDED THEMSELVES (voted
  // on — even if a co-approver's vote then closed it, the human knows it is not awaiting
  // them): one that closed more than OWN_DECISION_CORRECTION_WINDOW_S before the message
  // was TYPED no longer counts. The race
  // above is a CORRECTION typed seconds after the next approval arrived; minutes later the
  // human has seen fr's confirmation of A and B's notification, and the 24h rule made every
  // untagged reply in a busy topic ambiguous (the conveyor delivers B seconds after A closes,
  // all day). A co-approver's decision, a void and an expiry keep the full 24h: those the
  // human may not have noticed, which is exactly when "1" can still mean A.
  const [closed] = await db
    .select({ n: sql<number>`count(distinct ${approvals.id})::int` })
    .from(approvals)
    .innerJoin(engagementDeliveries, sql`${engagementDeliveries.engagement_id} = ${approvals.id}::text`)
    .where(and(
      deliveredHere,
      // Closed in the last 24h — OR past its deadline but not yet reaped (the expiry
      // worker ticks every ~15 min): from the human's side that one has expired too.
      // The past-deadline arm is bounded too: without it ONE stale unreaped row blocked
      // every untagged reply in the chat forever.
      sql`(
        (${approvals.status} <> 'pending'
          AND coalesce(${approvals.completed_at}, ${approvals.voided_at}, ${approvals.updated_at}) > now() - interval '24 hours')
        OR (${approvals.status} = 'pending' AND ${approvals.expires_at} IS NOT NULL AND ${approvals.expires_at} <= now()
          AND ${approvals.expires_at} > now() - interval '24 hours')
      )`,
      sql`NOT (
        ${approvals.status} <> 'pending'
        -- ⛔ On TELEGRAM's clock (the message's own \`date\`), never now(): a reply typed 30 s
        -- after the decision but PROCESSED minutes later (a Telegram retry after a deploy kill,
        -- an fr outage) must still count as a possible correction.
        -- ⛔ AND INDEPENDENT OF THE SESSION TimeZone. \`completed_at\` / \`updated_at\` are
        -- timestamp WITHOUT time zone holding UTC wall time (every decision seat writes
        -- completed_at as a JS Date through drizzle; the expiry worker writes now() in the
        -- session zone, which is UTC for fr — measured 2026-10-02 — and an expired row is not
        -- an own decision anyway). Compared
        -- bare against a timestamptz, Postgres reads them in the SESSION zone, so a session
        -- ahead of UTC made every own decision look hours old and silently disabled this
        -- 5-minute window (a reviewer measured 6/13 red under Asia/Tokyo). The 24h arm above
        -- absorbs such an offset; a 300 s window cannot. \`voided_at\` is already timestamptz.
        AND coalesce(
          ${approvals.completed_at} AT TIME ZONE 'UTC',
          ${approvals.voided_at},
          ${approvals.updated_at} AT TIME ZONE 'UTC'
        ) <= to_timestamp(${messageDate}::bigint - ${OWN_DECISION_CORRECTION_WINDOW_S})
        AND EXISTS (
          SELECT 1 FROM ${approvalDecisions}
          WHERE ${approvalDecisions.approval_id} = ${approvals.id}
            AND ${inArray(approvalDecisions.approver_id, userIds)}
        )
      )`,
    ));

  return {
    eligible: eligible.map((r) => ({ id: r.id, description: r.description ?? '', kind: r.kind, metadata: r.metadata, action_id: r.action_id })),
    recentlyClosed: (closed?.n ?? 0) + votedRecently.length + votedOldInPlay,
  };
}

/**
 * Pending, unexpired approvals delivered (status `sent`) to this sender's linked user in
 * ANY chat, before the message was typed. DM-ONLY consumer (`resolveUnquotedReply`): an
 * approval posted to a group topic could not be decided from the DM, because every other
 * read filters on the reply's chat. A group message never calls this, so it can never
 * reach a DM-delivered row.
 */
async function findPendingForRecipientAnywhere(
  channel: string,
  senderAddress: string,
  messageDate: number | null,
  /** Same meaning as in `findEligibleUnquotedApprovals`: false for an explicit `#id`. */
  inferred = true,
): Promise<UnquotedCandidate[]> {
  if (!messageDate || messageDate <= 0) return [];
  const userIds = await findUserIdsByChannelAddress(channel, senderAddress);
  if (userIds.length === 0) return [];
  const rows = await db
    .selectDistinct({
      id: approvals.id,
      description: approvals.description,
      expires_at: approvals.expires_at,
      kind: approvals.kind,
      metadata: approvals.metadata,
      action_id: approvals.action_id,
    })
    .from(approvals)
    .innerJoin(engagementDeliveries, sql`${engagementDeliveries.engagement_id} = ${approvals.id}::text`)
    .where(and(
      eq(approvals.status, 'pending'),
      eq(engagementDeliveries.channel, channel),
      eq(engagementDeliveries.status, 'sent'),
      inArray(engagementDeliveries.recipient_user_id, userIds),
      sql`${deliveredAtSql(senderAddress)} <= ${messageDate}::bigint`,
      // Never binds (it only lists, or resolves an explicit #id with inferred=false): same
      // time-bounded vote rule as the here-lookup, so the two agree on what is "pending for you".
      inferred ? notVotedByOrVotedRecently(userIds, messageDate) : undefined,
    ));
  const unexpired = rows.filter((r) => !hasPassedDeadline(r.expires_at));
  return unexpired
    .map((r) => ({ id: r.id, description: r.description ?? '', kind: r.kind, metadata: r.metadata, action_id: r.action_id }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

// ⛔ `extractAnswerForId` (`[AnswerFor:<id>]`, the tag the bot's follow-up question carried)
// is DELETED with the question itself — owner ruling 2026-10-31, no channel keeps reply
// state. Nothing emits the tag any more, so nothing needs to read it; a Reply to one of
// those old messages is ordinary text and goes wherever any other reply goes.

/**
 * Does this text START like a decision — a decision head (`1`/`2`/`3`, approve, reject,
 * yes, ok, no, info, question, or the menu echo `2 - Reject`) followed by the end of the
 * text, whitespace, punctuation, an emoji or a delimiter (anything but a letter/digit, so
 * `nothing to add`, `okay`, `10 people` and `2nd` are not) — or contain the footer's
 * placeholder or one of its annotations? Used ONLY to stop an unparseable message from
 * being recorded as an answer; it never makes anything a decision.
 */
const DECISION_HEAD = /^(?:[123]\s*[-\u2013\u2014]\s*(?:approve|reject|need more info)|[123]|approve|reject|yes|ok|no|info|question)(?![\p{L}\p{N}_])/iu;
function looksLikeDecisionAttempt(text: string): boolean {
  const t = text.trim();
  if (DECISION_HEAD.test(t)) return true;
  if (t.toLowerCase().includes(FOOTER_ANSWER_PLACEHOLDER.toLowerCase())) return true;
  return containsFooterAnnotation(t);
}

/**
 * ⛔ THE ONE DEFINITION OF "THIS MESSAGE IS FOR THE APPROVAL FLOW" (the synchronous part;
 * there is deliberately no per-channel state that adds anything to it). `runChannelTurn`
 * consults it BEFORE offering a message to the E-7 agent dispatcher, and
 * `channels/telegram.ts`'s `parseWebhook` delegates to it — there is no second word list.
 *
 * True when the message carries an `[ApprovalId:…]` tag (quoted or
 * inline), or when its text — with an inline tag and a head `#<short id>` removed — is
 * anything the handler treats as a decision attempt: what `parseDecision` reads, what
 * `looksLikeDecisionAttempt` refuses as an unreadable one (`1.`, `Approve!`, `Approve 👍`,
 * `2 - Reject?`, a pasted footer line), or the pasted answer placeholder. Every one of
 * those gets an answer from this flow (a decision, a bind, or a sentence saying why
 * nothing was recorded); handed to the agent instead, the human's decision went nowhere.
 *
 * Deliberately broad on the decision HEAD and nothing else: `ok thanks` or `no idea` stay
 * with the approval handler (as they did under the old keyword list), where an unaddressed
 * group message is still answered only when it is the narrow untagged grammar. Ordinary
 * chatter ("hello bot, what's the status?") is not claimed.
 */
// ⛔ THE CLAIM IS origin/main's KEYWORD RULE, VERBATIM, PLUS ONLY WHAT IT DROPPED BY ACCIDENT.
// Two fresh validators returned NO on broader heads: `No, I meant…`, `Yes, show me…`, `Ok!`,
// then `1.5 hours left?`, `1,000 users…`, `1) deploy`, `(1) first item`, `see #deadbeef12
// please` were all newly taken from the agent and answered "I couldn't match that message".
// So: (1) the pre-r5 rule from channels/telegram.ts (whole message, or the word followed by
// whitespace or a `: | – — -` delimiter) — unchanged; (2) the SAME rule after stripping
// TRAILING noise only (`1.`, `Approve!`, `Approve 👍` — stripTrailingNoise, the handler's own
// helper); (3) the same rule on the remainder of a `#<short id>` placed at the very START or
// END (the documented `1 #id` / `#id 1` forms), never one buried mid-sentence.
const LEGACY_DECISION_KEYWORDS = ['1', '2', '3', 'approve', 'reject', 'yes', 'no', 'ok', 'info', 'question'];
function legacyKeywordReply(text: string): boolean {
  const t = text.trim().toLowerCase();
  for (const kw of LEGACY_DECISION_KEYWORDS) {
    if (t === kw || t.startsWith(kw + ' ')) return true;
    if (t.startsWith(kw) && /^[:|\u2013\u2014-]/.test(t.slice(kw.length))) return true;
  }
  return false;
}
const MENU_WORD = /^(?:[123]|approve|reject)$/i;
const EDGE_SHORT_REF = /^#[0-9a-f]{8}\s+(.+)$|^(.+?)\s+#[0-9a-f]{8}$/i;

export function looksLikeApprovalTraffic(input: { quotedText?: string; messageText: string }): boolean {
  const { quotedText, messageText } = input;
  if (extractApprovalId(quotedText, messageText) !== null) return true;
  // fr-agui SPEC §5.2 (P): `approve|reject <approval id>` with no tag NAMES its approval, and
  // it is exactly what the reply to a channel-parked write (`start …`) tells the sender to
  // send. It belongs to the channel dispatcher's `approvals.decide` — the same seat, roster
  // and §6.5 tenant checks as on every other channel — not to this handler, whose untagged
  // grammar would read the id as a comment and could not match it ("I couldn't match that
  // message", measured: the P0a `approve <id>` never decided on Telegram). With dispatch
  // off the dispatcher returns null and this handler still answers it, as before.
  if (isExplicitApprovalIdCommand(messageText)) return false;
  const text = stripApprovalTag(messageText).trim();
  if (!text) return false;
  const edge = text.match(EDGE_SHORT_REF);
  const cores = edge ? [text, (edge[1] ?? edge[2] ?? '').trim()] : [text];
  // Trailing noise is stripped ONLY to recover an exact menu word (`1.`, `Approve!`, `2 👍`):
  // `Ok!` / `Yes!` / `No!` stay chat, as on origin/main.
  return cores.some((c) => legacyKeywordReply(c) || MENU_WORD.test(stripTrailingNoise(c).trim()));
}

/**
 * Pure decision over the eligible set. Exactly one match binds; 2+ is ambiguous; 0 is
 * none. A `#prefix` narrows the set first but can only ever pick from it — it is an
 * address within what this sender was sent here, never a lookup of arbitrary rows.
 */
export function chooseUnquotedCandidate(
  eligible: UnquotedCandidate[],
  prefix: string | null,
  recentlyClosed = 0,
): UnquotedResolution {
  const matched = prefix
    ? eligible.filter((c) => c.id.toLowerCase().startsWith(prefix.toLowerCase()))
    : eligible;
  // An explicit `#id` names the approval, so recent history cannot make it ambiguous.
  if (matched.length === 1 && !prefix && recentlyClosed > 0) {
    return { kind: 'recently-closed', candidate: matched[0]! };
  }
  if (matched.length === 1) return { kind: 'bound', candidate: matched[0]! };
  if (matched.length > 1) return { kind: 'ambiguous', candidates: matched };
  return { kind: 'none' };
}

/** The eligible set for an unquoted reply, resolved against ONE channel's deliveries.
 * `isDirectChat` is the transport's own answer (a chat that is provably 1:1 with the
 * sender): only there may a bare `#id` reach approvals delivered in ANOTHER chat. */
export async function resolveUnquotedReply(
  channel: string,
  senderAddress: string,
  chatKey: string,
  threadId: number | null,
  messageDate: number | null,
  prefix: string | null,
  isDirectChat: boolean,
): Promise<UnquotedResolution> {
  let lookup: UnquotedLookup;
  try {
    // ⛔ The round-7 inference filters apply ONLY when no `#id` names the approval.
    lookup = await findEligibleUnquotedApprovals(channel, senderAddress, chatKey, threadId, messageDate, prefix === null);
  } catch (err) {
    // Fail closed: a lookup we could not complete binds nothing, and the caller falls
    // through to the ordinary "couldn't match" answer.
    console.error('[channel-reply] untagged-reply lookup failed:', err);
    return { kind: 'none' };
  }
  if (lookup.unlinked) return { kind: 'unlinked' };

  const resolution = chooseUnquotedCandidate(lookup.eligible, prefix, lookup.recentlyClosed);
  // ⛔ PRIVATE CHAT ONLY from here on. A group message never reaches rows delivered
  // elsewhere (it would let anyone's chatter in a group land on a DM-delivered row).
  if (!isDirectChat) return resolution;
  // A head `#prefix` in the DM is an explicit address, so it may reach this recipient's
  // approvals delivered in ANY chat (a group topic cannot be answered from the DM
  // otherwise). Unique among all of them, or nothing. No recently-closed rule: it names one.
  // A bare form that found nothing here may point at those, but never binds to them.
  if (!prefix && resolution.kind !== 'none') return resolution;
  let anywhere: UnquotedCandidate[];
  try {
    anywhere = await findPendingForRecipientAnywhere(channel, senderAddress, messageDate, prefix === null);
  } catch (err) {
    console.error('[channel-reply] any-chat lookup failed:', err);
    return resolution;
  }
  if (prefix) {
    const byId = new Map<string, UnquotedCandidate>();
    for (const c of [...lookup.eligible, ...anywhere]) byId.set(c.id, c);
    return chooseUnquotedCandidate([...byId.values()], prefix, 0);
  }
  if (anywhere.length === 0) return resolution;
  return { kind: 'elsewhere', candidates: anywhere.slice(0, 5), total: anywhere.length };
}

/**
 * `#2bdc6219` — an 8+ hex-char approval id prefix anywhere in the message. Returns the
 * prefix and the message with the token removed (so `2 #2bdc6219 too risky` parses as
 * `2 too risky`). The `#` is required so a bare hex-looking word is never an address.
 */
export function extractShortRef(text: string): { prefix: string; rest: string } | null {
  // Only at the HEAD of the message — first token, or right after the decision token —
  // so a `#deadbeef1` quoted inside an answer is never stripped out of the recorded
  // comment, nor allowed to pick which approval is bound.
  const t = text.trim();
  const m = t.match(/^((?:\S+\s+)?)#([0-9a-f]{8,36})(?=\s|$|[:|])/i);
  if (!m) return null;
  const rest = (m[1]! + t.slice(m[0]!.length)).replace(/[ \t]{2,}/g, ' ').trim();
  return { prefix: m[2]!.toLowerCase(), rest };
}

/**
 * The grammar an UNTAGGED message must match before it may bind to an approval.
 * Deliberately narrower than `parseDecision` (which still governs tagged replies), and
 * narrower again in a GROUP, where people talk to each other:
 *   * DM (every message is addressed to the bot): bare `1`/`2`/`3`/`approve`/`reject`, the
 *     menu echo, or a number/keyword + explicit delimiter + text (`1: x`, `2 - x`).
 *   * GROUP: bare `1` / `approve`, the menu echo (`1 - Approve`, `2 - Reject …`,
 *     `3 - Need more info …`), and KEYWORD + delimiter + text (`approve: x`,
 *     `reject: x`). NOT bare `2`/`3`, NOT `2 - 3 days`, NOT `1 - 2` — digits alone are
 *     ordinary answers to ordinary questions.
 *   * Never `ok`, `yes`, `no …`, `info`, `question`.
 * A message carrying a `#<hex>` id we could not use as an address (not at the head) is
 * refused: the human named an approval, so binding a different one would be a guess.
 * With a usable head `#short id` the human addressed deliberately: full grammar.
 */
const UNTAGGED_BARE = /^(?:1|2|3|approve|reject)$/i;
const UNTAGGED_DELIMITED = /^(?:1|2|3|approve|reject)(?:\s*[:|]|\s*[–—]|\s+-)\s*\S/i;
const UNTAGGED_GROUP_BARE = /^(?:1|approve)$/i;
const UNTAGGED_GROUP_KEYWORD = /^(?:approve|reject)(?:\s*[:|]|\s*[–—]|\s+-)\s*\S/i;

function isUntaggedDecisionForm(
  text: string,
  ctx: { addressed: boolean; isDirectChat: boolean },
): boolean {
  if (isQualifiedBareForm(text)) return false;
  // A pasted `approve: <your answer>` template is not a decision form (it records nothing).
  if (isPastedAnswerPlaceholder(text)) return false;
  if (ctx.addressed) return true;
  const t = cleanDecisionText(text);
  if (/#[0-9a-f]{8,}/i.test(t)) return false;
  const normalized = normalizeMenuEcho(t);
  if (normalized === 'contradictory' || normalized === 'undelimited') return false;
  // A STATUS line ("1. Approved", "2) Rejected") is a report, not a decision.
  if (/^[123]\s*[-\u2013\u2014.)]\s*(?:approved|rejected)(?!\w)/i.test(t)) return false;
  if (isMenuEcho(t)) return true;
  if (ctx.isDirectChat) return UNTAGGED_BARE.test(t) || UNTAGGED_DELIMITED.test(t);
  return UNTAGGED_GROUP_BARE.test(t) || UNTAGGED_GROUP_KEYWORD.test(t);
}

/** Would this unquoted GROUP message have been taken as a decision attempt? Same gate the
 * bind path uses, so the "couldn't match" answer and the bind can never disagree. */
function isGroupDecisionAttempt(text: string): boolean {
  const shortRef = extractShortRef(text);
  const candidate = shortRef ? shortRef.rest : text;
  return isUntaggedDecisionForm(candidate, { addressed: shortRef !== null, isDirectChat: false }) &&
    parseDecision(candidate) !== null;
}

/**
 * `1.`, `Approve!`, `1 - Approve 👍` → the bare form. Measured: phones add a period or an
 * emoji, and `1 - Approve.` then APPROVED WITH ANSWER "Approve." while `Approve.` parsed to
 * nothing. Stripped ONLY when what remains is a bare form or the bare menu echo, so the
 * period in `1: looks good.` is kept as part of the answer.
 * ⛔ Only whitespace, `.`, `!` and an ALLOWLIST of affirmative emoji are noise. `?` and any
 * other emoji (👎, ❌) change the meaning: `Approve?` is a question, not an approval.
 */
const ALLOWED_NOISE = /(?:[\s.!]|(?:\u{1F44D}|\u2705|\u2714|\u{1F44C}|\u{1F64F})[\u{1F3FB}-\u{1F3FF}]?\uFE0F?)+$/u;
const ANY_NOISE = /[\s.!?,;\u200D\uFE0F\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Emoji_Modifier}]+$/u;
const NOISE_STRIPPABLE = /^(?:1|approve|yes|ok|[123]\s*[-–—]\s*(?:approve|reject|need more info))$/i;
function stripTrailingNoise(text: string): string {
  const t = text.trim();
  const stripped = t.replace(ALLOWED_NOISE, '');
  if (stripped === t) return t;
  return NOISE_STRIPPABLE.test(stripped) ? stripped : t;
}

/** A reason that is nothing but punctuation (`?`, `—`, `...`) is not a reason. */
const ONLY_PUNCTUATION = /^[\p{P}\s]*$/u;

/**
 * A trailing SAD emoticon: `:(`, `:-(`, `:'(`, ☹(️), 🙁, 😞.
 * ⛔ fr#1341: `1 :(` and `Approve :(` APPROVED with answer "(" — `APPROVE_WITH_ANSWER`
 * read `1 :` as its delimiter. A frown qualifies a bare form exactly like 👎 does. Only
 * consulted by `isQualifiedBareForm`, i.e. only when what is left is a BARE form, so an
 * explicit answer (`approve: fine :(`) is untouched and keeps its emoticon.
 */
const SAD_EMOTICON_TAIL = /\s*(?:[:;](?:-|['’])?\(+|☹️?|\u{1F641}|\u{1F61E})\s*$/u;

/** A bare form QUALIFIED by `?`, a non-affirmative emoji or a frown (`Approve?`, `1 👎`,
 * `1 - Approve ❌`, `1 :(`): never a decision, in any chat, tagged or not. */
function isQualifiedBareForm(text: string): boolean {
  const t = stripFooterAnnotation(text).trim();
  let core = t;
  for (let prev = ''; prev !== core; ) {
    prev = core;
    core = core.replace(ANY_NOISE, '').replace(SAD_EMOTICON_TAIL, '');
  }
  if (core === t || !NOISE_STRIPPABLE.test(core)) return false;
  return stripTrailingNoise(t) !== core;
}

/**
 * A footer line pasted back: `1 - Approve   (accepts the reviewer's recommendation: …)`.
 * The parenthetical is dropped ONLY when it is exactly one of the adapter's own
 * annotations (imported, never retyped), leaving the bare menu echo. Otherwise the
 * annotation was the approve's ANSWER — on a BLOCKED row, the opposite of what it says.
 */
function stripFooterAnnotation(text: string): string {
  const t = text.trim();
  const m = t.match(/^([\s\S]*?)\s*\(([^()]*)\)$/);
  if (!m) return t;
  const norm = (s: string) => s.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
  const inner = norm(m[2]!);
  return FOOTER_APPROVE_ANNOTATIONS.some((a) => norm(a) === inner) ? m[1]!.trim() : t;
}

/** Both normalisations, footer first (its annotation ends in `)`, which is not noise). */
function cleanDecisionText(text: string): string {
  return stripTrailingNoise(stripFooterAnnotation(text));
}

export function shortId(id: string): string {
  return id.slice(0, 8);
}

function firstLine(description: string): string {
  const line = description.replace(/^\[n8n\]\s*/, '').split('\n')[0]!.trim();
  return line.length > 90 ? `${line.slice(0, 87)}...` : line;
}

/** The line naming the approval an untagged reply concerned, when it was NOT recorded: the
 * refusal follows it. */
function untaggedSubjectLine(c: UnquotedCandidate, how: 'untagged' | 'named'): string {
  if (how === 'untagged') {
    return `Your reply did not quote an approval; the only pending approval sent to you in this ` +
      `chat is #${shortId(c.id)} — ${firstLine(c.description)}`;
  }
  return `Your reply named #${shortId(c.id)} — ${firstLine(c.description)}`;
}

function boundWithoutTagMessage(c: UnquotedCandidate): string {
  return (
    `Your reply did not quote an approval, so I applied it to the only pending approval ` +
    `sent to you in this chat: #${shortId(c.id)} — ${firstLine(c.description)}`
  );
}

/** At most this many candidates are listed; the rest are counted. Uncapped, ~38 approvals
 * pushed the reply past Telegram's 4096-character limit and it was rejected (400), so the
 * human heard NOTHING. Same cap as `elsewhereReplyMessage`. */
const MAX_LISTED_CANDIDATES = 5;

function ambiguousReplyMessage(candidates: UnquotedCandidate[], prefix: string | null, typed = true): string {
  const shown = candidates.slice(0, MAX_LISTED_CANDIDATES);
  const lines = shown.map((c) => typed
    ? `#${shortId(c.id)} — ${firstLine(c.description)}`
    : `#${shortId(c.id)} — ${firstLine(c.description)}: ${frApprovalLink(c.id)}`);
  const more = candidates.length > shown.length
    ? `\n(+${candidates.length - shown.length} more — see them in fr)`
    : '';
  return (
    `Nothing was recorded: ${prefix ? `#${prefix} matches` : 'you have'} ${candidates.length} ` +
    `pending approvals in this chat, so I can't tell which one you meant.\n\n` +
    `${lines.join('\n')}${more}\n\n` +
    (typed
      ? `Tap Reply ON the approval notification, or include its id, e.g. ` +
        `\`1 #${shortId(candidates[0]!.id)}\` or \`2 #${shortId(candidates[0]!.id)} reason\`.`
      : `A typed reply here cannot decide an agent action. Decide them in fr (links above).`)
  );
}

function recentlyClosedReplyMessage(c: UnquotedCandidate, typed = true): string {
  const why = `another approval sent to you in this chat was decided or ` +
    `expired in the last 24 hours, so a reply that doesn't quote one could mean either.`;
  return (
    `Nothing was recorded: ${why}\n\n` +
    `The one still pending is #${shortId(c.id)} — ${firstLine(c.description)}\n\n` +
    (typed ? `Tap Reply ON its notification, or send e.g. \`1 #${shortId(c.id)}\`.` : typedReplyCannotDecideLine(c.id))
  );
}

function unknownShortRefMessage(prefix: string): string {
  return (
    `Nothing was recorded: no pending approval sent to you in this chat has an id ` +
    `starting with #${prefix}.\n\n` +
    'Tap Reply ON the approval notification (so its [ApprovalId:…] tag is quoted), or decide it in fr.'
  );
}

/** One text for "this Telegram id maps to no approver" — the untagged path and
 * `processDecision` must not tell the same human two different things. */
const NOT_LINKED_MESSAGE =
  'Your Telegram account is not linked to an authorized approver for this request.';

function elsewhereReplyMessage(candidates: UnquotedCandidate[], total: number, typed = true): string {
  const lines = candidates.map((c) => typed
    ? `#${shortId(c.id)} — ${firstLine(c.description)}`
    : `#${shortId(c.id)} — ${firstLine(c.description)}: ${frApprovalLink(c.id)}`);
  const more = total > candidates.length ? `\n(+${total - candidates.length} more)` : '';
  return (
    `Nothing was recorded: no pending approval was sent to you in this chat, but you have ` +
    `${total} pending in another chat (e.g. a project group):\n\n` +
    `${lines.join('\n')}${more}\n\n` +
    (typed
      ? `To decide one from here, include its id, e.g. \`1 #${shortId(candidates[0]!.id)}\` or ` +
        `\`2 #${shortId(candidates[0]!.id)} reason\`.`
      : `A typed reply here cannot decide an agent action. Decide them in fr (links above).`)
  );
}

/**
 * Extract [ApprovalId:uuid] from text. Quoted (replied-to) text first — that's
 * the most reliable anchor when a user taps "Reply" on the approval message.
 */
export function extractApprovalId(quotedText?: string, messageText?: string): string | null {
  const pattern = /\[ApprovalId:([0-9a-f-]{36})\]/i;
  if (quotedText) {
    const match = quotedText.match(pattern);
    if (match) return match[1] ?? null;
  }
  if (messageText) {
    const match = messageText.match(pattern);
    if (match) return match[1] ?? null;
  }
  return null;
}

/**
 * Strip the inline `[ApprovalId:…]` tag before handing text to `parseDecision`.
 *
 * ⛔ WHY THIS EXISTS. `extractApprovalId` reads the tag from TWO places: quoted
 * (reply) text, or — the fallback used whenever the client doesn't set
 * `reply_to_message`, e.g. an n8n forwarder that drops it, or a user pasting the
 * notification back — the message body itself. `channels/telegram.ts ::
 * looksLikeApprovalReply` documents that second shape as a legitimate,
 * deliberately-supported input: "a quoted/inline `[ApprovalId:…]` tag". But when
 * the tag lands in the message body, it trails whatever the user typed (e.g.
 * `"1 [ApprovalId:…]"`), and `parseDecision`'s token matches (`t === '1'`, the
 * `^…(\s|$)` anchors) can never succeed against that trailing text — the message
 * reads as unrecognised and NOTHING is decided, even though the decision was
 * perfectly clear. Applying this before `parseDecision` (and before it captures a
 * reject/need-info reason, so the tag does not leak into the stored comment
 * either) restores the fallback `extractApprovalId` already promises to support.
 */
export function stripApprovalTag(text: string): string {
  return text.replace(/\[ApprovalId:[0-9a-f-]{36}\]/i, '').trim();
}

/**
 * What fr says when a message could not be matched to any approval.
 *
 * ⛔ IT NAMES THE FIX, NOT JUST THE FAILURE. "Could not match" on its own leaves the
 * human with no next move — and the next move is cheap and specific: tap Reply ON the
 * notification (which quotes the `[ApprovalId:…]` tag `extractApprovalId` reads), or
 * paste that tag into the message (the inline fallback `extractApprovalId` already
 * supports, and `stripApprovalTag` exists to make usable), or decide it in fr. The
 * third exit is always available, which is the property every refusal in this file
 * keeps: a refused decider is never left without a legitimate move.
 *
 * Deliberately says NOTHING about which approval was meant. This branch reached us
 * precisely because we cannot attribute the message; guessing "you probably meant
 * approval X" on a channel with no identity binding would be the bypass wearing the
 * shape of a helpful hint.
 */
export function unmatchedReplyMessage(): string {
  return (
    "I couldn't match that message to an approval, so nothing was recorded.\n\n" +
    'Tap Reply ON the approval notification (so its [ApprovalId:…] tag is quoted) and ' +
    'send your decision again, or include that tag in your message, or decide it in fr.'
  );
}

/**
 * Parse a decision from message text. Channel-agnostic grammar — this is the ONE copy, the
 * same one every text channel's reply is read with:
 *   "1" / approve / yes / ok        → approved
 *   "2 reason" / reject / bare no / "no: reason" → rejected with feedback
 *   "3 question" / info / question  → need-info (recorded as reject w/ question)
 *
 * ⛔ The reject and need-info tokens are WHOLE-TOKEN matches. Do NOT
 * "simplify" them back to `t.startsWith('no')` / `t.startsWith('2')` /
 * `t.startsWith('info')`. Prefix matching silently turned ordinary prose into
 * a REJECTION on a live approval gate: "Note: this looks fine" and "Nothing
 * blocking here" both start with "no", "November deadline is fine" does too,
 * "20 minutes late but ok" starts with "2", and "informally approved" starts
 * with "info". A message only has to carry the `[ApprovalId:…]` anchor to be
 * acted on, so a reviewer typing a reassuring sentence rejected the request.
 * The token must now be the entire message or be followed by whitespace.
 *
 * ⛔ `no` IS NARROWER STILL (fr#1341). Whole-token was not enough for it: `no blockers,
 * ship it`, `No problem, go ahead` and `no migration` all REJECTED — the opposite of what
 * the human meant. `no` is now a reject ONLY as the whole message (`no`, `No.`, `no!` —
 * trailing `.`/`!`/space stripped for that check only) or followed by an explicit
 * delimiter (`no: too risky`, `no - x`, `no | x`, `no — x`; `REJECT_WITH_REASON`).
 * `no <words>` with no delimiter is NOT a decision (null). `2 …` and `reject …` keep the
 * whole-token rule. Do not put `no` back into `REJECT_TOKEN`.
 *
 * ⛔ THE BARE APPROVE BRANCH IS STILL AN EXACT-MATCH EQUALITY TEST, AND MUST STAY ONE.
 * `APPROVE_WITH_ANSWER` below does NOT loosen it — see that constant's own note.
 */
const REJECT_TOKEN = /^(2|reject)(\s|$)/i;
const NEED_INFO_TOKEN = /^(3|info|question)(\s|$)/i;
const REJECT_WITH_REASON = /^(?:reject|no)(?:\s*[:|]|\s*[\u2013\u2014]|\s+-)\s*(\S[\s\S]*)$/i;
/** `no`, `No.`, `no!` — the whole message. Trailing `.`/`!`/space only; `no?` is a question. */
const BARE_NO = /^no[.!\s]*$/i;

/**
 * Approve AND carry the answer, in one message: `approve: <text>`.
 *
 * ⛔ WHY THIS EXISTS. Measured on prod 2026-09-15: the product owner tried to complete a
 * QUESTION row from a phone by typing "approve — the vendor confirmed Tuesday". That
 * matched NOTHING — not the equality test (the string is not `approve`), not
 * `REJECT_TOKEN`, not `NEED_INFO_TOKEN` — so the reply parsed to `null` and fr answered
 * "Didn't understand". The `answerlessApproveDemand` guard below is CORRECT to refuse a
 * bare `approve` on a row that owes an answer, but until now this seat had no way to
 * SUPPLY one either, and the refusal's own sentence conceded it ("approve it in fr").
 * A gate with no on-channel exit is a strand dressed as a guard.
 *
 * ⛔ WHY A DELIMITER, AND NOT `^(1|approve|yes|ok)(\s|$)` LIKE THE OTHER TWO TOKENS.
 * The whole-token form would ALSO accept, as approvals, the exact strings the existing
 * test pins as NOT-approvals: `1 with caveats`, `yes but only if`, `approved by me`.
 * Those are hedges and prose, and the file's standing rule — "loosening an APPROVAL path
 * is the one change that would make this worse" — is what stops them closing a live gate.
 * Requiring an explicit separator keeps every one of those `null` while accepting an
 * unmistakably deliberate `approve: …`. The delimiter is the consent, not the keyword.
 *
 * Accepted separators, and why each: `:` (the canonical form we tell people to use),
 * `|`, an en/em dash `–`/`—` (what a phone keyboard autocorrects ` - ` into, and the
 * exact character in the measured message), and a SPACED hyphen ` - `. An UNSPACED
 * hyphen is deliberately NOT a separator, so `yes-ish` stays a hedge and not an approval.
 *
 * The captured group is the answer VERBATIM — matched against the trimmed original, not
 * the lower-cased copy, so the recorded text keeps the human's own capitalisation.
 * It requires a leading `\S`, so `approve:` with nothing after it is not an approval at
 * all: it falls through to `null` and gets the grammar help, rather than silently
 * degrading into the bare approve this form exists to avoid.
 */
const APPROVE_WITH_ANSWER = /^(?:1|approve|yes|ok)(?:\s*[:|]|\s*[\u2013\u2014]|\s+-)\s*(\S[\s\S]*)$/i;

/**
 * The notification's own menu, echoed back: `1 - Approve`, `2 - Reject …`,
 * `3 - Need more info …`.
 *
 * ⛔ WHY THIS EXISTS. Measured on prod 2026-10-01: the product owner copied the menu line
 * `1 - Approve`. `APPROVE_WITH_ANSWER` read the spaced hyphen as its delimiter and would
 * have recorded the LABEL "Approve" as the answer to a QUESTION row — satisfying the
 * answer guard with text that answers nothing. The label is stripped so the line means
 * exactly its number; anything typed after the label is kept (`1 - Approve: <answer>`).
 *
 * ⛔ A number and a label that DISAGREE (`1 - Reject`) is contradictory and returns
 * `'contradictory'`; without this check `1 - Reject` would APPROVE with answer "Reject".
 */
// `3 - Question` is the round-6 footer label; `need more info` stays for older notifications.
const MENU_ECHO = /^([123])\s*[-–—.)]\s*(approved?|reject(?:ed)?(?:\s*\(include reason after number\))?|need more info|question)(?!\w)/i;

/** True only when `normalizeMenuEcho` actually rewrote the line as a menu echo. */
export function isMenuEcho(text: string): boolean {
  const n = normalizeMenuEcho(text);
  return n !== 'contradictory' && n !== 'undelimited' && n !== text.trim();
}

const MENU_CONTRADICTION = /^(?:1\s*[-\u2013\u2014.)]\s*reject|2\s*[-\u2013\u2014.)]\s*approv)/i;

export function normalizeMenuEcho(text: string): string | 'contradictory' | 'undelimited' {
  const trimmed = text.trim();
  // Any reject-word after `1 -` (or approve-word after `2 -`) is a contradiction, never
  // an approval carrying "Rejection…" as its answer. Safe direction only: it can turn an
  // approval into nothing, never anything into an approval.
  if (MENU_CONTRADICTION.test(trimmed)) return 'contradictory';
  const m = trimmed.match(MENU_ECHO);
  if (!m) return trimmed;
  // `approved`/`rejected` count as the label so a contradiction cannot hide behind a
  // suffix (`1 - Rejected` used to approve with answer "Rejected"). The label match is
  // EXACT otherwise, and `:` is not a menu separator, so answer prose that merely starts
  // with an approve-ish word (`1: approval granted`, `1 - approve the PR …`) is untouched.
  const word = m[2]!.toLowerCase();
  const labelNumber = word.startsWith('approve') ? '1' : word.startsWith('reject') ? '2' : '3';
  if (labelNumber !== m[1]) return 'contradictory';
  const rest = trimmed.slice(m[0].length).trim();
  if (!rest) return m[1]!;
  if (m[1] === '1') {
    // `1 - Approve: x` → `1: x` (APPROVE_WITH_ANSWER). ⛔ UNDELIMITED text after the
    // label (`1 - Approve now please`, `1 - Approve\nno wait 2`) is NOT a decision: it used
    // to approve with "Approve …" as the answer, including a human's correction. The
    // answer delimiter after the echo is `:` (or `|`, a dash).
    const delimited = rest.match(/^[:|–—-]\s*(\S[\s\S]*)$/);
    return delimited ? `1: ${delimited[1]}` : 'undelimited';
  }
  // Reject / need-info take free text after a space: drop a leading delimiter so
  // `2 - Reject: bad` means `2 bad`, not an unparseable `2: bad`.
  return `${m[1]} ${rest.replace(/^[:|–—-]\s*/, '')}`.trim();
}

/**
 * The footer's `approve: <your answer>` line pasted back VERBATIM (optionally with its
 * own parenthetical annotation). That is not an answer: it is the template. Matched
 * against the adapter's exported constants only, so the two cannot drift.
 *
 * Accepts the whole line (`approve: <your answer>   (…)`) or just the captured answer
 * (`<your answer>   (…)`). ⛔ It records NOTHING: `parseDecision` returns null for it,
 * because as a bare approve it would ACCEPT the reviewer's recommendation — on a BLOCKED
 * row that is an accepted REJECT, the opposite of what the human was trying to do.
 */
export function isPastedAnswerPlaceholder(text: string): boolean {
  const norm = (x: string) => x.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const line = text.trim().match(APPROVE_WITH_ANSWER);
  const c = norm(line ? line[1]! : text);
  const placeholder = norm(FOOTER_ANSWER_PLACEHOLDER);
  // ANY occurrence inside an approve-with-answer comment (`approve: <your answer>?`,
  // `approve: <your answer> yes`): the template was pasted, never a real answer.
  if (line && c.includes(placeholder)) return true;
  if (c === placeholder) return true;
  if (!c.startsWith(placeholder)) return false;
  const m = c.slice(placeholder.length).trim().match(/^\(([^()]*)\)$/);
  return m !== null && FOOTER_ANSWER_ANNOTATIONS.some((a) => norm(a) === norm(m[1]!));
}

const BARE_APPROVE: ReadonlySet<string> = new Set(['1', 'approve', 'yes', 'ok']);

/** Does the text carry any of the adapter's exported footer annotations (imported, never
 * retyped), anywhere? */
function containsFooterAnnotation(text: string): boolean {
  const norm = (x: string) => x.replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim().toLowerCase();
  const t = norm(text);
  return [...FOOTER_APPROVE_ANNOTATIONS, ...FOOTER_ANSWER_ANNOTATIONS].some((a) => t.includes(norm(a)));
}

/** The reply to a pasted `approve: <your answer>` line. Nothing is recorded. */
const PASTED_PLACEHOLDER_MESSAGE =
  `Nothing was recorded. Replace ${FOOTER_ANSWER_PLACEHOLDER} with your actual answer, e.g. approve: ship it`;

export function parseDecision(rawText: string): { decision: 'approved' | 'rejected'; comment?: string } | null {
  if (isQualifiedBareForm(rawText)) return null;
  const text = normalizeMenuEcho(cleanDecisionText(rawText));
  if (text === 'contradictory' || text === 'undelimited') return null;
  const t = text.trim().toLowerCase();
  // A footer annotation that did NOT strip cleanly back to a bare form (`1 - Approve
  // (I'll ask for your answer)?`, an annotation with text after it) would otherwise be
  // recorded as the approve's ANSWER. The human pasted our template; never guess.
  if (containsFooterAnnotation(rawText) && !BARE_APPROVE.has(t)) return null;

  if (BARE_APPROVE.has(t)) {
    // ⛔ NO `comment` FIELD. This is load-bearing, not an omission: it is what makes
    // `answerlessApproveDemand` below still refuse a bare approve on a row that owes an
    // answer. Do not "helpfully" default it to a string.
    return { decision: 'approved' };
  }
  const withAnswer = text.trim().match(APPROVE_WITH_ANSWER);
  if (withAnswer) {
    // The captured text becomes `approval_decisions.comment` — the SAME column the fr
    // web seat writes its answer to (`routes/approvals.ts` PUT body field `comment`), and
    // the same value `answerlessApproveDemand` reads. One field, four seats.
    const comment = withAnswer[1]!.trim();
    // The footer's template pasted as-is is NOT a decision at all (`isPastedAnswerPlaceholder`).
    // It used to be a bare approve, which on a BLOCKED-recommendation row accepted the
    // recommendation — a REJECT the human never meant. The webhook answers it with
    // PASTED_PLACEHOLDER_MESSAGE.
    if (isPastedAnswerPlaceholder(comment) || isPastedAnswerPlaceholder(text.trim())) return null;
    return { decision: 'approved', comment };
  }
  // `reject: reason` / `reject - reason`: the untagged grammar has accepted these since
  // #1328 (`UNTAGGED_DELIMITED`, `UNTAGGED_GROUP_KEYWORD`) but this parser did not, so they
  // bound and then answered "Didn't understand". KEYWORD ONLY: `2: …` stays unparsed, so
  // "2:30pm" can never become a reject.
  // `no: reason` / `no - reason` joined the keyword set in fr#1341 — `no` without a
  // delimiter is no longer a reject (see `REJECT_TOKEN`'s note).
  // ⛔ A reason/question that is ONLY punctuation (`Reject ?`, `3 ?`, `reject: ?`) is not a
  // reason: it used to be recorded verbatim as the comment "?". It gets the default text.
  const delimitedReject = text.trim().match(REJECT_WITH_REASON);
  if (delimitedReject) {
    const reason = delimitedReject[1]!.trim();
    return { decision: 'rejected', comment: ONLY_PUNCTUATION.test(reason) ? REJECT_DEFAULT_REASON : reason };
  }
  if (BARE_NO.test(t)) {
    return { decision: 'rejected', comment: REJECT_DEFAULT_REASON };
  }
  if (REJECT_TOKEN.test(t)) {
    const reason = text.trim().replace(/^(2|reject)\s*/i, '').trim();
    return { decision: 'rejected', comment: ONLY_PUNCTUATION.test(reason) ? REJECT_DEFAULT_REASON : reason };
  }
  // ⛔ `3` / `info` / `question` (and the menu echo `3 - Need more info`) are NOT a decision.
  // This returned a REJECT with comment "Need more info: …" — and consensus closes an
  // approval on ANY reject (services/approval-consensus.ts), so "3 which repo?" rejected the
  // whole approval and sent n8n a rejected callback, while the notification offered `3` as a
  // neutral third option. A question cannot be passed on from this seat (approvals have no
  // comment thread), so it records NOTHING and the human is sent to fr (`isNeedInfoRequest`).
  return null;
}

/**
 * `3`, `3 <question>`, `info …`, `question …`, or the menu echo `3 - Need more info …`: the
 * human asked a question. Never a decision (see `parseDecision`); every seat that reads it
 * answers `needInfoMessage` and records nothing. Only consulted where the message is already
 * addressed to the bot (a tag, an open question, a DM, a Reply, or the group menu echo), so
 * "3 people are coming" in group chatter is never answered.
 */
export function isNeedInfoRequest(rawText: string): boolean {
  if (isQualifiedBareForm(rawText)) return false;
  const text = normalizeMenuEcho(cleanDecisionText(rawText));
  if (text === 'contradictory' || text === 'undelimited') return false;
  return NEED_INFO_TOKEN.test(text.trim().toLowerCase());
}

/** The reply to a `3` / need-more-info message. Nothing is recorded. */
export function needInfoMessage(approvalId: string | null, typed = true): string {
  const where = approvalId !== null
    ? `Approval #${shortId(approvalId)} is still pending. Ask your question in fr: ${frApprovalLink(approvalId)}`
    : `The approval is still pending. Ask your question on the approval's page in fr.`;
  return (
    `Nothing was recorded — a question is not a decision, and this chat cannot pass it on. ` +
    `${where}` +
    (typed
      ? `\n\nTo decide here instead, reply to its notification with \`1\` (approve) or \`2 <reason>\` ` +
        `(reject) — or decide it in fr.`
      : '')
  );
}

/**
 * Resolve a channel sender address to an authorized approver for this approval.
 * Looks up the user(s) who registered this address under `channel`, then
 * intersects with the approval's required approvers.
 *
 * ⛔ NO ROSTER, NO DECIDER. An approval with no `required_approvers` rows used to accept
 * `candidates[0]` — the first fr account linked to this address, in whatever order
 * the prefs read returned — as its decider. The web seat refuses exactly that row (no
 * roster row names the caller → 422), so this seat was the one place a linked stranger
 * could decide an approval nobody had assigned them. It now refuses too (null → the
 * not-linked reply). `routes/approvals.ts` records a measurement of all 1032 pending rows
 * carrying a roster of exactly one, so this should refuse no real traffic; it closes the
 * path a roster-less mint would open.
 *
 * ⛔ SEVERAL LINKED ACCOUNTS ⇒ REFUSED (P1-TEAM-c, George 2026-10-15: "an address linked
 * to several accounts is refused, never guessed"). This used to say several linked accounts
 * were normal (prod: 12 fr accounts on the owner's Telegram id) and PICKED the lowest
 * rostered one — and since P1-TEAM-c an action approval then RUNS AS that pick. When
 * `approval` is given (every decide path) the linked set is narrowed by
 * `narrowLinkedAccountsForDecision` first: several accounts decide nothing unless the row
 * is unambiguously this address's own request. The pick below is deterministic (lowest
 * roster row id, then user id) and is reached with several candidates only on the
 * approval-less ask path, which records who was ASKED, never a decision.
 */
async function findApproverForSender(
  channel: string,
  senderAddress: string,
  approvalId: string,
  /** When given, the requester guard runs over EVERY linked account (P1-TEAM-b M1). */
  approval?: RequesterGuardApproval & { tenant_id: string; action_channel?: string | null },
): Promise<string | ChatSeatRefusal | null> {
  let candidates = await findUserIdsByChannelAddress(channel, senderAddress);
  if (candidates.length === 0) return null;
  if (approval) {
    const narrowed = await narrowLinkedAccountsForDecision(candidates, approval, channel);
    if (isChatSeatRefusal(narrowed)) return narrowed;
    candidates = narrowed;
  }

  const required = await db.select()
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, approvalId));

  return chooseRosterApprover(candidates, required);
}

/** Pure: the linked candidate a roster admits, deterministically; null for an empty roster. */
function chooseRosterApprover(
  candidates: readonly string[],
  roster: ReadonlyArray<{ id: string; user_id: string }>,
): string | null {
  if (roster.length === 0) return null;
  const linked = new Set(candidates);
  const ordered = [...roster].sort((a, b) => a.id.localeCompare(b.id) || a.user_id.localeCompare(b.user_id));
  return ordered.find((r) => linked.has(r.user_id))?.user_id ?? null;
}

/**
 * P1-TEAM-b — the 1-of-any tenant-member arm (lib/chat-seat-tenant-member.ts): when no
 * linked account is on the roster, the linked account that is a member of (and homed in)
 * the approval's tenant. Null for an empty roster, a stranger, or an unverifiable read.
 */
async function findTenantMemberDeciderForSender(
  channel: string,
  senderAddress: string,
  approval: { id: string; tenant_id: string; action_id?: string | null; action_channel?: string | null } &
    RequesterGuardApproval,
): Promise<string | ChatSeatRefusal | null> {
  // ⛔ P1-TEAM-c audit 2: the SAME tenant narrowing `findApproverForSender` applied
  // (`narrowLinkedAccountsForDecision`): of several linked accounts only the one that is a
  // current member of the approval's tenant may decide here; several such ⇒ refused.
  let candidates = await findUserIdsByChannelAddress(channel, senderAddress);
  if (candidates.length === 0) return null;
  const narrowed = await narrowLinkedAccountsForDecision(candidates, approval, channel);
  if (isChatSeatRefusal(narrowed)) return narrowed;
  candidates = narrowed;
  const roster = await db.select({ id: requiredApprovers.id })
    .from(requiredApprovers)
    .where(eq(requiredApprovers.approval_id, approval.id));
  return chooseTenantMemberDecider(candidates, approval.tenant_id, roster.length, {
    approval,
  });
}

/** How long an unquoted message waits on laya before it goes on to the agent. */
const UNQUOTED_LAYA_TIMEOUT_MS = 3_000;

/** laya's approve/reject, as `interpretApprovalReply` returns it. */
type LayaReadDecision = { kind: 'approve' | 'reject'; comment?: string; layaSaysExtra: boolean };

/** Does a bare approve on this row owe an answer (a QUESTION row, a fix assertion …)? */
export function owesAnswer(approval: { metadata: unknown }): boolean {
  return answerlessApproveDemand({ decision: 'approved', comment: undefined, metadata: approval.metadata }) !== null;
}

/** What a message replies to, as `processDecision` needs it for the laya allowlist. */
type QuotedMessage = {
  /** The INBOUND chat id (never the sender fallback): undefined = unknown = not proven. */
  chatId: string | undefined;
  quotedText: string | undefined;
  replyTo: ReplyToMessage | undefined;
};

/**
 * ⭐ THE laya ALLOWLIST for a quoted Reply: TRUE only when the replied-to message is the bot's
 * OWN approval notification of `approvalId`, sent to this chat. Every condition must hold:
 *   * `reply_to_message.from.is_bot` and `from.id` equal OUR bot's id (the numeric prefix of
 *     the configured Bot-API token — never a hard-coded number; no token ⇒ not proven);
 *   * the quoted message is not itself a forward (no `forward_origin` / legacy forward field);
 *   * its text is an approval notification (`isApprovalNotificationText`);
 *   * ⭐ the strongest proof: fr's own send record — an `engagement_deliveries` row
 *     (channel telegram, type `approval`, sent) whose recorded `chatId` + `messageId` are this
 *     chat and the quoted `message_id` — names THIS approval.
 * A colleague's forwarded or pasted copy (from = the colleague), another bot's message, the
 * bot's confirm / ask / refusal (not an `approval` delivery), or a notification of another
 * approval all fail. Any lookup failure = false (fail closed: main's behaviour).
 */
async function quotesOwnNotificationOf(approvalId: string, q: QuotedMessage | undefined, channel: string): Promise<boolean> {
  const r = q?.replyTo;
  if (!q || !r || !q.chatId) return false;
  const botId = telegramBotIdFromToken(config.services.telegram.botToken);
  if (botId === null || !r.fromIsBot || r.fromId !== botId || r.isForwarded) return false;
  if (typeof r.messageId !== 'number' || !q.quotedText || !isApprovalNotificationText(q.quotedText)) return false;
  try {
    return (await findNotifiedApprovalId(channel, q.chatId, r.messageId)) === approvalId;
  } catch (err) {
    console.error('[channel-reply] notification-record lookup failed:', err instanceof Error ? err.message : err);
    return false;
  }
}

/** The approval whose notification fr sent as message `messageId` in `chatId`, from fr's
 * own send record; null when there is none (or, defensively, more than one). */
async function findNotifiedApprovalId(channel: string, chatId: string, messageId: number): Promise<string | null> {
  const md = engagementDeliveries.metadata_json;
  const rows = await db
    .selectDistinct({ id: engagementDeliveries.engagement_id })
    .from(engagementDeliveries)
    .where(and(
      eq(engagementDeliveries.channel, channel),
      eq(engagementDeliveries.engagement_type, 'approval'),
      eq(engagementDeliveries.status, 'sent'),
      sql`${md}->>'chatId' = ${chatId}`,
      sql`${md}->>'messageId' = ${String(messageId)}`,
    ))
    .limit(2);
  return rows.length === 1 ? rows[0]!.id ?? null : null;
}

async function loadApproval(id: string): Promise<typeof approvals.$inferSelect | null> {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, id));
  return row ?? null;
}

/**
 * May this channel's sender decide `approval` from this seat? The SAME resolution
 * `processDecision` runs (roster, then the tenant-member arm, each refusal = no), plus the
 * requester guard. Read-only and silent: used to decide whether laya may be asked at all.
 * Any failure = no (fail closed: the message goes on as if laya did not exist).
 */
async function senderDecider(channel: string, senderAddress: string, approval: typeof approvals.$inferSelect): Promise<string | null> {
  try {
    let decider = await findApproverForSender(channel, senderAddress, approval.id, approval);
    if (isChatSeatRefusal(decider)) return null;
    if (!decider) {
      const member = await findTenantMemberDeciderForSender(channel, senderAddress, approval);
      if (isChatSeatRefusal(member)) return null;
      decider = member;
    }
    return typeof decider === 'string' ? decider : null;
  } catch {
    return null;
  }
}

/**
 * ⛔ THE ONLY WAY fr ASKS laya (sixth audit). The request is built from exactly ONE approval —
 * the one being decided — and the licence used is THAT approval's tenant. There is no way to
 * pass a second approval's text or another tenant: another tenant's data never leaves it.
 */
export function askLayaAbout(
  approval: Pick<typeof approvals.$inferSelect, 'tenant_id' | 'description'>,
  reply: string,
  opts: { allowUnrelated: boolean; timeoutMs?: number },
): ReturnType<typeof interpretApprovalReply> {
  return interpretApprovalReply({
    tenantId: approval.tenant_id,
    request: approval.description ?? '',
    reply,
    allowUnrelated: opts.allowUnrelated,
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
}

type LayaUnquotedOutcome =
  /** Exactly one approval: laya read a decision on it; the handler records it (R325). */
  | { kind: 'bound'; candidate: UnquotedCandidate; read: LayaReadDecision }
  /** One pending plus a recently closed one: the human was told which one is pending. */
  | { kind: 'answered'; why: 'recently_closed' }
  /** laya WAS called and did not read a decision (or the call failed): final — nothing may be
   * recorded for this message. `candidateId` = the one approval it was read against. */
  | {
    kind: 'declined';
    read: 'question' | 'unsure' | 'unrelated' | 'unavailable';
    candidateId: string | null;
    /** The candidate is an ACTION approval (so an unverified seat cannot decide it). */
    candidateIsAction: boolean;
  };

/**
 * R325 — an UNQUOTED free-text message nothing else claims. The untagged-bind preconditions
 * of `1` without Reply: a DM or a forum topic (never an ordinary group's chatter), not a reply
 * to another message, not naming an `#id`, approvals delivered to this sender here, and the
 * newest thing fr sent into this chat is an approval ask (`untaggedBindAllowed`). laya reads
 * it with a fourth option, "not about the request".
 *   * exactly one pending ⇒ a confident approve / reject is returned `bound` (recorded by the
 *     caller through processDecision);
 *   * several pending ⇒ null, laya never asked (sixth audit: one approval per laya read);
 *   * one plus a recently closed one ⇒ only when laya reads a decision, the human is told
 *     which one is still pending and that nothing was recorded (`answered`) — never a guess;
 *   * anything else ⇒ null: the message goes on to the agent unchanged. Never throws.
 */
export async function layaUnquotedRead(m: {
  channel: string;
  senderAddress: string;
  chatKey: string;
  threadId: number | null;
  messageDate: number | undefined;
  messageText: string;
  isDirectChat: boolean;
  isForumTopic: boolean;
  isReplyToOther: boolean;
  guardScope: Parameters<typeof untaggedBindAllowed>[0];
  say: Say;
  /** false ⇒ this seat cannot decide ACTION approvals (see runChannelTurn). */
  decidesActions?: boolean;
}): Promise<LayaUnquotedOutcome | null> {
  // Set the moment laya is asked: from then on a failure is `declined`, never null (null lets
  // the untagged grammar decide the message).
  let askedFor: string | null | undefined;
  let askedForAction = false;
  try {
    if (m.chatKey === '' || m.isReplyToOther) return null;
    if (!m.isDirectChat && !m.isForumTopic) return null;
    const text = stripApprovalTag(m.messageText).trim();
    if (!text || extractShortRef(text) !== null || /#[0-9a-f]{8,}/i.test(text)) return null;
    const resolution = await resolveUnquotedReply(
      m.channel, m.senderAddress, m.chatKey, m.threadId, m.messageDate ?? null, null, m.isDirectChat,
    );
    // ⛔ EXACTLY ONE pending approval, or laya is never asked (sixth audit). Several pending
    // (`ambiguous`) ⇒ null: main's behaviour — the agent, else the help text. Reading the
    // message against several approvals sent every candidate's text on ONE tenant's licence.
    if (resolution.kind !== 'bound' && resolution.kind !== 'recently-closed') {
      return null; // zero or several pending here (or unlinked / elsewhere): main's behaviour
    }
    if (!(await untaggedBindAllowed(m.guardScope)).allowed) return null;
    // ⛔ ELIGIBILITY BEFORE laya: a sender who may not decide THE approval (not on the roster
    // and not a deciding tenant member, a refused linked account, the requester) never causes
    // a laya call — neither the approval's text nor theirs goes out on its tenant's licence.
    const approval = await loadApproval(resolution.candidate.id);
    if (!approval || approval.id !== resolution.candidate.id) return null;
    const approverUserId = await senderDecider(m.channel, m.senderAddress, approval);
    if (approverUserId === null) return null;
    askedFor = resolution.kind === 'bound' ? resolution.candidate.id : null;
    askedForAction = resolution.kind === 'bound' && Boolean(resolution.candidate.action_id);
    // The agent is waiting behind this read: keep it short; a timeout hands it on.
    const read = await askLayaAbout(approval, text, { allowUnrelated: true, timeoutMs: UNQUOTED_LAYA_TIMEOUT_MS });
    if (read.kind !== 'approve' && read.kind !== 'reject') {
      return { kind: 'declined', read: read.kind, candidateId: askedFor, candidateIsAction: askedForAction };
    }
    if (resolution.kind === 'bound') return { kind: 'bound', candidate: resolution.candidate, read };
    await m.say(recentlyClosedReplyMessage(resolution.candidate, offerTyped(m.decidesActions ?? true, [resolution.candidate])));
    return { kind: 'answered', why: 'recently_closed' };
  } catch (err) {
    console.error('[channel-reply] laya unquoted read failed:', err instanceof Error ? err.message : err);
    return askedFor === undefined
      ? null
      : { kind: 'declined', read: 'unavailable', candidateId: askedFor, candidateIsAction: askedForAction };
  }
}

/** The grammar help (the reply could not be read). Nothing was recorded. */
export function grammarHelpMessage(approvalId: string): string {
  return (
    `Didn't understand. Reply:\n` +
    `1 - Approve\n` +
    `approve: your answer - Approve AND record "your answer" (needed when the ` +
    `request asks a question)\n` +
    `2 reason - Reject\n` +
    `A question? Ask it in fr: ${frApprovalLink(approvalId)}`
  );
}

/**
 * Process an approval decision from a channel reply: the grammar, then laya, then the ONE
 * shared decide write (`decideAsChannelSender` → `recordApprovalDecision`).
 *
 * Resolves TRUE only when a decision was actually recorded (the write tail ran).
 *
 * Exported so an integration test can drive the SHIPPED decision path for a message the
 * webhook entry point cannot produce in CI: a laya read (`ctx.layaPreRead`, the same seam
 * R325's `layaUnquotedRead` fills) needs the tenant's `laya` licence and an HTTP call to
 * laya, neither of which a test process has. See
 * `tests/integration/channels/telegram-proposed-answer.integration.test.ts`.
 */
export async function processDecision(
  approval: typeof approvals.$inferSelect,
  senderAddress: string,
  say: Say,
  messageText: string,
  ctx: {
    /** The channel id recorded on the decision ('telegram', 'teams', …). */
    channel: string;
    /** What the message replies to (inbound chat id, quoted text, `reply_to_message`). */
    quoted?: QuotedMessage;
    /** R325: laya already read this unquoted message against this approval. */
    layaPreRead?: LayaReadDecision;
    /** Edited, forwarded, or carrying fr's notification in its own text: never laya-read. */
    layaExcluded?: boolean;
    /** The transport already resolved who decides (mcp `on_behalf_of`) and their workspace. */
    actAs?: { userId: string; tenantId: string };
    /** The audit `via` the decision carries. */
    via?: DecisionVia;
    /** What this request proves about the sender (the in-app Keycloak session). */
    evidence?: ActionDecisionEvidence;
  },
): Promise<boolean> {
  // ⛔ ONE DECIDER PER MESSAGE. A message laya already read (R325 pre-read) is decided by
  // laya's choice ALONE: the grammar never runs on it. It used to run first, so "Ok!" /
  // "No!" — unclaimed by `looksLikeApprovalTraffic`, so laya read them — were then decided by
  // `parseDecision` with `layaRead` left null, and on a BLOCKED recommendation "Ok!" recorded a
  // REJECT (second audit). With the pre-read, `decision` stays null and laya's read decides.
  // ⛔ An ACTION approval runs as its decider, so a seat whose sender this request does not
  // verify (lib/action-decision-identity.ts: email, Teams free text, an in-app box without its
  // session) cannot decide it — and must not be offered a menu, a help text or a re-ask that
  // suggests it can. One answer, before any grammar: decide it in fr.
  if (approval.action_id && !isVerifiedActionDecisionSeat({ channel: ctx.channel, evidence: ctx.evidence ?? {} })) {
    await say(`${typedReplyCannotDecideLine(approval.id)}\n\n[ApprovalId:${approval.id}]`);
    return false;
  }
  const preRead = ctx.layaPreRead && !ctx.layaExcluded ? ctx.layaPreRead : undefined;
  let decision: ChatDecision | null = preRead ? null : parseDecision(messageText);
  if (!preRead && !decision && isPastedAnswerPlaceholder(messageText)) {
    await say(PASTED_PLACEHOLDER_MESSAGE);
    return false;
  }
  if (!preRead && !decision && isNeedInfoRequest(messageText)) {
    await say(needInfoMessage(approval.id));
    return false;
  }
  let layaRead: LayaReadDecision | null = null;
  // ── WHAT THE GRAMMAR CANNOT READ, laya READS (George 2026-10-23) — AFTER the sender is
  // known to be a decider (below), so a stranger quoting the notification never sends the
  // approval or their words to laya on the tenant's licence.

  // ⛔ P1-TEAM-b M1: the member arm never PICKS between several eligible linked accounts
  // (`ambiguous`); the refusal records nothing. The requester rule is the shared path's.
  // A transport that already resolved the decider (mcp `on_behalf_of`) names them and the
  // workspace they were resolved in. ⛔ Only an approval OF THAT workspace: a tag or `#id` binds
  // by id alone, so without this an agent could decide another tenant's approval as one of
  // that tenant's members. The shared decide path still checks membership and every rule.
  if (ctx.actAs && ctx.actAs.tenantId !== approval.tenant_id) {
    await say(NOT_LINKED_MESSAGE);
    return false;
  }
  const rosterHit = ctx.actAs?.userId ?? await findApproverForSender(ctx.channel, senderAddress, approval.id, approval);
  if (isChatSeatRefusal(rosterHit)) {
    await say(chatSeatRefusalMessage(rosterHit, frApprovalLink(approval.id)));
    return false;
  }
  let approverUserId: string | null = rosterHit;
  // P1-TEAM-b: not on the roster ⇒ any member of the approval's tenant may decide it
  // (1-of-any; one obligation discharged — discharged by the shared decide path).
  if (!approverUserId) {
    let memberHit: string | ChatSeatRefusal | null = null;
    try {
      memberHit = await findTenantMemberDeciderForSender(ctx.channel, senderAddress, approval);
    } catch (err) {
      // FAIL CLOSED: an unverifiable membership is not a decider — the sender gets the
      // not-linked answer below, exactly as before this arm existed.
      reportSwallowedFailure(err, {
        service: 'fr-db',
        degradedTo: 'telegram reply -> tenant-member decider unverifiable, no decision recorded',
      });
      memberHit = null;
    }
    if (isChatSeatRefusal(memberHit)) {
      await say(chatSeatRefusalMessage(memberHit, frApprovalLink(approval.id)));
      return false;
    }
    approverUserId = memberHit;
  }
  if (!approverUserId) {
    await say(NOT_LINKED_MESSAGE);
    return false;
  }
  // The bot authenticates with its secret token, not a bearer, so the request frame has
  // no tenant and `withUsageSpans` billed every Telegram delivery to the nil tenant.
  // Bound to a real approval and a linked approver, the tenant is the APPROVAL's own.
  // Not metering-only: downstream calls in this request (http-client `x-tenant-id`,
  // `resolvePendingAction`) now carry it too, as they do on the web seat.
  // ⛔ Only here: an unbound message stays unattributed rather than guess a tenant.
  attributeRequestTo({ userId: approverUserId, tenantId: approval.tenant_id });

  if (!decision && (extractShortRef(messageText) !== null || /#[0-9a-f]{8,}/i.test(messageText))) {
    // ⛔ A reply to THIS approval that names an `#id` (`approve #<B>`): the human said two
    // things. Never read — laya sees only this approval's request and would decide it
    // (fifth validator). Same refusal as the untagged binder's `conflicting_ref` arm.
    await say(
      `Nothing was recorded: you replied to #${shortId(approval.id)} but named an approval ` +
        `number. Reply to that approval's own notification instead, or send \`1\` / ` +
        `\`2 <reason>\` here to decide #${shortId(approval.id)}.`,
    );
    return false;
  }
  if (!decision && (ctx.layaExcluded || (!preRead && !(await quotesOwnNotificationOf(approval.id, ctx.quoted, ctx.channel))))) {
    // ⭐ AN ALLOWLIST, NOT A LIST OF DENIALS. Three audits in a row each found one more message
    // that reached a recorded decision laya should never have read (a Reply to the recently-
    // closed confirm, a forwarded notification, a Reply to a colleague's forwarded or pasted
    // copy of the notification). Outside R325's own pre-read, laya now reads a message ONLY
    // when it is a Reply to fr's OWN notification of THIS approval (quotesOwnNotificationOf).
    // Everything else — and an edited message, a forward, a pasted notification (fr's words,
    // not an answer) — gets main's behaviour: only the exact grammar decides; free text gets
    // the grammar help.
    await say(grammarHelpMessage(approval.id));
    return false;
  }
  if (!decision) {
    // A reply that quotes this approval ("approved", "looks good, ship it", "nee, eerst de
    // tests") used to get "Didn't understand". laya now chooses approve / reject / question
    // (lib/approval-reply-interpreter.ts). Unsure ⇒ nothing recorded and the human is asked
    // for `1` / `2 <reason>`; a question ⇒ the approval stays pending (needInfoMessage);
    // laya unreachable ⇒ the grammar help, exactly as before.
    const read = preRead ?? await askLayaAbout(approval, messageText, { allowUnrelated: false });
    if (read.kind === 'approve' || read.kind === 'reject') {
      layaRead = read;
      decision = toChatDecision(read, owesAnswer(approval));
    } else if (read.kind === 'question') {
      await say(needInfoMessage(approval.id));
      return false;
    } else if (read.kind === 'unsure' || read.kind === 'unrelated') {
      // ⭐ THE SAME RE-ASK AS EVERY OTHER CHANNEL (owner ruling 2026-10-31): laya's score was
      // too low to record, so the human is shown the options this row's notification carried
      // and told it was not clear enough — identical wording, identical list.
      await say(unclearChoiceMessage(approvalMenuLines(approval)));
      return false;
    } else {
      await say(grammarHelpMessage(approval.id));
      return false;
    }
  }
  // What fr understood, said only where something is recorded or an answer is asked for —
  // never in front of a refusal, which would read as if the decision had landed.
  const layaPreface = layaRead !== null
    ? `${interpretedPreface(layaRead.kind, Boolean(decision.comment) && decision.comment !== REJECT_DEFAULT_REASON)}\n\n`
    : '';

  // ── APPROVE-ALL (user ruling 2026-10-02) ─────────────────────────────────────────
  // ⛔ APPROVE-ALL IS NOT DECIDED HERE ANY MORE. A plain approve on a bug-fix authorization
  // or a feature design carries the structured G-12 body the web sends for "approve
  // everything" — derived in the SHARED decide path (lib/channel-bare-approve.ts, called by
  // `decideAsChannelSender`) so Teams, `approvals.decide` and this seat all do it.
  // Owner ruling 2026-10-31: the seat does not decide what a `1` means; the ROW does.
  // `bareGrammar` below is the one thing this seat tells the shared path: a reply laya read
  // as an approval is not the `1` grammar and may not claim either derivation.

  // Already decided, requester, rate limit (#901): the shared decide path's rules.

  // ── A BARE APPROVE ON A ROW THAT OWES AN ANSWER ─────────────────────────────────────
  // Ruled 2026-10-01 after the product owner answered a QUESTION row with "1", "1 -
  // Approve" and "Approve" — what its own first question ("Approve with "yes" to accept
  // that") invited — and every one was refused.
  //
  // ⛔ NOTHING HERE DECIDES WHAT A `1` MEANS, AND NOTHING HERE ASKS FOR THE ANSWER. Both
  // are claims about the ROW, and both belong to the shared side: the shared decide path
  // (lib/channel-bare-approve.ts) records a bare approve identically from every channel,
  // and `recordApprovalDecision` refuses a row that still owes an answer with its OWN
  // answer-required sentence — the same one the human gets on every other channel. There
  // is no per-channel "now answer my question" state to create one here.
  //
  // A `fix_assertion` hold never accepts a recommendation — what it owes is a statement of
  // what was fixed.
  //
  // ⛔ A `metadata.proposed_answer` ROW IS NOT HANDLED HERE EITHER. Filling the proposal for
  // a comment-less approve is `withProposedAnswer` inside `recordApprovalDecision` (the same
  // line the web PUT and every other seat reach), and it must NOT fire when laya read the
  // human's own words — those were dropped by `toChatDecision` because the row owes an
  // answer, and filling would record the asker's text over them. That distinction is carried
  // by `bareGrammar` below (`ChannelSender.bareGrammar` → `recordApprovalDecision`'s
  // `fromFreeText`), so there is exactly one place that decides it.

  // The finished-card (#1098), answer-owed (#1072) and broken-gate (#1064) refusals are the
  // shared decide path's (`recordApprovalDecision`), applied identically on every seat.
  const recorded = await recordDecision(approval, ctx.channel, approverUserId, decision, say, {
    // ⛔ THE ONE THING THIS SEAT TELLS THE SHARED PATH ABOUT THE REPLY ITSELF. A reply laya
    // read as an approval is free text, not the `1` grammar, and the shared path's
    // bare-approve derivations (approve-all, accepting a BLOCKED recommendation) may only be
    // claimed by the grammar. Every other seat defaults to grammar.
    bareGrammar: layaRead === null,
    approveAllForm: layaRead === null && isApproveAllMenuReply(messageText),
    layaPreface,
    ...(ctx.via ? { via: ctx.via } : {}),
    ...(ctx.evidence ? { evidence: ctx.evidence } : {}),
  });
  // `recordDecision` resolves false when it refused at the insert (already decided, or the
  // row closed under the lock).
  return recorded;
}

function frPublicBaseUrl(): string {
  return config.publicBaseUrl || DEFAULT_FR_PUBLIC_URL;
}

/** The fr `/approvals/<id>` link. */
export function frApprovalLink(approvalId: string): string {
  return `${frPublicBaseUrl().replace(/\/+$/, '')}/approvals/${approvalId}`;
}

/** The write tail of `processDecision`: THE SHARED DECIDE PATH (`decideAsChannelSender` →
 * `recordApprovalDecision`, owner ruling 2026-10-31), then the reply. Resolves FALSE when
 * nothing was recorded (the shared path refused; its message is relayed with the web link). */
export async function recordDecision(
  approval: typeof approvals.$inferSelect,
  channel: string,
  approverUserId: string,
  decision: { decision: 'approved' | 'rejected'; comment?: string },
  say: Say,
  ctx: {
    /** False when laya read free text; see ChannelSender.bareGrammar. */
    bareGrammar: boolean;
    /** Was the raw reply exactly the approve-all form? (`isApproveAllMenuReply`) */
    approveAllForm: boolean;
    /** "I read your reply as …" when laya read the reply (said only on a recorded decision). */
    layaPreface?: string;
    /** The audit `via` the decision carries. */
    via?: DecisionVia;
    /** What this request proves about the sender. */
    evidence?: ActionDecisionEvidence;
  },
): Promise<boolean> {
  const verb = decision.decision === 'approved' ? 'approve' : 'reject';
  let response: Record<string, unknown>;
  let derivedPreface: string;
  /** What was RECORDED — the shared path may turn a bare approve into a REJECT. */
  let recorded: 'approve' | 'reject' = verb;
  try {
    const out = await decideAsChannelSender(
      {
        channel,
        userId: approverUserId,
        tenantId: approval.tenant_id,
        bareGrammar: ctx.bareGrammar,
        approveAllForm: ctx.approveAllForm,
        ...(ctx.via ? { via: ctx.via } : {}),
        ...(ctx.evidence ? { evidence: ctx.evidence } : {}),
      },
      {
        approvalId: approval.id,
        decision: verb,
        ...(decision.comment ? { comment: decision.comment } : {}),
      },
    );
    recorded = out.output.decision;
    response = out.response;
    // What the SHARED path derived from the row — approve-all confirmed, or the accepted
    // recommendation explained. Said only after a recorded decision.
    derivedPreface = out.preface;
  } catch (err) {
    if (!(err instanceof AppError)) throw err;
    await say(channelRefusalReply(err, approval.id, frPublicBaseUrl()));
    return false;
  }
  await say((ctx.layaPreface ?? '') + derivedPreface + channelDecisionReply(recorded, response, approval.card_id !== null));
  return true;
}
