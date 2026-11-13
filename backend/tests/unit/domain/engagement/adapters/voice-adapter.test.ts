// Unit tests for VoiceAdapter STUB (E-10).
import { test, expect, describe } from 'bun:test';
import { VoiceAdapter } from '../../../../../src/domain/engagement/adapters/voice';
import type { ApprovalWithDetails, ChannelMessage } from '../../../../../src/domain/engagement/notifications';

const APPROVAL: ApprovalWithDetails = {
  id: '11111111-2222-3333-4444-555555555555',
  project_id: null,
  description: 'irrelevant',
  card_id: null,
  callback_path: null,
  source: null,
  metadata: null,
  status: 'pending',
  expires_at: new Date(Date.now() + 60_000),
  requester_id: null,
};

describe('VoiceAdapter (stub)', () => {
  test('construction never throws', () => {
    expect(() => new VoiceAdapter()).not.toThrow();
  });

  test('name is "voice"', () => {
    expect(new VoiceAdapter().name).toBe('voice');
  });

  test('send always returns voice-not-implemented', async () => {
    const adapter = new VoiceAdapter();
    const res = await adapter.send(APPROVAL, '+15551112222');
    expect(res.success).toBe(false);
    expect(res.error).toBe('voice-not-implemented');
  });

  test('sendMessage always returns voice-not-implemented', async () => {
    const adapter = new VoiceAdapter();
    const msg: ChannelMessage = {
      kind: 'text',
      correlationId: 'cid-1',
      text: 'hello',
    };
    const res = await adapter.sendMessage('+15551112222', msg);
    expect(res.success).toBe(false);
    expect(res.error).toBe('voice-not-implemented');
  });

  test('sendMessage approval-request kind also returns not-implemented (no meta validation needed)', async () => {
    const adapter = new VoiceAdapter();
    const msg: ChannelMessage = {
      kind: 'approval-request',
      correlationId: 'cid-2',
      text: 'Deploy?',
      // stub doesn't validate, it just rejects — meta is required by the
      // discriminated union but not exercised here.
      meta: { approvalId: 'a-1' },
    };
    const res = await adapter.sendMessage('+15551112222', msg);
    expect(res.success).toBe(false);
    expect(res.error).toBe('voice-not-implemented');
  });
});
