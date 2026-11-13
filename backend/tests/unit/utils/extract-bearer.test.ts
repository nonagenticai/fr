import { describe, test, expect } from 'bun:test';
import { extractBearerToken } from '../../../src/utils/extract-bearer';

describe('extractBearerToken', () => {
  test('returns the token when header is "Bearer <jwt>"', () => {
    const req = new Request('http://test', {
      headers: { Authorization: 'Bearer abc.def.ghi' },
    });
    expect(extractBearerToken(req)).toBe('abc.def.ghi');
  });

  test('returns null when header is missing', () => {
    // unarmed-absence-ok: pure parser over a Request object — there is no client, no ALS frame
    //   and no upstream call, so there is no ambient credential that could leak. The absence IS
    //   the return value under test.
    const req = new Request('http://test');
    expect(extractBearerToken(req)).toBeNull();
  });

  test('returns null when header is not a Bearer token', () => {
    // unarmed-absence-ok: same — the subject is the parse of a header this test supplies
    //   directly.
    const req = new Request('http://test', {
      headers: { Authorization: 'Basic dXNlcjpwYXNz' },
    });
    expect(extractBearerToken(req)).toBeNull();
  });

  test('returns null when header is "Bearer " with no token', () => {
    // unarmed-absence-ok: same — the subject is the parse of a header this test supplies
    //   directly.
    const req = new Request('http://test', { headers: { Authorization: 'Bearer ' } });
    expect(extractBearerToken(req)).toBeNull();
  });
});
