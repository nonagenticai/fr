// src/domain/engagement/approval-menu.ts
//
// ⭐ ONE MENU, EVERY TEXT CHANNEL.
//
// George, 2026-10-31: "any channel for any project any card-type always works exactly the
// same, if via any channel the approval message for choices [1,2,3] can be '1' as response,
// that applies to all channels and all cases!"
//
// So the [1,2,3] list is built here, once, from the ROW — and `bareApproveArm` is the same
// predicate the decide path runs on the reply, so a menu can never promise a `1` the code
// does not honour. The WHOLE notification text is built here too
// (`approvalNotificationParts` / `approvalNotificationText`), and every channel sends it:
// Telegram, mcp, email, teams and inapp. Every one of them answers through the same
// reply→decision flow (`channel-reply.ts runChannelTurn`). Teams keeps its buttons as well.
//
// ⛔ THE MENU IS THE WHOLE MESSAGE. There is no per-transport variation: a bare `1` means
// what the ROW says it means on every channel (lib/channel-bare-approve.ts), and a row that
// still owes an answer is refused by the shared decide path with its own sentence — no
// channel asks a follow-up question and remembers the answer. Do not add a
// "what happens next on this transport" note back.

import { and, eq } from 'drizzle-orm';

import { config } from '../../config';
import { db, projectReports } from '../../db/client';
import { isUuidShape } from '../../lib/uuid-shape';
import { DEFAULT_FR_PUBLIC_URL } from '../../services/github-app-config';
import {
  chatApproveAllContent,
  PROPOSED_ANSWER_NOTE,
  proposedAnswer,
} from './deblock-actions';
import { bareApproveArm, type BareApproveRow } from '../../lib/channel-bare-approve';
import { actionDecisionTrustOf, typedReplyDecidesActionApprovals } from '../../lib/action-decision-identity';

/**
 * The address placeholder in the `approve: <your answer>` line, and that line's parenthetical
 * annotations. Exported so a seat can recognise the line PASTED BACK VERBATIM and record
 * nothing (`<your answer>` was once recorded as the literal answer).
 */
export const FOOTER_ANSWER_PLACEHOLDER = '<your answer>';
export const FOOTER_NOTE_ANSWER_OTHER = 'to answer something else';
export const FOOTER_NOTE_ANSWER_IN_ONE_GO = 'answer in one go';
export const FOOTER_ANSWER_ANNOTATIONS: readonly string[] = [FOOTER_NOTE_ANSWER_OTHER, FOOTER_NOTE_ANSWER_IN_ONE_GO];

/**
 * The `1 - Approve` line's parenthetical, present EXACTLY when a bare `1` will be recorded as
 * a REJECT (the reviewer recommended BLOCKED and the human is accepting that). Exported for
 * the same reason as the answer annotations: it is stripped from a pasted-back menu echo.
 */
export const FOOTER_NOTE_ACCEPTS_BLOCKED = "accepts the reviewer's recommendation: card stays BLOCKED";

/**
 * The `1 - Approve` annotation for a row carrying a proposed answer (`metadata.proposed_answer`,
 * fr#1687): a plain approve records the proposal as the answer. Same reason as above — a
 * pasted-back menu echo must strip it rather than store it as the answer.
 */
export const FOOTER_NOTE_ACCEPTS_PROPOSED = 'accepts the proposed answer';

/**
 * The parentheticals a `1 - Approve` line can carry, in ONE list. The shared reply flow
 * strips them from a pasted-back menu echo (`channel-reply.ts`), so they must be the very
 * strings this menu writes — which is why they are declared here and not in an adapter.
 */
export const FOOTER_APPROVE_ANNOTATIONS: readonly string[] = [
  FOOTER_NOTE_ACCEPTS_BLOCKED,
  FOOTER_NOTE_ACCEPTS_PROPOSED,
];

/** Absolute link to an approval in fr (FR_PUBLIC_URL, else the production default). */
export function frApprovalUrl(approvalId: string): string {
  return `${config.publicBaseUrl || DEFAULT_FR_PUBLIC_URL}/approvals/${approvalId}`;
}

/**
 * The menu a PENDING approval shows on a numbered-reply channel.
 */
export function approvalMenuLines(
  approval: BareApproveRow & { deblock_action?: unknown },
): string[] {
  const arm = bareApproveArm(approval);
  if (arm === 'approve-all') {
    // The items themselves are rendered ABOVE this block by the adapter, so `1` is only
    // offered where the human can see what "all" is.
    return [
      `Reply 1 to approve ALL. To reject or approve only some, decide in fr: ${frApprovalUrl(approval.id)}`,
    ];
  }

  // A proposed answer is a real answer the row already carries (fr#1687), so it outranks the
  // reviewer recommendation: `1` records it.
  const proposal = proposedAnswer(approval.metadata);
  const approveLine = proposal !== null
    ? `1 - Approve   (${FOOTER_NOTE_ACCEPTS_PROPOSED})`
    : arm === 'accepts-blocked'
      ? `1 - Approve   (${FOOTER_NOTE_ACCEPTS_BLOCKED})`
      : `1 - Approve`;

  return [
    ...(proposal !== null ? [`Proposed answer: ${proposal}`, PROPOSED_ANSWER_NOTE, ``] : []),
    `Reply to THIS message with:`,
    approveLine,
    // ⛔ Advertised on EVERY channel, not only where the bot happens to ask: `1` alone cannot
    // carry an answer, and this form is the one every text seat's grammar accepts.
    `approve: ${FOOTER_ANSWER_PLACEHOLDER}   (approve AND record "your answer" — needed when the request asks a question)`,
    `2 - Reject (include reason after number)`,
    // `3` is NOT a decision (fr#1370): it records nothing and answers with the fr link.
    `3 - Question (nothing is decided; I'll send you the fr link)`,
  ];
}

// ─────────────────────────────────────────────────────────────────────────────────────
// WHAT "ALL" IS — rendered identically wherever an approve-all menu is offered.
// ─────────────────────────────────────────────────────────────────────────────────────

/** Per-item cap inside the content list, so one huge item cannot crowd out the rest. */
const MAX_ITEM_LENGTH = 400;

/** Cut to `max` WITHOUT leaving half a surrogate pair behind (shared by every renderer). */
export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, Math.max(0, max - 1));
  // Never leave half a surrogate pair behind.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

/** The cited report's `details.bugs`, tenant-predicated; null when absent / not a list. */
async function getReportBugs(tenantId: string, reportId: string): Promise<unknown[] | null> {
  const rows = await db
    .select({ details: projectReports.details })
    .from(projectReports)
    .where(and(eq(projectReports.id, reportId), eq(projectReports.tenant_id, tenantId)))
    .limit(1);
  const bugs = (rows[0]?.details as { bugs?: unknown } | null | undefined)?.bugs;
  return Array.isArray(bugs) ? bugs : null;
}

/** One bug line: id prefix, kind, severity, file:line, then the first fix-outline step. */
function bugLine(index: number, id: string, bug: Record<string, unknown> | undefined): string {
  const head = `${index}. [${id.slice(0, 8)}]`;
  if (!bug) return `${head} (details not found in the report — see fr)`;
  const kind = typeof bug.kind === 'string' && bug.kind.trim() ? bug.kind.trim() : 'bug';
  const sev = typeof bug.severity === 'string' && bug.severity.trim() ? ` (${bug.severity.trim()})` : '';
  const loc = asRecord(bug.location);
  const file = typeof loc.file === 'string' && loc.file.trim() ? loc.file.trim() : '';
  const where = file ? ` — ${file}${typeof loc.line === 'number' ? `:${loc.line}` : ''}` : '';
  const outline = Array.isArray(bug.fix_outline) ? bug.fix_outline.find((x) => typeof x === 'string' && x.trim()) : undefined;
  const fix = typeof outline === 'string' ? `\n   fix: ${outline.trim()}` : '';
  return clip(`${head} ${kind}${sev}${where}${fix}`, MAX_ITEM_LENGTH);
}

/**
 * The content a human judges BEFORE approving ALL: the cited bugs of a bug-fix
 * authorization, or the scenarios of a feature design. null when the row is not
 * approve-all-from-chat ({@link bareApproveArm}), or when there is nothing to show — such a
 * row must never be offered a bare "approve all" it cannot be shown.
 *
 * ⛔ EVERY channel that offers `Reply 1 to approve ALL` renders THIS, so no seat can promise
 * an "all" whose content the human was not shown.
 */
export async function approveAllContentLines(approval: {
  id: string;
  status?: string;
  kind?: string | null;
  metadata: unknown;
  tenant_id?: string | null;
}): Promise<{ label: string; lines: string[] } | null> {
  if (approval.status !== undefined && approval.status !== 'pending') return null;
  const md = asRecord(approval.metadata);
  const content = chatApproveAllContent({
    kind: approval.kind,
    metadata: approval.metadata,
    deblock_action: md.deblock_action,
  });
  if (content === null) return null;
  if (content.kind === 'bugs') {
    const ids = content.bugIds;
    const tenantId = approval.tenant_id ?? undefined;
    const reportId = md.report_id;
    let bugs: unknown[] | null = null;
    if (typeof tenantId === 'string' && isUuidShape(tenantId) && typeof reportId === 'string' && isUuidShape(reportId)) {
      try {
        bugs = await getReportBugs(tenantId, reportId);
      } catch (err) {
        console.error(`[approval-menu] bug report lookup failed approval=${approval.id}: ${err instanceof Error ? err.message : err}`);
      }
    }
    const byId = new Map<string, Record<string, unknown>>();
    for (const b of bugs ?? []) {
      const r = asRecord(b);
      if (typeof r.id === 'string') byId.set(r.id, r);
    }
    return {
      label: `Bugs to fix (${ids.length}):`,
      lines: ids.map((id, i) => bugLine(i + 1, id, byId.get(id))),
    };
  }
  const lines = content.scenarios.map((sc, i) => {
    const crit = sc.criterion_id ? ` [${sc.criterion_id}]` : '';
    return clip(`${i + 1}. ${sc.title}${crit}`, MAX_ITEM_LENGTH);
  });
  return { label: `Design scenarios (${lines.length}):`, lines };
}

// ─────────────────────────────────────────────────────────────────────────────────────
// THE APPROVAL NOTIFICATION — one text, every channel.
// ─────────────────────────────────────────────────────────────────────────────────────

/**
 * The first character of every PENDING approval notification fr sends, on every channel.
 * Nothing else fr sends starts with it: the reply flow's own answers never do.
 */
export const APPROVAL_NOTIFICATION_MARK = '🔔';

/**
 * True when `text` (a quoted message) is an approval NOTIFICATION, not some other fr message
 * that merely carries an `[ApprovalId:…]` tag. Only a Reply to the notification itself may be
 * read by laya as a decision on it.
 */
export function isApprovalNotificationText(text: string | undefined): boolean {
  return typeof text === 'string' && text.trimStart().startsWith(APPROVAL_NOTIFICATION_MARK);
}

/**
 * True when a message's OWN text carries fr's approval notification — the notification mark
 * anywhere, or an `[ApprovalId:…]` tag in the body: a pasted (or forwarded) notification. Such
 * text is fr's words, not the human's answer, so laya never reads it as a decision.
 */
export function containsApprovalNotificationText(text: string | undefined): boolean {
  return typeof text === 'string' && (text.includes(APPROVAL_NOTIFICATION_MARK) || /\[ApprovalId:/i.test(text));
}

/** An approval notification, in the blocks every channel renders. */
export interface ApprovalMessageParts {
  /** Fixed lines before the description (the header). */
  head: string[];
  /** Cut with "…" ONLY when a transport's size cap leaves no other room. */
  description: string;
  /** The content to judge (approve-ALL rows). A capped transport truncates it FIRST. */
  items?: { label: string; lines: string[] };
  /** Never cut: the reply instructions, the fr link and the [ApprovalId:…] tag. */
  footer: string[];
}

/** The honest omission line: N is exactly the number of items not shown. */
export function moreItemsLine(omitted: number): string {
  return `… +${omitted} more (see fr)`;
}

/** Render the parts with `shown` content items and the given description. */
export function renderApprovalParts(parts: ApprovalMessageParts, description: string, shown: number): string {
  const blocks: string[] = [];
  if (parts.head.length) blocks.push(parts.head.join('\n'));
  if (description.length) blocks.push(description);
  const lines = parts.items?.lines ?? [];
  if (parts.items && lines.length) {
    const omitted = lines.length - shown;
    blocks.push([
      parts.items.label,
      ...lines.slice(0, shown),
      ...(omitted > 0 ? [moreItemsLine(omitted)] : []),
    ].join('\n'));
  }
  blocks.push(parts.footer.join('\n'));
  return blocks.join('\n\n');
}

/** What an unverified channel says instead of a menu on an ACTION approval. */
export function typedReplyCannotDecideLine(approvalId: string): string {
  return `A typed reply here cannot decide this: an agent action runs as the person who approves it. ` +
    `Decide it in fr: ${frApprovalUrl(approvalId)}`;
}

/**
 * The channel reply when a message PARKS an action for approval (channels/index.ts). The same
 * rule as the notification: a typed `approve <id>` is offered only where it can decide an
 * action approval (`webSession`: the in-app box sent it inside a Keycloak session).
 */
export function actionPendingReply(args: {
  channel: string;
  webSession: boolean;
  actionName: string;
  approvalId: string;
  /** The action's own wording (`channelPendingText`), used where a typed reply decides. */
  pendingText?: string;
}): string {
  const decidable = typedReplyDecidesActionApprovals(args.channel) &&
    (actionDecisionTrustOf(args.channel) !== 'keycloak_session' || args.webSession);
  if (!decidable) {
    return `Action "${args.actionName}" is awaiting approval. ${typedReplyCannotDecideLine(args.approvalId)}` +
      `\n\n[ApprovalId:${args.approvalId}]`;
  }
  return args.pendingText ??
    `Action "${args.actionName}" is awaiting approval. Reply "approve ${args.approvalId}" or "reject ${args.approvalId}".`;
}

type NotifiableApproval = BareApproveRow & {
  id: string;
  status: string;
  description: string;
  deblock_action?: unknown;
  action_id?: string | null;
};

/**
 * The notification for an approval: a decision notice for a closed row; for a pending row the
 * description, the approve-ALL content when the row has it (`content`), and THE menu. The
 * `[ApprovalId:…]` tag closes every one, so a reply carrying it names its approval on any
 * channel.
 */
export function approvalNotificationParts(
  approval: NotifiableApproval,
  content: ApprovalMessageParts['items'] | null,
  /** The channel the notification goes out on — only to know whether its typed reply can
   * decide an ACTION approval (lib/action-decision-identity.ts); the menu itself never varies. */
  channel: string,
): ApprovalMessageParts {
  if (approval.status !== 'pending') {
    const emoji = approval.status === 'approved' ? '✅' : '❌';
    return {
      head: [`${emoji} Approval ${approval.status.toUpperCase()}`],
      description: approval.description,
      footer: [`[ApprovalId:${approval.id}]`],
    };
  }
  // Clean description — remove [n8n] prefix for readability
  const desc = approval.description.replace(/^\[n8n\]\s*/, '');
  const head = [`${APPROVAL_NOTIFICATION_MARK} Approval Required`];
  // ⛔ A menu never promises a `1` the code refuses: an ACTION approval runs as its decider, so a
  // channel whose typed sender is unverified (email, Teams free text) is offered fr instead.
  if (approval.action_id && !typedReplyDecidesActionApprovals(channel)) {
    return {
      head,
      description: desc,
      footer: [typedReplyCannotDecideLine(approval.id), ``, `[ApprovalId:${approval.id}]`],
    };
  }
  // Approve-ALL (ruling 2026-10-02): `1` approves ALL — only with the items IN the message, so
  // the human sees what "all" is. A row whose content cannot be shown gets the plain menu.
  if (content && content.lines.length > 0) {
    return {
      head,
      description: desc,
      items: content,
      footer: [
        `Reply 1 to approve ALL. To reject or approve only some, decide in fr: ${frApprovalUrl(approval.id)}`,
        ``,
        `[ApprovalId:${approval.id}]`,
      ],
    };
  }
  return {
    head,
    description: desc,
    footer: [...approvalMenuLines(approval), ``, `[ApprovalId:${approval.id}]`],
  };
}

/** The whole notification as one text, for a transport with no size cap. */
export async function approvalNotificationText(
  approval: NotifiableApproval & { kind?: string | null; tenant_id?: string | null },
  channel: string,
): Promise<string> {
  const content = approval.status === 'pending' ? await approveAllContentLines(approval) : null;
  const parts = approvalNotificationParts(approval, content, channel);
  return renderApprovalParts(parts, parts.description, parts.items?.lines.length ?? 0);
}
