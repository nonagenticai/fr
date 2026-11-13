// tests/unit/lib/cron-due.test.ts
//
// `isDue` THROWS CronValidationError on an unparseable cron / unknown IANA
// timezone. The scheduled-trigger tick calls it inside a `for` loop that runs
// inside a single `queryClient.begin(...)` transaction covering EVERY enabled
// trigger in EVERY tenant — so one bad row aborts the whole transaction,
// rolls back the already-processed good rows, and (because `last_run_at`
// never advances) stays due forever. The global scheduler is then wedged
// permanently with one `console.error` as the only symptom.
//
// `evaluateDue` is the non-throwing wrapper the worker must use so a bad row
// is isolated to itself.

import { describe, expect, test } from 'bun:test';
import { evaluateDue, isDue, CronValidationError } from '../../../src/lib/cron-due';

const NOW = new Date('2026-05-04T10:00:00Z');

describe('isDue — throwing surface (unchanged)', () => {
  test('throws on unparseable cron', () => {
    expect(() => isDue('not-a-cron', 'UTC', null, NOW)).toThrow(CronValidationError);
  });

  test('throws on unknown IANA timezone', () => {
    expect(() => isDue('* * * * *', 'Mars/Olympus_Mons', null, NOW)).toThrow(
      CronValidationError,
    );
  });
});

describe('evaluateDue — non-throwing wrapper for the tick loop', () => {
  test('valid cron, never run → ok + due', () => {
    expect(evaluateDue('* * * * *', 'UTC', null, NOW)).toEqual({
      ok: true,
      due: true,
    });
  });

  test('valid cron, next fire still in the future → ok + not due', () => {
    // last run just past the 09:00 slot; next fire is tomorrow 09:00.
    const lastRunAt = new Date('2026-05-04T09:30:00Z');
    expect(evaluateDue('0 9 * * *', 'UTC', lastRunAt, NOW)).toEqual({
      ok: true,
      due: false,
    });
  });

  test('unparseable cron → ok:false with a reason, does NOT throw', () => {
    const r = evaluateDue('not-a-cron', 'UTC', null, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatch(/invalid cron/i);
  });

  test('unknown IANA timezone → ok:false with a reason, does NOT throw', () => {
    const r = evaluateDue('* * * * *', 'Mars/Olympus_Mons', null, NOW);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error('unreachable');
    expect(r.error).toMatch(/invalid timezone/i);
  });

  test('empty cron → ok:false, does NOT throw', () => {
    const r = evaluateDue('', 'UTC', null, NOW);
    expect(r.ok).toBe(false);
  });
});
