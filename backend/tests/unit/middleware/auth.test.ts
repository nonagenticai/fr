import { test, expect, describe, afterEach } from 'bun:test';
import { validateAuthWithToken } from '../../../src/middleware/auth';

// Preload (tests/setup.ts) sets AUTH_BYPASS=true globally. These tests
// flip it off temporarily to exercise the non-bypass branch; afterEach must
// always restore to 'true', never delete, or parallel cross-file tests lose
// the preload guarantee mid-run.
afterEach(() => {
  process.env.AUTH_BYPASS = 'true';
});

describe('validateAuthWithToken', () => {
  test('returns user + raw bearer token with AUTH_BYPASS=true', async () => {
    process.env.AUTH_BYPASS = 'true';
    const req = new Request('http://x', { headers: { Authorization: 'Bearer xyz' } });
    const out = await validateAuthWithToken(req);
    expect(out.user.id).toBeTruthy();
    expect(out.accessToken).toBe('xyz');
  });

  test('returns bypass accessToken when no Bearer header under AUTH_BYPASS', async () => {
    process.env.AUTH_BYPASS = 'true';
    const req = new Request('http://x');
    const out = await validateAuthWithToken(req);
    expect(out.accessToken).toBe('bypass');
  });
});
