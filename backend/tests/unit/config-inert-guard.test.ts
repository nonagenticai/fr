import { describe, test, expect, spyOn, beforeEach, afterEach } from 'bun:test';
import { validateProductionConfig } from '../../src/config';

// -------------------------------------------------------------------------
// PROD-BOOT GUARD INERT diagnostic.
//
// `validateProductionConfig` early-returns unless `cfg.env === 'production'`
// (and cfg.env is `process.env.NODE_ENV || 'development'`). A prod-shaped
// deploy that sets ENVIRONMENT=production but forgets NODE_ENV=production
// leaves the guard silently inert — ~25 required-var checks become no-ops.
// That silence caused the analytics outage (empty PROMETHEUS_URL in prod).
// The diagnostic emits a LOUD console.warn on exactly that state WITHOUT
// changing control flow (still returns/proceeds as before). It does NOT
// throw — throwing could crash-loop an env that legitimately omits NODE_ENV.
// -------------------------------------------------------------------------

// ⚠️ AUTH_BYPASS is cleared throughout this file.
//
// `validateProductionConfig` refuses to boot when AUTH_BYPASS=true on a
// production-shaped deploy (config.ts) — a deliberate, narrow exception to this
// file's own "warn, don't throw" rule. The exception is justified because there
// is no legitimate production deploy carrying a full authentication and
// tenant-isolation bypass: refusing to serve beats serving unauthenticated.
//
// CI runs the backend suite with AUTH_BYPASS=true (tests/setup.ts preload), so a test that
// puts the validator in a production posture without clearing it is asserting
// against an INCOHERENT state — prod-shaped AND bypassed — and trips the
// security guard instead of the invariant it means to exercise. Clearing it
// keeps each test measuring its own thing.

const INERT = 'PROD-BOOT GUARD INERT';

describe('validateProductionConfig — inert-guard diagnostic', () => {
  let warnSpy: ReturnType<typeof spyOn>;
  let savedEnvironment: string | undefined;
  let savedNodeEnv: string | undefined;
  let savedAuthBypass: string | undefined;

  beforeEach(() => {
    savedEnvironment = process.env.ENVIRONMENT;
    savedNodeEnv = process.env.NODE_ENV;
    savedAuthBypass = process.env.AUTH_BYPASS;
    delete process.env.AUTH_BYPASS;
    warnSpy = spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (savedEnvironment === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = savedEnvironment;
    if (savedNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedNodeEnv;
    if (savedAuthBypass === undefined) delete process.env.AUTH_BYPASS;
    else process.env.AUTH_BYPASS = savedAuthBypass;
  });

  /** Did console.warn receive a call whose message mentions the inert guard? */
  const warnedInert = (): boolean =>
    warnSpy.mock.calls.some((args: unknown[]) =>
      args.some((a: unknown) => typeof a === 'string' && a.includes(INERT)),
    );

  test('warns (does NOT throw) when ENVIRONMENT=production but NODE_ENV is not', () => {
    process.env.ENVIRONMENT = 'production';
    process.env.NODE_ENV = 'development'; // the silent-inert state

    // Must NOT throw — the diagnostic is warn-only and the early-return path
    // is preserved (cfg.env !== 'production' → the validator returns).
    expect(() =>
      validateProductionConfig({ env: 'development', services: {} }),
    ).not.toThrow();

    expect(warnedInert()).toBe(true);
  });

  test('does NOT warn AND proceeds past the early-return when env IS production', () => {
    // With ENVIRONMENT=production AND cfg.env=production the INERT branch is
    // false. Empty services means the validator proceeds past the early-return
    // and THROWS on the missing required env vars — proving it did NOT early
    // return, and proving no inert warning was emitted on the correct posture.
    process.env.ENVIRONMENT = 'production';

    expect(() =>
      validateProductionConfig({ env: 'production', services: {} }),
    ).toThrow(/missing required env vars/);

    expect(warnedInert()).toBe(false);
  });

  test('silent (no warn, no throw) when neither ENVIRONMENT nor NODE_ENV is production', () => {
    delete process.env.ENVIRONMENT;
    process.env.NODE_ENV = 'development';

    expect(() =>
      validateProductionConfig({ env: 'development', services: {} }),
    ).not.toThrow();

    expect(warnedInert()).toBe(false);
  });
});
