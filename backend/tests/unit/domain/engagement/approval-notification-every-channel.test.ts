// The approval notification is ONE text on every channel (approval-menu.ts). Its menu never
// promises a typed `1` the decide path refuses: an ACTION approval runs as its decider, so on a
// channel whose typed sender is unverified (lib/action-decision-identity.ts — email, Teams free
// text) it offers fr instead of the numbered menu.
import { describe, expect, test } from 'bun:test';

import {
  actionPendingReply,
  approvalNotificationParts,
  renderApprovalParts,
} from '../../../../src/domain/engagement/approval-menu';
import { approvalNotificationCopy } from '../../../../src/domain/engagement/notifications';

const ID = '5f1b7c2e-0d4a-4e8b-9c3f-2a6d8e1f0b47';
const row = (action_id: string | null) => ({
  id: ID, status: 'pending', description: 'Run the write?', kind: 'generic', metadata: {}, action_id,
});
const text = (channel: string, action_id: string | null) => {
  const parts = approvalNotificationParts(row(action_id), null, channel);
  return renderApprovalParts(parts, parts.description, 0);
};

describe('approval notification on every channel', () => {
  test('a non-action approval: the identical text, numbered menu included, on every channel', () => {
    const first = text('telegram', null);
    expect(first).toContain('1 - Approve');
    for (const ch of ['mcp', 'inapp', 'email', 'teams']) expect(text(ch, null)).toBe(first);
  });

  test('an ACTION approval offers `1` only where a typed reply can decide it', () => {
    for (const ch of ['telegram', 'mcp', 'inapp']) expect(text(ch, 'a1')).toContain('1 - Approve');
    for (const ch of ['email', 'teams']) {
      expect(text(ch, 'a1')).not.toContain('1 - Approve');
      expect(text(ch, 'a1')).toContain('Decide it in fr: ');
      expect(text(ch, 'a1')).toContain(`[ApprovalId:${ID}]`);
    }
  });

  test('the copy every send and re-delivery is built from keeps action_id (and kind)', () => {
    // The first send of an action approval and the re-delivery worker both send THIS copy.
    const copy = approvalNotificationCopy({
      id: ID, tenant_id: 't1', project_id: null, description: 'Run the write?', card_id: null,
      callback_path: null, source: null, metadata: {}, status: 'pending', expires_at: null,
      requester_id: null, kind: 'generic', action_id: 'a1',
    });
    expect(copy).toMatchObject({ action_id: 'a1', kind: 'generic', tenant_id: 't1' });
    const parts = approvalNotificationParts(copy, null, 'email');
    expect(renderApprovalParts(parts, parts.description, 0)).not.toContain('1 - Approve');
  });

  test('the reply to a PARKED action offers `approve <id>` only where it can decide it', () => {
    const reply = (channel: string, webSession = false) =>
      actionPendingReply({ channel, webSession, actionName: 'projects.create', approvalId: ID, pendingText: `Reply "approve ${ID}" to create it` });
    for (const ch of ['telegram', 'mcp']) expect(reply(ch)).toBe(`Reply "approve ${ID}" to create it`);
    expect(reply('inapp', true)).toBe(`Reply "approve ${ID}" to create it`);
    // The in-app box without a session, email and Teams free text cannot decide it.
    for (const r of [reply('inapp', false), reply('email'), reply('teams')]) {
      expect(r).not.toContain('Reply "approve');
      expect(r).toContain('Decide it in fr: ');
      expect(r).toContain(`[ApprovalId:${ID}]`);
    }
  });
});
