// An event_type with no EVENT_TYPE_DEFS entry must not throw.
//
// `event_type` is a plain `text` column (not a PG enum), so a row written by an
// older/newer deploy — or a retired type — can carry a value the registry does
// not know. defaultSeverity/defaultChannelEnabled indexed it unguarded, and the
// resulting `TypeError: Cannot read properties of undefined` escaped through
// fanOutEventToUser, whose contract is documented "Never throws".
import { test, expect, describe } from 'bun:test';
import {
  defaultSeverity,
  defaultChannelEnabled,
  EXECUTION_EVENT_TYPES,
  type ExecutionEventType,
} from '../../../../src/domain/engagement/event-types';

const UNKNOWN = 'card.retired_in_a_past_deploy' as unknown as ExecutionEventType;

describe('EVENT_TYPE_DEFS lookup is total', () => {
  test('defaultSeverity does not throw on an unregistered type', () => {
    expect(() => defaultSeverity(UNKNOWN)).not.toThrow();
    expect(defaultSeverity(UNKNOWN)).toBe('info');
  });

  test('defaultChannelEnabled does not throw on an unregistered type', () => {
    expect(() => defaultChannelEnabled(UNKNOWN, 'email')).not.toThrow();
    // Unknown => inbox-only, never a surprise external blast.
    expect(defaultChannelEnabled(UNKNOWN, 'email')).toBe(false);
  });

  test('every registered event type still resolves a severity', () => {
    for (const t of EXECUTION_EVENT_TYPES) {
      expect(() => defaultSeverity(t)).not.toThrow();
      expect(['info', 'success', 'warning', 'error']).toContain(defaultSeverity(t));
    }
  });

  test('budget.threshold defaults external channels ON (warning severity)', () => {
    expect(defaultSeverity('budget.threshold')).toBe('warning');
    expect(defaultChannelEnabled('budget.threshold', 'email')).toBe(true);
  });
});
