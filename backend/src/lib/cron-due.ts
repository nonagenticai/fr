/**
 * Pure helpers for cron evaluation.
 *
 * Used by the scheduled-trigger tick worker (workers/scheduled-trigger-tick.ts)
 * and by the route validators on scheduled_triggers.
 *
 * No DB, no I/O — just cron-parser wrapping with a stable surface so tests
 * stay deterministic even if cron-parser bumps a major version later.
 */

import { CronExpressionParser } from 'cron-parser';

export class CronValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronValidationError';
  }
}

/**
 * Throw CronValidationError if `cron` or `timezone` is not parseable.
 * Used at the route layer before persisting a scheduled_triggers row.
 */
export function validateCron(cron: string, timezone: string): void {
  if (!cron || cron.trim().length === 0) {
    throw new CronValidationError('cron expression is empty');
  }
  // cron-parser v5 does not validate the timezone at parse time — it silently
  // falls through to UTC. We want a 422-class error for typo'd timezones, so
  // probe it explicitly via Intl.DateTimeFormat (V8 / JSC throw RangeError on
  // unknown IANA zones).
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CronValidationError(`invalid timezone: ${msg}`);
  }
  try {
    CronExpressionParser.parse(cron, { tz: timezone });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new CronValidationError(`invalid cron: ${msg}`);
  }
}

/**
 * Return true iff the next firing instant after `lastRunAt` (or after the
 * Unix epoch if null) is now-or-past. This is the "should we tick this row
 * right now" question the cron worker asks per row.
 */
export function isDue(
  cron: string,
  timezone: string,
  lastRunAt: Date | null,
  now: Date,
): boolean {
  validateCron(cron, timezone);
  const baseline = lastRunAt ?? new Date(0);
  const it = CronExpressionParser.parse(cron, { tz: timezone, currentDate: baseline });
  const next = it.next().toDate();
  return next <= now;
}

/**
 * Result of a non-throwing due-evaluation.
 */
export type DueEvaluation =
  | { ok: true; due: boolean }
  | { ok: false; error: string };

/**
 * Non-throwing `isDue`.
 *
 * The cron worker evaluates EVERY enabled row of EVERY tenant inside a single
 * transaction. `isDue` throws `CronValidationError` on an unparseable cron or
 * an unknown IANA timezone — from inside that loop a throw aborts the whole
 * transaction, discards the work already committed for the healthy rows, and
 * (because `last_run_at` never advances) leaves the bad row due forever. The
 * result is a permanently wedged global scheduler whose only symptom is one
 * console.error per tick.
 *
 * Callers that must isolate a bad row use this wrapper instead: the failure
 * becomes a value they can record against the row and skip.
 *
 * Rows can go bad after they were validated at the route layer — e.g. a
 * timezone the runtime ICU build no longer carries, or a row written by a
 * migration/backfill/manual SQL that bypassed `validateCron`.
 */
export function evaluateDue(
  cron: string,
  timezone: string,
  lastRunAt: Date | null,
  now: Date,
): DueEvaluation {
  try {
    return { ok: true, due: isDue(cron, timezone, lastRunAt, now) };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
