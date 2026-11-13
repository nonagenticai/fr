// ⭐ THE SAME `1` RECORDS THE SAME DECISION FROM EVERY CHANNEL (owner ruling 2026-10-31).
//
// "any channel for any project any card-type always works exactly the same, if via any
// channel the approval message for choices [1,2,3] can be '1' as response, that applies to
// all channels and all cases!"
//
// A QUESTION row that names the reviewer's recommendation of BLOCKED is the case that used
// to differ: Telegram recorded the acceptance as a REJECT, while the identical bare approve
// from Teams/`approvals.decide` fell into the answer-required refusal. Both rows below
// are IDENTICAL except for the seat, and both must land on the same decision, the same
// comment, and the same completed status.
//
// The approve-all arm is covered by tests/unit/lib/channel-bare-approve.test.ts: the
// derivation takes NO channel argument, so it cannot branch on one.
import { afterEach, describe, expect } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';

import {
  approvalDecisions,
  approvals,
  db,
  requiredApprovers,
  userRoles,
  workspaces,
} from '../../../src/db/client';
import { decideAsChannelSender } from '../../../src/agui/actions/approvals-decide';
import { createDbSuite } from '../helpers/db-suite';

const TENANT = '7b94f1c6-2794-4d22-8b66-00000000c0de';
const DECIDER_A = '7b94f1c6-2794-4d22-8b66-0000000000a1';
const DECIDER_B = '7b94f1c6-2794-4d22-8b66-0000000000b2';
const REQUESTER = '7b94f1c6-2794-4d22-8b66-000000000aaa';

const { itDb } = createDbSuite('bare-approve-every-channel');

/** The row shape that owes an answer AND names the recommendation a bare `1` accepts. */
const QUESTION_METADATA = {
  deblock_action: 'QUESTION',
  open_questions: [
    'The reviewer recommends "BLOCKED". Approve with "yes" to accept that, or state what to do instead.',
  ],
};

afterEach(async () => {
  const appr = (await db.select({ id: approvals.id }).from(approvals).where(eq(approvals.tenant_id, TENANT))).map((r) => r.id);
  if (appr.length) {
    await db.delete(approvalDecisions).where(inArray(approvalDecisions.approval_id, appr));
    await db.delete(requiredApprovers).where(inArray(requiredApprovers.approval_id, appr));
    await db.delete(approvals).where(inArray(approvals.id, appr));
  }
  await db.delete(userRoles).where(eq(userRoles.tenant_id, TENANT));
  await db.delete(workspaces).where(eq(workspaces.id, TENANT));
});

async function seedQuestionRow(deciderId: string): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({
      tenant_id: TENANT,
      status: 'pending',
      kind: 'generic',
      description: 'Worker asks what to do',
      requester_id: REQUESTER,
      metadata: QUESTION_METADATA,
    })
    .returning({ id: approvals.id });
  const approvalId = row!.id;
  await db.insert(requiredApprovers).values({ tenant_id: TENANT, approval_id: approvalId, user_id: deciderId, role: 'approver' });
  return approvalId;
}

/** One bare approve, through the SAME function every chat seat calls. */
async function bareApprove(channel: string, userId: string, approvalId: string) {
  return decideAsChannelSender(
    { channel, userId, tenantId: TENANT },
    { approvalId, decision: 'approve' },
  );
}

describe('a bare approve records the same decision from every channel', () => {
  itDb('a BLOCKED recommendation is accepted as a REJECT from Telegram and from Teams', async () => {
    await db.insert(workspaces).values({ id: TENANT, name: 'bare approve every channel' }).onConflictDoNothing();
    // Two deciders: the burst limiter is per DECIDER (lib/decision-rate-limit.ts), so one
    // person deciding twice in a row would be refused for a reason that is not under test.
    await db.insert(userRoles).values([
      { user_id: DECIDER_A, tenant_id: TENANT, role: 'workspace-member' },
      { user_id: DECIDER_B, tenant_id: TENANT, role: 'workspace-member' },
    ]);

    const telegramRow = await seedQuestionRow(DECIDER_A);
    const teamsRow = await seedQuestionRow(DECIDER_A);

    const telegram = await bareApprove('telegram', DECIDER_A, telegramRow);
    const teams = await bareApprove('teams', DECIDER_B, teamsRow);

    // The seat's own report of what it recorded — identical, including the preface the chat
    // reply leads with. ⛔ `output.decision` is the RECORDED verb, and the seat must render
    // its reply from THIS, not from the `approve` it typed: the shared path turned it into a
    // reject, and a chat reply that says "approved" over a rejected row is a lie.
    expect(telegram.output.decision).toBe('reject');
    expect(teams.output.decision).toBe('reject');
    expect(telegram.preface).toBe(teams.preface);

    for (const [label, approvalId] of [['telegram', telegramRow], ['teams', teamsRow]] as const) {
      const [status] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, approvalId));
      expect(status?.status, label).toBe('rejected');
      const decisions = await db.select().from(approvalDecisions).where(eq(approvalDecisions.approval_id, approvalId));
      expect(decisions, label).toHaveLength(1);
      expect(decisions[0]!.decision, label).toBe('rejected');
      expect(decisions[0]!.comment, label).toContain('Accepted reviewer recommendation: BLOCKED');
    }
  }, 60_000);
});
