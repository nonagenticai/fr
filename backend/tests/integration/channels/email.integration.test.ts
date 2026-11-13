// E-10: Mailgun-style email webhook parsing. No mocks — exercises the real
// channels/email.ts against synthetic Mailgun-shaped Request payloads.
import { test, expect, describe } from 'bun:test';
import { emailChannel } from '../../../src/channels/email';

function urlencodedRequest(form: Record<string, string>): Request {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(form)) params.set(k, v);
  return new Request('http://test/webhooks/email', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: params.toString(),
  });
}

function multipartRequest(form: Record<string, string>): Request {
  const fd = new FormData();
  for (const [k, v] of Object.entries(form)) fd.set(k, v);
  return new Request('http://test/webhooks/email', {
    method: 'POST',
    body: fd,
  });
}

function jsonRequest(form: Record<string, string>): Request {
  return new Request('http://test/webhooks/email', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(form),
  });
}

describe('emailChannel.parseWebhook (Mailgun-style)', () => {
  test('parses urlencoded Mailgun POST and extracts plain-text body', async () => {
    const req = urlencodedRequest({
      from: 'Alice <alice@example.com>',
      subject: 'Re: Approval needed',
      'body-plain': 'Approve this please.',
      'Message-Id': '<msg-abc-123@example.com>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.channel).toBe('email');
    expect(msg!.userId).toBe('alice@example.com');
    expect(msg!.address).toBe('alice@example.com');
    expect(msg!.text).toContain('Approve this please.');
    expect(msg!.text).toContain('Re: Approval needed');
    expect(msg!.correlationId).toBe('msg-abc-123@example.com');
  });

  test('falls back to stripped-text when body-plain absent', async () => {
    const req = urlencodedRequest({
      from: 'bob@example.com',
      subject: 'hi',
      'stripped-text': 'just the user-typed bit',
      'Message-Id': '<m1@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.text).toContain('just the user-typed bit');
  });

  test('parses multipart/form-data Mailgun POST', async () => {
    const req = multipartRequest({
      from: 'carol@example.com',
      subject: 'multipart subject',
      'body-plain': 'multipart body',
      'Message-Id': '<m-multi@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.userId).toBe('carol@example.com');
    expect(msg!.text).toContain('multipart body');
  });

  test('accepts JSON-shaped webhook with same field names', async () => {
    const req = jsonRequest({
      from: 'dave@example.com',
      subject: 'json',
      'body-plain': 'json body text',
      'Message-Id': '<m-json@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.userId).toBe('dave@example.com');
    expect(msg!.text).toContain('json body text');
  });

  test('returns null when from header is missing', async () => {
    const req = urlencodedRequest({
      subject: 'orphan',
      'body-plain': 'no sender',
      'Message-Id': '<m@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).toBeNull();
  });

  test('returns null when body is empty', async () => {
    const req = urlencodedRequest({
      from: 'alice@example.com',
      subject: 'empty body',
      'Message-Id': '<m@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).toBeNull();
  });

  test('lowercases the extracted email address', async () => {
    const req = urlencodedRequest({
      from: 'Alice <ALICE@EXAMPLE.COM>',
      'body-plain': 'hi',
      'Message-Id': '<m@x>',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg!.userId).toBe('alice@example.com');
  });

  test('mints a correlationId when Message-Id is absent', async () => {
    const req = urlencodedRequest({
      from: 'alice@example.com',
      'body-plain': 'no message-id',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).not.toBeNull();
    expect(msg!.correlationId).toBeTruthy();
    expect(msg!.correlationId.length).toBeGreaterThan(0);
  });

  test('returns null on non-form content-type with garbage body', async () => {
    const req = new Request('http://test/webhooks/email', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: 'just a plain string',
    });
    const msg = await emailChannel.parseWebhook(req);
    expect(msg).toBeNull();
  });
});
