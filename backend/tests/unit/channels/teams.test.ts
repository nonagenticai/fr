// Unit tests for E-7 Teams channel.parseWebhook.
//
// Asserts the back-compat hinge: any payload satisfying the legacy
// TeamsActionSchema returns null (so the existing route handler still owns
// it), and free-text Bot Framework / adaptive-card text input returns a
// populated InboundMessage.

import { test, expect, describe } from 'bun:test';

import { teamsChannel } from '../../../src/channels/teams';

function jsonReq(body: unknown): Request {
  return new Request('https://fr.test/api/webhooks/teams', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('teamsChannel.parseWebhook', () => {
  test('returns null for a legacy approval-callback payload (TeamsActionSchema)', async () => {
    const result = await teamsChannel.parseWebhook(
      jsonReq({
        approvalId: '123e4567-e89b-12d3-a456-426614174000',
        decision: 'approved',
        approverId: '00000000-0000-0000-0000-000000000001',
      }),
    );
    expect(result).toBeNull();
  });

  test('returns null for an abstain decision (still legacy approval shape)', async () => {
    const result = await teamsChannel.parseWebhook(
      jsonReq({
        approvalId: '123e4567-e89b-12d3-a456-426614174000',
        decision: 'abstain',
      }),
    );
    expect(result).toBeNull();
  });

  test('returns InboundMessage for a top-level text payload', async () => {
    const result = await teamsChannel.parseWebhook(
      jsonReq({
        text: 'scrape https://example.com',
        from: { aadObjectId: 'aad-1', name: 'Alice' },
        conversation: { id: 'convo-1' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.channel).toBe('teams');
    expect(result!.userId).toBe('aad-1');
    expect(result!.address).toBe('aad-1');
    expect(result!.text).toBe('scrape https://example.com');
    expect(result!.threadId).toBe('convo-1');
    expect(typeof result!.correlationId).toBe('string');
  });

  test('returns InboundMessage for nested value.text (adaptive-card free input)', async () => {
    const result = await teamsChannel.parseWebhook(
      jsonReq({
        value: { text: 'hello agent' },
        from: { id: 'fallback-id' },
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.text).toBe('hello agent');
    expect(result!.userId).toBe('fallback-id');
  });

  test('returns null for empty body', async () => {
    const result = await teamsChannel.parseWebhook(jsonReq({}));
    expect(result).toBeNull();
  });

  test('returns null for malformed JSON', async () => {
    const req = new Request('https://fr.test/api/webhooks/teams', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    const result = await teamsChannel.parseWebhook(req);
    expect(result).toBeNull();
  });
});
