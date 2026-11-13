// tests/unit/services/signup-naming.test.ts — the default workspace name / slug of an early-access
// approval (services/signup/naming.ts) and the C6 locale normalisation (services/signup/config.ts).
import { describe, expect, test } from 'bun:test';

import { defaultTenantName, organisationOfDomain, slugCandidates, slugify } from '../../../src/services/signup/naming';
import { FR_APP_KEY } from '../../../src/lib/require-fr-license';
import {
  DEFAULT_SIGNUP_APPS,
  droppedSignupApps,
  logSignupAppsStatus,
  normaliseSignupLocale,
  signupProvisioningConfig,
} from '../../../src/services/signup/config';

describe('defaultTenantName', () => {
  test('company first', () => {
    expect(defaultTenantName({ email: 'ann@acme.com', name: 'Ann', company: 'Globex Ltd' })).toBe('Globex Ltd');
  });
  test('else the organisation of a corporate domain', () => {
    expect(defaultTenantName({ email: 'ann@mail.acme.co.uk', name: 'Ann', company: null })).toBe('acme');
    expect(defaultTenantName({ email: 'ann@acme.com', name: 'Ann', company: '  ' })).toBe('acme');
  });
  test('a public mailbox names a person: the requester name, else the local part', () => {
    expect(defaultTenantName({ email: 'test.user@gmail.com', name: 'Ann Early', company: null })).toBe('Ann Early');
    expect(defaultTenantName({ email: 'test.user@gmail.com', name: null, company: null })).toBe('test.user');
  });
  test('organisationOfDomain', () => {
    expect(organisationOfDomain('acme.com')).toBe('acme');
    expect(organisationOfDomain('a.b.acme.de')).toBe('acme');
    expect(organisationOfDomain('localhost')).toBeNull();
  });
});

describe('slugify', () => {
  test('lower-case ascii, dashes, ≤ 36 chars, provision-user shape', () => {
    expect(slugify('Glöbex Ltd. & Söhne')).toBe('globex-ltd-sohne');
    const long = slugify('x'.repeat(80));
    expect(long.length).toBe(36);
    for (const s of [slugify('Ann Early'), slugify('Æ'), slugify('!!'), slugify('q')]) expect(s).toMatch(/^[a-z0-9-]{2,40}$/);
    expect(slugCandidates('acme')).toEqual(['acme', 'acme-2', 'acme-3', 'acme-4', 'acme-5', 'acme-6', 'acme-7', 'acme-8', 'acme-9', 'acme-10']);
    for (const s of slugCandidates(long)) expect(s).toMatch(/^[a-z0-9-]{2,40}$/);
  });
});

describe('locale (C6)', () => {
  test('lenient: region tags and case map to the eight; unknown is not told', () => {
    expect(normaliseSignupLocale('de-DE')).toBe('de');
    expect(normaliseSignupLocale('NL')).toBe('nl');
    expect(normaliseSignupLocale('pl_PL')).toBe('pl');
    expect(normaliseSignupLocale('it')).toBeNull();
    expect(normaliseSignupLocale(42)).toBeNull();
  });
});

describe('provisioning defaults', () => {
  test('fr + fr-frontend licences, the conveyor bundle on standard, fr-frontend link client', () => {
    const c = signupProvisioningConfig();
    expect(c.apps).toEqual(['fr', 'fr-frontend']);
    expect(c.bundle).toBe('conveyor');
    expect(c.bundlePlans).toEqual(['standard']);
    expect(c.frontendClientId).toBe('fr-frontend');
    expect(c.emailLifespanSeconds).toBe(14 * 24 * 3600);
  });

  test("the default app list contains the fr gate's own key (require-fr-license FR_APP_KEY)", () => {
    expect(FR_APP_KEY).toBe('fr');
    expect(DEFAULT_SIGNUP_APPS).toContain(FR_APP_KEY);
    expect(signupProvisioningConfig().apps).toContain(FR_APP_KEY);
  });

  test('FR_SIGNUP_APPS without the gate key gets it appended; with it, unchanged', () => {
    const prior = process.env.FR_SIGNUP_APPS;
    try {
      process.env.FR_SIGNUP_APPS = 'fr-frontend';
      expect(signupProvisioningConfig().apps).toEqual(['fr-frontend', FR_APP_KEY]);
      process.env.FR_SIGNUP_APPS = 'fr-frontend,fr';
      expect(signupProvisioningConfig().apps).toEqual(['fr-frontend', 'fr']);
    } finally {
      if (prior === undefined) delete process.env.FR_SIGNUP_APPS;
      else process.env.FR_SIGNUP_APPS = prior;
    }
  });

  test("FR_SIGNUP_APPS keys outside fr's per-person bundle are dropped and logged", () => {
    const prior = process.env.FR_SIGNUP_APPS;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      process.env.FR_SIGNUP_APPS = 'fr-frontend, coding, w2v, agent';
      expect(signupProvisioningConfig().apps).toEqual(['fr-frontend', FR_APP_KEY]);
      expect(droppedSignupApps()).toEqual(['coding', 'w2v', 'agent']);
      logSignupAppsStatus();
      expect(logs.join('\n')).toContain('dropped coding,w2v,agent');
      expect(logs.join('\n')).toContain("omitted the gate key 'fr'");
    } finally {
      console.log = origLog;
      if (prior === undefined) delete process.env.FR_SIGNUP_APPS;
      else process.env.FR_SIGNUP_APPS = prior;
    }
  });

  test('FR_SIGNUP_BUNDLE must be an fr bundle, else no bundle (named at boot)', () => {
    const prior = process.env.FR_SIGNUP_BUNDLE;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => void logs.push(a.join(' '));
    try {
      process.env.FR_SIGNUP_BUNDLE = 'non-agentic-ai';
      expect(signupProvisioningConfig().bundle).toBe('non-agentic-ai');
      process.env.FR_SIGNUP_BUNDLE = '';
      expect(signupProvisioningConfig().bundle).toBe('');
      process.env.FR_SIGNUP_BUNDLE = 'commonpractice';
      expect(signupProvisioningConfig().bundle).toBe('');
      logSignupAppsStatus();
      expect(logs.join('\n')).toContain('FR_SIGNUP_BUNDLE=commonpractice is not an fr bundle');
    } finally {
      console.log = origLog;
      if (prior === undefined) delete process.env.FR_SIGNUP_BUNDLE;
      else process.env.FR_SIGNUP_BUNDLE = prior;
    }
  });
});
