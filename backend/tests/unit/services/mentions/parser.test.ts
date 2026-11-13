// tests/unit/services/mentions/parser.test.ts
import { test, expect, describe } from 'bun:test';
import { parseMentions } from '../../../../src/services/mentions/parser';

describe('parseMentions', () => {
  test('extracts @handle tokens', () => {
    expect(parseMentions('hey @alice can you look? @bob too')).toEqual(['alice', 'bob']);
  });
  test('skips code blocks and inline code', () => {
    expect(parseMentions('see `@literal` and ```@also@literal```')).toEqual([]);
  });
  test('skips email-shaped @', () => {
    expect(parseMentions('send to alice@example.com about @bob')).toEqual(['bob']);
  });
  test('deduplicates', () => {
    expect(parseMentions('@alice @alice @alice')).toEqual(['alice']);
  });
  test('empty when no mentions', () => {
    expect(parseMentions('nothing to mention here')).toEqual([]);
  });
});
