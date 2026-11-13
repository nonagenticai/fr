// tests/unit/db/member-knowledge-area-check.test.ts
//
// `member_knowledge_areas.area` has NO vocabulary CHECK since migration 187:
// knowledge areas are the TENANT's RM capabilities (design Q1 = a), validated
// on the write path (lib/knowledge-areas.ts `unknownAreas`). Pinned from the
// files as text; the DB-backed half is
// tests/integration/db/member-knowledge-area-check.integration.test.ts.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { probeForMigration } from '../../../src/db/migration-runner';

const BACKEND = path.resolve(import.meta.dir, '../../..');
const M187 = '187_drop_member_knowledge_area_check.sql';
const body = readFileSync(path.join(BACKEND, 'migrations', M187), 'utf8')
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');

describe('migration 187 drops the member_knowledge_areas area CHECK', () => {
  test('DROP CONSTRAINT IF EXISTS, forward-only, runner conventions', () => {
    expect(body).toMatch(
      /ALTER TABLE member_knowledge_areas DROP CONSTRAINT IF EXISTS member_knowledge_areas_area_check;/,
    );
    expect(body).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(body).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
    expect(body).not.toMatch(/ADD CONSTRAINT/i);
  });

  test('db/schema.ts no longer declares it (drizzle-kit push cannot re-create it)', () => {
    const schema = readFileSync(path.join(BACKEND, 'src/db/schema.ts'), 'utf8');
    expect(schema).not.toContain("'member_knowledge_areas_area_check'");
    expect(schema).not.toContain('KNOWLEDGE_AREA_SQL_LITERALS');
    // positive control: the table itself is still declared
    expect(schema).toContain("'member_knowledge_areas'");
  });

  test('187 is probed for ABSENCE', () => {
    expect(typeof probeForMigration(M187)).toBe('function');
  });
});
