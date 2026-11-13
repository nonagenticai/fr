// src/lib/net/wsClient.test.ts
// The JWT travels via the Sec-WebSocket-Protocol subprotocol (`bearer.<jwt>`),
// never in the URL query string.

import { describe, it, expect } from 'vitest';
import { buildSubprotocols } from './wsClient';

describe('buildSubprotocols', () => {
  it('returns a single-element array of `bearer.<jwt>`', () => {
    expect(buildSubprotocols('eyJhbGciOi.x.y')).toEqual(['bearer.eyJhbGciOi.x.y']);
  });
});
