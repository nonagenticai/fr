// tests/unit/types/api-shape.test.ts
//
// Spec 2 Plan 2-A — zod-only test for ProjectCreateSchema.shape default.

import { describe, expect, test } from 'bun:test';
import { ProjectCreateSchema } from '../../../src/types/api';

describe('ProjectCreateSchema.shape', () => {
  test('defaults to "deliverable" when omitted', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
    });
    expect(parsed.shape).toBe('deliverable');
  });

  test('accepts "continuous_flow"', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      shape: 'continuous_flow',
    });
    expect(parsed.shape).toBe('continuous_flow');
  });

  test('rejects unknown shape values', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        shape: 'agile',
      }),
    ).toThrow();
  });
});

// G1 bug hunt (B1) — `bug_hunt` is a boolean flag on ProjectCreateSchema.
describe('ProjectCreateSchema.bug_hunt', () => {
  const base = { name: 'p', repository_url: 'https://example.com/repo' };

  test('bug_hunt: true round-trips (lands in project_data via extendedFields)', () => {
    expect(ProjectCreateSchema.parse({ ...base, bug_hunt: true }).bug_hunt).toBe(true);
  });

  test('absent stays absent', () => {
    expect('bug_hunt' in ProjectCreateSchema.parse(base)).toBe(false);
  });

  test('rejects a non-boolean ("yes")', () => {
    expect(() => ProjectCreateSchema.parse({ ...base, bug_hunt: 'yes' })).toThrow();
  });
});
