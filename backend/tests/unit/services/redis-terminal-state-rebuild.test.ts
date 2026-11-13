// tests/unit/services/redis-terminal-state-rebuild.test.ts
//
// The supervised redis client's terminal-state grace window is a real,
// reconnect-outlasting number. (The rebuild behaviour itself needed a fake
// redis client and was removed under the no-test-doubles ruling.)

import { test, expect, describe } from 'bun:test';
import { REDIS_TERMINAL_GRACE_MS } from '../../../src/services/redis-supervisor';

describe('the grace window', () => {
  test('is long enough to outlast an honest reconnect, and is a real number', () => {
    expect(REDIS_TERMINAL_GRACE_MS).toBeGreaterThanOrEqual(30_000);
    expect(Number.isFinite(REDIS_TERMINAL_GRACE_MS)).toBe(true);
  });
});
