// The helpers routes use when they render a caught error THEMSELVES (warning
// fields, failed[] lists, stored request errors, AG-UI outputs) instead of going
// through integrationErrorResponse.

import { describe, expect, test } from 'bun:test';
import {
  IntegrationError,
  clientSafeCaughtErrorText,
  clientSafeUpstreamText,
} from '../../../src/integrations/_lib/errors';
import { withRequestContext, type RequestContext } from '../../../src/integrations/_lib/context';

function frame(callerIsSuperAdmin: boolean): RequestContext {
  return { correlationId: 'cse', initiator: 'human', channel: 'web', callerIsSuperAdmin };
}

const upstream = () =>
  new IntegrationError({
    code: 'UPSTREAM_BAD_STATUS',
    message: 'coding-gateway POST /api/graph/initialize returned 503',
    service: 'coding-gateway',
    path: '/api/graph/initialize',
    method: 'POST',
    upstreamStatus: 503,
  });
const plain = () => new Error('secrets-service createSecret failed (500): vault at secrets.example.com refused');

describe('clientSafeCaughtErrorText', () => {
  test('non-super-admin: IntegrationError → per-status generic text', async () => {
    const out = await withRequestContext(frame(false), async () => clientSafeCaughtErrorText(upstream(), 'fb'));
    expect(out).toBe('A backing service failed — try again');
  });

  test('non-super-admin: a plain Error → the fallback (fails closed)', async () => {
    const out = await withRequestContext(frame(false), async () => clientSafeCaughtErrorText(plain(), 'fb'));
    expect(out).toBe('fb');
  });

  test('super-admin: the raw message', async () => {
    const out = await withRequestContext(frame(true), async () => clientSafeCaughtErrorText(plain(), 'fb'));
    expect(out).toContain('secrets.example.com');
  });

  test('forStorage redacts even for a super-admin writer (a customer reads it back)', async () => {
    const a = await withRequestContext(frame(true), async () =>
      clientSafeCaughtErrorText(upstream(), 'fb', { forStorage: true }),
    );
    const b = await withRequestContext(frame(true), async () =>
      clientSafeCaughtErrorText(plain(), 'fb', { forStorage: true }),
    );
    expect(a).not.toContain('/api/graph/');
    expect(b).toBe('fb');
  });
});

describe('clientSafeUpstreamText', () => {
  test('redacts an IntegrationError for a non-super-admin, keeps an fr-authored message', async () => {
    const [a, b] = await withRequestContext(frame(false), async () => [
      clientSafeUpstreamText(upstream()),
      clientSafeUpstreamText(new Error('Unknown action: fake.tool')),
    ]);
    expect(a).not.toContain('coding-gateway');
    expect(b).toBe('Unknown action: fake.tool');
  });
});
