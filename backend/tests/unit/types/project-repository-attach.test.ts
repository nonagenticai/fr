// Pure schema test for ProjectRepositoryAttachSchema (task #25 scope B PR 2).
//
// The schema is a discriminator-free OR — either `repo_id` (existing-repo
// attach) or `url` (create-or-attach by url). Both missing must 422 so the
// handler never branches into a "neither" arm at runtime. `repo_id` MUST
// be a uuid because the handler queries `repositories` by it directly.

import { test, expect, describe } from 'bun:test';
import { ProjectRepositoryAttachSchema } from '../../../src/types/api';

describe('ProjectRepositoryAttachSchema', () => {
  test('accepts repo_id form', () => {
    const parsed = ProjectRepositoryAttachSchema.parse({
      repo_id: '11111111-1111-4111-8111-111111111111',
    });
    expect(parsed.repo_id).toBe('11111111-1111-4111-8111-111111111111');
  });

  test('accepts url form with optional branch + name', () => {
    const parsed = ProjectRepositoryAttachSchema.parse({
      url: 'https://github.com/x/y.git',
      branch: 'develop',
      name: 'my-repo',
    });
    expect(parsed.url).toBe('https://github.com/x/y.git');
    expect(parsed.branch).toBe('develop');
  });

  test('rejects empty body (neither repo_id nor url)', () => {
    expect(() => ProjectRepositoryAttachSchema.parse({})).toThrow();
  });

  test('rejects non-uuid repo_id', () => {
    expect(() =>
      ProjectRepositoryAttachSchema.parse({ repo_id: 'not-a-uuid' }),
    ).toThrow();
  });

  test('rejects empty url string', () => {
    expect(() => ProjectRepositoryAttachSchema.parse({ url: '' })).toThrow();
  });
});
