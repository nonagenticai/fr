// tests/unit/db/project-vocabulary-checks.test.ts
//
// `projects.project_phase` and `projects.project_type` have NO vocabulary CHECK
// since migration 185 (design: fr consumes RM vocabulary, George 2026-10-12).
// Both vocabularies are the TENANT's requirements_management catalogue and are
// validated in the app (services/catalogue/tenant-catalogue.ts). Pinned here,
// from the files as text (no database):
//   * migration 185 drops BOTH constraints, forward-only, idempotently, under a
//     lock_timeout, with no DML;
//   * db/schema.ts declares neither, so `drizzle-kit push` cannot re-create them;
//   * the runner probes 185 for their ABSENCE and no longer probes 165/166
//     for their presence (which would re-create them after 185);
//   * the create door shape-checks the type only.
// The DB-backed half (an RM-only name is now storable; 185 executed drops both)
// was the project-vocabulary-checks integration suite, deleted 2026-10-29 under
// the no-test-doubles ruling — no longer in the suite.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { probeForMigration } from '../../../src/db/migration-runner';
import { ProjectCreateFields, ProjectCreateSchema } from '../../../src/types/api';

const BACKEND = path.resolve(import.meta.dir, '../../..');
const M185 = '185_drop_project_vocabulary_checks.sql';

const sqlOnly = (file: string): string =>
  readFileSync(path.join(BACKEND, 'migrations', file), 'utf8')
    .split('\n')
    .map((l) => l.replace(/--.*$/, ''))
    .join('\n');

describe('migration 185 drops the project_phase / project_type CHECKs', () => {
  const body = sqlOnly(M185);

  test('DROP CONSTRAINT IF EXISTS for both, on projects', () => {
    expect(body).toMatch(/ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_phase_check;/);
    expect(body).toMatch(/ALTER TABLE projects DROP CONSTRAINT IF EXISTS projects_project_type_check;/);
  });

  test('follows the runner conventions: lock_timeout, no DML, no transaction control', () => {
    expect(body).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(body).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    // forward-only: nothing re-adds a vocabulary CHECK
    expect(body).not.toMatch(/ADD CONSTRAINT/i);
  });

  test('leaves the priority and knowledge-area CHECKs alone (part 2)', () => {
    expect(body).not.toMatch(/priority/i);
    expect(body).not.toMatch(/knowledge/i);
  });
});

describe('db/schema.ts no longer declares either CHECK', () => {
  const schema = readFileSync(path.join(BACKEND, 'src/db/schema.ts'), 'utf8');
  test('no projects_project_phase_check / projects_project_type_check', () => {
    expect(schema).not.toContain("'projects_project_phase_check'");
    expect(schema).not.toContain("'projects_project_type_check'");
    expect(schema).not.toContain('PROJECT_PHASE_SQL_LITERALS');
    expect(schema).not.toContain('PROJECT_TYPE_SQL_LITERALS');
  });
  test('positive control: the other projects CHECKs are still declared', () => {
    expect(schema).toContain("'projects_shape_check'");
    expect(schema).toContain("'projects_template_pair_check'");
  });
});

describe('runner probes', () => {
  test('185 is probed (absence); 165/166 are no longer probed', () => {
    expect(typeof probeForMigration(M185)).toBe('function');
    expect(probeForMigration('165_project_phase_check.sql')).toBeUndefined();
    expect(probeForMigration('166_project_type_check.sql')).toBeUndefined();
  });
});

describe('the CREATE door shape-checks project_type only', () => {
  test('any name-shaped type parses (RM decides which exist); the draft fields stay open', () => {
    const base = { name: 'n', repository_url: 'https://github.com/a/b' };
    expect(ProjectCreateSchema.safeParse({ ...base, project_type: 'bug_hunt_fix' }).success).toBe(true);
    expect(ProjectCreateSchema.safeParse({ ...base, project_type: '' }).success).toBe(false);
    expect(ProjectCreateSchema.safeParse({ ...base, project_type: 'x'.repeat(101) }).success).toBe(false);
    expect(ProjectCreateSchema.safeParse(base).success).toBe(true);
    expect(ProjectCreateFields.safeParse({ ...base, project_type: 'business' }).success).toBe(true);
  });
});
