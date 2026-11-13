// src/lib/channel-bare-approve.ts
//
// ⭐ WHAT A BARE APPROVE MEANS IS A PROPERTY OF THE APPROVAL, NOT OF THE CHANNEL.
//
// George, 2026-10-31: "any channel for any project any card-type always works exactly the
// same, if via any channel the approval message for choices [1,2,3] can be '1' as response,
// that applies to all channels and all cases! please stop creating extra complexity by
// making things 'special case'".
//
// Before this module the two derivations below lived in `routes/telegram-webhook.ts`, so a
// bare `1` was a COMPLETE answer on Telegram and a refusal on Teams, the AG-UI
// action and `approvals.decide` — for exactly the two kinds that need structured fields
// (a bug-fix authorization, a feature design) and for exactly one row shape that owes an
// answer (a BLOCKED reviewer recommendation). The seat was deciding what a decision meant.
//
// They now run in `decideAsChannelSender` (agui/actions/approvals-decide.ts), the ONE
// function every non-web seat calls, so every channel derives the same decision from the
// same row. The web PUT keeps its own path: it has no numbered reply — its UI sends the
// structured `g12_decision` explicitly from the same builder (`buildChatApproveAllG12Body`,
// served read-only as `g12_decide`) and shows the reviewer recommendation on the card.
//
// ⛔ NOTHING HERE BYPASSES A GATE. The approve-all body goes through the route's
// `assertU3DecideGates` exactly as the web's does, and the recommendation arm records a
// REJECT that the answer guard would otherwise refuse — it never records an approval.

import {
  answerlessApproveDemand,
  chatApproveAllContent,
  proposedAnswer,
  type ChatApproveAllContent,
} from '../domain/engagement/deblock-actions';
import { buildChatApproveAllG12Body } from '../services/approvals/u3-gates';
import {
  acceptRecommendationDecision,
  extractReviewerRecommendation,
  recommendationKeepsCardBlocked,
} from './reviewer-recommendation';
import type { DecideInput } from '../capabilities/approvals/decide';

/**
 * A PLAIN approve — the only form approve-all accepts. `1` / `approve` / `yes` / `ok` parse
 * to an approve with NO comment at all (`parseDecision` in every text seat), and the menu
 * echo `1 - Approve: approve.` carries the label as the comment. Anything else is a real
 * answer, and a real answer on one of these rows needs the web.
 *
 * ⛔ It also refuses any caller that already supplied a structured decision: a seat that
 * sent `g12_decision` or `rejected_bug_ids` said what it meant, and re-deriving would
 * silently replace a partial approve with approve-ALL.
 */
const APPROVE_WORD_ONLY = /^(?:approve|approved|ok|okay|yes)\.?$/i;

export function isPlainApprove(input: DecideInput): boolean {
  if (input.decision !== 'approve') return false;
  if (input.g12_decision !== undefined || input.rejected_bug_ids !== undefined) return false;
  if (input.comment === undefined) return true;
  return APPROVE_WORD_ONLY.test(input.comment.trim());
}

/**
 * Which arm a bare approve takes on this row, decided from the row alone.
 *
 * ⭐ EXPORTED SO THE NOTIFICATION AND THE DECISION CANNOT DISAGREE. The menu a human reads
 * and the rule that runs on their `1` are the same predicate: before, the Telegram footer
 * said "I'll ask for your answer" and the webhook decided separately whether to ask, which
 * is how a menu ends up promising one thing and the code doing another.
 */
export type BareApproveArm = 'approve-all' | 'accepts-blocked' | 'none';

/**
 * Was the reply EXACTLY the approve-all form the menu offers (`1`, `1 - Approve`, `Approve`)?
 *
 * ⛔ THE OWNER'S 2026-10-02 RULING IS THREE FORMS, NOT "any approve word": a bare approve on a
 * bug-fix authorization fixes EVERY cited bug, so `yes` / `ok` must not silently become
 * approve-ALL. The seats pass this explicitly because only they still hold the raw text — by
 * the time a decision reaches `DecideInput` all four forms are the same object.
 */
export function isApproveAllMenuReply(rawText: string): boolean {
  const cleaned = rawText
    .replace(/^\[n8n\]\s*/i, '')
    .replace(/\[ApprovalId:[^\]]*\]/gi, '')
    .replace(/#[0-9a-f]{8,}/gi, '')
    .trim();
  return /^(?:1|approve|1\s*[-\u2013\u2014:]\s*approve)\.?$/i.test(cleaned);
}

export function bareApproveArm(row: BareApproveRow): BareApproveArm {
  if (chatApproveAllContent(row) !== null) return 'approve-all';
  const demand = answerlessApproveDemand({ decision: 'approved', comment: undefined, metadata: row.metadata });
  if (demand === null || demand === 'fix_assertion') return 'none';
  // An explicit proposed answer IS the answer (fr#1687): the approve stands and no
  // recommendation is interpreted. `proposedAnswer` is that module's own reader.
  if (proposedAnswer(row.metadata) !== null) return 'none';
  const recommendation = extractReviewerRecommendation(row.metadata);
  if (recommendation === null) return 'none';
  return recommendationKeepsCardBlocked(recommendation) ? 'accepts-blocked' : 'none';
}

export interface BareApproveResolution {
  /** What to send to the decide route: the caller's input, possibly completed or turned into a reject. */
  input: DecideInput;
  /** A sentence the seat says BEFORE the decision reply, or ''. */
  preface: string;
}

/** The row fields the two derivations read. */
export interface BareApproveRow {
  id: string;
  /** `approvals.kind` — optional/nullable on the notification shapes that spread a DB row. */
  kind?: string | null;
  metadata: unknown;
  tenant_id?: string | null;
  deblock_action?: unknown;
}

function approveAllConfirmation(content: ChatApproveAllContent, approvalId: string): string {
  const what = content.kind === 'bugs'
    ? `Approved ALL ${content.bugIds.length} bug${content.bugIds.length === 1 ? '' : 's'}`
    : 'Approved the feature design';
  return `${what} (#${approvalId.slice(0, 8)}).\n\n`;
}

export const ACCEPTED_RECOMMENDATION_PREFACE =
  'You accepted the reviewer\'s recommendation "BLOCKED", so this was recorded as a ' +
  'REJECT: the card stays in BLOCKED.\n\n';

/**
 * Complete (or reinterpret) a plain approve from the ROW alone.
 *
 * 1. APPROVE-ALL (owner ruling 2026-10-02, made channel-blind 2026-10-31). A bug-fix
 *    authorization and a feature design need a structured G-12 body; the web builds it from
 *    the same function this calls. `chatApproveAllContent` is the ONE predicate for "this
 *    row may be approved in one word" and already excludes every row whose bare approve
 *    owes an answer, so arms 1 and 2 cannot both fire.
 *
 * 2. ACCEPT THE REVIEWER'S RECOMMENDATION (owner ruling 2026-10-01). The producer's own
 *    question says `The reviewer recommends "BLOCKED". Approve with "yes" to accept that` —
 *    so a bare approve on such a row is the human accepting a recommendation that keeps the
 *    card where it is, and the receiver's QUESTION arm would send any *approved* answer to
 *    TODO. Accepting BLOCKED is therefore recorded as a REJECT. A `fix_assertion` hold never
 *    takes this arm (nothing was recommended — the row owes a statement of what was fixed),
 *    and any recommendation a decision cannot carry out also falls through, leaving the
 *    answer-required refusal to say what to send instead.
 *
 * Everything else is returned untouched: a bare approve that owes nothing is just an approve.
 */
export async function resolveBareApprove(
  row: BareApproveRow,
  input: DecideInput,
  opts: {
    /**
     * False when the seat did not match the numbered grammar — the reply was free text an
     * LLM read as an approval. Both arms below are claims about what a `1` MEANS, and only
     * the exact grammar may make them: "approved, retry it against staging instead" must
     * never be recorded as a reject, and must never fix every cited bug.
     */
    bareGrammar?: boolean;
    /**
     * True only when the seat's raw reply was EXACTLY the approve-all form
     * ({@link isApproveAllMenuReply}). Without it a seat can never claim approve-all, which
     * is what keeps a structured seat (Teams' button, an mcp agent's bare approve) from
     * fixing every cited bug having shown the human nothing.
     */
    approveAllForm?: boolean;
    /** The seat, for the audit sentence recorded with an accepted recommendation. */
    seat?: string;
  } = {},
): Promise<BareApproveResolution> {
  if (opts.bareGrammar === false) return { input, preface: '' };
  if (!isPlainApprove(input)) return { input, preface: '' };

  const arm = bareApproveArm(row);
  if (arm === 'approve-all' && opts.approveAllForm !== true) return { input, preface: '' };

  switch (arm) {
    case 'approve-all': {
      const content = chatApproveAllContent(row)!;
      const body = await buildChatApproveAllG12Body({
        id: row.id,
        tenant_id: row.tenant_id ?? '',
        kind: row.kind ?? '',
        metadata: row.metadata,
      });
      return {
        // The echoed menu label is not a comment on these rows (the G-12 gate refuses free
        // text anyway); drop it so the decision carries only the structured body.
        input: { ...input, comment: undefined, ...body } as DecideInput,
        preface: approveAllConfirmation(content, row.id),
      };
    }
    case 'accepts-blocked': {
      const accepted = acceptRecommendationDecision(extractReviewerRecommendation(row.metadata)!, opts.seat ?? 'chat')!;
      return {
        input: { ...input, decision: 'reject', comment: accepted.comment, reason: accepted.comment },
        preface: ACCEPTED_RECOMMENDATION_PREFACE,
      };
    }
    case 'none':
    default:
      // A bare approve that owes nothing is just an approve.
      return { input, preface: '' };
  }
}
