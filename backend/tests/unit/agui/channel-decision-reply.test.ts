// The chat reply for a decision recorded through the shared decide path (Telegram, Teams).
// The route's body says whether n8n accepted the hand-off in `callback.settled` (never
// `delivered`); reading the wrong field told every operator the hand-off failed.
import { describe, expect, test } from 'bun:test';

import { channelDecisionReply } from '../../../src/agui/actions/approvals-decide';

describe('channelDecisionReply', () => {
  test('a settled callback is reported as handed off', () => {
    const reply = channelDecisionReply('approve', {
      status: 'approved',
      approval_complete: true,
      callback: { outcome: 'sent', settled: true },
    });
    expect(reply).not.toContain('could NOT confirm');
    expect(reply).toContain('APPROVED');
  });

  test('an unsettled callback says fr could not confirm the hand-off', () => {
    const reply = channelDecisionReply('approve', {
      status: 'approved',
      approval_complete: true,
      callback: { outcome: 'pending', settled: false, reason: 'still in flight' },
    });
    expect(reply).toContain('could NOT confirm');
  });

  test('a decision that did not complete the approval only says it was recorded', () => {
    const reply = channelDecisionReply('reject', { status: 'pending', approval_complete: false, callback: { outcome: 'not-attempted', settled: true } });
    expect(reply).toContain('Waiting for other approvers');
  });
});
