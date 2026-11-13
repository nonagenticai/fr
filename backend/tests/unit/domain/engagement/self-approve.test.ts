// Unit tests for shouldSelfApprove — the human self-service "immediate
// self-approve" gate. It fires ONLY when the action opts in via
// autoApproveForInitiator, the initiator is a human, and the sole required
// approver is the requester. Non-opted-in actions, non-human initiators, and
// other/multi approvers all park.
//
// No DB: single-approver:initiator and literal-approver policies resolve without
// a projects lookup, so these cases never touch Postgres.

import { test, expect, describe } from 'bun:test';
import { z } from 'zod';

import { shouldSelfApprove } from '../../../../src/domain/engagement/action-approvals';
import type {
  AgentCallableAction,
  ActionContext,
  ApprovalPolicy,
} from '../../../../src/agui/types';

function writeAction(
  approval: ApprovalPolicy,
  autoApproveForInitiator = true,
): AgentCallableAction {
  return {
    name: 'demo.write_thing',
    kind: 'write',
    description: 'demo write',
    input: z.object({ id: z.string() }),
    output: z.object({ ok: z.boolean() }),
    approval,
    autoApproveForInitiator,
    idempotencyKey: (input) => `demow:${(input as { id: string }).id}`,
    cronSafe: true,
    handler: async () => ({ ok: true }),
    rbac: { type: 'public' },
  } as AgentCallableAction;
}

const ctx = (over: Partial<ActionContext> = {}): ActionContext => ({
  userId: 'u1',
  projectId: null,
  correlationId: 'cid',
  initiator: 'human',
  channel: 'web',
  ...over,
});

const initiatorPolicy: ApprovalPolicy = { type: 'single-approver', approver: 'initiator' };

describe('shouldSelfApprove', () => {
  test('opted-in + human + single-approver:initiator → true', async () => {
    expect(await shouldSelfApprove(writeAction(initiatorPolicy), ctx())).toBe(true);
  });

  test('NOT opted in → false (default; other writes park unchanged)', async () => {
    expect(await shouldSelfApprove(writeAction(initiatorPolicy, false), ctx())).toBe(false);
  });

  test('agent initiator → false (human-reviews-agent gate stands)', async () => {
    expect(
      await shouldSelfApprove(writeAction(initiatorPolicy), ctx({ initiator: 'agent' })),
    ).toBe(false);
  });

  test('cron initiator → false', async () => {
    expect(
      await shouldSelfApprove(writeAction(initiatorPolicy), ctx({ initiator: 'cron' })),
    ).toBe(false);
  });

  test('opted-in + human but a DIFFERENT sole approver → false (real gate)', async () => {
    const other: ApprovalPolicy = { type: 'single-approver', approver: 'someone-else' };
    expect(await shouldSelfApprove(writeAction(other), ctx())).toBe(false);
  });

  test('opted-in + human + consensus (min 2) → false', async () => {
    const consensus: ApprovalPolicy = {
      type: 'consensus',
      approvers: ['u1', 'u2'],
      min: 2,
    };
    expect(await shouldSelfApprove(writeAction(consensus), ctx())).toBe(false);
  });
});
