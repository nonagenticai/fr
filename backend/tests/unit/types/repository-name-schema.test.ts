// tests/unit/types/repository-name-schema.test.ts
//
// The WIRE half of "there are never blank repository names".
//
// `name` stays OPTIONAL on both repository schemas — it is always resolvable
// from the url, so requiring it would 422 a caller for omitting something the
// server can compute. What must never be accepted is an EXPLICIT blank, and
// `.min(1)` alone accepts '   '. These arms pin `.trim()` sitting BEFORE
// `.min(1)`.
//
// ⭐ KILLING MUTATIONS, per group:
//   · drop `.trim()` from `RepositoryUpdateSchema.name` → the '   ' update arm
//     passes and goes red here (that value reaches
//     `handleUpdateRepository`'s `if (validated.name !== undefined)` and is
//     WRITTEN, so this is the whole guard on the update path).
//   · drop `.trim()` from `RepositoryCreateSchema.name` → the '   ' create arm.
//   · make either `name` REQUIRED → the omitted-name arms, which are the
//     contract that the url-derivation is allowed to do its job.
//   · drop `.max(255)` → the over-long arms.

import { test, expect, describe } from 'bun:test';
import {
  ProjectRepositoryAttachSchema,
  RepositoryCreateSchema,
  RepositoryUpdateSchema,
} from '../../../src/types/api';

const URL_OK = 'https://github.com/owner/repo.git';

describe('RepositoryUpdateSchema.name — optional, never blank', () => {
  test('an omitted name is accepted (nothing to change)', () => {
    const parsed = RepositoryUpdateSchema.parse({ branch: 'develop' });
    expect(parsed.name).toBeUndefined();
  });

  test('an explicit empty string is REJECTED', () => {
    expect(() => RepositoryUpdateSchema.parse({ name: '' })).toThrow();
  });

  test('a whitespace-only name is REJECTED', () => {
    // `.min(1)` without `.trim()` accepts this. That is the defect.
    expect(() => RepositoryUpdateSchema.parse({ name: '   ' })).toThrow();
  });

  test('a name with padding is accepted and TRIMMED', () => {
    expect(RepositoryUpdateSchema.parse({ name: '  owner/repo  ' }).name).toBe('owner/repo');
  });

  test('a name over 255 chars is REJECTED', () => {
    expect(() => RepositoryUpdateSchema.parse({ name: 'x'.repeat(256) })).toThrow();
  });
});

describe('RepositoryCreateSchema.name — optional, never blank', () => {
  test('an omitted name is accepted — the url supplies it', () => {
    const parsed = RepositoryCreateSchema.parse({ url: URL_OK });
    expect(parsed.name).toBeUndefined();
    expect(parsed.url).toBe(URL_OK);
  });

  test('an explicit empty string is REJECTED', () => {
    expect(() => RepositoryCreateSchema.parse({ name: '', url: URL_OK })).toThrow();
  });

  test('a whitespace-only name is REJECTED', () => {
    expect(() => RepositoryCreateSchema.parse({ name: '   ', url: URL_OK })).toThrow();
  });

  test('a name with padding is accepted and TRIMMED', () => {
    expect(RepositoryCreateSchema.parse({ name: ' my repo ', url: URL_OK }).name).toBe('my repo');
  });
});

describe('ProjectRepositoryAttachSchema.name — optional, never blank', () => {
  test('an omitted name is accepted — the url supplies it', () => {
    expect(ProjectRepositoryAttachSchema.parse({ url: URL_OK }).name).toBeUndefined();
  });

  test('a whitespace-only name is REJECTED', () => {
    expect(() => ProjectRepositoryAttachSchema.parse({ url: URL_OK, name: '   ' })).toThrow();
  });
});
