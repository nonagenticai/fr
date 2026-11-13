// tests/unit/config-auth-bypass-guard.test.ts
//
// AUTH_BYPASS must never reach production.
//
// `AUTH_BYPASS=true` is not merely "skip Keycloak". Measured on origin/main it
// also disables the fr licence gate (lib/require-fr-license.ts:148), the kag
// licence gate, the board TENANT-ISOLATION gate (lib/board-tenant-access.ts:104)
// and the n8n API-key requirement (integrations/n8n.ts:82), while handing every
// request a synthetic admin. Until this guard, NOTHING in the codebase stopped
// it being set on a production deployment — there was no check anywhere.
//
// The guard is what makes it safe to give the bypass identity `super_admin`, so
// fr's own Playwright lanes can finally drive the Administration zone. These two
// changes are a pair: the roles are only safe because the boot refuses.

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';

import { validateProductionConfig } from '../../src/config';

const TOUCHED = ['AUTH_BYPASS', 'ENVIRONMENT'] as const;
const saved = Object.fromEntries(TOUCHED.map((k) => [k, process.env[k]]));
afterEach(() => {
  for (const k of TOUCHED) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});
beforeEach(() => {
  delete process.env.AUTH_BYPASS;
  delete process.env.ENVIRONMENT;
});

/** A config whose service URLs are all present, so only the bypass check can fire. */
function prodCfg(env = 'production') {
  return { env, services: {} as Record<string, unknown> };
}

describe('a production boot refuses AUTH_BYPASS', () => {
  test('NODE_ENV=production + AUTH_BYPASS=true throws', () => {
    process.env.AUTH_BYPASS = 'true';
    expect(() => validateProductionConfig(prodCfg())).toThrow(/AUTH_BYPASS/);
  });

  test('ENVIRONMENT=production ALSO throws, even when NODE_ENV does not say so', () => {
    // ⚠️ The discriminating case, and the reason this guard sits BEFORE the
    // `cfg.env !== 'production'` early return. config.ts already documents that
    // a deploy with ENVIRONMENT=production but NODE_ENV unset makes the rest of
    // this validator a NO-OP — a coupling that caused a real outage. That is
    // exactly the deploy shape where a stray AUTH_BYPASS would otherwise
    // survive, so this check fires on the UNION of the two signals.
    process.env.AUTH_BYPASS = 'true';
    process.env.ENVIRONMENT = 'production';
    expect(() => validateProductionConfig(prodCfg('development'))).toThrow(/AUTH_BYPASS/);
  });

  test('the message names the blast radius, not just the variable', () => {
    // An operator who sees only "AUTH_BYPASS is set" may believe it merely skips
    // a login. It also switches off tenant isolation and both licence gates.
    process.env.AUTH_BYPASS = 'true';
    let msg = '';
    try {
      validateProductionConfig(prodCfg());
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toContain('licence');
    expect(msg).toContain('tenant isolation');
  });
});

describe('what the guard must NOT do', () => {
  test('development with AUTH_BYPASS=true boots fine', () => {
    // The whole point. Breaking local dev and both Playwright lanes to close a
    // production hole would trade one defect for another.
    process.env.AUTH_BYPASS = 'true';
    expect(() => validateProductionConfig({ env: 'development', services: {} })).not.toThrow();
  });

  test('production WITHOUT AUTH_BYPASS is unaffected by this check', () => {
    // Negative control: proves the throw above comes from the bypass check and
    // not merely from being in production mode.
    expect(() => validateProductionConfig(prodCfg())).not.toThrow(/AUTH_BYPASS/);
  });

  test('AUTH_BYPASS set to anything other than "true" is not a bypass', () => {
    // The runtime check is `=== 'true'`. A guard that tripped on 'false' would
    // block a legitimate deploy that explicitly disables the bypass.
    process.env.AUTH_BYPASS = 'false';
    expect(() => validateProductionConfig(prodCfg())).not.toThrow(/AUTH_BYPASS/);
  });
});
