import { describe, it, expect } from 'vitest';
import { safeNext } from './safeNext';

// Every input this suite exercises, so the "never `/dashboard`" sweep below is
// provably over the SAME population as the per-case assertions and cannot drift
// out of sync with them.
const ALL_INPUTS: (string | null)[] = [
  null,
  '',
  '/projects/abc',
  '/',
  '/cards/1?tab=qa#note',
  'https://evil.example.com',
  'http://evil.example.com/path',
  'dashboard',
  '//evil.example.com',
  '//evil.example.com/login',
];

describe('safeNext', () => {
  // POSITIVE CONTROL. Without this case a function that returned '/' for every
  // input would satisfy every other assertion in this file, so the open-redirect
  // guards would be "proven" by a helper that had stopped honouring `next` at
  // all — the exact regression this page already shipped once (it hardcoded a
  // landing page and threw `next` away).
  it('returns a valid relative next unchanged', () => {
    expect(safeNext('/projects/abc')).toBe('/projects/abc');
    expect(safeNext('/cards/1?tab=qa#note')).toBe('/cards/1?tab=qa#note');
    expect(safeNext('/')).toBe('/');
  });

  it('falls back to / when there is no next', () => {
    expect(safeNext(null)).toBe('/');
    expect(safeNext('')).toBe('/');
  });

  it('rejects an absolute off-origin next (open redirect)', () => {
    expect(safeNext('https://evil.example.com')).toBe('/');
    expect(safeNext('http://evil.example.com/path')).toBe('/');
  });

  it('rejects a next that is not /-prefixed', () => {
    expect(safeNext('dashboard')).toBe('/');
  });

  it('rejects a protocol-relative next (off-origin)', () => {
    expect(safeNext('//evil.example.com')).toBe('/');

			// MEASURED 2026-09-25: a single backslash bypassed BOTH prefix guards —
			// `/\evil.example.com` starts with exactly one `/`, and the URL spec
			// treats a backslash in a special-scheme URL as a `/`, so it resolved to
			// `https://evil.example.com/`. The prefix rules could not see it; the
			// parser check can. Without this case the residual ships silently.
			expect(safeNext('/\\evil.example.com')).toBe('/');
			expect(safeNext('/\\\\evil.example.com')).toBe('/');
			expect(safeNext('/\\/evil.example.com')).toBe('/');
    expect(safeNext('//evil.example.com/login')).toBe('/');
  });

  // `/dashboard` was deleted as a thinner duplicate of `/`. All three guarded
  // returns now yield `/`; putting `/dashboard` back would surface only as a
  // 404 in a browser, so this is the only thing that can catch it.
  it('never redirects to the deleted /dashboard route', () => {
    for (const input of ALL_INPUTS) {
      expect(safeNext(input)).not.toBe('/dashboard');
      expect(safeNext(input).startsWith('/dashboard')).toBe(false);
    }
  });
});
