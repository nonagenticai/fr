// AUTH_BYPASS (dev/CI only; production refuses to start with it) has no real
// identity provider, so the deleted-user check must not ask Keycloak — or every
// agent-session refresh under AUTH_BYPASS becomes a 503.
import { afterEach, describe, expect, test } from 'bun:test';
import { resolveUserAccountStatus } from '../../../src/services/agent-session';

const saved = { bypass: process.env.AUTH_BYPASS, env: process.env.NODE_ENV };
afterEach(() => {
  process.env.AUTH_BYPASS = saved.bypass;
  process.env.NODE_ENV = saved.env;
});

const unreachable = () => Promise.reject(new Error('auth.invalid unreachable'));

describe('resolveUserAccountStatus', () => {
  test('AUTH_BYPASS outside production: active, Keycloak never asked', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'test';
    let asked = false;
    const status = await resolveUserAccountStatus('u1', () => {
      asked = true;
      return unreachable();
    });
    expect(status).toBe('active');
    expect(asked).toBe(false);
  });

  test('without AUTH_BYPASS the real lookup decides (deleted user stays refused)', async () => {
    process.env.AUTH_BYPASS = 'false';
    expect(await resolveUserAccountStatus('u1', () => Promise.resolve('not_found'))).toBe('not_found');
    await expect(resolveUserAccountStatus('u1', unreachable)).rejects.toThrow('unreachable');
  });

  test('AUTH_BYPASS in production still asks (defence in depth beyond the boot guard)', async () => {
    process.env.AUTH_BYPASS = 'true';
    process.env.NODE_ENV = 'production';
    expect(await resolveUserAccountStatus('u1', () => Promise.resolve('disabled'))).toBe('disabled');
  });
});
