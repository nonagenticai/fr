// src/utils/wsAuth.test.ts
import { describe, it, expect } from 'bun:test';
import { extractWsBearerToken } from './wsAuth';

function mkReq(headers: Record<string, string>, urlSuffix = ''): Request {
  return new Request(`http://test/api/kanban/ws${urlSuffix}`, { headers });
}

describe('extractWsBearerToken', () => {
  it('extracts a token from Sec-WebSocket-Protocol bearer.<jwt>', () => {
    const req = mkReq({ 'Sec-WebSocket-Protocol': 'bearer.abc123' });
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('abc123');
    expect(r.protocolHeader).toBe('bearer.abc123');
    expect(r.source).toBe('subprotocol');
  });

  it('finds the bearer.<jwt> entry when other protocols are listed first', () => {
    const req = mkReq({ 'Sec-WebSocket-Protocol': 'json, bearer.abc.def, ext-foo' });
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('abc.def');
    expect(r.protocolHeader).toBe('bearer.abc.def');
    expect(r.source).toBe('subprotocol');
  });

  it('falls back to Authorization: Bearer when no subprotocol is set', () => {
    const req = mkReq({ Authorization: 'Bearer xyz' });
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('xyz');
    expect(r.protocolHeader).toBeNull();
    expect(r.source).toBe('authorization');
  });

  it('falls back to ?token= query when no headers are set', () => {
    const req = mkReq({}, '?token=qq');
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('qq');
    expect(r.protocolHeader).toBeNull();
    expect(r.source).toBe('query');
  });

  it('precedence: subprotocol > Authorization > query', () => {
    const req = mkReq(
      {
        'Sec-WebSocket-Protocol': 'bearer.from-proto',
        Authorization: 'Bearer from-auth',
      },
      '?token=from-query',
    );
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('from-proto');
    expect(r.source).toBe('subprotocol');
  });

  it('precedence: Authorization > query when no subprotocol', () => {
    const req = mkReq({ Authorization: 'Bearer from-auth' }, '?token=from-query');
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('from-auth');
    expect(r.source).toBe('authorization');
  });

  it('returns none when nothing is provided', () => {
    const req = mkReq({});
    const r = extractWsBearerToken(req);
    expect(r.token).toBeNull();
    expect(r.protocolHeader).toBeNull();
    expect(r.source).toBe('none');
  });

  it('ignores empty bearer. entries', () => {
    const req = mkReq({ 'Sec-WebSocket-Protocol': 'bearer.' }, '?token=q');
    const r = extractWsBearerToken(req);
    // Falls through to query token because the bearer entry has no value.
    expect(r.token).toBe('q');
    expect(r.source).toBe('query');
  });

  it('ignores Authorization header that does not start with Bearer', () => {
    const req = mkReq({ Authorization: 'Basic abcdef' }, '?token=q');
    const r = extractWsBearerToken(req);
    expect(r.token).toBe('q');
    expect(r.source).toBe('query');
  });
});
