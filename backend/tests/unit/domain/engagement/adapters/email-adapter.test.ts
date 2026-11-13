// Unit tests for EmailAdapter (E-10): enablement from config, and SMTP config
// parsing — both read the real process.env, set per case and restored after.
// (Send-path tests injected a fake fetch / fake SMTP transporter and were
// removed under the no-test-doubles ruling.)
import { test, expect, describe, afterEach } from 'bun:test';
import { EmailAdapter, smtpConfigFromEnv } from '../../../../../src/domain/engagement/adapters/email';

const KEYS = [
  'FR_EMAIL_API_URL',
  'FR_EMAIL_API_KEY',
  'FR_SMTP_HOST',
  'FR_SMTP_PORT',
  'FR_SMTP_USER',
  'FR_SMTP_PASSWORD',
  'FR_SMTP_FROM',
  'FR_SMTP_SECURE',
] as const;
const saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

/** Replace every email/SMTP env var with exactly `vars`. */
function setEnv(vars: Partial<Record<(typeof KEYS)[number], string>>): void {
  for (const k of KEYS) delete process.env[k];
  Object.assign(process.env, vars);
}

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('EmailAdapter — enablement', () => {
  test('isEnabled false when API URL or key missing (and no SMTP)', () => {
    setEnv({});
    expect(new EmailAdapter().isEnabled()).toBe(false);
    setEnv({ FR_EMAIL_API_URL: 'x' });
    expect(new EmailAdapter().isEnabled()).toBe(false);
    setEnv({ FR_EMAIL_API_KEY: 'k' });
    expect(new EmailAdapter().isEnabled()).toBe(false);
    setEnv({ FR_EMAIL_API_URL: 'https://email.test/send', FR_EMAIL_API_KEY: 'test-key' });
    expect(new EmailAdapter().isEnabled()).toBe(true);
  });

  test('is enabled by SMTP config alone (no FR_EMAIL_API_URL needed)', () => {
    setEnv({ FR_SMTP_HOST: 'smtp.gmail.com', FR_SMTP_PORT: '587', FR_SMTP_FROM: 'a@b.c' });
    expect(new EmailAdapter().isEnabled()).toBe(true);
  });
});

describe('smtpConfigFromEnv', () => {
  test('returns null without a host', () => {
    setEnv({ FR_SMTP_FROM: 'a@b.c' });
    expect(smtpConfigFromEnv()).toBeNull();
  });

  test('returns null without a from/user address', () => {
    setEnv({ FR_SMTP_HOST: 'smtp.gmail.com' });
    expect(smtpConfigFromEnv()).toBeNull();
  });

  test('587 is STARTTLS (secure=false) — secure:true there hangs the handshake', () => {
    setEnv({
      FR_SMTP_HOST: 'smtp.gmail.com',
      FR_SMTP_PORT: '587',
      FR_SMTP_USER: 'no-reply@example.com',
      FR_SMTP_PASSWORD: 'pw',
    });
    const cfg = smtpConfigFromEnv();
    expect(cfg).not.toBeNull();
    expect(cfg!.secure).toBe(false);
    expect(cfg!.port).toBe(587);
    // from falls back to user
    expect(cfg!.from).toBe('no-reply@example.com');
  });

  test('465 is implicit TLS (secure=true)', () => {
    setEnv({ FR_SMTP_HOST: 'smtp.gmail.com', FR_SMTP_PORT: '465', FR_SMTP_FROM: 'a@b.c' });
    expect(smtpConfigFromEnv()!.secure).toBe(true);
  });
});
