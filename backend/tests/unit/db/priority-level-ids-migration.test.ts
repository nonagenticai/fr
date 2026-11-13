// tests/unit/db/priority-level-ids-migration.test.ts
//
// Migration 188 (design Q3 = b, store the RM priority-level id), pinned from the
// files: it ADDs the two id columns and DROPs 160's to_priority vocabulary
// CHECK, pure idempotent DDL; schema.ts declares the columns and not the CHECK;
// the runner probes 188. The DB half (columns usable, backfill) was the
// backfill-priority-level-ids integration suite, deleted 2026-10-29 under the
// no-test-doubles ruling — no longer in the suite.

import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import { probeForMigration } from '../../../src/db/migration-runner';

const BACKEND = path.resolve(import.meta.dir, '../../..');
const M188 = '188_priority_level_ids.sql';
const body = readFileSync(path.join(BACKEND, 'migrations', M188), 'utf8')
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))
  .join('\n');
const schema = readFileSync(path.join(BACKEND, 'src/db/schema.ts'), 'utf8');

describe('migration 188', () => {
  test('adds both level-id columns and drops the to_priority CHECK, idempotently', () => {
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS from_priority_level_id uuid;/);
    expect(body).toMatch(/ADD COLUMN IF NOT EXISTS to_priority_level_id uuid;/);
    expect(body).toMatch(/DROP CONSTRAINT IF EXISTS priority_change_events_to_check;/);
    expect(body).toMatch(/SET LOCAL lock_timeout = '10s';/);
    expect(body).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(body).not.toMatch(/\b(BEGIN|COMMIT|ROLLBACK)\s*;/i);
  });
  test('schema.ts declares the columns, keeps the legacy text, and no longer the vocabulary CHECK', () => {
    expect(schema).toContain("uuid('from_priority_level_id')");
    expect(schema).toContain("uuid('to_priority_level_id')");
    expect(schema).toContain("text('from_priority')");
    expect(schema).not.toContain("'priority_change_events_to_check'");
    // positive control: the other priority CHECKs stay
    expect(schema).toContain("'priority_change_events_changed_check'");
  });
  test('188 is probed', () => {
    expect(typeof probeForMigration(M188)).toBe('function');
  });
});
