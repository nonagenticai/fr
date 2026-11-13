// tests/unit/types/question-mode.test.ts
//
// fr#1388 (U3/A6) — question_mode is validated at the ONE door that can write
// it: the create schema (ProjectCreateSchema, also re-parsed by bulk create and
// project-request approval). PATCH /api/projects/:id no longer accepts it — it
// is RM-owned after the request (D15/R16). Allowed:
// 'structured', 'free_text', absent, or null ("unset"). Everything else — a typo,
// a case variant, a wrong type — is refused by the parse, which both handlers run
// before any DB access. The DB-backed handler half (the project-question-mode
// route suite) was deleted 2026-10-29 — no longer in the suite.

import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { ProjectCreateSchema } from '../../../src/types/api';
import { QUESTION_MODES } from '../../../src/types/question-mode';
import { statusForError } from '../../../src/utils/errors';

const baseCreate = { name: 'qm', repository_url: 'https://example.com/r' };

const OK: Array<[string, Record<string, unknown>, unknown]> = [
  ['absent', {}, undefined],
  ['structured', { question_mode: 'structured' }, 'structured'],
  ['free_text', { question_mode: 'free_text' }, 'free_text'],
  ['null (unset)', { question_mode: null }, null],
];

const REFUSED: Array<[string, unknown]> = [
  ['"bogus"', 'bogus'],
  ['1 (number)', 1],
  ['"Structured" (case variant)', 'Structured'],
  ['"" (empty string)', ''],
  ['true (boolean)', true],
];

test('the vocabulary is exactly the two ruled values', () => {
  expect([...QUESTION_MODES]).toEqual(['structured', 'free_text']);
});

for (const [label, schema, base] of [
  ['ProjectCreateSchema', ProjectCreateSchema, baseCreate],
] as const) {
  describe(`${label} question_mode`, () => {
    for (const [name, extra, expected] of OK) {
      test(`accepts ${name}`, () => {
        const parsed = (schema as z.ZodTypeAny).parse({ ...base, ...extra }) as {
          question_mode?: unknown;
        };
        expect(parsed.question_mode).toBe(expected);
      });
    }
    for (const [name, value] of REFUSED) {
      test(`refuses ${name} with a 422-mapped ZodError naming the field`, () => {
        const r = (schema as z.ZodTypeAny).safeParse({ ...base, question_mode: value });
        expect(r.success).toBe(false);
        if (r.success) return;
        expect(statusForError(r.error)).toBe(422);
        expect(r.error.issues.some((i) => i.path.join('.') === 'question_mode')).toBe(true);
      });
    }
  });
}
