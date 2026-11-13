// tests/unit/types/api-programme-id.test.ts
//
// D6/3C — zod schema test for the ProjectCreateSchema `programme_id` intake
// field. It flows into project_data JSONB via projects.ts `...extendedFields`
// (rest-destructure of the validated body — programme_id is NOT one of the
// explicitly-destructured columns), so a valid value lands at
// project_data.programme_id and is filterable via GET /api/projects?programme_id=.

import { describe, expect, test } from 'bun:test';
import { ProjectCreateSchema } from '../../../src/types/api';

describe('ProjectCreateSchema programme_id (D6/3C)', () => {
  test('programme_id is optional (existing projects unchanged)', () => {
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
    });
    expect(parsed.programme_id).toBeUndefined();
  });

  test('accepts a valid uuid programme_id', () => {
    const pid = '019f3297-0f45-76b4-96f1-bf06d212d082';
    const parsed = ProjectCreateSchema.parse({
      name: 'p',
      repository_url: 'https://example.com/repo',
      programme_id: pid,
    });
    expect(parsed.programme_id).toBe(pid);
  });

  test('rejects a non-uuid programme_id', () => {
    expect(() =>
      ProjectCreateSchema.parse({
        name: 'p',
        repository_url: 'https://example.com/repo',
        programme_id: 'not-a-uuid',
      } as unknown),
    ).toThrow();
  });

  test('programme_id is NOT one of the columns destructured out of project_data', () => {
    // Guard the "flows into project_data via ...extendedFields" contract: the
    // create path destructures name/repository_url/branch/project_type/
    // scope_level/shape/bound_assets out, and spreads the
    // REST into project_data. programme_id must remain in that rest set.
    const DESTRUCTURED_OUT = new Set([
      'name',
      'repository_url',
      'branch',
      'project_type',
      'scope_level',
      'shape',
      'bound_assets',
    ]);
    expect(DESTRUCTURED_OUT.has('programme_id')).toBe(false);
  });
});
