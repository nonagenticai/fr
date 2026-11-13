// P1c-b — `lastMessagePreview` is redacted BEFORE it is cut to 120 chars.
//
// The bug: `content.slice(0, 120)` ran first, so a token straddling char 120
// was truncated, the length-anchored scrub patterns no longer matched the stub,
// and a real secret's PREFIX reached thread titles and lists.
//
// ⚠️ Fake secrets are assembled from fragments — no secret literal in this file.

import { describe, expect, test } from 'bun:test';

import { REDACTED, redactThenTruncate, scrubString } from '../../../src/capabilities/redact';
import { THREAD_PREVIEW_MAX, threadPreview } from '../../../src/routes/agui-threads';

/** 43 url-safe chars, mixed case + digit: the fr licence token shape. */
const LICENCE = 'Ab3'.repeat(14) + 'x';
const GLPAT = 'gl' + 'pat-' + 'Q7'.repeat(12);
const FILLER_100 = 'word '.repeat(20); // exactly 100 chars, no token-like run

/** Every prefix of `secret` of ≥4 chars that `text` contains. */
function leakedPrefixes(text: string, secret: string): string[] {
  const hits: string[] = [];
  for (let k = 4; k <= secret.length; k++) if (text.includes(secret.slice(0, k))) hits.push(secret.slice(0, k));
  return hits;
}

/** The OLD order, kept only to prove the test reds against it. */
const truncateThenRedact = (s: string): string => scrubString(s.slice(0, THREAD_PREVIEW_MAX));

const assistant = (content: string) => ({ role: 'assistant' as const, content, ts: '2026-10-16T00:00:00Z' });
const user = (content: string) => ({ role: 'user' as const, content, ts: '2026-10-16T00:00:00Z' });

describe('threadPreview — redact the full text, then truncate', () => {
  test('fixtures are the shapes the scanner redacts, and straddle char 120', () => {
    expect(scrubString(`x ${LICENCE} y`)).toBe(`x ${REDACTED} y`);
    expect(scrubString(`x ${GLPAT} y`)).toBe(`x ${REDACTED} y`);
    // starts at 100, ends past 120 ⇒ the cut lands inside it
    expect(100 + LICENCE.length).toBeGreaterThan(THREAD_PREVIEW_MAX);
  });

  for (const [name, secret] of [['43-char licence token', LICENCE], ['glpat- token', GLPAT]] as const) {
    const content = `${FILLER_100}${secret} and more text after the secret`;

    test(`${name} at char 100: the assistant preview holds no prefix of it`, () => {
      const p = threadPreview(assistant(content))!;
      expect(p.length).toBeLessThanOrEqual(THREAD_PREVIEW_MAX);
      expect(leakedPrefixes(p, secret)).toEqual([]);
      expect(p.startsWith(`${FILLER_100}${REDACTED} and more`)).toBe(true);
    });

    test(`${name} at char 115: the MARKER straddles 120 ⇒ cut before it, never a half marker`, () => {
      const filler115 = 'word '.repeat(23);
      const p = threadPreview(assistant(`${filler115}${secret} tail`))!;
      expect(p).toBe(filler115);
      expect(p).not.toContain('«');
      expect(leakedPrefixes(p, secret)).toEqual([]);
    });

    test(`${name} at char 100: a USER turn (stored as typed) is scrubbed the same`, () => {
      expect(leakedPrefixes(threadPreview(user(content))!, secret)).toEqual([]);
    });

    test(`${name}: MUTANT — the old truncate-then-redact order leaks its prefix`, () => {
      const old = truncateThenRedact(content);
      expect(leakedPrefixes(old, secret).length).toBeGreaterThan(0);
    });
  }

  test('a marker wholly inside the window is kept; text after the cut is dropped', () => {
    const content = `key ${LICENCE} ` + 'z'.repeat(200);
    const p = threadPreview(assistant(content))!;
    expect(p.startsWith(`key ${REDACTED} `)).toBe(true);
    expect(p.length).toBe(THREAD_PREVIEW_MAX);
  });

  test('redactThenTruncate never ends inside a marker, at any cut position', () => {
    const content = `${'a '.repeat(30)}${LICENCE} b ${GLPAT} c`;
    const scrubbed = scrubString(content);
    for (let max = 1; max <= scrubbed.length + 2; max++) {
      const out = redactThenTruncate(content, max);
      expect(out.length).toBeLessThanOrEqual(max);
      expect(scrubbed.startsWith(out)).toBe(true);
      const open = out.lastIndexOf('«');
      if (open !== -1) expect(out.slice(open).startsWith(REDACTED)).toBe(true);
      expect(leakedPrefixes(out, LICENCE)).toEqual([]);
      expect(leakedPrefixes(out, GLPAT)).toEqual([]);
    }
  });

  test('short text is returned scrubbed, untouched otherwise; tool rows keep `tool: <action>`; empty thread ⇒ null', () => {
    expect(threadPreview(assistant('hello there'))).toBe('hello there');
    expect(threadPreview({ role: 'tool', action: 'projects.get' } as never)).toBe('tool: projects.get');
    expect(threadPreview(undefined)).toBeNull();
  });
});
