// tests/unit/routes/bug-hunt-unique-violation.test.ts
//
// Pure (no DB) proof that isBugHuntUniqueViolation in routes/projects.ts maps
// ONLY a unique violation on migration 163's BUG_HUNT_UNIQUE_INDEX to the 409
// bug_hunt_project_exists. Any OTHER 23505 (a different unique index) must
// read false so createProjectCore rethrows it instead of mislabelling it as a
// duplicate hunt. The DB-backed race test (the bug-hunt-duplicate-guard suite,
// deleted 2026-10-29) only ever produced OUR index's violation, so it cannot tell "our index" from
// "any 23505" — these cases can.
//
// Error shapes mirror what reaches the catch: the bare postgres.js error
// (depth 0), and the Drizzle wrapper carrying it on `.cause` (pgErrorCode only
// trusts a cause that looks like a driver error — severity/routine set).

import { describe, expect, test } from 'bun:test';

import { BUG_HUNT_UNIQUE_INDEX, isBugHuntUniqueViolation } from '../../../src/routes/projects';

const OTHER_INDEX = 'repositories_user_id_url_key';

function pgError(code: string, constraintName: string) {
  return { code, severity: 'ERROR', routine: '_bt_check_unique', constraint_name: constraintName };
}

function drizzleWrapped(inner: object) {
  return Object.assign(new Error('Failed query: insert into "projects" …'), { cause: inner });
}

describe('isBugHuntUniqueViolation — our index only', () => {
  test('the index name is migration 163’s', () => {
    // Literal on purpose: a rename on one side only must fail here.
    expect(BUG_HUNT_UNIQUE_INDEX).toBe('projects_one_live_bug_hunt_per_repo_idx');
  });

  test('23505 on BUG_HUNT_UNIQUE_INDEX (bare driver error) → true', () => {
    expect(isBugHuntUniqueViolation(pgError('23505', BUG_HUNT_UNIQUE_INDEX))).toBe(true);
  });

  test('23505 on BUG_HUNT_UNIQUE_INDEX wrapped in cause → true', () => {
    expect(isBugHuntUniqueViolation(drizzleWrapped(pgError('23505', BUG_HUNT_UNIQUE_INDEX)))).toBe(
      true,
    );
  });

  test('23505 on ANOTHER unique index (bare) → false', () => {
    expect(isBugHuntUniqueViolation(pgError('23505', OTHER_INDEX))).toBe(false);
  });

  test('23505 on ANOTHER unique index wrapped in cause → false', () => {
    expect(isBugHuntUniqueViolation(drizzleWrapped(pgError('23505', OTHER_INDEX)))).toBe(false);
  });

  test('23505 with no constraint_name at all → false', () => {
    expect(isBugHuntUniqueViolation({ code: '23505', severity: 'ERROR' })).toBe(false);
  });

  test('a non-unique SQLSTATE (23503) naming our index → false', () => {
    expect(isBugHuntUniqueViolation(pgError('23503', BUG_HUNT_UNIQUE_INDEX))).toBe(false);
    expect(isBugHuntUniqueViolation(drizzleWrapped(pgError('23503', BUG_HUNT_UNIQUE_INDEX)))).toBe(
      false,
    );
  });
});
