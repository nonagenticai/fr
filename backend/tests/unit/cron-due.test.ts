import { describe, expect, test } from 'bun:test';

import { CronValidationError, isDue, validateCron } from '../../src/lib/cron-due';

describe('cron-due helpers', () => {
  test('isDue returns true when last_run_at is null and now ≥ 1970-01-01 + first cron firing', () => {
    expect(isDue('* * * * *', 'UTC', null, new Date('2026-05-04T09:00:30Z'))).toBe(true);
  });

  test('isDue returns false when nextFire after last_run_at is still in the future', () => {
    const last = new Date('2026-05-04T09:00:00Z');
    const now = new Date('2026-05-04T09:30:00Z');
    expect(isDue('0 10 * * *', 'UTC', last, now)).toBe(false);
  });

  test('isDue returns true when nextFire after last_run_at is now-or-past', () => {
    const last = new Date('2026-05-04T09:00:00Z');
    const now = new Date('2026-05-04T10:00:30Z');
    expect(isDue('0 10 * * *', 'UTC', last, now)).toBe(true);
  });

  test('validateCron accepts a 5-field expression', () => {
    expect(() => validateCron('*/5 * * * *', 'UTC')).not.toThrow();
  });

  test('validateCron rejects an empty expression', () => {
    expect(() => validateCron('', 'UTC')).toThrow(CronValidationError);
    expect(() => validateCron('   ', 'UTC')).toThrow(CronValidationError);
  });

  test('validateCron rejects an unparseable expression', () => {
    expect(() => validateCron('not a cron', 'UTC')).toThrow(CronValidationError);
  });

  test('validateCron rejects an unknown timezone', () => {
    expect(() => validateCron('* * * * *', 'Mars/Olympus_Mons')).toThrow(CronValidationError);
  });
});
