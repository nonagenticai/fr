// tests/unit/routes/comments-mentions.test.ts
//
// Pure coverage of the project-comment mention snippet. The dispatcher itself
// talks to Keycloak, the delivery channels and the database, so it is verified
// live, not with injected fakes (no-test-doubles ruling 2026-10-29).
import { describe, expect, test } from 'bun:test';

import { buildSnippet } from '../../../src/routes/_comments-mentions';

describe('buildSnippet', () => {
  test('returns text unchanged below limit', () => {
    expect(buildSnippet('hi')).toBe('hi');
  });
  test('truncates with ellipsis above limit', () => {
    const long = 'x'.repeat(200);
    const out = buildSnippet(long);
    expect(out.endsWith('…')).toBe(true);
    expect(out.length).toBe(141);
  });
});
