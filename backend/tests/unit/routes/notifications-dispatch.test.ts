// Unit tests for the /api/notifications/dispatch request contract — the
// schema refinements (routing mode + payload rules) and the ChannelMessage
// builder.
import { test, expect, describe } from 'bun:test';
import { dispatchSchema, buildMessage } from '../../../src/routes/notifications/dispatch';

describe('dispatchSchema routing modes', () => {
  test('accepts a recipientUserId + text', () => {
    const r = dispatchSchema.safeParse({
      recipientUserId: '11111111-1111-4111-8111-111111111111',
      text: 'hello',
    });
    expect(r.success).toBe(true);
  });

  test('accepts a direct channel + address target', () => {
    const r = dispatchSchema.safeParse({ channel: 'telegram', address: '-100999', text: 'ops alert' });
    expect(r.success).toBe(true);
  });

  test('rejects when neither recipientUserId nor channel+address given', () => {
    expect(dispatchSchema.safeParse({ text: 'orphan' }).success).toBe(false);
  });

  test('rejects channel without address', () => {
    expect(dispatchSchema.safeParse({ channel: 'telegram', text: 'x' }).success).toBe(false);
  });

  test('rejects action-result without actionId', () => {
    const r = dispatchSchema.safeParse({
      recipientUserId: '11111111-1111-4111-8111-111111111111',
      kind: 'action-result',
      text: 'done',
    });
    expect(r.success).toBe(false);
  });

  test('defaults kind to text', () => {
    const r = dispatchSchema.safeParse({ channel: 'telegram', address: '5', text: 'x' });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.kind).toBe('text');
  });
});

describe('buildMessage', () => {
  test('builds a text ChannelMessage with correlationId', () => {
    const m = buildMessage({ channel: 'telegram', address: '5', kind: 'text', text: 'hi', correlationId: 'c-1' } as any);
    expect(m.kind).toBe('text');
    expect(m.text).toBe('hi');
    expect(m.correlationId).toBe('c-1');
  });

  test('builds an action-result with meta.actionId', () => {
    const m = buildMessage({ channel: 'telegram', address: '5', kind: 'action-result', text: 'done', actionId: 'a-9' } as any);
    expect(m.kind).toBe('action-result');
    expect((m as any).meta.actionId).toBe('a-9');
  });

  test('empty correlationId when omitted', () => {
    const m = buildMessage({ recipientUserId: 'u', kind: 'text', text: 'x' } as any);
    expect(m.correlationId).toBe('');
  });
});
