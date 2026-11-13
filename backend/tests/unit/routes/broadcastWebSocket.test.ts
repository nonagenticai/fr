/**
 * broadcastWebSocket — WS path pattern.
 *
 * The container-lifecycle broadcast proxy (the fr consumer of coding-realtime's
 * publish/fan-out) translates a 1008 upstream policy close
 * (bad tenant / unknown container) into the NO_CONTAINER frame the
 * frontend classifier treats as terminal, so the client renders "no active
 * container" instead of a reconnect storm.
 */

import { describe, expect, test } from 'bun:test';

import {
  CODING_BROADCAST_WS_PATTERN,
} from '../../../src/routes/coding/broadcastWebSocket';

describe('CODING_BROADCAST_WS_PATTERN', () => {
  test('matches the namespaced broadcast WS path, not quality or arbitrary paths', () => {
    expect(CODING_BROADCAST_WS_PATTERN.test('/api/coding/broadcast/ws/codegraph-demo')).toBe(true);
    expect(CODING_BROADCAST_WS_PATTERN.test('/api/coding/broadcast/ws/c1')).toBe(true);
    // Must not serve the retired quality WS path (fr#1306) or a nested path.
    expect(CODING_BROADCAST_WS_PATTERN.test('/api/coding/quality/ws/c1')).toBe(false);
    expect(CODING_BROADCAST_WS_PATTERN.test('/api/coding/broadcast/ws/c1/extra')).toBe(false);
    expect(CODING_BROADCAST_WS_PATTERN.test('/api/coding/broadcast/ws/')).toBe(false);
  });
});
