import { test, expect, describe } from 'bun:test';
import {
  plankaEnv,
  unique,
  isProdHost,
  prodTargetRefusal,
  plankaEnabled,
  cleanupProjects,
  PLANKA_OPT_IN_VAR,
} from './_setup';

/**
 * Restore a single env var to its previous value — handles the undefined →
 * unset case explicitly. Needed because this file runs alphabetically FIRST
 * in the integration suite; leaking mutated TEST_PLANKA_* vars here causes
 * every other file's `plankaDescribe(...)` to evaluate to `.skip`.
 */
function restoreEnv(key: string, prev: string | undefined): void {
  if (prev === undefined) delete process.env[key];
  else process.env[key] = prev;
}

describe('integration harness', () => {
  test('plankaEnv returns null when TEST_PLANKA_* vars are unset', () => {
    const prevUrl = process.env.TEST_PLANKA_URL;
    const prevEmail = process.env.TEST_PLANKA_EMAIL;
    const prevPw = process.env.TEST_PLANKA_PASSWORD;
    delete process.env.TEST_PLANKA_URL;
    delete process.env.TEST_PLANKA_EMAIL;
    delete process.env.TEST_PLANKA_PASSWORD;
    try {
      expect(plankaEnv()).toBeNull();
    } finally {
      restoreEnv('TEST_PLANKA_URL', prevUrl);
      restoreEnv('TEST_PLANKA_EMAIL', prevEmail);
      restoreEnv('TEST_PLANKA_PASSWORD', prevPw);
    }
  });

  test('plankaEnv returns values when all three vars are set', () => {
    const prevUrl = process.env.TEST_PLANKA_URL;
    const prevEmail = process.env.TEST_PLANKA_EMAIL;
    const prevPw = process.env.TEST_PLANKA_PASSWORD;
    process.env.TEST_PLANKA_URL = 'http://example';
    process.env.TEST_PLANKA_EMAIL = 'a@b';
    process.env.TEST_PLANKA_PASSWORD = 'p';
    try {
      expect(plankaEnv()).toEqual({ url: 'http://example', email: 'a@b', password: 'p' });
    } finally {
      restoreEnv('TEST_PLANKA_URL', prevUrl);
      restoreEnv('TEST_PLANKA_EMAIL', prevEmail);
      restoreEnv('TEST_PLANKA_PASSWORD', prevPw);
    }
  });

  test('unique produces distinct strings', () => {
    const a = unique('test');
    const b = unique('test');
    expect(a.startsWith('test-')).toBe(true);
    expect(a).not.toBe(b);
  });
});

describe('production-target guard', () => {
  test('isProdHost: estate zones are prod, local hosts are not', () => {
    for (const h of ['kanban.nonagentic.ai', 'nonagentic.ai', 'planka.kanban', 'postgres',
      'planka.kanban', 'pgbouncer.pgbouncer.svc', 'KANBAN.NONAGENTIC.AI.']) {
      expect(isProdHost(h)).toBe(true);
    }
    for (const h of ['localhost', '127.0.0.1', 'api.notnonagentic.ai', 'devbox.test', 'db.test', 'app.localhost']) {
      expect(isProdHost(h)).toBe(false);
    }
  });

  test('isProdHost: short in-cluster names are prod', () => {
    for (const h of ['postgres', 'planka', 'example', 'pgbouncer', 'pgbouncer.pgbouncer', 'planka.kanban',
      '10-42-1-7.default.pod.cluster.local']) {
      expect(isProdHost(h)).toBe(true);
    }
  });

  test('isProdHost: pod/service CIDRs, tailnet and node public IPs are prod; neighbours are not', () => {
    for (const h of ['10.42.0.1', '10.42.255.254', '10.43.0.10', '10.43.0.219', '100.64.0.11',
      '100.64.0.10', '100.64.0.1', '100.127.255.254', '[fd7a:115c:a1e0::1]', '[::ffff:6471:2030]',
      '85.215.118.229', '217.160.28.34', '217.160.57.117', '85.215.101.85', '85.215.253.207', '84.80.5.71']) {
      expect(isProdHost(h)).toBe(true);
    }
    for (const h of ['[::1]', '10.41.255.255', '10.44.0.0', '100.63.255.255', '100.128.0.0', '192.168.1.13',
      '85.215.118.228']) {
      expect(isProdHost(h)).toBe(false);
    }
  });

  test('refuses IP and short-name targets as new URL() spells them', () => {
    for (const DATABASE_URL of ['postgres://u:p@postgres:5432/fr', 'postgres://u:p@10.43.0.34:6432/fr',
      'postgres://u:p@[fd7a:115c:a1e0::5]:5432/fr', 'postgres://u:p@[::ffff:100.64.0.11]:5432/fr',
      'postgres://u:p@pgbouncer.pgbouncer:6432/fr']) {
      expect(prodTargetRefusal({ TEST_PLANKA_URL: 'http://localhost:3333', DATABASE_URL })).toContain('DATABASE_URL');
    }
    expect(prodTargetRefusal({ TEST_PLANKA_URL: 'http://100.64.0.10:3333' })).toContain('production');
  });

  test('refuses a prod Planka URL and a prod DATABASE_URL unless ALLOW_PROD_INTEGRATION=1', () => {
    expect(prodTargetRefusal({ TEST_PLANKA_URL: 'https://kanban.nonagentic.ai' })).toContain('production');
    expect(
      prodTargetRefusal({
        TEST_PLANKA_URL: 'http://localhost:3333',
        DATABASE_URL: 'postgres://u:p@pgbouncer.pgbouncer:6432/fr',
      }),
    ).toContain('DATABASE_URL');
    expect(prodTargetRefusal({ TEST_PLANKA_URL: 'not a url' })).toContain('not a parseable URL');
    expect(prodTargetRefusal({ TEST_PLANKA_URL: 'https://kanban.nonagentic.ai', ALLOW_PROD_INTEGRATION: 'true' }))
      .not.toBeNull();
    expect(prodTargetRefusal({ TEST_PLANKA_URL: 'https://kanban.nonagentic.ai', ALLOW_PROD_INTEGRATION: '1' }))
      .toBeNull();
    expect(
      prodTargetRefusal({ TEST_PLANKA_URL: 'http://localhost:3333', DATABASE_URL: 'postgres://u:p@localhost:5432/fr' }),
    ).toBeNull();
  });

  test('plankaEnabled needs the TEST_PLANKA_* credentials AND the explicit opt-in', () => {
    const keys = ['TEST_PLANKA_URL', 'TEST_PLANKA_EMAIL', 'TEST_PLANKA_PASSWORD', PLANKA_OPT_IN_VAR];
    const prev = keys.map((k) => process.env[k]);
    try {
      process.env.TEST_PLANKA_URL = 'http://localhost:3333';
      process.env.TEST_PLANKA_EMAIL = 'a@b';
      process.env.TEST_PLANKA_PASSWORD = 'p';
      delete process.env[PLANKA_OPT_IN_VAR];
      expect(plankaEnabled()).toBe(false);
      process.env[PLANKA_OPT_IN_VAR] = '1';
      expect(plankaEnabled()).toBe(true);
    } finally {
      keys.forEach((k, i) => restoreEnv(k, prev[i]));
    }
  });
});

describe('cleanupProjects', () => {
  test('no client with ids to clean is a failure, not a no-op', async () => {
    await expect(cleanupProjects(undefined, ['p1'])).rejects.toThrow(/no client/);
    await expect(cleanupProjects(undefined, [undefined])).resolves.toBeUndefined();
  });
});
