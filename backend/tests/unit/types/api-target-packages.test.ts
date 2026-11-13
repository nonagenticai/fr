// tests/unit/types/api-target-packages.test.ts
//
// EXEC `it` pipeline — zod schema test for ProjectCreateSchema.target_packages.

import { describe, expect, test } from 'bun:test';
import { ProjectCreateSchema } from '../../../src/types/api';

describe('ProjectCreateSchema.target_packages', () => {
  test('is optional when omitted', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
    });
    expect(parsed.target_packages).toBeUndefined();
  });

  test('accepts a non-empty array of {name, target_version}', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      target_packages: [
        { name: 'fastmcp', target_version: '3.0.0' },
        { name: 'pydantic', target_version: '2.9.0' },
      ],
    });
    expect(parsed.target_packages).toHaveLength(2);
    expect(parsed.target_packages![0]).toEqual({
      name: 'fastmcp',
      target_version: '3.0.0',
    });
  });

  test('rejects entries missing required fields', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        target_packages: [{ name: 'fastmcp' }],
      } as unknown),
    ).toThrow();
  });

  test('rejects empty package name or version strings', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        target_packages: [{ name: '', target_version: '3.0.0' }],
      }),
    ).toThrow();
  });
});
