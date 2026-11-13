// tests/unit/services/catalogue/target-language.test.ts
//
// The target language of a rewrite is EXTRACTED from the project request (George
// 2026-11-07) instead of asked on the form. These pin the pure parts: which
// bodies need the extraction, what text it is given, and how the worker's answer
// is read. The worker round-trip itself is verified live (no test doubles, owner
// ruling 2026-10-29).
//
// Hermetic: pure functions, no DB, no network.

import { describe, expect, test } from 'bun:test';

import {
  needsTargetLanguage,
  requestTextOf,
  targetLanguageFromOutput,
} from '../../../../src/services/catalogue/target-language';

describe('needsTargetLanguage', () => {
  test('only a rewrite WITHOUT a language needs the extraction', () => {
    expect(needsTargetLanguage({ it_flow: 'rewrite' })).toBe(true);
    expect(needsTargetLanguage({ it_flow: 'rewrite', target_language: '' })).toBe(true);
    expect(needsTargetLanguage({ it_flow: 'rewrite', target_language: 'rust' })).toBe(false);
    expect(needsTargetLanguage({ it_flow: 'bug' })).toBe(false);
    expect(needsTargetLanguage({})).toBe(false);
  });
});

describe('requestTextOf', () => {
  test('collects the name, the description and every brief field the body carries', () => {
    const text = requestTextOf({
      name: 'Port the ingester',
      description: 'd',
      problem_statement: 'p',
      high_level_requirements: ['r1', ' ', 'r2'],
      acceptance_criteria: [],
      notes: 'rewrite it in Rust',
      secret_ids: ['should-not-be-read'],
    });
    expect(text).toBe(
      [
        'name: Port the ingester',
        'description: d',
        'problem_statement: p',
        'high_level_requirements: r1; r2',
        'notes: rewrite it in Rust',
      ].join('\n'),
    );
    expect(text).not.toContain('should-not-be-read');
  });

  test('an empty body yields an empty string, never an invented sentence', () => {
    expect(requestTextOf({})).toBe('');
    expect(requestTextOf({ name: '   ', notes: '' })).toBe('');
  });
});

describe('targetLanguageFromOutput', () => {
  test('reads the enum, case/space normalised', () => {
    expect(targetLanguageFromOutput({ target_language: 'rust' })).toBe('rust');
    expect(targetLanguageFromOutput({ target_language: ' Python ' })).toBe('python');
  });

  test('anything off-vocabulary, missing or malformed is null — never guessed', () => {
    expect(targetLanguageFromOutput({})).toBeNull();
    expect(targetLanguageFromOutput({ target_language: 'go' })).toBeNull();
    expect(targetLanguageFromOutput({ target_language: 42 })).toBeNull();
    expect(targetLanguageFromOutput(null)).toBeNull();
    expect(targetLanguageFromOutput('rust')).toBeNull();
  });
});
