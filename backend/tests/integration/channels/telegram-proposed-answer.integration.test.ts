// tests/integration/channels/telegram-proposed-answer.integration.test.ts
//
// fr#1687 — `metadata.proposed_answer` on the Telegram seat, through the REAL code.
// Two independent-review findings are closed here:
//
//  1. THE GUARD THAT STOPS A laya-READ APPROVE BEING FILLED WITH THE PROPOSAL. It lives in
//     the SHARED decide path (owner ruling 2026-10-31, one flow for every channel):
//     `channel-reply.ts` sends `bareGrammar: layaRead === null`, `decideAsChannelSender`
//     forwards it as `recordApprovalDecision(..., { fromFreeText: true })`, and
//     `routes/approvals.ts` skips `withProposedAnswer` on that input. The unit suite once
//     re-implemented the fill+demand (`telegram-adapter.test.ts :: recorded`), so deleting
//     the argument left every test green — while the regression it guards is the worst one
//     the feature had: laya reads "approve, but use the main repo" as an approve,
//     `toChatDecision` drops the words (the row owes an answer), and a fill would record the
//     PROPOSAL in their place. This file calls the shared flow's own `processDecision`
//     against a real Postgres row and asserts on the persisted `approval_decisions` row —
//     no derivation is re-implemented in the test.
//
//     ⚠️ WHY NOT POST A TELEGRAM UPDATE FOR THIS ARM. A laya read only exists when
//     `interpretApprovalReply` returns approve/reject, which first mints the tenant's
//     `laya` licence (`BUNDLE_MINTER_*` + `LICENCES_SERVICE_URL`) and then POSTs to
//     laya. CI has neither credential, so from `handleTelegramIncoming` every free-text
//     reply is `unavailable` BEFORE any fetch and the guard is unreachable. The read is
//     supplied at the SAME seam R325 uses in production — `ctx.layaPreRead`, the field
//     `layaUnquotedRead` fills at the flow's single `processDecision` call — so either
//     mutation control (`bareGrammar: layaRead === null` in channel-reply.ts, or the
//     `opts?.fromFreeText` read in routes/approvals.ts) turns this file red.
//
//  2. PRECEDENCE, previously untested and unstated: on a QUESTION row carrying BOTH a
//     proposal and a BLOCKED reviewer recommendation, a bare approve now accepts the
//     PROPOSAL — recorded as an APPROVE, which re-drives the card to TODO — instead of
//     the recommendation being accepted as a reject. Both arms run the HTTP webhook
//     handler (`handleTelegramIncoming`) end to end; the second arm is the pre-feature
//     behaviour on the same fixture minus the proposal, so the pair proves the proposal
//     is what flips the outcome.
//
// ⛔ THE SUITE MUST NEVER MESSAGE A REAL TELEGRAM CHAT. No bot token ⇒ the adapter's
// sends are no-ops (`sendTextDetailed` → `{success:false}`), which is what the ask path
// in arm 1 needs. With a token configured the ask would be DELIVERED to the numeric id
// below, so the file fails loudly instead.

import { afterEach, describe, expect } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import { config } from '../../../src/config';
import {
  approvalDecisions,
  approvals,
  db,
  requiredApprovers,
  userChannelPrefs,
  userRoles,
  workspaces,
} from '../../../src/db/client';
import { handleTelegramIncoming } from '../../../src/routes/telegram-webhook';
import { processDecision } from '../../../src/domain/engagement/channel-reply';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '9f3c2a71-68d7-4e15-9d70-00000000d187';
const REQUESTER = '9f3c2a71-68d7-4e15-9d70-000000000aaa';
const STAFF_A = '9f3c2a71-68d7-4e15-9d70-0000000000a1';
const STAFF_B = '9f3c2a71-68d7-4e15-9d70-0000000000b2';
const STAFF_C = '9f3c2a71-68d7-4e15-9d70-0000000000c3';
/** Telegram ids are numeric; each test gets its own so the per-approver rate limit (1s) is irrelevant. */
const SENDER_A = '7619636015';
const SENDER_B = '7619636016';
const SENDER_C = '7619636017';
const PROPOSAL = 'Use the fixtures repo';

if (config.services.telegram.botToken) {
  throw new Error(
    '[telegram-proposed-answer] TELEGRAM_BOT_TOKEN is configured. This suite proves an ASK path ' +
      'and would deliver it to a real chat; unset the token to run it.',
  );
}

const { itDb } = createDbSuite('telegram-proposed-answer');

afterEach(async () => {
  const ids = (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.tenant_id, TENANT))).map((r) => r.id);
  if (ids.length) {
    await db.delete(approvalDecisions).where(inArray(approvalDecisions.approval_id, ids));
    await db.delete(requiredApprovers).where(inArray(requiredApprovers.approval_id, ids));
    await db.delete(approvals).where(inArray(approvals.id, ids));
  }
  await db.delete(userRoles).where(eq(userRoles.tenant_id, TENANT));
  await db.delete(userChannelPrefs).where(inArray(userChannelPrefs.user_id, [STAFF_A, STAFF_B, STAFF_C]));
  await db.delete(workspaces).where(eq(workspaces.id, TENANT));
});

/** A pending QUESTION approval in TENANT that `approver` (linked at `sender`) is named to decide. */
async function seed(metadata: Record<string, unknown>, approver: string, sender: string): Promise<string> {
  await db.insert(workspaces).values({ id: TENANT, name: 'telegram proposed answer' }).onConflictDoNothing();
  await db.insert(userRoles).values({ user_id: approver, tenant_id: TENANT, role: 'workspace-member' });
  await db.insert(userChannelPrefs).values({
    user_id: approver, channel: 'telegram', address: sender, tenant_id: TENANT, enabled: true,
  });
  const [row] = await db
    .insert(approvals)
    .values({
      tenant_id: TENANT, status: 'pending', kind: 'generic', description: 'Which repo?',
      requester_id: REQUESTER, source: 'n8n', metadata,
    })
    .returning({ id: approvals.id });
  await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: row!.id, user_id: approver, role: 'approver' });
  return row!.id;
}

async function rowOf(approvalId: string) {
  const [row] = await db.select().from(approvals).where(eq(approvals.id, approvalId));
  return row!;
}
async function decisionsOf(approvalId: string) {
  return db.select().from(approvalDecisions).where(eq(approvalDecisions.approval_id, approvalId));
}
async function statusOf(approvalId: string) {
  return (await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId)))[0]!.status;
}

const QUESTION = { deblock_action: 'QUESTION', open_questions: ['Which repo?'] };

/** A Telegram Update that Replies to fr's notification of `approvalId` with `text`. */
function replyUpdate(approvalId: string, text: string, sender: string): Request {
  return new Request('http://test/api/webhooks/telegram/incoming', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      update_id: 1,
      message: {
        message_id: 10,
        from: { id: Number(sender), is_bot: false, first_name: 'George' },
        chat: { id: Number(sender), type: 'private' },
        date: Math.floor(Date.now() / 1000),
        text,
        reply_to_message: {
          message_id: 9,
          from: { id: 123456789, is_bot: true },
          text: `🔔 Approval Required\n\nWhich repo?\n\n[ApprovalId:${approvalId}]`,
        },
      },
    }),
  });
}

describe('a laya-READ approve is never filled with the proposal (the human wrote something)', () => {
  // The ask state machine that used to carry this arm (`sendAsk` + `telegram_pending_answers`)
  // is gone — owner ruling 2026-10-31, one flow for every channel, no per-channel state. The
  // GUARD it protected is not gone: it moved into the shared decide path, where it belongs.
  // A chat seat tells `decideAsChannelSender` that laya read free text via
  // `ChannelSender.bareGrammar === false`, that path forwards it as
  // `recordApprovalDecision(..., { fromFreeText: true })`, and `routes/approvals.ts` then
  // skips `withProposedAnswer` for this row — so the reply's own words are never replaced by
  // the asker's proposal. The row's own answer-required refusal fires instead, which is the
  // same sentence every other channel gives.
  //
  // ⛔ The mutation control is `fromFreeText` at EITHER end (the `bareGrammar: layaRead ===
  // null` argument in channel-reply.ts, or the `opts?.fromFreeText` read in
  // routes/approvals.ts). Remove either and this test goes red.
  itDb('records NOTHING and leaves the row pending — the shared path refuses the unanswerable approve', async () => {
    const approvalId = await seed({ ...QUESTION, proposed_answer: PROPOSAL }, STAFF_A, SENDER_A);
    const approval = await rowOf(approvalId);
    // R325's shape: laya read "approve, but use the main repo" as an approve carrying words.
    // `toChatDecision` drops those words on a row that owes an answer, so `comment` arrives
    // EMPTY — exactly the state that made the old fill record the proposal over them.
    const recorded = await processDecision(approval, SENDER_A, async () => true, 'approve, but use the main repo', {
      channel: 'telegram',
      layaPreRead: { kind: 'approve', comment: 'approve, but use the main repo', layaSaysExtra: true },
    });
    expect(recorded).toBe(false);
    expect(await decisionsOf(approvalId)).toHaveLength(0);
    expect(await statusOf(approvalId)).toBe('pending');
  });

  itDb('CONTROL: the same fixture, a bare grammar `1`, DOES record the proposal (the row is decidable)', async () => {
    // Without this, the test above could be green because the fixture is undecidable.
    const approvalId = await seed({ ...QUESTION, proposed_answer: PROPOSAL }, STAFF_B, SENDER_B);
    const recorded = await processDecision(await rowOf(approvalId), SENDER_B, async () => true, '1', {
      channel: 'telegram',
    });
    expect(recorded).toBe(true);
    const [decision, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(decision).toMatchObject({ decision: 'approved', comment: PROPOSAL });
    expect(await statusOf(approvalId)).toBe('approved');
  });
});

describe('PRECEDENCE: a proposal beats a BLOCKED reviewer recommendation', () => {
  itDb('a bare `1` on a row with BOTH approves WITH the proposal (→ TODO), not as an accepted BLOCKED', async () => {
    const approvalId = await seed(
      { ...QUESTION, reviewer_recommendation: 'BLOCKED', proposed_answer: PROPOSAL },
      STAFF_C,
      SENDER_C,
    );
    const res = await handleTelegramIncoming(replyUpdate(approvalId, '1', SENDER_C));
    expect(res.status).toBe(200);
    const [decision, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(decision).toMatchObject({ decision: 'approved', comment: PROPOSAL });
    expect(await statusOf(approvalId)).toBe('approved');
  });

  itDb('CONTROL: the same row WITHOUT a proposal accepts the BLOCKED recommendation as a reject', async () => {
    // This is the pre-feature meaning of the same reply; the pair is the precedence.
    const approvalId = await seed(
      { ...QUESTION, reviewer_recommendation: 'BLOCKED' },
      STAFF_C,
      SENDER_C,
    );
    const res = await handleTelegramIncoming(replyUpdate(approvalId, '1', SENDER_C));
    expect(res.status).toBe(200);
    const [decision, ...rest] = await decisionsOf(approvalId);
    expect(rest).toHaveLength(0);
    expect(decision).toMatchObject({
      decision: 'rejected',
      comment: 'Accepted reviewer recommendation: BLOCKED (bare approve via Telegram)',
    });
    expect(await statusOf(approvalId)).toBe('rejected');
  });
});
